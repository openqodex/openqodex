// A pull request case into the repository a review reads (PLAN-benchmark
// 4.6), through a clone cache under $OPENQODEX_BENCH_CACHE (default
// ~/.cache/openqodex-bench):
//
//   repos/<owner>__<name>.commits.git
//                               bare, shallow and commits only (a partial
//                               clone without trees or files): the history
//                               finding each merge base took
//   repos/<owner>__<name>.git   bare and shallow: each case's merge base and
//                               head with their whole trees, nothing else,
//                               each kept by a ref refs/openqodex/<sha>
//   cases/<case hash>.git       bare and complete: two commits, B with the
//                               merge base's tree and H with the head's tree,
//                               and materialised.json, which records both
//                               and the upstream commits and trees they copy
//
// How the cache grows: a tree fetch sends every commit the tree cache holds
// as a have, so the server sends only the objects the new tree does not
// share with those commits' trees. A repository's tree cache holds one whole
// tree and then each later commit's changes, and each case repository holds
// one tree (B and H share every file the pull request leaves alone): n cases
// of one repository keep about n + 1 trees, where they kept about 3n.
//
// Each attempt then clones the case repository into its own folder:
//   laptop  B committed, the head's files in the working tree as the
//           uncommitted change (new files untracked, deleted files deleted),
//           the shape a developer has before a push and the planted shape
//   server  B then H as two commits, for reviewChange({ clonePath,
//           mergeBaseSha: B, headSha: H })
//
// The merge base is git's merge base of the dataset's base commit and the
// head (AACR-Bench reviews `base...head`), worked out from the clone URL
// alone, on commits only: the commits cache fetches both tips deeper (64
// commits, then 128, and so on) until the merge base is found and every
// commit between it and either tip is present. Only the merge base and the
// head are then fetched with their trees. A merge base frozen in the entry
// must be one git finds. When git finds more than one, the entry must
// freeze one (the ingest's --freeze-merge-base freezes the first by
// MERGE_BASE_RULE: newest committer date, then the smaller commit id;
// docs/benchmark.md).
//
// Failure list, written before the code:
// 1. The built head differs from the pull request head, so AACR's lines
//    point at other code: B and H are commits of the upstream trees
//    themselves (commit-tree on the fetched tree ids), never files checked
//    out and added again, which line endings, filters, export-ignore,
//    ignore rules, modes, links and case-folding file systems all change.
//    Each attempt's repository turns off every attribute that rewrites file
//    bytes, so its files are the blobs' own bytes, and the laptop shape is
//    proved to show exactly H.
// 2. The target branch's tip is used as the base after the target moved:
//    B is the merge base, found by git and proved complete; a frozen merge
//    base git does not find, or more than one merge base with none frozen,
//    is refused, and the record names every merge base git found.
// 3. A shallow or partial clone reaches reviewChange: the case repository
//    is a fresh repository holding B, H and every object they name, copied
//    out of the shallow cache (no alternates, no promisor, not shallow).
// 4. The laptop shape loses a file the pull request deleted, added or only
//    changed in mode: after the reset, the tree a review sees (HEAD plus
//    every working tree change, untracked files included) must equal H's
//    tree, with the machine's global ignore file and line-ending settings
//    unable to reach it.
// 5. The server shape is not exactly B then H: the attempt clones the case
//    repository, whose only branch is H on B.
// 6. A case whose licence is not usable, or that is excluded, or held out,
//    is fetched: every refusal comes before the first git command.
// 7. A second call fetches or builds again: a case repository with its
//    record is used as it is, after a check of its two trees, and commits
//    already in the cache are never fetched again.
// 8. A pull request pushed over after the dataset was made is built from
//    its pull request ref's newer tip: a head the server no longer serves
//    is refused, saying where the ref points now, before any tree is
//    downloaded.
// 9. Finding the merge base downloads the trees and files of every commit
//    between the tips (FreeCAD#19411: 1.7 GB and counting), or never ends
//    because `fetch --deepen` leaves a commit GitHub reaches only by id at
//    depth 1: the search fetches commits only, with an absolute depth.
// 10. Two processes fetch into one cache repository at once and one fails
//    on git's own lock: each cache repository is taken by one process at a
//    time (a lock file naming the process; a dead process's lock is taken
//    over), and a case repository appears only by a rename once complete.
// 11. A clone URL that is not the named repository on its pull request's
//    host is fetched (user info such as https://github.com@attacker.example,
//    another host or path, plain http, a local path): the URL is parsed and
//    bound to the case's repository and its pull request link's host; a
//    file URL only when the caller asks (the tests).
// 12. A server that ignores the commits-only filter (git warns "filtering
//    not recognized by server" and sends trees and files) turns the commits
//    cache into a full clone: the warning refuses the case, and a mark in
//    that cache keeps refusing until a person moves it away.
// 13. A damaged case repository counts as built: the build runs a full
//    fsck, and the record holds its result beside the tree ids; a record
//    without it is refused, and verifyCaseRepo (materialise.mjs --check)
//    runs fsck again.
// 14. A checkout on a case-folding file system keeps one of two files whose
//    names differ only in case: both shapes prove the working tree holds
//    the head, and a refusal names the colliding paths.
// 15. A held-out case is built with no record: every build through any
//    entry point appends { at, caseId, argv1, cwd } to
//    <cache>/held-out-access.log first, and a line that cannot be written
//    refuses the build.
// 16. The ancestry proof answers "history unknown" and stops: a fetch at an
//    absolute depth also shortens history, so a later case of the same
//    repository can cut the path from an earlier head back to its merge
//    base, and a commits cache may have been moved away. mergeBaseAncestry
//    then deepens that repository's commits cache from the head (64
//    commits, then 128, and so on, up to the merge base search's bound),
//    and records the depths it fetched and the commits it added; at the
//    bound it answers unknown and says so.
// 17. The tree fetches send no haves, so the server sends each merge base's
//    and each head's whole tree again, and the cache keeps about three trees
//    per case (21 GB after 56 AACR cases; issue #160): every commit fetched
//    into the tree cache gets a ref, and a cache filled before the refs gets
//    one for each commit its shallow list names, before the next fetch.
// 18. Two machines freeze different merge bases for one case: when two merge
//    bases share a committer date, `git merge-base` alone picks one by the
//    shape of the history, which git does not promise. Every merge base is
//    listed with --all and ordered by MERGE_BASE_RULE (newest committer
//    date, then the smaller commit id); the first is the one frozen, and
//    the record keeps the ordered list and the rule.
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gitEnv } from "./cases.mjs";
import { checkGreptileChange, greptileEntryProblems } from "./greptile.mjs";
import { cacheRoot, licenceExclusion } from "./licence.mjs";
import { takeOverStale } from "./runner.mjs";

// How deep the first search for a merge base fetches; each later one
// fetches twice as deep.
export const DEPTH_FIRST = 64;
const LOCK_WAIT_MS = 30 * 60 * 1000;
const SHA = /^[0-9a-f]{40}$/;
const HASH = /^[0-9a-f]{64}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
// Left in the commits cache when its server ignored the commits-only
// filter; the cache is then never used until a person moves it away.
const FILTER_REFUSED = "openqodex-filter-refused";
const FSCK = "git fsck --no-dangling";
// How a case's merge bases are ordered, the first being the one the ingest
// freezes when there are several (docs/benchmark.md, "Two merge bases").
export const MERGE_BASE_RULE = "every merge base git merge-base --all finds, newest committer date first, then the smaller commit id first";

// Every attribute that makes a file's bytes in the working tree differ from
// its blob, turned off in each attempt's repository (.git/info/attributes
// wins over the repository's own .gitattributes).
export const BYTE_EXACT_ATTRIBUTES = "* -text !eol -ident -filter -working-tree-encoding\n";

const FLAGS = ["-c", "user.name=OpenQodex benchmark", "-c", "user.email=benchmark@openqodex.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-c", "core.autocrlf=false", "-c", "init.defaultBranch=main", "-c", "fetch.recurseSubmodules=false", "-c", "gc.auto=0"];

function g(dir, args, env = gitEnv()) {
  return execFileSync("git", [...FLAGS, ...args], { cwd: dir, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 30 }).trim();
}

// git's answer, or null when it exits non-zero.
function tryG(dir, args, env) {
  try {
    return g(dir, args, env);
  } catch {
    return null;
  }
}

// git's own words from a failed command, on one line.
const said = (error) => (`${error.stderr ?? ""}`.trim() || error.message).split("\n").map((l) => l.trim()).filter(Boolean).join("; ");

// Why this case may not be materialised here, or null. Nothing is fetched
// before this answers (failure 6).
// Why the case's clone URL may not be fetched, or null. It must be the
// named repository on the host the case's pull request link names: https,
// no user name or password, path /<owner>/<name> with or without .git, no
// query (failure 11). A file URL (a local upstream) only when the caller
// asks for it, as the tests do.
function cloneUrlRefusal(c, { allowFileUrl }) {
  const raw = c.materialise.cloneUrl;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return `the clone URL ${JSON.stringify(raw)} is not a URL`;
  }
  if (url.protocol === "file:") return allowFileUrl ? null : `the clone URL ${raw} is a local path, which only a test may use`;
  if (url.protocol !== "https:") return `the clone URL ${raw} is not https`;
  if (url.username !== "" || url.password !== "") return `the clone URL ${raw} carries a user name or password`;
  let host = null;
  try {
    host = new URL(c.source?.prUrl ?? "").host;
  } catch {
    // no pull request link
  }
  if (!host) return "the case names no pull request link, so the host its clone URL must be on is unknown";
  if (url.host !== host) return `the clone URL ${raw} is on ${url.host}, not on ${host}, where the pull request is`;
  if (url.search !== "" || url.hash !== "" || (url.pathname !== `/${c.source.repo}` && url.pathname !== `/${c.source.repo}.git`)) return `the clone URL ${raw} is not the repository ${c.source.repo}`;
  return null;
}

export function prRefusal(c, { heldOut = false, allowFileUrl = false } = {}) {
  const m = c?.materialise;
  if (m?.kind !== "pr") return `${c?.id ?? "the case"} is not a pull request case`;
  if (c.suite === "greptile") {
    const problems = greptileEntryProblems({ ...c, ...m, prUrl: c.source?.prUrl, repo: c.source?.repo });
    if (problems.length > 0) return `${c.id}: ${problems.join("; ")}`;
  }
  if (c.status !== "usable") return `${c.id} is excluded (${c.excludedWhy ?? "no reason recorded"}), so it is never fetched`;
  const licence = licenceExclusion(c.source?.licence ?? { class: "none" });
  if (licence !== null) return `${c.id}: ${licence}; it is never fetched`;
  if (c.split === "test" && !heldOut) return `${c.id} is held out: it is materialised only by a release run or by run.mjs --materialise-only, which log the access`;
  if (!REPO.test(c.source?.repo ?? "") || c.source.repo.includes("..")) return `${c.id}: the repository name ${JSON.stringify(c.source?.repo)} is not <owner>/<name>`;
  if (!HASH.test(c.hash ?? "")) return `${c.id}: the case hash ${JSON.stringify(c.hash)} is not a sha256`;
  const url = cloneUrlRefusal(c, { allowFileUrl });
  if (url !== null) return `${c.id}: ${url}`;
  if (!/^refs\/pull\/\d+\/head$/.test(m.prRef ?? "")) return `${c.id}: the pull request ref ${JSON.stringify(m.prRef)} is not refs/pull/<number>/head`;
  for (const k of ["baseSha", "headSha"]) if (!SHA.test(m[k] ?? "")) return `${c.id}: ${k} ${JSON.stringify(m[k])} is not a full commit id`;
  if (m.mergeBaseSha !== null && m.mergeBaseSha !== undefined && !SHA.test(m.mergeBaseSha)) return `${c.id}: mergeBaseSha ${JSON.stringify(m.mergeBaseSha)} is not a full commit id`;
  return null;
}

// ---------- one process per cache repository ----------

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function withLock(path, fn) {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      writeFileSync(path, `${process.pid}\n`, { flag: "wx" });
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const text = existsSync(path) ? readFileSync(path, "utf8").trim() : "";
    if (/^\d+$/.test(text) && !alive(Number(text)) && takeOverStale(path, Number(text))) continue;
    if (Date.now() > deadline) throw new Error(`${path} has been held by process ${text || "unknown"} for ${LOCK_WAIT_MS / 60000} minutes; if no materialise is running, move the lock to the Trash`);
    sleep(500);
  }
  try {
    return fn();
  } finally {
    if (existsSync(path) && readFileSync(path, "utf8").trim() === String(process.pid)) rmSync(path, { force: true });
  }
}

// ---------- the clone cache ----------

// The deepest search for a merge base; past this the case is refused.
const DEPTH_LAST = 1 << 20;

const shallowOf = (repo) => (existsSync(join(repo, "shallow")) ? readFileSync(join(repo, "shallow"), "utf8").split("\n").filter(Boolean).sort() : []);
const hasCommit = (repo, sha, env) => tryG(repo, ["cat-file", "-e", `${sha}^{commit}`], env) !== null;

// The commits cache never fetches a missing object by itself, which a
// partial clone otherwise does, one object at a time.
const commitsEnv = () => ({ ...gitEnv(), GIT_NO_LAZY_FETCH: "1" });

function initBare(repo, config = []) {
  if (existsSync(join(repo, "HEAD"))) return;
  mkdirSync(repo, { recursive: true });
  g(repo, ["init", "-q", "--bare"]);
  for (const [k, v] of config) g(repo, ["config", k, v]);
}

// The merge bases of the two tips, once proved: no commit between a merge
// base and either tip has its parents cut by the shallow cache, so no
// better common ancestor can be hiding behind a cut.
function provedMergeBases(repo, tips) {
  const env = commitsEnv();
  const bases = (tryG(repo, ["merge-base", "--all", ...tips], env) ?? "").split("\n").filter(Boolean).sort();
  if (bases.length === 0) return null;
  const shallow = new Set(shallowOf(repo));
  if (shallow.size === 0) return bases;
  const between = g(repo, ["rev-list", ...tips, "--not", ...bases], env).split("\n").filter(Boolean);
  return between.some((sha) => shallow.has(sha)) ? null : bases;
}

// repos/<owner>__<name>.commits.git, made when missing and pointed at the
// case's clone URL; refused while it carries the filter refusal mark.
function initCommitsCache(repo, c) {
  const { cloneUrl } = c.materialise;
  const env = commitsEnv();
  initBare(repo, [["core.repositoryformatversion", "1"], ["extensions.partialClone", "origin"], ["remote.origin.url", cloneUrl], ["remote.origin.promisor", "true"], ["remote.origin.partialclonefilter", "tree:0"]]);
  if (g(repo, ["config", "remote.origin.url"], env) !== cloneUrl) g(repo, ["config", "remote.origin.url", cloneUrl], env);
  const refused = join(repo, FILTER_REFUSED);
  if (existsSync(refused)) throw new Error(`${c.id}: ${readFileSync(refused, "utf8").trim()}`);
}

// Fetches `wants` into the commits cache, commits only. git only warns, and
// fetches everything, when the server ignores the filter (failure 12), so
// its words are read on success too.
function commitsFetch(repo, c, args, wants) {
  const { cloneUrl } = c.materialise;
  const r = spawnSync("git", [...FLAGS, "fetch", "-q", "--no-tags", "--no-recurse-submodules", "--filter=tree:0", ...args, "--end-of-options", "origin", ...wants], { cwd: repo, env: commitsEnv(), encoding: "utf8", maxBuffer: 1 << 30 });
  if (r.error) throw r.error;
  if (r.status !== 0) throw Object.assign(new Error(`git fetch exited ${r.status}`), { stderr: r.stderr });
  const warning = r.stderr.split("\n").find((l) => /filtering not recognized by server/i.test(l));
  if (warning) {
    const why = `${cloneUrl} ignored the commits-only filter (git: "${warning.trim()}") and sent trees and files, so ${repo} is no longer commits only; it is not used until a person moves it to the Trash`;
    writeFileSync(join(repo, FILTER_REFUSED), `${why}\n`);
    throw new Error(`${c.id}: ${why}`);
  }
}

// Fetches the head into the commits cache with `args`, by its id, or by its
// pull request ref when the server serves it only there and the ref's tip is
// still the head (failure 8). Returns what it was fetched by, which a later
// fetch passes back as `want`.
function fetchHead(repo, c, args, want = c.materialise.headSha) {
  const { cloneUrl, prRef, headSha } = c.materialise;
  if (want !== headSha) {
    commitsFetch(repo, c, args, [want]);
    return want;
  }
  try {
    commitsFetch(repo, c, args, [headSha]);
    return headSha;
  } catch (bySha) {
    if (existsSync(join(repo, FILTER_REFUSED))) throw bySha;
    const tip = (tryG(repo, ["ls-remote", "--end-of-options", cloneUrl, prRef], commitsEnv()) ?? "").split(/\s/)[0] || null;
    if (tip !== headSha) throw new Error(`${c.id}: the head ${headSha.slice(0, 12)} is gone from ${cloneUrl}: the server refuses it by id (${said(bySha)}), and ${prRef} ${tip ? `now points at ${tip.slice(0, 12)}, so the pull request was pushed over after the dataset was made` : "is not there"}`);
    commitsFetch(repo, c, args, [prRef]);
    return prRef;
  }
}

// Finds the case's merge bases in repos/<owner>__<name>.commits.git, which
// holds commits only. Returns { bases, headWant }, headWant being what the
// server gives the head by: its id, or its pull request ref.
function findMergeBases(repo, c) {
  const { cloneUrl, baseSha, headSha } = c.materialise;
  const env = commitsEnv();
  initCommitsCache(repo, c);
  const fetch = (args, wants) => commitsFetch(repo, c, args, wants);
  // The head first: when the server no longer has it, the case stops
  // before any tree is downloaded (failure 8).
  let headWant = headSha;
  if (!hasCommit(repo, headSha, env)) headWant = fetchHead(repo, c, ["--depth=1"]);
  if (!hasCommit(repo, baseSha, env)) {
    try {
      fetch(["--depth=1"], [baseSha]);
    } catch (error) {
      throw new Error(`${c.id}: the dataset's base ${baseSha.slice(0, 12)} cannot be fetched from ${cloneUrl}: ${said(error)}`);
    }
  }
  // An absolute depth, never --deepen: GitHub leaves a commit it reaches
  // only by id at depth 1 when asked to deepen it (failure 9).
  for (let depth = DEPTH_FIRST; ; depth *= 2) {
    const bases = provedMergeBases(repo, [baseSha, headSha]);
    if (bases !== null) return { bases, headWant };
    if (shallowOf(repo).length === 0) throw new Error(`${c.id}: ${baseSha.slice(0, 12)} and ${headSha.slice(0, 12)} share no history at ${cloneUrl}`);
    if (depth > DEPTH_LAST) throw new Error(`${c.id}: no merge base of ${baseSha.slice(0, 12)} and ${headSha.slice(0, 12)} is proved within ${DEPTH_LAST} commits of either at ${cloneUrl}`);
    try {
      fetch([`--depth=${depth}`], [baseSha, headWant]);
    } catch (error) {
      throw new Error(`${c.id}: fetching the history at ${cloneUrl} ${depth} commits deep to find the merge base failed: ${said(error)}`);
    }
  }
}

// The merge base the case is built on: git's only merge base, or the one
// the entry froze, which must be one git finds (failure 2).
function chosenMergeBase(c, bases) {
  const m = c.materialise;
  const list = bases.map((b) => b.slice(0, 12)).join(", ");
  if (m.mergeBaseSha && !bases.includes(m.mergeBaseSha)) throw new Error(`${c.id}: the frozen mergeBaseSha ${m.mergeBaseSha.slice(0, 12)} is not the merge base of ${m.baseSha.slice(0, 12)} and ${m.headSha.slice(0, 12)}; git finds ${list}`);
  if (!m.mergeBaseSha && bases.length > 1) throw new Error(`${c.id}: ${m.baseSha.slice(0, 12)} and ${m.headSha.slice(0, 12)} have ${bases.length} merge bases (${list}); the suite entry must freeze one: node benchmark/ingest/${c.suite}.mjs --freeze-merge-base ${c.name}`);
  return m.mergeBaseSha ?? bases[0];
}

// The merge bases in MERGE_BASE_RULE's order, read from the commits cache:
// newest committer date first, then the smaller commit id. `git
// merge-base` alone prints the newest too, but on a tie it picks by the
// shape of the history, which git does not promise (failure 18).
function orderedMergeBases(repo, bases) {
  if (bases.length < 2) return bases;
  const dates = new Map(g(repo, ["log", "--no-walk=unsorted", "--format=%H %ct", ...bases], commitsEnv()).split("\n").filter(Boolean).map((l) => [l.split(" ")[0], Number(l.split(" ")[1])]));
  for (const b of bases) if (!Number.isInteger(dates.get(b))) throw new Error(`the commits cache ${repo} gives no committer date for the merge base ${b.slice(0, 12)}`);
  return [...bases].sort((a, b) => dates.get(b) - dates.get(a) || (a < b ? -1 : a > b ? 1 : 0));
}

// The merge bases git finds for a pull request case, on commits only (the
// search a build runs, failure 9), in MERGE_BASE_RULE's order, and `pick`,
// the first. The ingest freezes `pick` when there are several
// (lib/suites.mjs freezeMergeBase). No tree, file or truth is read, so a
// held-out case is not logged.
export function mergeBasesOf(c, { cache = cacheRoot(), allowFileUrl = false } = {}) {
  const why = prRefusal(c, { heldOut: true, allowFileUrl });
  if (why !== null) throw new Error(why);
  const repo = repoCachePath(cache, c, ".commits");
  mkdirSync(dirname(repo), { recursive: true });
  return withLock(`${repoCachePath(cache, c)}.lock`, () => {
    const bases = orderedMergeBases(repo, findMergeBases(repo, c).bases);
    return { bases, pick: bases[0] };
  });
}

// The ref that keeps a fetched commit in repos/<owner>__<name>.git, so each
// later fetch sends it as a have (failure 17).
const HAVE_REFS = "refs/openqodex/";

// Gives every commit the tree cache holds a ref, when it has none: a cache
// filled before the refs existed holds its commits only in its shallow list,
// where every commit fetched at depth 1 is named.
function refEveryCommit(repo) {
  const refs = new Set(g(repo, ["for-each-ref", "--format=%(objectname)", HAVE_REFS]).split("\n").filter(Boolean));
  const missing = shallowOf(repo).filter((sha) => SHA.test(sha) && !refs.has(sha) && hasCommit(repo, sha));
  if (missing.length > 0) execFileSync("git", [...FLAGS, "update-ref", "--stdin"], { cwd: repo, env: gitEnv(), input: missing.map((sha) => `update ${HAVE_REFS}${sha} ${sha}\n`).join(""), stdio: ["pipe", "ignore", "pipe"] });
}

// Fetches the merge base and the head with their whole trees into
// repos/<owner>__<name>.git, each at depth 1, unless they are there. Every
// commit there has a ref, so the fetch sends them all as haves and the
// server sends only the objects the new tree does not share with a tree
// already held (failure 17).
function fetchTrees(repo, c, mergeBaseSha, headWant) {
  const { cloneUrl, headSha } = c.materialise;
  initBare(repo);
  for (const [sha, want] of [[headSha, headWant], [mergeBaseSha, mergeBaseSha]]) {
    if (hasCommit(repo, sha)) continue;
    refEveryCommit(repo);
    try {
      g(repo, ["fetch", "-q", "--no-tags", "--no-recurse-submodules", "--depth=1", "--end-of-options", cloneUrl, want]);
    } catch (error) {
      throw new Error(`${c.id}: fetching ${sha.slice(0, 12)} with its files from ${cloneUrl} failed: ${said(error)}`);
    }
    if (!hasCommit(repo, sha)) throw new Error(`${c.id}: ${want} at ${cloneUrl} no longer gives ${sha.slice(0, 12)}`);
    g(repo, ["update-ref", `${HAVE_REFS}${sha}`, sha]);
  }
}

// ---------- the case repository ----------

const caseRepoPath = (cache, c) => join(cache, "cases", `${c.hash}.git`);
const repoCachePath = (cache, c, kind = "") => join(cache, "repos", `${c.source.repo.replace("/", "__")}${kind}.git`);

// The record of a built case repository, after a check that its two
// commits still hold the trees it names and that it is this case's.
function checkedRecord(path, c) {
  const record = JSON.parse(readFileSync(join(path, "materialised.json"), "utf8"));
  const problems = [];
  if (record.upstream?.headSha !== c.materialise.headSha || record.upstream?.baseSha !== c.materialise.baseSha) problems.push(`it was built from ${record.upstream?.baseSha?.slice(0, 12)}...${record.upstream?.headSha?.slice(0, 12)}, not this case's commits`);
  if (typeof record.fsck !== "string" || !record.fsck.startsWith(`${FSCK}: no problems`)) problems.push("its record holds no passed fsck, so the build never finished");
  if (tryG(path, ["rev-parse", `${record.head}^{tree}`]) !== record.headTree || tryG(path, ["rev-parse", `${record.base}^{tree}`]) !== record.baseTree) problems.push("its commits no longer hold the trees its record names");
  if (problems.length > 0) throw new Error(`${c.id}: the case repository ${path} is damaged: ${problems.join("; ")}. Move it to the Trash and materialise again`);
  return record;
}

// A full fsck of the case repository: every object read back and its id
// checked, every link followed. Throws with git's words.
function fsckCaseRepo(path) {
  const r = spawnSync("git", [...FLAGS, "fsck", "--no-dangling", "--no-progress"], { cwd: path, env: gitEnv(), encoding: "utf8", maxBuffer: 1 << 30 });
  if (r.error) throw r.error;
  const said = `${r.stdout}${r.stderr}`.trim();
  if (r.status !== 0 || said !== "") throw new Error(`${FSCK} in ${path} found problems: ${said.split("\n").slice(0, 5).join("; ") || `exit ${r.status}`}`);
  return `${FSCK}: no problems`;
}

// Checks a built case repository again (materialise.mjs --check): its
// record, its trees, and a full fsck. Returns the record.
export function verifyCaseRepo(c, { cache = cacheRoot(), heldOut = false, allowFileUrl = false } = {}) {
  const why = prRefusal(c, { heldOut, allowFileUrl });
  if (why !== null) throw new Error(why);
  const path = caseRepoPath(cache, c);
  if (!existsSync(join(path, "materialised.json"))) throw new Error(`${c.id}: no case repository is built at ${path}`);
  try {
    fsckCaseRepo(path);
  } catch (error) {
    throw new Error(`${c.id}: the case repository is damaged: ${error.message}. Move it to the Trash and materialise again`);
  }
  return checkedRecord(path, c);
}

// Builds cases/<case hash>.git from the cache: B and H are commits of the
// upstream merge base's and head's own trees, with the harness's fixed
// author and date, so their ids are fixed per case. The record names every
// merge base git found, in MERGE_BASE_RULE's order, and the rule, beside
// the one the case is built on.
function buildCaseRepo(cache, c, repo, mergeBaseSha, bases) {
  const m = c.materialise;
  const upstream = {
    cloneUrl: m.cloneUrl,
    baseSha: m.baseSha,
    headSha: m.headSha,
    mergeBaseSha,
    mergeBaseFrom: m.mergeBaseSha ? "entry" : "git",
    mergeBases: bases,
    mergeBaseRule: MERGE_BASE_RULE,
    mergeBaseTree: g(repo, ["rev-parse", `${mergeBaseSha}^{tree}`]),
    headTree: g(repo, ["rev-parse", `${m.headSha}^{tree}`]),
  };
  const final = caseRepoPath(cache, c);
  mkdirSync(dirname(final), { recursive: true });
  const temp = `${final}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    g(dirname(final), ["init", "-q", "--bare", temp]);
    writeFileSync(join(temp, "objects", "info", "alternates"), `${join(repo, "objects")}\n`);
    const base = g(temp, ["commit-tree", upstream.mergeBaseTree, "-m", "Base: the pull request's merge base"]);
    const head = g(temp, ["commit-tree", upstream.headTree, "-p", base, "-m", "Head: the pull request"]);
    g(temp, ["update-ref", "refs/heads/main", head]);
    g(temp, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    // Copy every object B and H name out of the cache, then cut the link.
    g(temp, ["repack", "-a", "-d", "-q"]);
    rmSync(join(temp, "objects", "info", "alternates"));
    const fsck = fsckCaseRepo(temp);
    const record = { v: 1, caseId: c.id, name: c.name, hash: c.hash, repo: c.source.repo, base, head, baseTree: g(temp, ["rev-parse", `${base}^{tree}`]), headTree: g(temp, ["rev-parse", `${head}^{tree}`]), fsck, upstream };
    if (record.baseTree !== upstream.mergeBaseTree || record.headTree !== upstream.headTree) throw new Error(`${c.id}: the built trees differ from upstream's (base ${record.baseTree} for ${upstream.mergeBaseTree}, head ${record.headTree} for ${upstream.headTree})`);
    writeFileSync(join(temp, "materialised.json"), `${JSON.stringify(record, null, 2)}\n`);
    renameSync(temp, final);
    return record;
  } finally {
    if (existsSync(temp)) rmSync(temp, { recursive: true, force: true });
  }
}

// Appends one line to <cache>/held-out-access.log for a held-out case,
// before anything is fetched or read; refuses when it cannot (failure 15).
function recordHeldOut(cache, c) {
  const line = `${JSON.stringify({ at: new Date().toISOString(), caseId: c.id, argv1: process.argv[1] ?? null, cwd: process.cwd() })}\n`;
  try {
    mkdirSync(cache, { recursive: true });
    appendFileSync(join(cache, "held-out-access.log"), line);
  } catch (error) {
    throw new Error(`${c.id} is held out, and its access cannot be recorded in ${join(cache, "held-out-access.log")} (${error.message}), so it is not built`);
  }
}

// The case repository of a pull request case, built once: { path, record,
// built }, built false when it was already there and nothing was fetched.
export function caseRepo(c, { cache = cacheRoot(), heldOut = false, allowFileUrl = false } = {}) {
  const why = prRefusal(c, { heldOut, allowFileUrl });
  if (why !== null) throw new Error(why);
  if (c.suite === "greptile") checkGreptileChange(c, cache);
  if (c.split === "test") recordHeldOut(cache, c);
  const path = caseRepoPath(cache, c);
  if (existsSync(join(path, "materialised.json"))) return { path, record: checkedRecord(path, c), built: false };
  const repo = repoCachePath(cache, c);
  mkdirSync(dirname(repo), { recursive: true });
  // One lock covers both cache repositories of the upstream repository.
  return withLock(`${repo}.lock`, () => {
    if (existsSync(join(path, "materialised.json"))) return { path, record: checkedRecord(path, c), built: false };
    const commits = repoCachePath(cache, c, ".commits");
    const found = findMergeBases(commits, c);
    const { headWant } = found;
    const bases = orderedMergeBases(commits, found.bases);
    const mergeBaseSha = chosenMergeBase(c, bases);
    fetchTrees(repo, c, mergeBaseSha, headWant);
    return { path, record: buildCaseRepo(cache, c, repo, mergeBaseSha, bases), built: true };
  });
}

// git's answer in the commits cache to "is the merge base an ancestor of
// the head": true; false when git says no on a history with no cut; or null
// when that history cannot answer (a missing commit, or a no on a shallow
// history, where the path may lie behind a cut).
function ancestryAnswer(repo, mergeBaseSha, headSha) {
  const r = spawnSync("git", [...FLAGS, "merge-base", "--is-ancestor", mergeBaseSha, headSha], { cwd: repo, env: commitsEnv(), encoding: "utf8" });
  if (r.status === 0) return { isAncestor: true, why: null };
  if (r.status === 1 && shallowOf(repo).length === 0) return { isAncestor: false, why: `git answers that ${mergeBaseSha.slice(0, 12)} is not an ancestor of ${headSha.slice(0, 12)}` };
  if (r.status === 1) return { isAncestor: null, why: "history unknown: the commits cache is shallow, and git found no path within it" };
  return { isAncestor: null, why: `history unknown: git merge-base --is-ancestor failed (${`${r.stderr ?? ""}`.trim().split("\n")[0] || `exit ${r.status}`})` };
}

// The number of objects in the commits cache, every one a commit.
const commitCount = (repo) => (tryG(repo, ["cat-file", "--batch-all-objects", "--unordered", "--batch-check=%(objectname)"], commitsEnv()) ?? "").split("\n").filter(Boolean).length;

// Deepens the commits cache from the head until git answers (failure 16):
// the head and the merge base by id when missing, then the head at
// `depthFirst` commits, twice as deep each time, up to `depthLast`.
function deepenForAncestry(repo, c, mergeBaseSha, { depthFirst, depthLast }) {
  const { headSha } = c.materialise;
  const env = commitsEnv();
  const depths = [];
  let before = null;
  const deepening = (answered) => ({ bound: depthLast, depths, commitsAdded: before === null ? 0 : commitCount(repo) - before, answered });
  try {
    initCommitsCache(repo, c);
    before = commitCount(repo);
    let headWant = headSha;
    if (!hasCommit(repo, headSha, env)) headWant = fetchHead(repo, c, ["--depth=1"]);
    if (!hasCommit(repo, mergeBaseSha, env)) commitsFetch(repo, c, ["--depth=1"], [mergeBaseSha]);
    let answer = ancestryAnswer(repo, mergeBaseSha, headSha);
    for (let depth = depthFirst; answer.isAncestor === null && depth <= depthLast; depth *= 2) {
      headWant = fetchHead(repo, c, [`--depth=${depth}`], headWant);
      depths.push(depth);
      answer = ancestryAnswer(repo, mergeBaseSha, headSha);
    }
    if (answer.isAncestor === null) return { isAncestor: null, why: `history unknown: git found no path from ${headSha.slice(0, 12)} back to ${mergeBaseSha.slice(0, 12)} after the commits cache was deepened to ${depthLast} commits from the head, its bound (${answer.why})`, deepening: deepening(false) };
    return { ...answer, deepening: deepening(true) };
  } catch (error) {
    return { isAncestor: null, why: `history unknown: deepening the commits cache failed: ${said(error)}`, deepening: deepening(false) };
  }
}

// Whether the case's merge base is an ancestor of its head, as git answers
// in the commits cache's history (run.mjs --materialise-only records it):
// { isAncestor, why, deepening }. isAncestor is true, false when git says
// no on a history with no cut, or null when the history cannot answer even
// after deepening. When git cannot answer at first, the commits cache of
// that repository only is deepened from the head (failure 16), up to
// `depthLast` commits (the merge base search's own bound by default), and
// `deepening` records { bound, depths, commitsAdded, answered }; it is null
// when git answered without a fetch.
export function mergeBaseAncestry(c, mergeBaseSha, { cache = cacheRoot(), allowFileUrl = false, depthFirst = DEPTH_FIRST, depthLast = DEPTH_LAST } = {}) {
  const repo = repoCachePath(cache, c, ".commits");
  if (existsSync(join(repo, "HEAD"))) {
    const answer = ancestryAnswer(repo, mergeBaseSha, c.materialise.headSha);
    if (answer.isAncestor !== null) return { ...answer, deepening: null };
  }
  const why = prRefusal(c, { heldOut: true, allowFileUrl });
  if (why !== null) return { isAncestor: null, why: `history unknown, and the commits cache is not deepened: ${why}`, deepening: null };
  mkdirSync(dirname(repo), { recursive: true });
  return withLock(`${repoCachePath(cache, c)}.lock`, () => deepenForAncestry(repo, c, mergeBaseSha, { depthFirst, depthLast }));
}

// ---------- one attempt's repository ----------

// The tree a review of `dir` sees: HEAD's tree with every working tree
// change added, untracked files included, on a copy of the index.
export function seenTree(dir) {
  const temp = mkdtempSync(join(tmpdir(), "oq-bench-seen-"));
  try {
    const env = { ...gitEnv(), GIT_INDEX_FILE: join(temp, "index") };
    copyFileSync(join(dir, ".git", "index"), join(temp, "index"));
    g(dir, ["add", "-A"], env);
    return g(dir, ["write-tree"], env);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

// Clones the case repository into `into` (a new or empty folder) in the
// shape asked and returns { dir, shape, base, head, mergeBaseSha, headSha,
// caseRepo, built }: base and head are B and H, the commits a server review
// names; mergeBaseSha and headSha are upstream's.
export function materialisePr(c, into, { shape = "laptop", cache = cacheRoot(), heldOut = false, allowFileUrl = false } = {}) {
  if (shape !== "laptop" && shape !== "server") throw new Error(`the shape is laptop or server, not ${JSON.stringify(shape)}`);
  const { path, record, built } = caseRepo(c, { cache, heldOut, allowFileUrl });
  mkdirSync(into, { recursive: true });
  if (readdirSync(into).length > 0) throw new Error(`${c.id}: ${into} is not empty`);
  g(dirname(into), ["clone", "-q", "--no-checkout", path, into]);
  g(into, ["remote", "remove", "origin"]);
  mkdirSync(join(into, ".git", "info"), { recursive: true });
  writeFileSync(join(into, ".git", "info", "attributes"), BYTE_EXACT_ATTRIBUTES);
  // The machine's global ignore file would hide new files from the review.
  g(into, ["config", "core.excludesFile", "/dev/null"]);
  g(into, ["reset", "-q", "--hard", record.head]);
  if (shape === "laptop") g(into, ["reset", "-q", record.base]);
  // Either shape: the working tree must hold the head exactly (failures 4
  // and 14). Two head paths that differ only in case land on one file where
  // the file system folds case, which git's own check can miss when the two
  // files are the same size, so they are looked for first.
  const byFolded = new Map();
  for (const p of g(into, ["ls-tree", "-r", "--name-only", "-z", record.head]).split("\0").filter(Boolean)) byFolded.set(p.toLowerCase(), [...(byFolded.get(p.toLowerCase()) ?? []), p]);
  const oneFile = (a, b) => {
    try {
      return lstatSync(join(into, a)).ino === lstatSync(join(into, b)).ino;
    } catch {
      return true;
    }
  };
  const collide = [...byFolded.values()].filter((ps) => ps.length > 1 && ps.slice(1).some((p) => oneFile(ps[0], p))).map((ps) => ps.sort().join(" and "));
  if (collide.length > 0) throw new Error(`${c.id}: the ${shape} shape cannot hold the pull request's head exactly: this file system folds case, so ${collide.slice(0, 5).join("; ")}${collide.length > 5 ? "; ..." : ""} are one file`);
  const seen = seenTree(into);
  if (seen !== record.headTree) {
    const differ = g(into, ["diff-tree", "-r", "-z", "--name-only", seen, record.headTree]).split("\0").filter(Boolean);
    throw new Error(`${c.id}: the ${shape} shape cannot hold the pull request's head exactly: the working tree differs from the head at ${differ.length} paths: ${differ.slice(0, 10).join(", ")}${differ.length > 10 ? ", ..." : ""}`);
  }
  return { dir: into, shape, base: record.base, head: record.head, mergeBaseSha: record.upstream.mergeBaseSha, headSha: record.upstream.headSha, caseRepo: path, built };
}

// ---------- the cache, listed ----------

function bytesUnder(path) {
  let total = 0;
  const walk = (p) => {
    for (const e of readdirSync(p, { withFileTypes: true })) {
      const full = join(p, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) total += statSync(full).size;
    }
  };
  walk(path);
  return total;
}

// Every folder of the clone cache with its size, largest first, for a
// person to choose what to move to the Trash.
export function cacheListing(cache = cacheRoot()) {
  const out = [];
  for (const kind of ["repos", "cases"]) {
    const dir = join(cache, kind);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).filter((n) => n.endsWith(".git")).sort()) out.push({ path: join(dir, name), bytes: bytesUnder(join(dir, name)) });
  }
  return out.sort((a, b) => b.bytes - a.bytes || (a.path < b.path ? -1 : 1));
}
