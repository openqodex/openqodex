// Writes the lock files of the registry-installed scanners: one per scanner
// and platform in packages/scanners/locks/, each naming every package of the
// tool's dependency tree at an exact version with its sha256. The installer
// installs exactly what a lock names and checks each file against its hash,
// so two machines get the same tree whatever was published since.
//
//   node scripts/lock-scanners.mjs           every uv and gem recipe
//   node scripts/lock-scanners.mjs semgrep   one of them
//
// uv recipes (semgrep, bandit): `uv pip compile --generate-hashes` for each
// platform, wheels only, for the recipe's Python. gem recipes (brakeman,
// rubocop): the dependency tree resolved from the RubyGems API, each gem the
// newest release that meets every requirement on it and runs on the recipe's
// lowest Ruby; its sha256 is the one RubyGems publishes, checked against the
// downloaded .gem. uv takes each wheel's sha256 from PyPI's index, and the
// installer checks every download against it. Uses the uv pinned in the
// table, downloaded and checked against its sha256 (or the file $UV names),
// and the network; reads nothing from any repository under review.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const locks = join(root, "packages", "scanners", "locks");
// The most a registry answer (PyPI or RubyGems metadata) may hold; past it the
// answer is given up, connection and all.
export const MAX_METADATA_BYTES = 16 * 1024 * 1024;
const MAX_GEM_BYTES = 64 * 1024 * 1024;
const MAX_UV_BYTES = 200 * 1024 * 1024;
const readTable = () => JSON.parse(readFileSync(join(root, "packages", "scanners", "toolchain.json"), "utf8"));
// The platforms a lock file is written for. FreeBSD is not one of them: no
// uv or gem recipe supports FreeBSD, so no wheel or gem is locked there.
const PLATFORMS = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-x64": "x86_64-unknown-linux-gnu",
  "linux-arm64": "aarch64-unknown-linux-gnu",
};


function uvLock(uv, recipe, triple, file) {
  const dir = mkdtempSync(join(tmpdir(), "openqodex-lock-"));
  try {
    const input = join(dir, "requirements.in");
    writeFileSync(input, [`${recipe.package}==${recipe.version}`, ...(recipe.with ?? [])].join("\n") + "\n");
    execFileSync(
      uv,
      ["pip", "compile", "--quiet", "--generate-hashes", "--no-header", "--no-annotate", "--python-version", recipe.python, "--python-platform", triple, "--only-binary", ":all:", "--index-url", "https://pypi.org/simple", input, "-o", file],
      { stdio: ["ignore", "inherit", "inherit"] },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The uv the table pins, for this machine: its GitHub release asset,
// downloaded (redirects only to GitHub's asset hosts) and checked against the
// pinned sha256 before it is unpacked. Returns the path of the binary.
async function pinnedUv(table) {
  // The table pins uv for darwin and linux only: a FreeBSD host has no uv
  // download to take, so it must name one with UV=<file>.
  const platform = { "darwin:arm64": "darwin-arm64", "darwin:x64": "darwin-x64", "linux:x64": "linux-x64", "linux:arm64": "linux-arm64" }[`${process.platform}:${process.arch}`];
  const asset = platform ? table.tools.uv?.assets?.[platform] : null;
  if (!asset) throw new Error("no pinned uv for this machine; name one with UV=<file>");
  const origins = ["https://github.com", "https://release-assets.githubusercontent.com", "https://objects.githubusercontent.com"];
  let url = asset.url;
  let bytes = null;
  for (let hop = 0; hop <= 5 && bytes === null; hop++) {
    if (!origins.includes(new URL(url).origin)) throw new Error(`refusing to download uv from ${new URL(url).origin}`);
    const response = await fetch(url, { redirect: "manual" });
    if (response.status >= 300 && response.status < 400) url = new URL(response.headers.get("location") ?? "", url).href;
    else if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    else bytes = await readCapped(response, url, MAX_UV_BYTES);
  }
  if (bytes === null) throw new Error(`${asset.url}: too many redirects`);
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== asset.sha256) throw new Error(`uv: the download has sha256 ${actual}, the table pins ${asset.sha256}`);
  const dir = mkdtempSync(join(tmpdir(), "openqodex-uv-"));
  writeFileSync(join(dir, asset.name), bytes);
  execFileSync("tar", ["-xzf", join(dir, asset.name), "-C", dir, "--no-same-owner"]);
  const bin = join(dir, asset.binaryPath);
  chmodSync(bin, 0o755);
  return bin;
}

// ---------- gems ----------

// A download's bytes, read as they arrive and given up, connection and all,
// the moment they pass `maxBytes`.
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
      throw new Error(`${url}: larger than ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
}

// A registry answer, read within MAX_METADATA_BYTES and then parsed, never
// through a redirect: a moved source is not followed.
export async function fetchMetadata(url, maxBytes = MAX_METADATA_BYTES) {
  const response = await fetch(url, { redirect: "manual" });
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`${url}: answered with a redirect; a moved source is not followed`);
  }
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return JSON.parse((await readCapped(response, url, maxBytes)).toString("utf8"));
}
const json = (url) => fetchMetadata(url);

// The sha256 of a gem, computed from the downloaded .gem itself, which must
// equal the sha256 RubyGems publishes for it.
async function checkGem(gem, version, published) {
  const url = `https://rubygems.org/downloads/${encodeURIComponent(gem)}-${version}.gem`;
  const response = await fetch(url, { redirect: "manual" });
  if (response.status >= 300 && response.status < 400) throw new Error(`${url}: answered with a redirect; a moved source is not followed`);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const actual = createHash("sha256").update(await readCapped(response, url, MAX_GEM_BYTES)).digest("hex");
  if (actual !== published) throw new Error(`${gem} ${version}: the .gem has sha256 ${actual}, RubyGems publishes ${published}`);
}

// Gem::Version order for release versions: numeric segments compared as
// numbers. A version with a letter is a prerelease and never chosen.
const isRelease = (v) => /^\d+(\.\d+)*$/.test(v);
function compare(a, b) {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

// One requirement such as "~> 2.3", ">= 1.10, < 2.0" or "= 7.1.3".
function satisfies(version, requirement) {
  return requirement.split(",").every((part) => {
    const t = part.trim();
    const op = ["~>", ">=", "<=", "!=", ">", "<", "="].find((o) => t.startsWith(o)) ?? "=";
    const want = t.startsWith(op) ? t.slice(op.length).trim() : t;
    if (!isRelease(want)) throw new Error(`cannot read the requirement "${requirement}"`);
    const c = compare(version, want);
    if (op === "=") return c === 0;
    if (op === "!=") return c !== 0;
    if (op === ">=") return c >= 0;
    if (op === ">") return c > 0;
    if (op === "<=") return c <= 0;
    if (op === "<") return c < 0;
    // ~> 2.3 is >= 2.3 and < 3; ~> 2.3.1 is >= 2.3.1 and < 2.4.
    const parts = want.split(".").map(Number);
    const upper = parts.length > 1 ? [...parts.slice(0, -2), parts[parts.length - 2] + 1].join(".") : `${parts[0] + 1}`;
    return c >= 0 && compare(version, upper) < 0;
  });
}

async function gemLock(name, recipe) {
  const ruby = /^ruby>=([0-9.]+)$/.exec(recipe.needs ?? "")?.[1];
  if (!ruby) throw new Error(`${name}: needs must name the lowest Ruby, such as ruby>=3.0`);
  const releases = new Map();
  const releasesOf = async (gem) => {
    if (!releases.has(gem)) {
      const all = await json(`https://rubygems.org/api/v1/versions/${encodeURIComponent(gem)}.json`);
      releases.set(gem, all.filter((r) => r.platform === "ruby" && isRelease(r.number) && satisfies(ruby, r.ruby_version ?? ">= 0")));
    }
    return releases.get(gem);
  };
  const deps = new Map();
  const depsOf = async (gem, version) => {
    const key = `${gem}@${version}`;
    if (!deps.has(key)) {
      const info = await json(`https://rubygems.org/api/v2/rubygems/${encodeURIComponent(gem)}/versions/${version}.json?platform=ruby`);
      deps.set(key, (info.dependencies?.runtime ?? []).map((d) => ({ name: d.name, requirement: d.requirements })));
    }
    return deps.get(key);
  };

  // gem -> (who asked -> requirement), and the version chosen for each gem.
  const asks = new Map();
  const chosen = new Map();
  const ask = (gem, from, requirement) => {
    if (!asks.has(gem)) asks.set(gem, new Map());
    asks.get(gem).set(from, requirement);
  };
  for (const spec of recipe.gems) {
    const [gem, version] = spec.split(":");
    ask(gem, "toolchain.json", `= ${version}`);
  }
  for (let round = 0; ; round++) {
    if (round > 200) throw new Error(`${name}: the gem tree did not settle`);
    let changed = false;
    // A snapshot: choosing a gem adds the requirements of its dependencies.
    for (const [gem, from] of Array.from(asks)) {
      const requirements = [...from.values()];
      const fits = (await releasesOf(gem)).filter((r) => requirements.every((q) => satisfies(r.number, q))).sort((a, b) => compare(b.number, a.number));
      if (fits.length === 0) throw new Error(`${name}: no release of ${gem} meets ${requirements.join(" and ")} on Ruby ${ruby}`);
      const best = fits[0];
      const before = chosen.get(gem);
      if (before?.number === best.number) continue;
      changed = true;
      // The old choice's requirements on others no longer stand.
      if (before) for (const m of asks.values()) m.delete(`${gem}@${before.number}`);
      chosen.set(gem, best);
      for (const d of await depsOf(gem, best.number)) ask(d.name, `${gem}@${best.number}`, d.requirement);
    }
    // A gem nobody asks for any more leaves the tree.
    for (const [gem, from] of Array.from(asks)) {
      if (from.size === 0) {
        asks.delete(gem);
        const old = chosen.get(gem);
        if (old) for (const m of asks.values()) m.delete(`${gem}@${old.number}`);
        chosen.delete(gem);
        changed = true;
      }
    }
    if (!changed) break;
  }
  for (const [gem, r] of chosen) await checkGem(gem, r.number, r.sha);
  const lines = [...chosen].sort(([a], [b]) => (a < b ? -1 : 1)).map(([gem, r]) => `${gem} ${r.number} sha256:${r.sha}`);
  return [`# ${recipe.gems.join(" ")} for Ruby ${ruby} or newer, made by scripts/lock-scanners.mjs`, ...lines, ""].join("\n");
}

async function main(wanted) {
  const table = readTable();
  const tools = Object.entries(table.tools).filter(([name, r]) => (r.method === "uv" || r.method === "gem") && (wanted.length === 0 || wanted.includes(name)));
  if (wanted.length > 0 && tools.length !== wanted.length) {
    process.stderr.write(`usage: node scripts/lock-scanners.mjs [${Object.entries(table.tools).filter(([, r]) => r.method === "uv" || r.method === "gem").map(([n]) => n).join("|")}]...\n`);
    return 2;
  }
  mkdirSync(locks, { recursive: true });
  const uv = tools.some(([, r]) => r.method === "uv") ? (process.env.UV ?? (await pinnedUv(table))) : null;
  for (const [name, recipe] of tools) {
    const text = recipe.method === "uv" ? null : await gemLock(name, recipe);
    for (const [platform, triple] of Object.entries(PLATFORMS)) {
      const file = join(locks, `${name}-${platform}.txt`);
      if (recipe.method === "uv") uvLock(uv, recipe, triple, file);
      else writeFileSync(file, text);
      const packages = readFileSync(file, "utf8").split("\n").filter((l) => l !== "" && !l.startsWith(" ") && !l.startsWith("#")).length;
      process.stdout.write(`${name} ${platform}: ${packages} packages\n`);
    }
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
