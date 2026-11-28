// scripts/pin-bump.mjs moves a scanner pin in toolchain.json, the table the
// installer trusts: what it writes is the product's supply chain. A local
// server stands in for GitHub's API, its release pages and its asset host;
// the script runs as its own process, as the monthly workflow runs it.
//
// Failure list, written before the code:
//   1. An asset whose bytes differ from the sha256 GitHub publishes for it (a
//      tampered artifact) is pinned, or the run exits other than 2.
//   2. An asset whose bytes differ from the project's own checksum file is
//      pinned.
//   3. A download that redirects to a host other than GitHub's asset host is
//      followed.
//   4. An API answer that redirects, as GitHub does for a renamed or
//      transferred project, is followed.
//   5. An asset whose URL is outside the pinned owner and repository is
//      pinned.
//   6. A release under seven days old, or not newer than the pin, is taken.
//   7. A run that stops leaves toolchain.json changed or a changeset behind.
//   8. A good release is not pinned at the sha256 of its downloaded bytes, or
//      a file other than toolchain.json and one changeset changes.
//   9. --proposal, the sha256 the workflow compares between the job that ran
//      the gate and the job that opens the pull request, misses a change to
//      a file the bump wrote.
// Added after the code review:
//  10. A release whose project publishes a checksum file is pinned on that
//      file alone, without GitHub's digest; or the run does not say whether
//      the project published one.
//  11. An asset past the size limit is read to its end before the limit
//      stops it.
//  12. With --locks (the job that opens the pull request), a PyPI pin starts
//      uv, or takes lock files whose sha256 differs from the one the gate
//      job recorded, or that name a hash PyPI does not publish.
// Added after the second code review:
//  13. A lock is taken whose packages are not exactly the dependency tree of
//      the pinned tool, as the registry declares it for that platform and
//      Python: an extra package with a real hash, a missing dependency, or a
//      dependency at a version its requirement rules out. PyPI and RubyGems.
//  14. A lock that pins one package twice, or whose hash lines run into the
//      next requirement, is taken, or the file written is the raw text and
//      not the checked structure.
// Added with kubeconform:
//  15. A release checksum file named CHECKSUMS, as kubeconform publishes it,
//      is not read, so its sums are never checked against the bytes.
// Added with FreeBSD:
//  16. A bump rewrites a FreeBSD download like the other downloads, or writes
//      a system asset as if it were a download.
//  17. A bump whose FreeBSD download the new release does not publish is
//      refused with a plain message, or writes a URL that is not there.
//  18. The report does not say what a tool has on FreeBSD, so a person
//      cannot tell a system asset from a download there.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeTempDirs, tempDir } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

const here = dirname(fileURLToPath(import.meta.url));
const runner = join(here, "pin-bump-runner.mjs");
const PLATFORMS = { "darwin-arm64": "darwin_arm64", "darwin-x64": "darwin_amd64", "linux-x64": "linux_amd64", "linux-arm64": "linux_arm64" } as const;
// The platforms the fixture's release publishes a download for: the four the
// table has always had, and FreeBSD on amd64.
const RELEASES = { ...PLATFORMS, "freebsd-x64": "freebsd_amd64" } as const;
// The FreeBSD system asset of the fixture: a program the host's package
// manager installs. A bump leaves it as it is.
const SYSTEM = { system: { package: "demo", path: "bin/demo", versionArgs: ["--version"], versionPattern: "^demo (\\d+\\.\\d+\\.\\d+)$" }, version: "1.2.3" };
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const DAY = 24 * 60 * 60 * 1000;

type Release = {
  tag: string;
  noDigest?: boolean;
  // Bytes streamed for one asset instead of `bytes`, in 64 KiB chunks.
  streamBytes?: number;
  ageDays: number;
  // Bytes served per asset name; `digest` overrides the digest the API gives.
  bytes: (name: string) => Buffer;
  digest?: (name: string) => string;
  checksums?: (names: string[]) => string;
  // The checksum file's name; demo_<version>_checksums.txt when not given.
  checksumsName?: string;
  // The name the release publishes the FreeBSD download under, when the
  // upstream names it differently from the other downloads.
  freebsdName?: (version: string) => string;
  assetUrlRepo?: string;
  redirectTo?: string;
  apiRedirect?: boolean;
};

let release: Release;
let origin = "";
let other = "";
const servers: Server[] = [];

function assetNames(version: string): string[] {
  return Object.entries(RELEASES).map(([platform, p]) => (platform === "freebsd-x64" && release.freebsdName ? release.freebsdName(version) : `demo_${version}_${p}.tar.gz`));
}

function sumsName(version: string): string {
  return release.checksumsName ?? `demo_${version}_checksums.txt`;
}

function handle(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? "/", origin);
  const version = release.tag.slice(1);
  if (url.pathname === "/repos/acme/demo/releases") {
    if (release.apiRedirect) {
      res.writeHead(301, { location: `${origin}/repositories/1/releases?per_page=100` }).end();
      return;
    }
    const names = assetNames(version);
    const assets = names.map((name) => ({
      name,
      digest: release.noDigest ? undefined : `sha256:${release.digest ? release.digest(name) : sha(release.bytes(name))}`,
      browser_download_url: `${origin}/${release.assetUrlRepo ?? "acme/demo"}/releases/download/${release.tag}/${name}`,
    }));
    if (release.checksums) {
      const file = sumsName(version);
      assets.push({ name: file, digest: `sha256:${sha(release.checksums(names))}`, browser_download_url: `${origin}/acme/demo/releases/download/${release.tag}/${file}` });
    }
    const published = new Date(Date.now() - release.ageDays * DAY).toISOString();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify([{ tag_name: release.tag, draft: false, prerelease: false, published_at: published, html_url: `${origin}/acme/demo/releases/tag/${release.tag}`, assets }]));
    return;
  }
  const download = /^\/[^/]+\/[^/]+\/releases\/download\/[^/]+\/([^/]+)$/.exec(url.pathname);
  if (download) {
    res.writeHead(302, { location: `${release.redirectTo ?? origin}/blob/${download[1]}` }).end();
    return;
  }
  const blob = /^\/blob\/([^/]+)$/.exec(url.pathname);
  if (blob && release.streamBytes !== undefined && blob[1] !== sumsName(version)) {
    // A large asset sent slowly; `sent` counts what left before the client
    // hung up.
    res.writeHead(200);
    const chunk = Buffer.alloc(64 * 1024, 1);
    const tick = setInterval(() => {
      if (res.destroyed || sent >= release.streamBytes!) {
        clearInterval(tick);
        res.end();
        return;
      }
      sent += chunk.length;
      res.write(chunk);
    }, 2);
    res.on("close", () => clearInterval(tick));
    return;
  }
  if (blob) {
    const name = blob[1]!;
    const names = assetNames(version);
    res.writeHead(200).end(name === sumsName(version) && release.checksums ? release.checksums(names) : release.bytes(name));
    return;
  }
  const day = (n: number) => new Date(Date.now() - n * DAY).toISOString();
  const pypi = /^\/pypi\/([^/]+)\/(?:([^/]+)\/)?json$/.exec(url.pathname);
  if (pypi) {
    const [, name, version] = pypi as unknown as [string, string, string | undefined];
    if (version === undefined) {
      res.writeHead(200).end(JSON.stringify({ releases: { "1.0.0": [{ upload_time_iso_8601: day(90) }], "2.0.0": [{ upload_time_iso_8601: day(30) }] } }));
    } else {
      const requires = PYPI_REQUIRES[`${name}==${version}`] ?? null;
      res.writeHead(200).end(JSON.stringify({ info: { requires_dist: requires }, urls: [{ digests: { sha256: sha(`${name}-${version}.whl`) } }] }));
    }
    return;
  }
  const versions = /^\/api\/v1\/versions\/([^/]+)\.json$/.exec(url.pathname);
  if (versions) {
    res.writeHead(200).end(JSON.stringify([
      { number: "2.0.0", platform: "ruby", prerelease: false, created_at: day(30), ruby_version: ">= 3.0.0" },
      { number: "1.0.0", platform: "ruby", prerelease: false, created_at: day(90), ruby_version: ">= 3.0.0" },
    ]));
    return;
  }
  const gem = /^\/api\/v2\/rubygems\/([^/]+)\/versions\/([^/]+)\.json$/.exec(url.pathname);
  if (gem) {
    const [, name, version] = gem as unknown as [string, string, string];
    res.writeHead(200).end(JSON.stringify({ sha: sha(`${name}-${version}.gem`), dependencies: { runtime: GEM_REQUIRES[`${name}@${version}`] ?? [] } }));
    return;
  }
  res.writeHead(404).end();
}

let sent = 0;

// The registries' declared dependencies, as PyPI's requires_dist and
// RubyGems' runtime dependencies give them.
const PYPI_REQUIRES: Record<string, string[] | null> = {
  "pydemo==2.0.0": ["dep>=1.0", 'winonly ; sys_platform == "win32"', 'speedup[fast]>=2 ; extra == "speed"'],
  "dep==1.2": ['leaf==3.0 ; python_version >= "3.8"'],
  "dep==0.9": ['leaf==3.0 ; python_version >= "3.8"'],
};
const GEM_REQUIRES: Record<string, { name: string; requirements: string }[]> = {
  "rbdemo@2.0.0": [{ name: "rdep", requirements: "~> 1.2" }],
};

const uvBlock = (name: string, version: string) => `${name}==${version} \\\n    --hash=sha256:${sha(`${name}-${version}.whl`)}\n`;
const gemLine = (name: string, version: string) => `${name} ${version} sha256:${sha(`${name}-${version}.gem`)}\n`;
const GEM_HEADER = "# rbdemo:2.0.0 for Ruby 3.0 or newer, made by scripts/lock-scanners.mjs\n";

async function listen(): Promise<string> {
  const server = createServer(handle);
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeAll(async () => {
  origin = await listen();
  other = await listen();
});
afterAll(() => {
  for (const s of servers) s.close();
});

// A repo root holding only the pinned table, with demo 1.0.0 in it. The table
// holds a FreeBSD download and a FreeBSD system asset, as the real table does.
function repoRoot(): { root: string; table: string; before: string } {
  const root = tempDir("oq-pin-bump-");
  mkdirSync(join(root, "packages", "scanners"), { recursive: true });
  mkdirSync(join(root, ".changeset"));
  const assets = Object.fromEntries(
    Object.entries(RELEASES).map(([platform, p]) => [
      platform,
      { name: `demo_1.0.0_${p}.tar.gz`, url: `https://example.invalid/demo_1.0.0_${p}.tar.gz`, sha256: "0".repeat(64), archive: "tar.gz", binaryPath: "demo" },
    ]),
  );
  assets["freebsd-arm64"] = SYSTEM;
  const text = `${JSON.stringify({ schema: 1, tools: { demo: { version: "1.0.0", method: "github-release", repo: "acme/demo", tag: "v1.0.0", binary: "demo", assets } } }, null, 2)}\n`;
  const table = join(root, "packages", "scanners", "toolchain.json");
  writeFileSync(table, text);
  return { root, table, before: text };
}

function files(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(dir, e.name), `${rel}${e.name}/`);
      else out.push(`${rel}${e.name}`);
    }
  };
  walk(root, "");
  return out.sort();
}

async function bump(root: string, args = ["--apply", "demo"], extra: Record<string, unknown> = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const options = { root, api: origin, web: origin, assetOrigins: [origin], pypi: origin, ...extra };
  const child = spawn(process.execPath, [runner, JSON.stringify(options), ...args], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
  child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
  const code = await new Promise<number | null>((done) => child.on("close", done));
  return { code, stdout, stderr };
}

const good = (): Release => ({
  tag: "v2.0.0",
  ageDays: 30,
  bytes: (name) => Buffer.from(`the real ${name}`),
  checksums: (names) => names.map((n) => `${sha(Buffer.from(`the real ${n}`))}  ${n}`).join("\n") + "\n",
});

describe("pin-bump stops on an artifact or a source it cannot trust, and changes nothing", () => {
  const cases: [string, () => Release, RegExp][] = [
    ["a tampered artifact: its bytes differ from the sha256 GitHub publishes (1)", () => ({ ...good(), checksums: undefined, bytes: (n) => Buffer.from(`tampered ${n}`), digest: (n) => sha(Buffer.from(`the real ${n}`)) }), /sha256/],
    ["bytes that differ from the project's own checksum file (2)", () => ({ ...good(), checksums: (names) => names.map((n) => `${"a".repeat(64)}  ${n}`).join("\n") + "\n" }), /checksum file/],
    ["a download that redirects to another host (3)", () => ({ ...good(), redirectTo: other }), /redirect/],
    ["an API answer that redirects, as for a renamed or transferred project (4)", () => ({ ...good(), apiRedirect: true }), /redirect/],
    ["an asset outside the pinned owner and repository (5)", () => ({ ...good(), assetUrlRepo: "mallory/demo" }), /outside/],
  ];
  for (const [name, make, reason] of cases) {
    it(name, async () => {
      release = make();
      const { root, table, before } = repoRoot();
      const r = await bump(root);
      expect(r.code, r.stderr).toBe(2);
      expect(r.stderr).toMatch(reason);
      expect(readFileSync(table, "utf8")).toBe(before);
      expect(files(root)).toEqual(["packages/scanners/toolchain.json"]);
    });
  }
});

describe("pin-bump takes only a release that is due (6)", () => {
  it("leaves the pin for a release under seven days old or not newer", async () => {
    for (const r of [{ ...good(), ageDays: 3 }, { ...good(), tag: "v1.0.0" }]) {
      release = r;
      const { root, table, before } = repoRoot();
      const out = await bump(root);
      expect(out.code, out.stderr).toBe(0);
      expect(readFileSync(table, "utf8")).toBe(before);
      expect(files(root)).toEqual(["packages/scanners/toolchain.json"]);
    }
  });
});

describe("pin-bump pins a good release (8)", () => {
  it("pins the sha256 of the downloaded bytes and writes only the table and one changeset", async () => {
    release = good();
    const { root, table } = repoRoot();
    const r = await bump(root);
    expect(r.code, r.stderr).toBe(0);
    const demo = JSON.parse(readFileSync(table, "utf8")).tools.demo;
    expect(demo).toMatchObject({ version: "2.0.0", tag: "v2.0.0", repo: "acme/demo" });
    expect(demo.assets["linux-x64"]).toEqual({
      name: "demo_2.0.0_linux_amd64.tar.gz",
      url: `${origin}/acme/demo/releases/download/v2.0.0/demo_2.0.0_linux_amd64.tar.gz`,
      sha256: sha(Buffer.from("the real demo_2.0.0_linux_amd64.tar.gz")),
      archive: "tar.gz",
      binaryPath: "demo",
    });
    expect(files(root)).toEqual([".changeset/pin-demo-2-0-0.md", "packages/scanners/toolchain.json"]);
  });
});

describe("a bump moves the FreeBSD pins too (16)", () => {
  it("rewrites a FreeBSD download like the other downloads and leaves a system asset as it is", async () => {
    release = good();
    const { root, table } = repoRoot();
    const r = await bump(root);
    expect(r.code, r.stderr).toBe(0);
    const demo = JSON.parse(readFileSync(table, "utf8")).tools.demo;
    expect(demo.assets["freebsd-x64"]).toEqual({
      name: "demo_2.0.0_freebsd_amd64.tar.gz",
      url: `${origin}/acme/demo/releases/download/v2.0.0/demo_2.0.0_freebsd_amd64.tar.gz`,
      sha256: sha(Buffer.from("the real demo_2.0.0_freebsd_amd64.tar.gz")),
      archive: "tar.gz",
      binaryPath: "demo",
    });
    expect(demo.assets["freebsd-arm64"]).toEqual(SYSTEM);
  });

  it("refuses a bump whose FreeBSD download the release does not publish, and changes nothing (17)", async () => {
    release = { ...good(), freebsdName: (version) => `demo_${version}_freebsd_amd64_v2.tar.gz` };
    const { root, table, before } = repoRoot();
    const r = await bump(root);
    expect(r.code, r.stderr).toBe(2);
    expect(r.stderr).toMatch(/freebsd-x64/);
    expect(r.stderr).toMatch(/pin it by hand/);
    expect(readFileSync(table, "utf8")).toBe(before);
    expect(files(root)).toEqual(["packages/scanners/toolchain.json"]);
  });

  it("says what a tool has on FreeBSD in the report (18)", async () => {
    release = good();
    const { root } = repoRoot();
    const r = await bump(root, ["--report"]);
    expect(r.code, r.stderr).toBe(0);
    const row = r.stdout.split("\n").find((l) => l.startsWith("| demo |"));
    expect(row, r.stdout).toBeDefined();
    expect(row).toContain("| x64 1.0.0; arm64 demo 1.2.3 |");
  });
});

describe("the proposal sha256 (9)", () => {
  it("covers the table and the changeset the bump wrote, and changes with either", async () => {
    release = good();
    const { root, table } = repoRoot();
    expect((await bump(root)).code).toBe(0);
    const first = await bump(root, ["--proposal", "demo"]);
    expect(first.code, first.stderr).toBe(0);
    expect(first.stdout.trim()).toMatch(/^[0-9a-f]{64}$/);
    expect((await bump(root, ["--proposal", "demo"])).stdout).toBe(first.stdout);
    writeFileSync(table, readFileSync(table, "utf8").replace("acme/demo", "acme/other"));
    expect((await bump(root, ["--proposal", "demo"])).stdout).not.toBe(first.stdout);
    const changeset = join(root, ".changeset", "pin-demo-2-0-0.md");
    writeFileSync(table, readFileSync(table, "utf8").replace("acme/other", "acme/demo"));
    expect((await bump(root, ["--proposal", "demo"])).stdout).toBe(first.stdout);
    writeFileSync(changeset, `${readFileSync(changeset, "utf8")}x`);
    expect((await bump(root, ["--proposal", "demo"])).stdout).not.toBe(first.stdout);
  });
});

describe("what the code review found in pin-bump", () => {
  it("refuses a checksum file without GitHub's digest, and says which sums matched (10)", async () => {
    release = { ...good(), noDigest: true };
    const refused = repoRoot();
    const r = await bump(refused.root);
    expect(r.code, r.stderr).toBe(2);
    expect(r.stderr).toMatch(/GitHub publishes no sha256/);
    expect(readFileSync(refused.table, "utf8")).toBe(refused.before);

    release = good();
    expect((await bump(repoRoot().root)).stdout).toMatch(/^sums=checksum-file-and-digest$/m);
    release = { ...good(), checksums: undefined };
    expect((await bump(repoRoot().root)).stdout).toMatch(/^sums=digest-only$/m);
  });

  it("reads a checksum file named CHECKSUMS and refuses bytes it disagrees with (15)", async () => {
    release = { ...good(), checksumsName: "CHECKSUMS", checksums: (names) => names.map((n) => `${"a".repeat(64)}  ${n}`).join("\n") + "\n" };
    const refused = repoRoot();
    const r = await bump(refused.root);
    expect(r.code, r.stderr).toBe(2);
    expect(r.stderr).toMatch(/the checksum file says/);
    expect(readFileSync(refused.table, "utf8")).toBe(refused.before);

    release = { ...good(), checksumsName: "CHECKSUMS" };
    expect((await bump(repoRoot().root)).stdout).toMatch(/^sums=checksum-file-and-digest$/m);
  });

  it("stops reading an asset at the size limit instead of after it (11)", async () => {
    sent = 0;
    release = { ...good(), checksums: undefined, streamBytes: 64 * 1024 * 1024 };
    const { root, table, before } = repoRoot();
    const r = await bump(root, ["--apply", "demo"], { maxAssetBytes: 1024 * 1024 });
    expect(r.code, r.stderr).toBe(2);
    expect(r.stderr).toMatch(/larger than/);
    expect(sent).toBeLessThan(16 * 1024 * 1024);
    expect(readFileSync(table, "utf8")).toBe(before);
  });

  it("with --locks takes a PyPI pin's lock files only by the recorded sha256 and PyPI's hashes, and starts no uv (12)", async () => {
    const make = () => {
      const root = tempDir("oq-pin-bump-uv-");
      mkdirSync(join(root, "packages", "scanners", "locks"), { recursive: true });
      mkdirSync(join(root, ".changeset"));
      const table = join(root, "packages", "scanners", "toolchain.json");
      const before = `${JSON.stringify({ schema: 1, tools: { pydemo: { version: "1.0.0", method: "uv", package: "pydemo", python: "3.11", binary: "pydemo" } } }, null, 2)}\n`;
      writeFileSync(table, before);
      const given = tempDir("oq-locks-");
      return { root, table, before, given };
    };
    const lock = (hash: string) => `${uvBlock("dep", "1.2")}${uvBlock("leaf", "3.0")}pydemo==2.0.0 \\\n    --hash=sha256:${hash}\n`;
    const write = (given: string, text: string) => {
      for (const p of Object.keys(PLATFORMS)) writeFileSync(join(given, `pydemo-${p}.txt`), text);
    };
    const digest = (given: string) => {
      const h = createHash("sha256");
      for (const p of Object.keys(PLATFORMS).sort()) h.update(`pydemo-${p}.txt\0`).update(readFileSync(join(given, `pydemo-${p}.txt`))).update("\0");
      return h.digest("hex");
    };
    const apply = (root: string, given: string, recorded: string) => bump(root, ["--apply", "pydemo", "--locks", given, "--locks-sha256", recorded]);

    // Good: the recorded sha256 and every hash PyPI publishes. No uv exists here, so a uv start would fail.
    const ok = make();
    write(ok.given, lock(sha("pydemo-2.0.0.whl")));
    const r = await apply(ok.root, ok.given, digest(ok.given));
    expect(r.code, r.stderr).toBe(0);
    expect(readFileSync(join(ok.root, "packages", "scanners", "locks", "pydemo-linux-x64.txt"), "utf8")).toBe(lock(sha("pydemo-2.0.0.whl")));
    expect(JSON.parse(readFileSync(ok.table, "utf8")).tools.pydemo.version).toBe("2.0.0");

    // A sha256 other than the recorded one, and a hash PyPI does not publish.
    for (const [text, recorded] of [
      [lock(sha("pydemo-2.0.0.whl")), "0".repeat(64)],
      [lock("f".repeat(64)), null],
    ] as const) {
      const bad = make();
      write(bad.given, text);
      const out = await apply(bad.root, bad.given, recorded ?? digest(bad.given));
      expect(out.code, out.stderr).toBe(2);
      expect(readFileSync(bad.table, "utf8")).toBe(bad.before);
      expect(files(bad.root)).toEqual(["packages/scanners/toolchain.json"]);
    }
  });
});

// A repo with one registry pin at 1.0.0, and a folder of lock files for it.
function registryRoot(tool: string, recipe: Record<string, unknown>) {
  const root = tempDir("oq-pin-bump-reg-");
  mkdirSync(join(root, "packages", "scanners", "locks"), { recursive: true });
  mkdirSync(join(root, ".changeset"));
  const table = join(root, "packages", "scanners", "toolchain.json");
  const before = `${JSON.stringify({ schema: 1, tools: { [tool]: recipe } }, null, 2)}\n`;
  writeFileSync(table, before);
  const given = tempDir("oq-locks-");
  return { root, table, before, given };
}

async function applyWithLocks(tool: string, recipe: Record<string, unknown>, text: string) {
  const r = registryRoot(tool, recipe);
  for (const p of Object.keys(PLATFORMS)) writeFileSync(join(r.given, `${tool}-${p}.txt`), text);
  const h = createHash("sha256");
  for (const p of Object.keys(PLATFORMS).sort()) h.update(`${tool}-${p}.txt\0`).update(readFileSync(join(r.given, `${tool}-${p}.txt`))).update("\0");
  const out = await bump(r.root, ["--apply", tool, "--locks", r.given, "--locks-sha256", h.digest("hex")], { rubygems: origin });
  return { ...r, out };
}

const PY = { version: "1.0.0", method: "uv", package: "pydemo", python: "3.11", binary: "pydemo" };
const RB = { version: "1.0.0", method: "gem", gems: ["rbdemo:1.0.0"], needs: "ruby>=3.0", binary: "rbdemo" };

describe("a lock is exactly the pinned tool's dependency tree (13)", () => {
  it("takes a PyPI lock that holds the tree, markers and requirement versions included", async () => {
    const text = `${uvBlock("dep", "1.2")}${uvBlock("leaf", "3.0")}${uvBlock("pydemo", "2.0.0")}`;
    const r = await applyWithLocks("pydemo", PY, text);
    expect(r.out.code, r.out.stderr).toBe(0);
    expect(readFileSync(join(r.root, "packages", "scanners", "locks", "pydemo-linux-x64.txt"), "utf8")).toBe(text);
  });

  const pypiBad: [string, string, RegExp][] = [
    ["an extra package with a hash PyPI publishes", `${uvBlock("dep", "1.2")}${uvBlock("django", "5.0")}${uvBlock("leaf", "3.0")}${uvBlock("pydemo", "2.0.0")}`, /not in the dependency tree|django/],
    ["a missing dependency", `${uvBlock("dep", "1.2")}${uvBlock("pydemo", "2.0.0")}`, /leaf/],
    ["a dependency at a version its requirement rules out", `${uvBlock("dep", "0.9")}${uvBlock("leaf", "3.0")}${uvBlock("pydemo", "2.0.0")}`, /dep/],
  ];
  for (const [name, text, reason] of pypiBad) {
    it(`refuses a PyPI lock with ${name}`, async () => {
      const r = await applyWithLocks("pydemo", PY, text);
      expect(r.out.code, r.out.stderr).toBe(2);
      expect(r.out.stderr).toMatch(reason);
      expect(readFileSync(r.table, "utf8")).toBe(r.before);
      expect(files(r.root)).toEqual(["packages/scanners/toolchain.json"]);
    });
  }

  it("takes a RubyGems lock that holds the tree", async () => {
    const text = `${GEM_HEADER}${gemLine("rbdemo", "2.0.0")}${gemLine("rdep", "1.2.5")}`;
    const r = await applyWithLocks("rbdemo", RB, text);
    expect(r.out.code, r.out.stderr).toBe(0);
    expect(readFileSync(join(r.root, "packages", "scanners", "locks", "rbdemo-linux-x64.txt"), "utf8")).toBe(text);
  });

  const gemBad: [string, string][] = [
    ["an extra gem", `${GEM_HEADER}${gemLine("rbdemo", "2.0.0")}${gemLine("rdep", "1.2.5")}${gemLine("zzz", "1.0")}`],
    ["a missing dependency", `${GEM_HEADER}${gemLine("rbdemo", "2.0.0")}`],
    ["a dependency at a version its requirement rules out", `${GEM_HEADER}${gemLine("rbdemo", "2.0.0")}${gemLine("rdep", "2.0.0")}`],
  ];
  for (const [name, text] of gemBad) {
    it(`refuses a RubyGems lock with ${name}`, async () => {
      const r = await applyWithLocks("rbdemo", RB, text);
      expect(r.out.code, r.out.stderr).toBe(2);
      expect(readFileSync(r.table, "utf8")).toBe(r.before);
      expect(files(r.root)).toEqual(["packages/scanners/toolchain.json"]);
    });
  }
});

describe("a lock is read block by block and written from what was read (14)", () => {
  const bad: [string, string][] = [
    ["one package pinned twice", `${uvBlock("dep", "1.2")}${uvBlock("leaf", "3.0")}${uvBlock("pydemo", "2.0.0")}${uvBlock("Dep", "1.2")}`],
    ["hash lines that run into the next requirement", `${uvBlock("dep", "1.2").replace(/\n$/, " \\\n")}${uvBlock("leaf", "3.0")}${uvBlock("pydemo", "2.0.0")}`],
    ["a requirement with no hash", `dep==1.2\n${uvBlock("leaf", "3.0")}${uvBlock("pydemo", "2.0.0")}`],
  ];
  for (const [name, text] of bad) {
    it(`refuses ${name}`, async () => {
      const r = await applyWithLocks("pydemo", PY, text);
      expect(r.out.code, r.out.stderr).toBe(2);
      expect(readFileSync(r.table, "utf8")).toBe(r.before);
    });
  }

  it("writes the checked structure, not the raw text", async () => {
    // Blank lines between blocks read fine and are not written back.
    const text = `${uvBlock("dep", "1.2")}\n${uvBlock("leaf", "3.0")}\n${uvBlock("pydemo", "2.0.0")}`;
    const r = await applyWithLocks("pydemo", PY, text);
    expect(r.out.code, r.out.stderr).toBe(0);
    expect(readFileSync(join(r.root, "packages", "scanners", "locks", "pydemo-darwin-arm64.txt"), "utf8")).toBe(`${uvBlock("dep", "1.2")}${uvBlock("leaf", "3.0")}${uvBlock("pydemo", "2.0.0")}`);
  });
});
