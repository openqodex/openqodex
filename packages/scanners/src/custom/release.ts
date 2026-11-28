// Finds a custom scanner's release on GitHub, picks the asset for this
// machine, and downloads it to quarantine. Nothing here executes or unpacks
// what it downloads.
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { OpenQodexError } from "@openqodex/core";
import type { CustomScanner } from "@openqodex/core";
import { downloadVerified } from "../toolchain/fetch.js";
import { currentPlatform, openqodexHome, type Platform } from "../toolchain/table.js";

const OS_TOKENS: Record<"darwin" | "freebsd" | "linux", string[]> = {
  darwin: ["darwin", "macos", "osx", "apple"],
  freebsd: ["freebsd"],
  linux: ["linux"],
};
const ARCH_TOKENS: Record<"arm64" | "x64", string[]> = {
  arm64: ["arm64", "aarch64"],
  x64: ["x86_64", "amd64", "x64", "64bit"],
};
const SKIP = /\.(sha256|sha512|sig|pem|sbom|json|deb|rpm|apk|msi|asc|txt|exe)$/i;
const ARCHIVE = /\.(tar\.gz|tgz|tar\.xz|zip)$/i;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// A token counts only between separators, so "arm" never matches inside "arm64".
const tokenRe = (tokens: string[]) => new RegExp(`(?<![a-z0-9])(?:${tokens.map(escape).join("|")})(?![a-z0-9])`, "i");

function splitPlatform(platform: Platform): { os: "darwin" | "freebsd" | "linux"; arch: "arm64" | "x64" } {
  const [os, arch] = platform.split("-") as ["darwin" | "freebsd" | "linux", "arm64" | "x64"];
  return { os, arch };
}

// An archive, or a bare file whose name ends in no letters-only extension.
function installable(name: string): boolean {
  if (SKIP.test(name)) return false;
  if (ARCHIVE.test(name)) return true;
  return !/\.[a-z]+$/i.test(name);
}

function refusal(what: string, names: string[], hint: string): OpenQodexError {
  const list = names.length > 0 ? names.map((n) => `  ${n}`).join("\n") : "  (none)";
  return new OpenQodexError(`${what}. Release assets:\n${list}\n${hint}`);
}

// The one asset for this platform. `pattern` is the entry's install.asset,
// with {version}, {os} and {arch} standing for the version and any of the
// platform's name tokens; it must match a whole asset name exactly once.
export function pickAsset(names: string[], platform: Platform, opts: { pattern: string | null; version: string }): string {
  const { os, arch } = splitPlatform(platform);
  const hint = `Name the asset in .openqodex/config.yaml with a line such as: install: { asset: "<name with {version}, {os}, {arch}>" }`;
  if (opts.pattern !== null) {
    const source = opts.pattern
      .split(/(\{version\}|\{os\}|\{arch\})/)
      .map((part) =>
        part === "{version}"
          ? escape(opts.version)
          : part === "{os}"
            ? `(?:${OS_TOKENS[os].map(escape).join("|")})`
            : part === "{arch}"
              ? `(?:${ARCH_TOKENS[arch].map(escape).join("|")})`
              : escape(part),
      )
      .join("");
    const re = new RegExp(`^${source}$`, "i");
    const hits = names.filter((n) => re.test(n));
    if (hits.length === 1) return hits[0]!;
    const what =
      hits.length === 0
        ? `install.asset "${opts.pattern}" matches no release asset for ${platform}`
        : `install.asset "${opts.pattern}" matches ${hits.length} release assets for ${platform}`;
    throw refusal(what, hits.length === 0 ? names : hits, hint);
  }
  const osRe = tokenRe(OS_TOKENS[os]);
  const archRe = tokenRe(ARCH_TOKENS[arch]);
  const hits = names.filter((n) => installable(n) && osRe.test(n) && archRe.test(n));
  if (hits.length === 1) return hits[0]!;
  if (hits.length === 0) throw refusal(`no release asset matches ${platform}`, names.filter(installable), hint);
  throw refusal(`${hits.length} release assets match ${platform}`, hits, hint);
}

type Release = { tag_name: string; assets: { name: string; browser_download_url: string }[] };

function githubRepo(source: string): string {
  const m = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(source);
  if (!m) throw new OpenQodexError(`${source} is not a GitHub repository link`);
  return `${m[1]}/${m[2]}`;
}

async function githubGet(path: string): Promise<Response> {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  const headers: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": "openqodex" };
  if (token) headers.Authorization = `Bearer ${token}`;
  let response: Response;
  try {
    response = await fetch(`https://api.github.com${path}`, { headers, signal: AbortSignal.timeout(30_000) });
  } catch (error) {
    throw new OpenQodexError(`could not reach the GitHub API: ${(error as Error).message}`);
  }
  if ((response.status === 403 || response.status === 429) && response.headers.get("x-ratelimit-remaining") === "0") {
    const reset = Number(response.headers.get("x-ratelimit-reset"));
    const when = Number.isFinite(reset) && reset > 0 ? ` after ${new Date(reset * 1000).toLocaleTimeString()}` : " later";
    throw new OpenQodexError(
      `GitHub API rate limit reached${token ? "" : " (60 requests an hour without a token; set GITHUB_TOKEN to raise it)"}: try again${when}`,
    );
  }
  return response;
}

async function readRelease(repo: string, version: string | null): Promise<Release> {
  const tags = version === null ? [null] : version.startsWith("v") ? [version, version.slice(1)] : [`v${version}`, version];
  for (const tag of tags) {
    const response = await githubGet(tag === null ? `/repos/${repo}/releases/latest` : `/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`);
    if (response.ok) return (await response.json()) as Release;
    if (response.status !== 404) throw new OpenQodexError(`GitHub API answered ${response.status} for ${repo}`);
  }
  throw new OpenQodexError(version === null ? `${repo} has no published release` : `${repo} has no release ${version}`);
}

const CHECKSUM_FILE = /(checksums|sha256sums)/i;
const SIGNATURE = /\.(sig|pem|asc|sigstore\.json|bundle)$/i;

// The hash an upstream checksum file gives for `asset`, or null.
async function upstreamHash(release: Release, asset: string, dir: string): Promise<string | null> {
  const files = release.assets.filter(
    (a) => a.name === `${asset}.sha256` || (CHECKSUM_FILE.test(a.name) && !SIGNATURE.test(a.name)),
  );
  for (const file of files) {
    const path = join(dir, `checksum-${randomBytes(4).toString("hex")}`);
    try {
      await downloadVerified(file.browser_download_url, null, path, { maxBytes: 1024 * 1024 });
      for (const line of readFileSync(path, "utf8").split("\n")) {
        const m = /^([0-9a-f]{64})(?:\s+\*?(?:\.\/)?(.+?))?\s*$/i.exec(line.trim());
        if (!m) continue;
        if (m[2] === asset || (m[2] === undefined && file.name === `${asset}.sha256`)) return m[1]!.toLowerCase();
      }
    } finally {
      rmSync(path, { force: true });
    }
  }
  return null;
}

// The version a release tag stands for.
const versionOfTag = (tag: string) => tag.replace(/^v(?=\d)/, "");

export async function resolveRelease(entry: CustomScanner & { install: { kind: "github-release" } }, binary: string) {
  const platform = currentPlatform();
  if (!platform) throw new OpenQodexError(`custom scanners from a release need macOS or Linux on arm64 or x64`);
  const repo = githubRepo(entry.source);
  const release = await readRelease(repo, entry.version);
  const version = versionOfTag(release.tag_name);
  const assetName = pickAsset(
    release.assets.map((a) => a.name),
    platform,
    { pattern: entry.install.asset, version },
  );
  const asset = release.assets.find((a) => a.name === assetName)!;

  const quarantine = join(openqodexHome(), "quarantine", randomBytes(12).toString("hex"));
  mkdirSync(quarantine, { recursive: true });
  try {
    const upstream = await upstreamHash(release, assetName, quarantine);
    if (upstream && entry.install.sha256 && upstream !== entry.install.sha256) {
      throw new OpenQodexError(`${entry.name}: install.sha256 differs from the checksum ${repo} publishes for ${assetName}`);
    }
    // Named by the code, never by release text.
    const quarantinePath = join(quarantine, "download");
    let sha256: string;
    try {
      ({ sha256 } = await downloadVerified(asset.browser_download_url, upstream ?? entry.install.sha256, quarantinePath));
    } catch (error) {
      throw new OpenQodexError(`${entry.name}: ${assetName}: ${(error as Error).message}`);
    }
    return {
      version,
      assetName,
      url: asset.browser_download_url,
      sha256,
      checksumSource: upstream ? ("upstream" as const) : ("first-download" as const),
      binary,
      quarantinePath,
    };
  } catch (error) {
    rmSync(quarantine, { recursive: true, force: true });
    throw error;
  }
}
