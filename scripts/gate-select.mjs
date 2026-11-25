// Which unit tests the fast gate (scripts/gate-fast.sh) runs for a change.
//
// A change under packages/<p>/ changes the code of p and of every package
// that depends on p, read from the workspace dependencies in
// packages/*/package.json (cli, scanners and review import @openqodex/core
// through its build, so a core change reaches them). The tests to run are
// those packages' own tests plus the tests elsewhere that read their files
// directly: a test in packages/core that runs packages/cli/dist/bin.js, or
// benchmark/test, which imports packages/review/dist. A path anywhere else
// (root config, the lockfile, tests/, benchmark/, scripts/, .github/), a
// missing or unrelated origin/main, or an empty change runs the whole suite,
// and so does a change that reaches every package.
//
// Run as a script it prints why on stderr and, on stdout, either "all" or
// the vitest filters, one per line.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BENCHMARK_TESTS = "benchmark/test";
// A test file of one package naming another package's folder: ../../cli/.
const UP_TWO = /\.\.\/\.\.\/([\w-]+)\//g;

// The dependency map of the repository at root: for each package folder
// name, `uses` (the package folders its code depends on) and `readBy` (the
// test folders outside it whose files name its files by path).
export function dependencyMap(root) {
  const dirs = readdirSync(join(root, "packages")).filter((d) => existsSync(join(root, "packages", d, "package.json")));
  const byName = new Map(dirs.map((d) => [JSON.parse(readFileSync(join(root, "packages", d, "package.json"), "utf8")).name, d]));
  const map = {};
  for (const d of dirs) {
    const pkg = JSON.parse(readFileSync(join(root, "packages", d, "package.json"), "utf8"));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
    map[d] = { uses: Object.keys(deps).filter((n) => String(deps[n]).startsWith("workspace:") && byName.has(n)).map((n) => byName.get(n)), readBy: [] };
  }
  const readers = (folder, pattern, kind) => {
    const files = listFiles(join(root, folder)).filter((f) => kind.test(f));
    const named = new Set();
    for (const f of files) for (const m of readFileSync(f, "utf8").matchAll(pattern)) if (m[1] in map) named.add(m[1]);
    return named;
  };
  for (const d of dirs) {
    const named = new Set([...readers(join("packages", d, "src"), UP_TWO, /\.test\.ts$/), ...readers(join("packages", d, "test"), UP_TWO, /\.(ts|mjs)$/)]);
    for (const n of named) if (n !== d) map[n].readBy.push(`packages/${d}`);
  }
  for (const n of readers(BENCHMARK_TESTS, /packages\/([\w-]+)\//g, /\.mjs$/)) map[n].readBy.push(BENCHMARK_TESTS);
  return map;
}

function listFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((p) => !p.split("/").includes("node_modules") && !p.split("/").includes("fixtures")).map((p) => join(dir, p));
}

// paths: the changed paths, relative to the repository. map: dependencyMap's
// shape. Returns { all: true, reason } or { all: false, filters, reason }.
export function select(paths, map) {
  if (paths.length === 0) return { all: true, reason: "no changed path was found" };
  const changed = new Set();
  for (const p of paths) {
    const m = /^packages\/([^/]+)\/./.exec(p);
    if (m === null || !(m[1] in map)) return { all: true, reason: `${p} is outside the packages` };
    changed.add(m[1]);
  }
  // Every package whose code the change reaches, through the dependents.
  const reached = new Set(changed);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [d, { uses }] of Object.entries(map)) {
      if (!reached.has(d) && uses.some((u) => reached.has(u))) { reached.add(d); grew = true; }
    }
  }
  if (reached.size === Object.keys(map).length) return { all: true, reason: `the change to ${[...changed].sort().join(", ")} reaches every package` };
  const filters = new Set([...reached].map((d) => `packages/${d}`));
  for (const d of reached) for (const r of map[d].readBy) filters.add(r);
  const sorted = [...filters].sort();
  const via = [...reached].filter((d) => !changed.has(d)).sort();
  const readers = sorted.filter((f) => ![...reached].some((d) => f === `packages/${d}`));
  const reason = [`changed: ${[...changed].sort().join(", ")}`, via.length > 0 ? `their dependents: ${via.join(", ")}` : null, readers.length > 0 ? `tests that read them: ${readers.join(", ")}` : null].filter(Boolean).join("; ");
  return { all: false, filters: sorted, reason };
}

function git(root, ...args) {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  return r.status === 0 ? r.stdout : null;
}

// The changed paths of this checkout against origin/main: committed since
// the merge base, staged, unstaged and untracked. Renames count as a
// deletion and an addition, so both names are in the list. Null with a
// reason when origin/main cannot be compared.
export function changedPaths(root) {
  if (git(root, "rev-parse", "--verify", "--quiet", "origin/main") === null) return { paths: null, reason: "origin/main is missing (git fetch origin main)" };
  if (git(root, "merge-base", "origin/main", "HEAD") === null) return { paths: null, reason: "origin/main shares no history with HEAD (git fetch origin main)" };
  const lists = [
    git(root, "diff", "--name-only", "--no-renames", "origin/main...HEAD"),
    git(root, "diff", "--name-only", "--no-renames", "--cached"),
    git(root, "diff", "--name-only", "--no-renames"),
    git(root, "ls-files", "--others", "--exclude-standard"),
  ];
  if (lists.includes(null)) return { paths: null, reason: "git could not list the changed paths" };
  return { paths: [...new Set(lists.join("\n").split("\n").filter(Boolean))].sort(), reason: null };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const changed = changedPaths(root);
  const result = changed.paths === null ? { all: true, reason: changed.reason } : select(changed.paths, dependencyMap(root));
  if (changed.paths !== null) process.stderr.write(`gate-select: ${changed.paths.length} changed path${changed.paths.length === 1 ? "" : "s"} against origin/main\n`);
  process.stderr.write(result.all ? `gate-select: the whole unit suite, because ${result.reason}\n` : `gate-select: ${result.filters.join(" ")} (${result.reason})\n`);
  process.stdout.write(result.all ? "all\n" : `${result.filters.join("\n")}\n`);
}
