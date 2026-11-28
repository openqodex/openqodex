// Pin freshness for the scanner table (packages/scanners/toolchain.json),
// the table the installer trusts: what this writes is the product's supply
// chain.
//
//   node scripts/pin-bump.mjs --report        each scanner's pin, its newest
//                                             release at least 7 days old,
//                                             and whether a bump is due
//   node scripts/pin-bump.mjs --matrix        the scanners with a bump due,
//                                             as a JSON list
//   node scripts/pin-bump.mjs --apply <tool>  moves that scanner's pin to its
//                                             newest release at least 7 days
//                                             old, and writes a changeset
//   node scripts/pin-bump.mjs --apply <tool> --locks <folder> --locks-sha256 <hex>
//                                             the same, for the job that holds
//                                             the write token: a PyPI or
//                                             RubyGems pin takes its lock files
//                                             from <folder> instead of
//                                             re-locking, which would start uv
//   node scripts/pin-bump.mjs --proposal <tool>
//                                             the sha256 of the files a bump
//                                             of that scanner wrote: the
//                                             table, its lock files and its
//                                             changeset
//   node scripts/pin-bump.mjs --lock-digest <tool>
//                                             the sha256 of that scanner's
//                                             lock files alone
//
// What --apply trusts, and how:
// - The source is the owner and repository (or registry package) already in
//   the table, over HTTPS. An API answer that redirects is refused: GitHub
//   redirects a renamed or transferred repository, which could swap the
//   source. A release asset whose URL is outside that repository's
//   releases is refused.
// - A GitHub release asset is downloaded, never past the size limit, and its
//   sha256 computed from its bytes. That sha256 must equal the one GitHub
//   publishes for the asset, always, and, when the project publishes a
//   checksum file, the one in that file too. The last line of --apply says
//   which: sums=checksum-file-and-digest or sums=digest-only. A download may
//   redirect only to GitHub's own asset host.
// - A system asset is not a download: the host's package manager installs it
//   and the host checks it at run time. A bump leaves it as it is, and a
//   FreeBSD download is bumped like any other download.
// - A PyPI or RubyGems pin is re-locked by scripts/lock-scanners.mjs, which
//   starts the pinned uv and checks each gem's download against RubyGems'
//   sha256; a gem's lowest Ruby comes from its own metadata. With --locks
//   nothing is started: the lock files given must have the sha256 the job
//   that made them recorded, read as locks line by line, and name only
//   hashes PyPI or RubyGems publishes for those exact versions.
// - A release must be newer than the pin and at least 7 days old.
// - It writes toolchain.json, the scanner's lock files and one changeset,
//   and nothing else. Any refusal exits 2 with the reason and puts every
//   file it touched back as it was.
// The monthly workflow (.github/workflows/pin-bump.yml) opens one pull request
// per bump; a person merges it. GITHUB_TOKEN, when set, goes to the GitHub API
// only.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkGemTree, checkPyTree, LockRefused, pyName, readGemLock, readUvLock, writeGemLock, writeUvLock } from "./lock-check.mjs";
import { FREEBSD_PLATFORMS, assetKind } from "./toolchain-assets.mjs";

const MIN_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const PLATFORM_COUNT_LIMIT = 16;
const MAX_REDIRECTS = 5;
const MAX_ASSET_BYTES = 500 * 1024 * 1024;
// The most a registry or API answer may hold; past it the answer is given up.
const MAX_METADATA_BYTES = 16 * 1024 * 1024;
const MAX_LOCK_BYTES = 1024 * 1024;

// The upstream origins and the asset size limit. Only an import (the tests)
// can change them; nothing in the environment does.
const UPSTREAM = {
  root: dirname(dirname(fileURLToPath(import.meta.url))),
  api: "https://api.github.com",
  web: "https://github.com",
  // Where a release download may redirect: GitHub's own asset hosts.
  assetOrigins: ["https://github.com", "https://release-assets.githubusercontent.com", "https://objects.githubusercontent.com"],
  pypi: "https://pypi.org",
  rubygems: "https://rubygems.org",
  maxAssetBytes: MAX_ASSET_BYTES,
};

class Refused extends Error {}

const isRelease = (v) => typeof v === "string" && /^\d+(\.\d+)*$/.test(v);
function compare(a, b) {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
const newest = (list) => list.sort((a, b) => compare(b.version, a.version))[0] ?? null;

// The body of a response, read as it arrives and given up, connection and
// all, the moment it passes `maxBytes`.
async function readCapped(response, url, maxBytes) {
  const chunks = [];
  let size = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks);
    size += value.length;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Refused(`${url}: larger than ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
}

// One GET, with one retry for a connection that drops, never following a
// redirect itself. A failure names the URL and its cause.
async function get(url, maxBytes, headers = {}) {
  for (let attempt = 0; ; attempt++) {
    let response;
    try {
      response = await fetch(url, { headers, redirect: "manual" });
    } catch (error) {
      if (attempt > 0) {
        const cause = error instanceof Error ? (error.cause?.code ?? error.cause?.message ?? error.message) : String(error);
        throw new Refused(`${url}: ${cause}`);
      }
      continue;
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      return { response, bytes: null };
    }
    return { response, bytes: await readCapped(response, url, maxBytes) };
  }
}

// GET with no redirect at all: an API or registry answer.
async function getJson(url, github) {
  const headers = { accept: "application/json" };
  if (github && process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const { response, bytes } = await get(url, MAX_METADATA_BYTES, headers);
  if (response.status >= 300 && response.status < 400) {
    throw new Refused(`${url} answered with a redirect to ${response.headers.get("location") ?? "nowhere"}; a renamed or moved source is not followed`);
  }
  if (!response.ok) throw new Refused(`${url}: HTTP ${response.status}`);
  return JSON.parse(bytes.toString("utf8"));
}

// The bytes of a release asset, following redirects only to the asset
// origins, and never more than `maxBytes` of them.
async function download(url, origins, maxBytes = MAX_ASSET_BYTES) {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const at = new URL(current);
    if (!origins.includes(at.origin)) throw new Refused(`refusing to download from ${at.origin}: a redirect may lead only to ${origins.join(", ")}`);
    const { response, bytes } = await get(current, maxBytes);
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Refused(`${current}: a redirect with no location`);
      current = new URL(location, current).href;
      continue;
    }
    if (!response.ok) throw new Refused(`${current}: HTTP ${response.status}`);
    return bytes;
  }
  throw new Refused(`${url}: more than ${MAX_REDIRECTS} redirects`);
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// The sha256 a checksum file gives a name: lines "<hex>  <name>" or
// "<hex> *<name>", or, for a per-asset .sha256 file, the hex alone.
function checksumFor(text, name, single) {
  for (const line of text.split("\n")) {
    const [hex = "", file = ""] = line.trim().split(/\s+/);
    if (!/^[0-9a-f]{64}$/i.test(hex)) continue;
    if (file.replace(/^\*/, "") === name || (single && file === "")) return hex.toLowerCase();
  }
  return null;
}

// The newest release of a GitHub project that is at least 7 days old.
async function githubLatest(recipe, up, now) {
  const prefix = recipe.tag.slice(0, recipe.tag.length - recipe.version.length);
  const releases = await getJson(`${up.api}/repos/${recipe.repo}/releases?per_page=100`, true);
  if (!Array.isArray(releases)) throw new Refused(`${recipe.repo}: the release list is not a list`);
  const fit = releases
    .filter((r) => !r.draft && !r.prerelease && typeof r.tag_name === "string" && r.tag_name.startsWith(prefix) && isRelease(r.tag_name.slice(prefix.length)))
    .filter((r) => now - Date.parse(r.published_at) >= MIN_AGE_MS)
    .map((r) => ({ version: r.tag_name.slice(prefix.length), date: r.published_at, release: r }));
  return newest(fit);
}

async function latest(recipe, up, now) {
  if (recipe.method === "github-release") return githubLatest(recipe, up, now);
  if (recipe.method === "uv") {
    const info = await getJson(`${up.pypi}/pypi/${encodeURIComponent(recipe.package)}/json`, false);
    const fit = Object.entries(info.releases ?? {})
      .filter(([v, files]) => isRelease(v) && Array.isArray(files) && files.length > 0 && !files.every((f) => f.yanked))
      .map(([v, files]) => ({ version: v, date: files.map((f) => f.upload_time_iso_8601).sort()[0] }))
      .filter((r) => now - Date.parse(r.date) >= MIN_AGE_MS);
    return newest(fit);
  }
  // gem: every gem of the recipe moves to its own newest release.
  const moved = [];
  for (const spec of recipe.gems) {
    const [gem] = spec.split(":");
    const all = await getJson(`${up.rubygems}/api/v1/versions/${encodeURIComponent(gem)}.json`, false);
    const best = newest(
      all
        .filter((r) => r.platform === "ruby" && !r.prerelease && isRelease(r.number) && now - Date.parse(r.created_at) >= MIN_AGE_MS)
        .map((r) => ({ version: r.number, date: r.created_at, ruby: r.ruby_version ?? ">= 0" })),
    );
    if (!best) throw new Refused(`${gem} has no release at least 7 days old`);
    moved.push({ gem, ...best });
  }
  return { version: moved[0].version, date: moved[0].date, gems: moved };
}

// The lowest Ruby a gem's "ruby_version" requirement allows: ">= 3.0.0" is 3.0.
function lowestRuby(requirement) {
  for (const part of requirement.split(",")) {
    const t = part.trim();
    if (!t.startsWith(">=")) continue;
    let v = t.slice(2).trim();
    while (v.split(".").length > 2 && v.endsWith(".0")) v = v.slice(0, -2);
    return isRelease(v) ? v : null;
  }
  return null;
}

// The new assets of a GitHub release pin, each checked as the top of this
// file says.
async function verifiedAssets(tool, recipe, found, up) {
  const { release, version } = found;
  const base = `${up.web}/${recipe.repo}/releases/download/${release.tag_name}/`;
  const listed = new Map((release.assets ?? []).map((a) => [a.name, a]));
  const fetchText = async (name) => {
    const a = listed.get(name);
    if (typeof a.browser_download_url !== "string" || a.browser_download_url !== `${base}${name}`) throw new Refused(`${tool}: ${name} is outside ${base}`);
    return (await download(a.browser_download_url, up.assetOrigins, up.maxAssetBytes)).toString("utf8");
  };
  // The project's checksum file for the whole release, when it has one
  // (kubeconform names its file CHECKSUMS).
  const sumText = new Map();
  for (const name of [...listed.keys()].filter((n) => /checksums?\.txt$|^checksums$|SHA256SUMS$|sha256sums\.txt$/i.test(n))) {
    sumText.set(name, await fetchText(name));
  }
  const entries = Object.entries(recipe.assets);
  if (entries.length > PLATFORM_COUNT_LIMIT) throw new Refused(`${tool}: too many platforms`);
  const assets = {};
  let withFile = 0;
  for (const [platform, asset] of entries) {
    if (!asset) {
      assets[platform] = asset;
      continue;
    }
    // A system asset is not a download: the host's package manager installs
    // it and the host checks it at run time. A bump leaves it as it is, so
    // the pin the host checks stays the one a person set.
    if (assetKind(asset) === "system") {
      assets[platform] = asset;
      continue;
    }
    const name = asset.name.split(recipe.version).join(version);
    const a = listed.get(name);
    if (!a) throw new Refused(`${tool} ${version}: no asset named ${name} for ${platform}; the names changed, pin it by hand`);
    if (typeof a.browser_download_url !== "string" || !a.browser_download_url.startsWith(base) || a.browser_download_url.slice(base.length) !== name) {
      throw new Refused(`${tool} ${version}: ${name} is outside ${base}`);
    }
    const published = /^sha256:([0-9a-f]{64})$/.exec(a.digest ?? "")?.[1] ?? null;
    if (published === null) throw new Refused(`${tool} ${version}: GitHub publishes no sha256 for ${name}; pin it by hand`);
    const actual = sha256(await download(a.browser_download_url, up.assetOrigins, up.maxAssetBytes));
    if (published !== actual) throw new Refused(`${tool} ${version}: ${name} has sha256 ${actual}, GitHub publishes ${published}`);
    // The release's checksum file, or a checksum file of this asset alone
    // (`<name>.sha256`, as ruff, uv and hadolint publish).
    let inFile = null;
    for (const text of sumText.values()) inFile ??= checksumFor(text, name, false);
    const own = listed.has(`${name}.sha256`) ? await fetchText(`${name}.sha256`) : null;
    if (own !== null) {
      const fromOwn = checksumFor(own, name, true);
      if (fromOwn === null) throw new Refused(`${tool} ${version}: ${name}.sha256 holds no sha256`);
      if (inFile !== null && inFile !== fromOwn) throw new Refused(`${tool} ${version}: the checksum files disagree about ${name}`);
      inFile = fromOwn;
    }
    if ((sumText.size > 0 || own !== null) && inFile === null) throw new Refused(`${tool} ${version}: the checksum file names no sha256 for ${name}`);
    if (inFile !== null && inFile !== actual) throw new Refused(`${tool} ${version}: ${name} has sha256 ${actual}, the checksum file says ${inFile}`);
    withFile += inFile === null ? 0 : 1;
    assets[platform] = { ...asset, name, url: a.browser_download_url, sha256: actual, binaryPath: asset.binaryPath.split(recipe.version).join(version) };
  }
  // Only the downloads count here: a system asset has no checksum file and no
  // digest, so it is never one of the assets a project publishes sums for.
  const pinned = Object.values(assets).filter((asset) => asset && assetKind(asset) === "release").length;
  // Never silently one of two: either every asset matched a checksum file of
  // the project's and GitHub's digest, or the project publishes none at all.
  if (withFile !== 0 && withFile !== pinned) throw new Refused(`${tool} ${version}: the project publishes a checksum for some assets only; pin it by hand`);
  return { assets, sums: withFile === 0 ? "digest-only" : "checksum-file-and-digest" };
}

// What a tool has on FreeBSD, one part per platform: the package and the pin
// of a system asset (the version the host's package manager must have), the
// pinned release of a download, or nothing at all.
function freebsdPins(recipe) {
  const parts = [];
  for (const platform of FREEBSD_PLATFORMS) {
    const asset = recipe.assets?.[platform];
    const arch = platform === "freebsd-x64" ? "x64" : "arm64";
    if (asset === undefined || asset === null) {
      parts.push(`${arch} none`);
      continue;
    }
    if (assetKind(asset) === "system") {
      parts.push(`${arch} ${asset.system.package} ${asset.version}`);
      continue;
    }
    parts.push(`${arch} ${recipe.version}`);
  }
  return parts.join("; ");
}

async function report(table, up, now) {
  const rows = [];
  for (const [tool, recipe] of Object.entries(table.tools)) {
    const l = await latest(recipe, up, now);
    const due = l !== null && compare(l.version, recipe.version) > 0;
    rows.push({ tool, pinned: recipe.version, latest: l?.version ?? "-", released: l?.date?.slice(0, 10) ?? "-", due, freebsd: freebsdPins(recipe) });
  }
  return rows;
}

// The lock files of `tool` in `folder`, one per platform, name order: the
// bytes the --lock-digest sha256 covers.
function lockFiles(folder, tool) {
  return Object.keys(PLATFORM_TRIPLES)
    .sort()
    .map((p) => `${tool}-${p}.txt`)
    .filter((name) => existsSync(join(folder, name)));
}

function lockDigest(folder, tool) {
  const hash = createHash("sha256");
  for (const name of lockFiles(folder, tool)) hash.update(`${name}\0`).update(readFileSync(join(folder, name))).update("\0");
  return hash.digest("hex");
}

// The lock files given for a PyPI or RubyGems pin, checked before any is
// used (lock-check.mjs): the recorded sha256, then each file read block by
// block, then its packages against the pinned tool's dependency tree for
// that platform, as the registry declares it, with every hash or sha256 one
// the registry publishes. Returns the files to write, made from what was
// read, never the raw text.
async function checkGivenLocks(tool, next, folder, recorded, up) {
  if (!/^[0-9a-f]{64}$/.test(recorded ?? "")) throw new Refused("--locks needs --locks-sha256 <hex>");
  const names = lockFiles(folder, tool);
  if (next.method === "github-release") {
    if (names.length !== 0) throw new Refused(`${tool}: a GitHub release pin takes no lock files`);
    return new Map();
  }
  if (names.length !== Object.keys(PLATFORM_TRIPLES).length) throw new Refused(`${tool}: --locks must hold one lock file per platform`);
  for (const name of names) {
    const st = lstatSync(join(folder, name));
    if (!st.isFile() || st.size > MAX_LOCK_BYTES) throw new Refused(`${tool}: ${name} is not a lock file`);
  }
  if (lockDigest(folder, tool) !== recorded) throw new Refused(`${tool}: the lock files given do not have the sha256 the job that made them recorded`);
  const cache = new Map();
  const cached = (key, url) => {
    if (!cache.has(key)) cache.set(key, getJson(url, false));
    return cache.get(key);
  };
  const out = new Map();
  try {
    for (const name of names) {
      const text = readFileSync(join(folder, name), "utf8");
      const platform = name.slice(tool.length + 1, -".txt".length);
      if (next.method === "uv") {
        const blocks = readUvLock(text, name);
        await checkPyTree({
          blocks,
          file: name,
          recipe: next,
          platform,
          metadata: (n, v) => cached(`${pyName(n)}==${v}`, `${up.pypi}/pypi/${encodeURIComponent(n)}/${encodeURIComponent(v)}/json`),
        });
        out.set(name, writeUvLock(blocks));
      } else {
        const ruby = /^ruby>=([0-9.]+)$/.exec(next.needs ?? "")?.[1];
        if (!ruby) throw new Refused(`${tool}: needs must name the lowest Ruby`);
        const header = `# ${next.gems.join(" ")} for Ruby ${ruby} or newer, made by scripts/lock-scanners.mjs`;
        const gems = readGemLock(text, name, header);
        await checkGemTree({
          gems,
          file: name,
          recipe: next,
          metadata: (n, v) => cached(`${n}@${v}`, `${up.rubygems}/api/v2/rubygems/${encodeURIComponent(n)}/versions/${encodeURIComponent(v)}.json?platform=ruby`),
        });
        out.set(name, writeGemLock(header, gems));
      }
    }
  } catch (error) {
    if (error instanceof LockRefused) throw new Refused(error.message);
    throw error;
  }
  return out;
}

async function apply(tool, table, up, now, given) {
  const tablePath = join(up.root, "packages", "scanners", "toolchain.json");
  const recipe = table.tools[tool];
  if (!recipe) throw new Refused(`${tool} is not in the toolchain table`);
  const found = await latest(recipe, up, now);
  if (found === null || compare(found.version, recipe.version) <= 0 || now - Date.parse(found.date) < MIN_AGE_MS) {
    process.stdout.write(`${tool}: ${recipe.version} is the newest release at least 7 days old\n`);
    return;
  }
  const from = recipe.version;
  const next = { ...recipe, version: found.version };
  let sums = "registry";
  if (recipe.method === "github-release") {
    const verified = await verifiedAssets(tool, recipe, found, up);
    next.assets = verified.assets;
    sums = verified.sums;
    next.tag = found.release.tag_name;
  } else if (recipe.method === "gem") {
    next.gems = found.gems.map((g) => `${g.gem}:${g.version}`);
    const lowest = found.gems.map((g) => lowestRuby(g.ruby)).filter((v) => v !== null).sort(compare).pop();
    if (lowest) next.needs = `ruby>=${lowest}`;
  }

  const givenLocks = given ? await checkGivenLocks(tool, next, given.folder, given.sha256, up) : null;

  // Everything checked: write, and put every file back if a step after fails.
  const locks = Object.keys(PLATFORM_TRIPLES).map((p) => join(up.root, "packages", "scanners", "locks", `${tool}-${p}.txt`));
  const before = new Map([tablePath, ...locks].map((f) => [f, existsSync(f) ? readFileSync(f) : null]));
  const changeset = join(up.root, ".changeset", `pin-${tool}-${found.version.split(".").join("-")}.md`);
  try {
    writeFileSync(tablePath, `${JSON.stringify({ ...table, tools: { ...table.tools, [tool]: next } }, null, 2)}\n`);
    if (givenLocks !== null) {
      for (const [name, text] of givenLocks) writeFileSync(join(up.root, "packages", "scanners", "locks", name), text);
    } else if (recipe.method !== "github-release") {
      execFileSync(process.execPath, [join(up.root, "scripts", "lock-scanners.mjs"), tool], { stdio: "inherit" });
    }
    writeFileSync(changeset, `---\n"openqodex": patch\n---\n\nThe built-in ${tool} scanner moves from ${from} to ${found.version}, released ${found.date.slice(0, 10)}.\n`);
  } catch (error) {
    for (const [file, bytes] of before) {
      if (bytes === null) rmSync(file, { force: true });
      else writeFileSync(file, bytes);
    }
    rmSync(changeset, { force: true });
    throw new Refused(`${tool}: ${error instanceof Error ? error.message : String(error)}; every file is back as it was`);
  }
  process.stdout.write(`${tool}: ${from} -> ${found.version}\nsums=${sums}\n`);
}

// The platforms a lock file is written for. A PyPI or RubyGems recipe has no
// FreeBSD lock file: no uv or gem recipe supports FreeBSD, so there is
// nothing to lock there.
const PLATFORM_TRIPLES = { "darwin-arm64": 1, "darwin-x64": 1, "linux-x64": 1, "linux-arm64": 1 };

// One sha256 over every file a bump of `tool` writes, name and bytes, in
// name order. The workflow compares it between the job that ran the gate and
// the job that makes the bump again and opens the pull request.
function proposal(tool, up) {
  if (!/^[a-z0-9-]+$/.test(tool)) throw new Refused(`${tool} is not a scanner name`);
  const files = ["packages/scanners/toolchain.json"];
  const locks = join(up.root, "packages", "scanners", "locks");
  if (existsSync(locks)) for (const f of readdirSync(locks)) if (f.startsWith(`${tool}-`) && f.endsWith(".txt")) files.push(`packages/scanners/locks/${f}`);
  const changesets = join(up.root, ".changeset");
  if (existsSync(changesets)) for (const f of readdirSync(changesets)) if (f.startsWith(`pin-${tool}-`) && f.endsWith(".md")) files.push(`.changeset/${f}`);
  const hash = createHash("sha256");
  for (const f of files.sort()) hash.update(`${f}\0`).update(readFileSync(join(up.root, f))).update("\0");
  return hash.digest("hex");
}

// The command line. Returns the exit code: 0 done or nothing due, 2 refused
// or wrong usage.
export async function run(argv, options = {}) {
  const up = { ...UPSTREAM, ...options };
  const now = Date.now();
  try {
    const table = JSON.parse(readFileSync(join(up.root, "packages", "scanners", "toolchain.json"), "utf8"));
    const [mode, arg, ...rest] = argv;
    let given = null;
    if (mode === "--apply" && rest.length > 0) {
      if (rest.length !== 4 || rest[0] !== "--locks" || rest[2] !== "--locks-sha256") throw new Refused("usage: --apply <tool> --locks <folder> --locks-sha256 <hex>");
      given = { folder: rest[1], sha256: rest[3] };
    } else if (rest.length > 0) {
      throw new Refused(`unknown arguments: ${rest.join(" ")}`);
    }
    if (mode === "--report" && arg === undefined) {
      process.stdout.write("| Scanner | Pinned | Newest 7 days old | Released | Bump due | FreeBSD |\n|---|---|---|---|---|---|\n");
      for (const r of await report(table, up, now)) process.stdout.write(`| ${r.tool} | ${r.pinned} | ${r.latest} | ${r.released} | ${r.due ? "yes" : "no"} | ${r.freebsd} |\n`);
    } else if (mode === "--matrix" && arg === undefined) {
      process.stdout.write(`${JSON.stringify((await report(table, up, now)).filter((r) => r.due).map((r) => r.tool))}\n`);
    } else if (mode === "--apply" && arg !== undefined) {
      await apply(arg, table, up, now, given);
    } else if (mode === "--proposal" && arg !== undefined) {
      process.stdout.write(`${proposal(arg, up)}\n`);
    } else if (mode === "--lock-digest" && arg !== undefined) {
      if (!/^[a-z0-9-]+$/.test(arg)) throw new Refused(`${arg} is not a scanner name`);
      process.stdout.write(`${lockDigest(join(up.root, "packages", "scanners", "locks"), arg)}\n`);
    } else {
      process.stderr.write("usage: node scripts/pin-bump.mjs --report | --matrix | --apply <tool> [--locks <folder> --locks-sha256 <hex>] | --proposal <tool> | --lock-digest <tool>\n");
      return 2;
    }
    return 0;
  } catch (error) {
    process.stderr.write(`pin-bump: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await run(process.argv.slice(2));
}
