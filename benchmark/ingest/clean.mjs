// Audited clean real changes: candidates for the clean suite, listed by
// script with their evidence, and the suite itself, written only from a
// person's signed rulings (PLAN-benchmark P1-T21 and question 33).
//
//   node benchmark/ingest/clean.mjs list [--offline]
//   node benchmark/ingest/clean.mjs sheet [--seed <n>] [--json]
//   node benchmark/ingest/clean.mjs admit
//
// list reads the AACR split (benchmark/splits/aacr-v1.json) and suite, and
// for each development repository group asks GitHub (gh api, every answer
// cached under $OPENQODEX_BENCH_CACHE/github/clean/, so the cache is the
// only source after the first reading) for the pull requests merged into
// the default branch in the pinned window, takes them in a seeded order and
// checks each against the evidence rule (RULE below) until the group has
// PER_GROUP candidates or MAX_EVAL were checked. It writes
//   benchmark/suites/clean/candidates.json    every candidate as a suite
//                                             entry with its evidence (links,
//                                             dates, the commits checked), and
//                                             every exclusion with its reason
//   benchmark/suites/clean/ingest-report.txt  the inclusion and exclusion
//                                             counts (also printed)
// --offline reads only the cache and stops at the first answer missing.
// sheet prints the candidates for a person in a seeded shuffle, with their
// evidence and the commands that record a ruling. It is blind in the
// queue's sense: it holds nothing from any run (no reviewer has seen these
// changes), so the ruling is made apart from any review result.
// admit reads the candidates and the adjudication file
// (benchmark/review-queue/decisions.jsonl, written only by queue.mjs
// decide) and writes benchmark/suites/clean/cases.json,
// benchmark/splits/clean-v1.json (every case development) and
// benchmark/suites/clean/admit-report.txt.
//
// No model is called anywhere here: every check is a script's.
//
// Failure list, written before the code:
// 1. A pull request with a later fix on the same lines is offered as clean:
//    every later commit on the default branch within 90 days of the merge
//    that touches a file it changed is read line by line, whatever its
//    message says (a fix said only in the body, a subject that quotes its
//    title), and one that changes its lines excludes it. The pull request's
//    lines (every line it added, and both neighbours of every place where
//    it only removed lines) are placed in that commit's parent by a diff of
//    the file at the pull request's head and at the parent, so any history
//    shape (squash, rebase, merge commits) places them; a change to such a
//    line, a removal of the file, or a pure insertion next to such a line
//    excludes it.
// 2. A line that cannot be followed is read as untouched: no patch, a file
//    GitHub serves no text of, or a line the commit's parent does not hold
//    excludes the pull request as "lines could not be followed", unless
//    GitHub's compare shows that parent does not hold the pull request's
//    merge (a commit or merge on another branch's line, which changes
//    nothing on the default branch's line). A commit of 300 files or more
//    whose list leaves out the file excludes it as too large to check.
// 3. A later fix-up or revert that names the pull request, or a later bug
//    report that links it, is missed: GitHub's timeline of the pull request
//    gives every commit that names it and every issue or pull request that
//    links it, and every later commit on its files is read too. Within the
//    90 days, a line that names the pull request and reads as a fix, revert
//    or follow-up once its quoted title is taken out excludes it (a
//    backport, cherry-pick or release-note line only quotes the title; a
//    fix word on a line that does not name it is about something else), and
//    so does a linking issue or pull request labelled as a bug.
// 4. A candidate from a held-out repository group is listed or admitted:
//    list reads development groups only and refuses a repository whose name
//    GitHub now answers with that is not in a development group
//    (candidateRefusal); admit refuses a candidates file that holds one.
// 5. A case enters the suite without a person's signed ruling: admit writes
//    only candidates whose standing ruling (the latest) is clean, signed by
//    a person on people.json (lib/rulings.mjs); lib/suites.mjs refuses a
//    clean suite entry without one at every read, so a hand edit stops every
//    run of the suite.
// 6. A quota, login or permission error reads as "no later fix": only a 404
//    (or "No commit found" for a commit GitHub dropped) means absent; any
//    other failure of gh stops the listing with GitHub's own words, and
//    nothing is cached.
// 7. A candidate whose 90 days had not passed when GitHub was read is
//    listed: the day each later-history answer was read must be after the
//    window's end, or the candidate is excluded with that reason.
// 8. A file the pull request changed is renamed within the 90 days, and
//    later fixes under its new name are missed: such a candidate is
//    excluded.
// 9. Two listings of the same cache write different files: nothing reads
//    the clock but the day a new answer is cached, every list is sorted,
//    and the order within a group is a seeded hash.
// 10. A ruling admits a candidate after its commits, its evidence or the
//    sheet it was made on changed: a ruling names the candidate's id, whose
//    hash covers the repository, the commits and the size; queue.mjs
//    decide records it only on a sheet that shows the current version of
//    the candidates (cleanRulingBinding) and records the candidate's
//    evidence hash; admit refuses a clean ruling whose sheet version or
//    evidence hash is not the current one, naming the candidate.
// The licence class each candidate carries (lib/licence.mjs) travels into
// the suite entry and every run's case copy, so a case whose licence is
// unverified is used and published in full like any other. Local board
// conversion accepts it; board submissions still apply publishRefusal.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { benchRoot, gitEnv } from "../lib/cases.mjs";
import { drawAudit } from "../lib/drops.mjs";
import { cacheRoot, licenceExclusion, licenceNote, licenceRecord, repoAnswer } from "../lib/licence.mjs";
import { readDecisions, resolveRulings } from "../lib/rulings.mjs";
import { HASHED, SUITES, canonicalJson, entryHash, realCaseId, sha256, splitRewriteProblems, truthHashOf } from "../lib/suites.mjs";

export const SALT = "openqodex-clean-v1";
export const SPLIT_NAME = "clean-v1";
// The merge window the candidates come from: closed long before any
// reading, so every candidate's 90 days have passed.
export const WINDOW = Object.freeze({ from: "2026-01-01", to: "2026-03-31" });
export const DAYS = 90;
export const PER_GROUP = 2;
export const MAX_EVAL = 12;
export const CANDIDATES = "suites/clean/candidates.json";
const REPORT = "suites/clean/ingest-report.txt";
const ADMIT_REPORT = "suites/clean/admit-report.txt";
const SEARCH_PAUSE_MS = 2500;

export const WHY = Object.freeze({
  bot: "authored by a bot",
  gone: "GitHub does not serve the pull request",
  notMerged: "not merged into the default branch",
  size: "its size is outside AACR's range",
  unreviewed: "no review by anyone but its author",
  changes: "a reviewer requested changes",
  open: "its 90 days had not passed when GitHub was read",
  named: "a later commit names it as a fix, revert or follow-up",
  linked: "a later issue or pull request links it as a bug, fix or revert",
  unfollowed: "a file it changed was renamed within the 90 days, so later fixes cannot be followed",
  touched: "a later commit changed lines it changed",
  unplaced: "its lines could not be followed through a later commit",
  tooLarge: "a later commit on its files is too large to check",
});

export const RULE = `A candidate is a pull request of a development repository group of the AACR split, from one of the group's AACR repositories under the name GitHub now answers with, merged into the default branch between ${WINDOW.from} and ${WINDOW.to}, that: is not authored by a bot; changes as many lines (additions plus deletions) as AACR's usable cases, from the fewest to the most; has a review by someone other than its author and no review that requested changes; and within ${DAYS} days of its merge, read after those days had passed, has no later commit or linking issue or pull request that names it as a fix, revert or follow-up on the line that names it (its quoted title aside) or is labelled as a bug, no file of it renamed, and no later commit on the default branch, whatever its message says, that changes, removes or inserts next to a line it added or a place it removed lines. Its lines are placed in each such commit's parent by a diff of the file at its head and at that parent; a line that cannot be followed (unless the parent does not hold its merge at all) and a commit too large to read exclude it. Each group's merged pull requests (GitHub's search, the 100 opened last) are taken in the order of sha256(salt, NUL, group, NUL, repository#number) until ${PER_GROUP} are listed or ${MAX_EVAL} checked. A candidate is not a case: it enters suites/clean/cases.json only through a person's clean ruling (queue.mjs decide, on the sheet that shows the current candidates) and clean.mjs admit, which refuses a ruling whose sheet or evidence moved.`;

const byBytes = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
// Upstream text (a title, a commit subject) is quoted in the sheet and the
// candidates file, which hold no em dash by this repository's rule: the
// character becomes a spaced hyphen, and nothing else in the quote changes.
const plain = (text) => String(text ?? "").replace(/ *\u2014 */g, " - ");
const subjectOf = (message) => plain(message).split("\n")[0].trim();
const short = (sha) => String(sha ?? "").slice(0, 12);
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const addDays = (at, days) => iso(Date.parse(at) + days * 86400000);
const within = (at, from, to) => typeof at === "string" && Date.parse(at) > Date.parse(from) && Date.parse(at) <= Date.parse(to);
// The window has passed on the day an answer was read when that day is
// after the window's last day.
const closedOn = (readOn, until) => typeof readOn === "string" && readOn > until.slice(0, 10);

// ---------- GitHub, through gh, cached ----------

const enc = (s) => encodeURIComponent(s);
const encPath = (p) => p.split("/").map(enc).join("/");

// Every GitHub read this file makes, by kind. The cache is keyed by the
// exact path, so a test writes its answers under these.
export const PATHS = Object.freeze({
  repo: (r) => `repos/${r}`,
  search: (r, branch, window = WINDOW) => `search/issues?q=${enc(`repo:${r} is:pr is:merged base:${branch} merged:${window.from}..${window.to}`)}&sort=created&order=desc&per_page=100`,
  pull: (r, n) => `repos/${r}/pulls/${n}`,
  reviews: (r, n) => `repos/${r}/pulls/${n}/reviews?per_page=100`,
  prCommits: (r, n) => `repos/${r}/pulls/${n}/commits?per_page=100`,
  prFiles: (r, n) => `repos/${r}/pulls/${n}/files?per_page=100`,
  timeline: (r, n) => `repos/${r}/issues/${n}/timeline?per_page=100`,
  history: (r, branch, file, since, until) => `repos/${r}/commits?sha=${enc(branch)}&path=${enc(file)}&since=${enc(since)}&until=${enc(until)}&per_page=100`,
  commit: (r, sha) => `repos/${r}/commits/${sha}`,
  contents: (r, file, ref) => `repos/${r}/contents/${encPath(file)}?ref=${ref}`,
  compare: (r, base, head) => `repos/${r}/compare/${base}...${head}?per_page=1`,
});
const PAGINATED = new Set(["reviews", "prCommits", "prFiles", "timeline", "history"]);

const repoOfApiUrl = (url) => /\/repos\/([^/]+\/[^/]+)\//.exec(String(url ?? ""))?.[1] ?? null;
const sourceOf = (s) => {
  const i = s?.issue;
  if (!i) return null;
  return {
    repo: i.repository?.full_name ?? repoOfApiUrl(`${i.repository_url ?? ""}/`) ?? null,
    number: i.number,
    kind: i.pull_request ? "pull request" : "issue",
    title: plain(i.title),
    createdAt: i.created_at ?? null,
    labels: (i.labels ?? []).map((l) => (typeof l === "string" ? l : l?.name)).filter(Boolean),
    state: i.state ?? null,
    mergedAt: i.pull_request?.merged_at ?? null,
  };
};

// What is kept of each answer: the fields the checks and the evidence read.
const PROJECT = {
  repo: (b) => ({ fullName: b.full_name, defaultBranch: b.default_branch }),
  search: (b) => ({ total: b.total_count, incomplete: b.incomplete_results === true, items: (b.items ?? []).map((i) => ({ number: i.number, title: plain(i.title), authorType: i.user?.type ?? null, createdAt: i.created_at ?? null, mergedAt: i.pull_request?.merged_at ?? null })) }),
  pull: (b) => ({ number: b.number, url: b.html_url, title: plain(b.title), author: b.user?.login ?? null, authorType: b.user?.type ?? null, mergedAt: b.merged_at ?? null, mergeCommit: b.merge_commit_sha ?? null, base: b.base?.ref ?? null, baseSha: b.base?.sha ?? null, headSha: b.head?.sha ?? null, additions: b.additions, deletions: b.deletions, changedFiles: b.changed_files, commits: b.commits, createdAt: b.created_at ?? null }),
  reviews: (b) => b.map((r) => ({ user: r.user?.login ?? null, state: r.state, at: r.submitted_at ?? null })),
  prCommits: (b) => b.map((c) => ({ sha: c.sha, subject: subjectOf(c.commit?.message) })),
  prFiles: (b) => b.map((f) => ({ filename: f.filename, previousFilename: f.previous_filename ?? null, status: f.status, additions: f.additions, deletions: f.deletions, patch: f.patch ?? null })),
  timeline: (b) =>
    b
      .filter((e) => e.event === "referenced" || e.event === "cross-referenced")
      .map((e) => (e.event === "referenced" ? { event: e.event, at: e.created_at ?? null, commitId: e.commit_id ?? null, commitRepo: repoOfApiUrl(e.commit_url) } : { event: e.event, at: e.created_at ?? null, source: sourceOf(e.source) })),
  history: (b) => b.map((c) => ({ sha: c.sha, date: c.commit?.committer?.date ?? null, subject: subjectOf(c.commit?.message), parents: (c.parents ?? []).length })),
  commit: (b) => ({
    sha: b.sha,
    parents: (b.parents ?? []).map((p) => p.sha),
    date: b.commit?.committer?.date ?? null,
    message: b.commit?.message ?? "",
    files: (b.files ?? []).map((f) => ({ filename: f.filename, previousFilename: f.previous_filename ?? null, status: f.status, patch: f.patch ?? null })),
    filesCapped: (b.files ?? []).length >= 300,
  }),
  compare: (b) => ({ status: b.status ?? null, aheadBy: b.ahead_by ?? null, behindBy: b.behind_by ?? null }),
  contents: (b) => ({ sha: b.sha ?? null, size: b.size ?? null, text: b.type === "file" && b.encoding === "base64" && typeof b.content === "string" ? Buffer.from(b.content, "base64").toString("utf8") : null }),
};

const apiFile = (cache, path) => join(cache, "github", "clean", `${sha256(path).slice(0, 32)}.json`);

// Caches GitHub's answer to `path` (null for a 404) as the projection of
// its kind, read on `readOn`. Returns { readOn, body }.
export function saveApi(cache, kind, path, raw, readOn) {
  if (!PROJECT[kind]) throw new Error(`no GitHub answer kind ${kind}`);
  const body = raw === null ? null : PROJECT[kind](raw);
  const file = apiFile(cache, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, `${JSON.stringify({ v: 1, kind, path, readOn, body })}\n`);
  renameSync(`${file}.tmp`, file);
  return { readOn, body };
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// One GitHub API read through gh: the parsed body (the pages joined for a
// list), or null when GitHub does not have it (a 404, or "No commit found"
// for a commit pushed over and dropped); anything else stops (failure 6).
function ghJson(path, { paginate }) {
  let out;
  try {
    out = execFileSync("gh", ["api", ...(paginate ? ["--paginate", "--slurp"] : []), path], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 28 });
  } catch (error) {
    const said = `${error.stderr ?? ""}${error.stdout ?? ""}`.trim() || error.message;
    if ((/\(HTTP 404\)/.test(said) || /No commit found for SHA/.test(said)) && !/rate limit/i.test(said)) return null;
    throw new Error(`gh api ${path} failed, so the listing stops: ${said}`);
  }
  const body = JSON.parse(out);
  return paginate ? body.flat() : body;
}

function api(kind, path, { cache, offline, today }) {
  const file = apiFile(cache, path);
  if (existsSync(file)) {
    const a = readJson(file);
    if (a.v !== 1 || a.kind !== kind || a.path !== path) throw new Error(`${file} does not hold the ${kind} answer for ${path}; move it to the Trash to read it again`);
    return { readOn: a.readOn, body: a.body };
  }
  if (offline) throw new Error(`no cached GitHub answer for ${path} in ${dirname(file)}, and the listing is offline`);
  // GitHub's search allows 30 reads a minute.
  if (kind === "search") sleep(SEARCH_PAUSE_MS);
  return saveApi(cache, kind, path, ghJson(path, { paginate: PAGINATED.has(kind) }), today);
}

// ---------- the groups ----------

// Why a pull request of `repo` may not be a clean candidate, or null: its
// repository must be a member of a development group of the AACR split,
// and of the group the candidate names, when it names one (failure 4).
export function candidateRefusal(repo, split, group = null) {
  const k = String(repo ?? "").toLowerCase();
  const g = (split.groups ?? []).find((x) => (x.members ?? []).includes(k));
  if (!g) return `${repo} is in no repository group of ${split.name}, so its side is unknown and it is not a candidate`;
  if (g.split !== "dev") return `${repo} is in the held-out group ${g.group}: clean candidates come from development groups only, and nothing is tuned on a held-out group`;
  if (group !== null && group !== g.group) {
    const named = (split.groups ?? []).find((x) => x.group === group);
    return named?.split === "test" ? `${repo} is named in the held-out group ${group}: clean candidates come from development groups only` : `${repo} is in the group ${g.group}, not ${group}`;
  }
  return null;
}

// ---------- lines ----------

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

// The lines of the head a pull request's patch of one file holds: every
// line it added, and both neighbours of every place where it only removed
// lines.
function headLines(patch) {
  const out = new Set();
  let n = 0;
  let removed = false;
  let added = false;
  const close = () => {
    if (removed && !added) {
      if (n > 1) out.add(n - 1);
      out.add(n);
    }
    removed = false;
    added = false;
  };
  for (const line of patch.split("\n")) {
    const h = HUNK.exec(line);
    if (h) {
      close();
      n = Number(h[3]) + (h[4] === "0" ? 1 : 0);
      continue;
    }
    if (line === "" || line.startsWith("\\")) continue;
    if (line[0] === "+") {
      out.add(n++);
      added = true;
    } else if (line[0] === "-") removed = true;
    else {
      close();
      n++;
    }
  }
  close();
  return out;
}

// `lines` of one version of a file in another, by git's diff of the two
// (-U0): a line inside a changed range is gone, any other moves by the
// lines added and removed above it. Returns { placed, gone }.
function mapLines(lines, u0) {
  const hunks = [];
  for (const line of u0.split("\n")) {
    const h = HUNK.exec(line);
    if (h) hunks.push({ a: Number(h[1]), b: h[2] === undefined ? 1 : Number(h[2]), d: h[4] === undefined ? 1 : Number(h[4]) });
  }
  const out = new Set();
  let lost = 0;
  for (const x of lines) {
    let shift = 0;
    let gone = false;
    for (const h of hunks) {
      if (h.b > 0) {
        if (x < h.a) break;
        if (x <= h.a + h.b - 1) {
          gone = true;
          break;
        }
        shift += h.d - h.b;
      } else {
        // Lines inserted after line a.
        if (x <= h.a) break;
        shift += h.d;
      }
    }
    if (gone) lost++;
    else out.add(x + shift);
  }
  return { placed: out, gone: lost };
}

// The lines of the parent, among `lines`, that a commit's patch of one file
// changes or removes, or inserts next to where it only inserts.
function touchedAt(lines, patch) {
  const at = new Set();
  let n = 0;
  let removed = false;
  for (const line of patch.split("\n")) {
    const h = HUNK.exec(line);
    if (h) {
      n = Number(h[1]) + (h[2] === "0" ? 1 : 0);
      removed = false;
      continue;
    }
    if (line === "" || line.startsWith("\\")) continue;
    if (line[0] === "-") {
      if (lines.has(n)) at.add(n);
      n++;
      removed = true;
    } else if (line[0] === "+") {
      if (!removed && lines.has(n - 1)) at.add(n - 1);
      if (!removed && lines.has(n)) at.add(n);
    } else {
      n++;
      removed = false;
    }
  }
  return [...at].sort((a, b) => a - b);
}

// git's diff of two texts, every changed range with no context.
function diffU0(a, b) {
  const dir = mkdtempSync(join(tmpdir(), "oq-clean-diff-"));
  try {
    writeFileSync(join(dir, "a"), a);
    writeFileSync(join(dir, "b"), b);
    const r = spawnSync("git", ["diff", "--no-index", "--no-color", "--no-ext-diff", "--minimal", "-U0", "a", "b"], { cwd: dir, env: gitEnv(), encoding: "utf8", maxBuffer: 1 << 28 });
    if (r.status !== 0 && r.status !== 1) throw new Error(`git diff --no-index failed: ${(r.stderr ?? "").trim() || r.error?.message}`);
    return r.stdout;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Line numbers as ranges: "6 to 7, 12".
const ranges = (nums) => {
  const s = [...nums].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < s.length; ) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    out.push(j > i ? `${s[i]} to ${s[j]}` : `${s[i]}`);
    i = j + 1;
  }
  return out.join(", ");
};

// What a later commit did to the pull request's lines of one file
// (failures 1 and 2): { result: "touched" | "clear" | "unplaced", how }.
// `cf` is the commit's entry for the file. A line the commit's parent does
// not hold is never read as untouched: GitHub's compare says whether that
// parent holds the pull request's merge at all (a commit on another
// branch's line, then clear), and otherwise the lines could not be
// followed.
const T = (how) => ({ result: "touched", how });
const C = (how) => ({ result: "clear", how });
const U = (how) => ({ result: "unplaced", how });
function touches(f, pull, commit, cf, repo, read) {
  if (f.status === "removed") return cf?.filename === f.filename && cf.status === "added" ? T("it adds back the file the pull request removed") : C("the pull request removed the file, and this commit does not add it back");
  if (!cf) return C("it does not change the file against its first parent (a merge whose first parent already held the change)");
  if (cf.status === "removed") return T("it removes the file");
  if (f.patch === null) return U("GitHub shows no patch for the pull request's change to the file (binary or too large)");
  const own = headLines(f.patch);
  if (own.size === 0) return C("the pull request changed no line of the file");
  if (cf.patch === null) return U("GitHub shows no patch for this commit's change to the file (binary or too large)");
  const atParent = read("contents", PATHS.contents(repo, cf.previousFilename ?? cf.filename, commit.parents[0])).body;
  const atHead = read("contents", PATHS.contents(repo, f.filename, pull.headSha)).body;
  if (atHead === null || atHead.text === null || (atParent !== null && atParent.text === null)) return U("GitHub serves no text of the file at the pull request's head or at the commit's parent (too large, or gone)");
  const { placed, gone } = atParent === null ? { placed: new Set(), gone: own.size } : mapLines(own, diffU0(atHead.text, atParent.text));
  if (gone > 0) {
    const cmp = pull.mergeCommit ? read("compare", PATHS.compare(repo, pull.mergeCommit, commit.parents[0])).body : null;
    if (cmp && (cmp.status === "behind" || cmp.status === "diverged")) return C("its first parent does not hold the pull request (a commit on another branch's line, or a merge into one)");
    return U(`${gone} of the pull request's ${own.size} lines are not in the commit's parent${cmp ? ", though that parent holds the pull request's merge" : ", and GitHub cannot say whether that parent holds the pull request's merge"}`);
  }
  const at = touchedAt(placed, cf.patch);
  return at.length > 0 ? T(`it changes or inserts next to line ${ranges(at)} of its parent, where the pull request's lines sit at ${ranges(placed)}`) : C(`its changes miss the pull request's lines, which sit at ${ranges(placed)} of its parent`);
}

// ---------- one pull request ----------

const FIX_WORDS = /\b(fix(e[sd]|ing|up)?|hot-?fix(e[sd])?|bug(fix(es)?|s)?|revert(s|ed|ing)?|regress(ion|ions|ed)?|crash(es|ed|ing)?|broken|break(s|age)?|repair(s|ed)?|undo(es|ne)?|roll(ed|s)?[- ]?back|typos?)\b/i;
const FOLLOW_WORDS = /\b(follow[- ]?ups?|addendum|amend(s|ed)?)\b/i;
const REVERT_WORDS = /\b(revert(s|ed|ing)?|roll(ed|s)?[- ]?back|undo(es|ne)?)\b/i;
const BUG_LABEL = /bug|regression|defect|revert|crash/i;
const reads = (s) => FIX_WORDS.test(s) || FOLLOW_WORDS.test(s);

// A title with its leading tags ("[8.x]") and trailing pull request numbers
// taken off.
const normTitle = (s) =>
  String(s ?? "")
    .replace(/^\s*(\[[^\]]*\]\s*)+/, "")
    .replace(/(\s*\(#\d+\))+\s*$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

// Whether a line only quotes the pull request's own title, or one of its
// commits' subjects: it holds the title, and what is left once the title
// is taken out reads as no fix, revert or follow-up. A backport, a
// cherry-pick, a release note or the pull request's own commit does that;
// "Fix the regression from <title>" and "Revert <title>" do not.
function quotesIt(line, pull, own) {
  const l = String(line ?? "").replace(/\s+/g, " ").toLowerCase();
  return [pull.title, ...own.map((c) => c.subject)].map(normTitle).some((t) => t.length >= 8 && l.includes(t) && !reads(l.replace(t, " ")));
}

// Whether one line names the pull request: its number (alone or after its
// repository), its link, one of its commits or its merge commit, or a
// revert of its title.
function namesPull(line, pull, own, repo) {
  if (new RegExp(`(^|[^\\w/.#-])#${pull.number}(?!\\d)`).test(line)) return true;
  if (line.toLowerCase().includes(`${repo.toLowerCase()}#${pull.number}`) && !new RegExp(`#${pull.number}\\d`).test(line)) return true;
  if (pull.url && line.includes(pull.url)) return true;
  const shas = [pull.mergeCommit, ...own.map((c) => c.sha)].filter(Boolean);
  if ((line.match(/\b[0-9a-f]{7,40}\b/g) ?? []).some((h) => shas.some((s) => s.startsWith(h)))) return true;
  const title = normTitle(pull.title);
  return REVERT_WORDS.test(line) && title.length >= 8 && line.toLowerCase().includes(title);
}

// Whether a line reads as a fix, revert or follow-up once the pull
// request's own title (or a subject of its commits) is taken out of it.
function readsBesideTitle(line, pull, own) {
  let l = String(line ?? "").replace(/\s+/g, " ").toLowerCase();
  for (const t of [pull.title, ...own.map((c) => c.subject)].map(normTitle).filter((x) => x.length >= 8)) l = l.split(t).join(" ");
  return reads(l);
}

// Whether a commit message names the pull request as a fix, revert or
// follow-up: a line that names it reads as one, its quoted title aside (a
// fix word on another line is about something else). `named` says GitHub
// already found the pull request named in it (a timeline reference), so
// the subject stands for the naming line when no line matches here.
function namesAsFix(message, pull, own, repo, { named = false } = {}) {
  const lines = String(message ?? "").split("\n");
  let naming = lines.filter((l) => namesPull(l, pull, own, repo));
  if (naming.length === 0 && named) naming = [lines[0]];
  return naming.some((l) => readsBesideTitle(l, pull, own));
}

const commitUrl = (repo, sha) => `https://github.com/${repo}/commit/${sha}`;

// A candidate as a suite entry (PLAN-benchmark 4.2, the shape of AACR's):
// a pull request case with no truth.
export function candidateEntry({ pull, repo, group, language, licence, evidence }) {
  const [owner, name] = repo.split("/");
  const entry = {
    name: `${owner}__${name}-${pull.number}`,
    id: null,
    hash: null,
    status: "usable",
    excludedWhy: null,
    prUrl: `https://github.com/${repo}/pull/${pull.number}`,
    repo,
    cloneUrl: `https://github.com/${repo}.git`,
    prRef: `refs/pull/${pull.number}/head`,
    baseSha: pull.baseSha,
    headSha: pull.headSha,
    mergeBaseSha: null,
    language,
    changeLines: pull.additions + pull.deletions,
    repoGroup: group,
    licence,
    truth: { kind: "lines", accepted: 0, rejected: 0 },
    truthHash: truthHashOf([]),
    matchSignatures: {},
    prCreatedAt: pull.createdAt ?? null,
    mergedAt: pull.mergedAt ?? null,
    title: pull.title ?? "",
  };
  entry.hash = entryHash(entry);
  entry.id = realCaseId("clean", entry.name, entry.hash);
  return { ...entry, evidenceSha256: sha256(canonicalJson(evidence ?? null)), evidence };
}

// Checks one merged pull request against the rule: { entry } for a
// candidate, or { excluded: { name, prUrl, repoGroup, why, detail } } with
// the first reason it fails.
function evaluate(item, { repo, defaultBranch, group, language, licence, sizeRange, read }) {
  const n = item.number;
  const [owner, rname] = repo.split("/");
  const name = `${owner}__${rname}-${n}`;
  const prUrl = `https://github.com/${repo}/pull/${n}`;
  const out = (why, detail) => ({ excluded: { name, prUrl, repoGroup: group, why, detail } });
  if (item.authorType === "Bot") return out(WHY.bot, "GitHub's search names a bot as its author");
  const pull = read("pull", PATHS.pull(repo, n)).body;
  if (pull === null) return out(WHY.gone, `GitHub answers 404 for ${prUrl}`);
  if (!pull.mergedAt || pull.base !== defaultBranch) return out(WHY.notMerged, pull.mergedAt ? `merged into ${pull.base}, and the default branch is ${defaultBranch}` : "GitHub names no merge");
  if (pull.authorType === "Bot") return out(WHY.bot, "GitHub names a bot as its author");
  const size = pull.additions + pull.deletions;
  if (!(size >= sizeRange.min && size <= sizeRange.max)) return out(WHY.size, `${size} changed lines; AACR's usable cases change ${sizeRange.min} to ${sizeRange.max}`);
  const until = addDays(pull.mergedAt, DAYS);
  const window = { mergedAt: pull.mergedAt, until };

  const reviews = read("reviews", PATHS.reviews(repo, n)).body ?? [];
  const others = reviews.filter((r) => r.user !== pull.author && r.state !== "PENDING");
  const asked = others.filter((r) => r.state === "CHANGES_REQUESTED");
  if (asked.length > 0) return out(WHY.changes, `${plural(asked.length, "review")} requested changes, the first on ${asked[0].at}`);
  if (others.length === 0) return out(WHY.unreviewed, `${plural(reviews.length, "review")}, none by anyone but its author`);
  const states = Object.fromEntries([...new Set(others.map((r) => r.state))].sort(byBytes).map((s) => [s, others.filter((r) => r.state === s).length]));

  const own = read("prCommits", PATHS.prCommits(repo, n)).body ?? [];
  const isOwn = (sha) => sha === pull.mergeCommit || own.some((c) => c.sha === sha);

  // Commits that name it, and issues or pull requests that link it (failure 3).
  const timeline = read("timeline", PATHS.timeline(repo, n));
  if (!closedOn(timeline.readOn, until)) return out(WHY.open, `its timeline was read on ${timeline.readOn}, and its ${DAYS} days end on ${until}`);
  const referenced = [];
  for (const e of (timeline.body ?? []).filter((x) => x.event === "referenced" && x.commitId)) {
    if ((e.commitRepo ?? repo).toLowerCase() !== repo.toLowerCase() || isOwn(e.commitId)) continue;
    const c = read("commit", PATHS.commit(repo, e.commitId)).body;
    if (c === null || !within(c.date, pull.mergedAt, until)) continue;
    const rec = { sha: c.sha, url: commitUrl(repo, c.sha), date: c.date, subject: subjectOf(c.message) };
    if (namesAsFix(c.message, pull, own, repo, { named: true })) return out(WHY.named, `${short(c.sha)} "${rec.subject}" on ${c.date} (${rec.url})`);
    referenced.push(rec);
  }
  const linked = [];
  for (const e of (timeline.body ?? []).filter((x) => x.event === "cross-referenced" && x.source)) {
    const s = e.source;
    if (String(s.repo ?? "").toLowerCase() === repo.toLowerCase() && s.number === n) continue;
    if (!within(s.createdAt, pull.mergedAt, until)) continue;
    const rec = { ref: `${s.repo}#${s.number}`, url: `https://github.com/${s.repo}/${s.kind === "issue" ? "issues" : "pull"}/${s.number}`, kind: s.kind, createdAt: s.createdAt, title: s.title, labels: [...s.labels].sort(byBytes), copy: quotesIt(s.title, pull, own) };
    if (readsBesideTitle(s.title, pull, own) || (!rec.copy && s.labels.some((l) => BUG_LABEL.test(l)))) return out(WHY.linked, `${s.kind} ${rec.ref} "${s.title}"${rec.labels.length ? ` (labels ${rec.labels.join(", ")})` : ""}, opened ${s.createdAt} (${rec.url})`);
    linked.push(rec);
  }

  // Later commits on the default branch that touch its files (failures 1, 2, 3, 7, 8).
  const files = [...(read("prFiles", PATHS.prFiles(repo, n)).body ?? [])].sort((a, b) => byBytes(a.filename, b.filename));
  const fileEvidence = [];
  let laterTotal = 0;
  let fixTotal = 0;
  for (const f of files) {
    const hist = read("history", PATHS.history(repo, defaultBranch, f.filename, pull.mergedAt, until));
    if (!closedOn(hist.readOn, until)) return out(WHY.open, `the history of ${f.filename} was read on ${hist.readOn}, and its ${DAYS} days end on ${until}`);
    // Every later commit on the default branch that touches the file is
    // read, whatever its message says, oldest first.
    const later = (hist.body ?? []).filter((c) => within(c.date, pull.mergedAt, until) && !isOwn(c.sha)).reverse();
    const checked = [];
    for (const c of later) {
      const url = commitUrl(repo, c.sha);
      const at = `${short(c.sha)} "${c.subject}" on ${c.date} (${url})`;
      const commit = read("commit", PATHS.commit(repo, c.sha)).body;
      if (commit === null) return out(WHY.unplaced, `${at}, ${f.filename}: GitHub lists it in the file's history and answers 404 for it, so its change cannot be read`);
      if (namesAsFix(commit.message, pull, own, repo)) return out(WHY.named, at);
      const cf = commit.files.find((x) => x.filename === f.filename) ?? commit.files.find((x) => x.previousFilename === f.filename) ?? null;
      if (cf === null && commit.filesCapped) return out(WHY.tooLarge, `${at}: it changes 300 files or more, and its list as GitHub serves it leaves out ${f.filename}`);
      // A renamed file goes on under a name this history does not follow.
      if (cf?.status === "renamed" && cf.previousFilename === f.filename && f.status !== "removed") return out(WHY.unfollowed, `${f.filename} renamed to ${cf.filename} by ${at}`);
      const t = touches(f, pull, commit, cf, repo, read);
      if (t.result === "touched") return out(WHY.touched, `${at}, ${f.filename}: ${t.how}`);
      if (t.result === "unplaced") return out(WHY.unplaced, `${at}, ${f.filename}: ${t.how}`);
      if (reads(commit.message)) fixTotal++;
      checked.push({ sha: c.sha, url, date: c.date, subject: c.subject, how: t.how });
    }
    laterTotal += later.length;
    fileEvidence.push({ path: f.filename, status: f.status, changedLines: (f.additions ?? 0) + (f.deletions ?? 0), laterCommits: checked });
  }

  const evidence = {
    readOn: timeline.readOn,
    window,
    pull: { url: prUrl, mergedAt: pull.mergedAt, mergeCommit: pull.mergeCommit, mergeCommitUrl: pull.mergeCommit ? commitUrl(repo, pull.mergeCommit) : null, base: pull.base, changedLines: size, changedFiles: pull.changedFiles, commits: pull.commits },
    reviews: { byOthers: others.length, states, changesRequested: 0 },
    referencedCommits: referenced,
    linkedLater: linked,
    files: fileEvidence,
    checked: { files: files.length, laterCommits: laterTotal, fixOrRevertCommits: fixTotal, touchingItsLines: 0 },
  };
  return { entry: candidateEntry({ pull, repo, group, language, licence, evidence }) };
}

// ---------- the listing ----------

export async function listCandidates({ root = benchRoot, cache = cacheRoot(), offline = false, window = WINDOW, perGroup = PER_GROUP, maxEval = MAX_EVAL, today = new Date().toISOString().slice(0, 10), log = () => {} } = {}) {
  const splitPath = join(root, SUITES.aacr.split);
  const split = readJson(splitPath);
  const aacr = readJson(join(root, SUITES.aacr.cases));
  const usable = aacr.cases.filter((e) => e.status === "usable" && Number.isInteger(e.changeLines));
  if (usable.length === 0) throw new Error(`${SUITES.aacr.cases} holds no usable case, so AACR's size range is unknown`);
  const sizeRange = { min: Math.min(...usable.map((e) => e.changeLines)), max: Math.max(...usable.map((e) => e.changeLines)) };
  const read = (kind, path) => api(kind, path, { cache, offline, today });

  const candidates = [];
  const excluded = [];
  const groups = [];
  const devGroups = (split.groups ?? []).filter((g) => g.split === "dev").sort((a, b) => byBytes(a.group, b.group));
  for (const g of devGroups) {
    const note = { group: g.group, language: g.language, repos: [], merged: 0, offered: 0, checked: 0, listed: 0, notes: [] };
    const asked = [...new Set(aacr.cases.filter((e) => e.repoGroup === g.group).map((e) => e.repo))].sort(byBytes);
    const pool = [];
    for (const repo of asked) {
      const answer = repoAnswer(repo, { cache, offline, licence: true });
      const licence = licenceRecord(answer);
      const licenceWhy = answer?.found ? licenceExclusion(licence) : "GitHub does not know the repository";
      if (licenceWhy) {
        note.notes.push(`${repo}: ${licenceWhy}`);
        continue;
      }
      const meta = read("repo", PATHS.repo(answer.fullName ?? repo)).body;
      if (meta === null) {
        note.notes.push(`${repo}: GitHub answers 404 for the repository`);
        continue;
      }
      const refusal = candidateRefusal(meta.fullName, split, g.group);
      if (refusal) {
        note.notes.push(refusal);
        continue;
      }
      const found = read("search", PATHS.search(meta.fullName, meta.defaultBranch, window)).body;
      if (found.incomplete) note.notes.push(`${meta.fullName}: GitHub's search said its answer was incomplete`);
      note.repos.push(meta.fullName);
      note.merged += found.total;
      note.offered += found.items.length;
      for (const item of found.items) pool.push({ ...item, repo: meta.fullName, defaultBranch: meta.defaultBranch, licence });
    }
    const order = (x) => sha256(`${SALT}\0${g.group}\0${x.repo.toLowerCase()}#${x.number}`);
    pool.sort((a, b) => byBytes(order(a), order(b)));
    for (const item of pool) {
      if (note.listed >= perGroup || note.checked >= maxEval) break;
      note.checked++;
      const r = evaluate(item, { repo: item.repo, defaultBranch: item.defaultBranch, group: g.group, language: g.language, licence: item.licence, sizeRange, read });
      if (r.entry) {
        candidates.push(r.entry);
        note.listed++;
      } else excluded.push(r.excluded);
    }
    groups.push(note);
    log(`${g.group}: ${note.listed} listed of ${note.checked} checked (${note.offered} offered)`);
  }
  candidates.sort((a, b) => byBytes(a.name, b.name));
  excluded.sort((a, b) => byBytes(a.name, b.name));

  const file = {
    version: 1,
    suite: "clean",
    rule: RULE,
    salt: SALT,
    window: { mergedFrom: window.from, mergedTo: window.to, days: DAYS },
    perGroup,
    maxEval,
    sizeRange: { ...sizeRange, from: `the usable cases of ${SUITES.aacr.cases}` },
    split: { name: split.name, file: SUITES.aacr.split, sha256: sha256(readFileSync(splitPath)) },
    hashCovers: HASHED,
    groups,
    candidates,
    excluded,
  };

  const lines = [];
  const say = (s = "") => lines.push(s);
  const heldOut = (split.groups ?? []).filter((g) => g.split !== "dev");
  say(`Clean candidates from the ${plural(devGroups.length, "development repository group")} of ${split.name} (sha256 ${file.split.sha256}): pull requests merged into the default branch from ${window.from} to ${window.to}, at most ${perGroup} listed and ${maxEval} checked per group, in the seeded order (salt ${SALT}).`);
  say(`Size: AACR's usable cases change ${sizeRange.min} to ${sizeRange.max} lines.`);
  say(`Held-out groups, never read: ${heldOut.length}.`);
  say();
  const langs = new Map();
  for (const c of candidates) langs.set(c.language, (langs.get(c.language) ?? 0) + 1);
  say(`Listed: ${plural(candidates.length, "candidate")} in ${plural(new Set(candidates.map((c) => c.repoGroup)).size, "group")}${langs.size ? ` (${[...langs.entries()].sort((a, b) => byBytes(a[0], b[0])).map(([l, k]) => `${l} ${k}`).join(", ")})` : ""}.`);
  say(`Checked: ${plural(candidates.length + excluded.length, "pull request")}; excluded ${excluded.length}, by the first reason each failed:`);
  for (const why of Object.values(WHY)) {
    const k = excluded.filter((e) => e.why === why).length;
    if (k > 0) say(`  ${why}: ${k}`);
  }
  say();
  say("Per group: merged in the window (GitHub's count), offered (the search's first page), checked, listed:");
  for (const g of groups) say(`  ${g.group} (${g.language}): ${g.merged} merged, ${g.offered} offered, ${g.checked} checked, ${g.listed} listed${g.notes.length ? `; ${g.notes.join("; ")}` : ""}`);
  say();
  say("No candidate is a case until a person rules it clean (node benchmark/queue.mjs decide clean <case id> --by <name>) and node benchmark/ingest/clean.mjs admit writes it.");
  const report = `${lines.join("\n")}\n`;
  return { file, report, files: { [CANDIDATES]: `${JSON.stringify(file, null, 2)}\n`, [REPORT]: report } };
}

function writeFiles(files, root) {
  const written = [];
  for (const [rel, body] of Object.entries(files)) {
    const path = join(root, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(`${path}.tmp`, body);
    renameSync(`${path}.tmp`, path);
    written.push(path);
  }
  return written;
}

export const writeCandidates = (result, { root = benchRoot } = {}) => writeFiles(result.files, root);

// ---------- the sheet ----------

// The version of the candidates a sheet shows, and a ruling binds to: the
// first 12 hex of the sha256 of candidates.json as list writes it.
export const candidatesVersion = (bytes) => sha256(bytes).slice(0, 12);
const versionOfFile = (file) => candidatesVersion(`${JSON.stringify(file, null, 2)}\n`);
const SHEET_ID = /^clean@(\d+)@([0-9a-f]{12})$/;
export const evidenceHash = (candidate) => sha256(canonicalJson(candidate.evidence ?? null));

// The candidates for a person, in a seeded shuffle: { sheet, suite, seed,
// version, items }, each item with the change, its evidence and nothing
// from a run. The sheet id names the version of the candidates it shows.
export function cleanSheet(file, { seed }) {
  const version = versionOfFile(file);
  return {
    sheet: `clean@${seed}@${version}`,
    version,
    suite: "clean",
    seed,
    items: drawAudit(file.candidates, file.candidates.length, seed).map((c, i) => ({
      item: i + 1,
      caseId: c.id,
      title: c.title,
      prUrl: c.prUrl,
      repo: c.repo,
      language: c.language,
      changeLines: c.changeLines,
      licence: licenceNote(c.licence),
      licenceClass: c.licence.class,
      baseSha: c.baseSha,
      headSha: c.headSha,
      mergedAt: c.mergedAt,
      evidenceSha256: evidenceHash(c),
      evidence: c.evidence,
    })),
  };
}

// What a clean or not-clean ruling on a clean candidate binds to (failure
// 10): the version of the candidates the sheet showed, which must be the
// current one, and the candidate's evidence as that version holds it.
// queue.mjs decide records the binding; returns { problem } when the ruling
// may not be recorded, else { evidence } for the ruling line.
export function cleanRulingBinding(caseId, sheet, { root = benchRoot } = {}) {
  const path = join(root, CANDIDATES);
  if (!existsSync(path)) return { problem: `${path} is missing, so ${caseId} is no candidate; run node benchmark/ingest/clean.mjs list` };
  const bytes = readFileSync(path);
  const version = candidatesVersion(bytes);
  const m = SHEET_ID.exec(String(sheet ?? ""));
  if (!m) return { problem: `a ruling on a clean candidate names the sheet it was made on, as the sheet prints it (--sheet clean@<seed>@<version>), not ${JSON.stringify(sheet ?? null)}; print it with node benchmark/ingest/clean.mjs sheet` };
  if (m[2] !== version) return { problem: `the sheet ${sheet} shows version ${m[2]} of the candidates, and ${CANDIDATES} is now version ${version}; print the sheet again and rule from it` };
  const c = JSON.parse(bytes.toString("utf8")).candidates.find((x) => x.id === caseId);
  if (!c) return { problem: `${caseId} is no candidate of ${CANDIDATES} version ${version}` };
  return { evidence: { text: null, lines: null, sha256: evidenceHash(c) } };
}

export function sheetMarkdown(s) {
  const out = [
    "# Clean controls: candidates to rule",
    "",
    `Sheet ${s.sheet}: ${plural(s.items.length, "pull request")} in a shuffled order (seed ${s.seed}). A script found each merged, reviewed with no request for changes, and with no later fix, revert, fix-up or bug report it can see touching it; the evidence it read is under each. No reviewer has seen these changes. Read the change itself (the Files tab of its link) and rule whether it is free of any issue a reviewer should raise. Record each ruling under your own name:`,
    "",
    "```",
    `node benchmark/queue.mjs decide clean <case id> --by <your name> --sheet ${s.sheet}`,
    `node benchmark/queue.mjs decide not-clean <case id> --by <your name> --sheet ${s.sheet} --note "<the issue>"`,
    "node benchmark/ingest/clean.mjs admit",
    "```",
    "",
    `A ruling binds to this sheet's version of the candidates (${s.version}) and to each candidate's evidence: if node benchmark/ingest/clean.mjs list writes them again with any change, admit refuses the ruling, and the sheet is printed and ruled again.`,
    "",
  ];
  for (const x of s.items) {
    const e = x.evidence;
    out.push(`## ${x.item}. ${x.title}`, "", `- Case: ${x.caseId} (evidence ${x.evidenceSha256.slice(0, 12)})`, `- Change: ${x.prUrl}/files (${x.changeLines} changed lines in ${plural(e.pull.changedFiles, "file")}, ${x.language})`, `- Commits: base ${x.baseSha}, head ${x.headSha}; merged ${x.mergedAt} as ${e.pull.mergeCommitUrl ?? "no merge commit GitHub names"}`, `- Licence: ${x.licence}${x.licenceClass === "unverified" ? " (unverified: used and published in full)" : ""}`, `- Reviews by others: ${e.reviews.byOthers} (${Object.entries(e.reviews.states).sort((a, b) => byBytes(a[0], b[0])).map(([k, v]) => `${k.toLowerCase().replace(/_/g, " ")} ${v}`).join(", ")}); none requested changes`, `- Checked up to ${e.window.until} (read ${e.readOn}): ${plural(e.checked.laterCommits, "later commit")} on its files, each read line by line (${e.checked.fixOrRevertCommits} reading as a fix, revert or follow-up), none touching its lines`);
    for (const f of e.files) {
      if (f.laterCommits.length === 0) continue;
      out.push(`- Later commits on ${f.path}:`);
      for (const c of f.laterCommits) out.push(`  - ${c.date} ${c.url} "${c.subject}": ${c.how}`);
    }
    if (e.referencedCommits.length > 0) out.push(`- Later commits naming it (quoting its title, or with no fix word): ${e.referencedCommits.map((c) => `${c.url} "${c.subject}"`).join("; ")}`);
    if (e.linkedLater.length > 0) out.push(`- Later issues and pull requests linking it (no bug label or fix word): ${e.linkedLater.map((l) => `${l.url} "${l.title}"`).join("; ")}`);
    out.push("- Ruling: ", "");
  }
  return out.join("\n");
}

// ---------- admit ----------

// The clean suite from the candidates and the rulings in force (failures 5 and 10):
// { suite, split, report, files }.
export function admitClean({ root = benchRoot, queue = join(root, "review-queue") } = {}) {
  const candidatesPath = join(root, CANDIDATES);
  if (!existsSync(candidatesPath)) throw new Error(`${candidatesPath} is missing; run node benchmark/ingest/clean.mjs list`);
  const cand = readJson(candidatesPath);
  const split = readJson(join(root, SUITES.aacr.split));
  const d = readDecisions(join(queue, "decisions.jsonl"));
  const R = resolveRulings(d.lines, d.people);
  const version = candidatesVersion(readFileSync(candidatesPath));
  const moved = [];
  const seen = new Set();
  const admitted = [];
  const notClean = [];
  const unruled = [];
  for (const c of [...cand.candidates].sort((a, b) => byBytes(a.name, b.name))) {
    const refusal = candidateRefusal(c.repo, split, c.repoGroup);
    if (refusal) throw new Error(`refused: ${c.id}: ${refusal}. The candidates file is written by clean.mjs list, never by hand.`);
    if (entryHash(c) !== c.hash || realCaseId("clean", c.name, c.hash) !== c.id) throw new Error(`refused: ${c.id} does not hash to its own id; the candidates file is written by clean.mjs list, never by hand`);
    if (seen.has(c.name)) throw new Error(`refused: ${c.name} is listed twice in ${CANDIDATES}`);
    seen.add(c.name);
    const licenceWhy = licenceExclusion(c.licence ?? { class: "none" });
    if (licenceWhy) throw new Error(`refused: ${c.id}: ${licenceWhy}`);
    const ruling = R.cases.get(c.id);
    if (!ruling) unruled.push(c);
    else if (ruling.status === "clean") {
      // Failure 10: the ruling binds to the evidence and the sheet's version.
      const line = d.lines[ruling.n - 1];
      const ruledOn = SHEET_ID.exec(String(line.fromSheet ?? ""))?.[2] ?? null;
      if (line.evidence?.sha256 !== evidenceHash(c)) moved.push(`${c.name}: its evidence moved since the ruling on sheet ${line.fromSheet ?? "(none)"} (line ${ruling.n} of the adjudication file), or the ruling holds none`);
      else if (ruledOn !== version) moved.push(`${c.name}: ruled clean on sheet ${line.fromSheet ?? "(none)"}, and the candidates are now version ${version}`);
      else admitted.push({ c, line, n: ruling.n });
    } else notClean.push(c);
  }
  if (moved.length > 0) throw new Error(`refused: a clean ruling binds to the sheet it was made on and to the candidate's evidence, and for ${plural(moved.length, "candidate")} one of them moved; print the sheet again (node benchmark/ingest/clean.mjs sheet) and rule again:\n  ${moved.join("\n  ")}`);
  const ids = new Set(cand.candidates.map((c) => c.id));
  const stray = [...R.cases.keys()].filter((id) => id.startsWith("clean/") && !ids.has(id)).sort(byBytes);

  const cases = admitted.map(({ c, line, n }) => {
    const { evidence: _evidence, ...entry } = c;
    return { ...entry, ruling: { by: line.by, at: line.at, sheet: line.fromSheet ?? null, evidenceSha256: line.evidence.sha256, note: line.note ?? "", decisionsLine: n } };
  });
  const suite = {
    version: 1,
    suite: "clean",
    rule: "A clean case is a candidate of suites/clean/candidates.json whose standing ruling in review-queue/decisions.jsonl is clean, signed by a person on review-queue/people.json; clean.mjs admit writes this file, and lib/suites.mjs refuses an entry without such a ruling.",
    candidates: { file: CANDIDATES, sha256: sha256(readFileSync(candidatesPath)) },
    hashCovers: HASHED,
    cases,
  };
  const splitFile = {
    version: 1,
    name: SPLIT_NAME,
    suite: "clean",
    salt: null,
    rule: "Every clean case is development: clean controls tune nothing a held-out case measures, and come from development repository groups only. The file is only ever extended: a case that loses its clean ruling needs a new split, which is a new file.",
    cases: { dev: cases.map((c) => c.name).sort(byBytes), test: [] },
    subsets: {},
    counts: { dev: cases.length },
  };
  const splitPath = join(root, SUITES.clean.split);
  const problems = existsSync(splitPath) ? splitRewriteProblems(readJson(splitPath), splitFile) : [];
  if (problems.length > 0) throw new Error(`refused: ${splitPath} exists, and a new split is a new file (${SPLIT_NAME.replace(/\d+$/, (k) => String(Number(k) + 1))}). The rulings would change it:\n  ${problems.join("\n  ")}`);

  const lines = [];
  const say = (s = "") => lines.push(s);
  say(`Clean suite from ${plural(cand.candidates.length, "candidate")} (${CANDIDATES}) and the rulings in review-queue/decisions.jsonl:`);
  say(`Admitted: ${cases.length}${cases.length ? ` (${cases.map((c) => c.name).join(", ")})` : ""}`);
  say(`Ruled not clean: ${notClean.length}${notClean.length ? ` (${notClean.map((c) => c.name).join(", ")})` : ""}`);
  say(`Not ruled yet: ${unruled.length}`);
  say(`Rulings that name no candidate: ${stray.length}${stray.length ? ` (${stray.join(", ")})` : ""}`);
  if (R.ignored.length > 0) say(`${plural(R.ignored.length, "line")} of the adjudication file ${R.ignored.length === 1 ? "is" : "are"} not a ruling and ${R.ignored.length === 1 ? "was" : "were"} ignored: ${R.ignored.map((x) => `line ${x.line} (${x.why})`).join("; ")}`);
  const report = `${lines.join("\n")}\n`;
  return { suite, split: splitFile, report, files: { [SUITES.clean.cases]: `${JSON.stringify(suite, null, 2)}\n`, [SUITES.clean.split]: `${JSON.stringify(splitFile, null, 2)}\n`, [ADMIT_REPORT]: report } };
}

export const writeAdmit = (result, { root = benchRoot } = {}) => writeFiles(result.files, root);

// ---------- the command ----------

const USAGE = "usage: node benchmark/ingest/clean.mjs list [--offline]\n       node benchmark/ingest/clean.mjs sheet [--seed <n>] [--json]\n       node benchmark/ingest/clean.mjs admit";

async function main(args) {
  const [command, ...rest] = args;
  if (command === "list" && rest.every((a) => a === "--offline")) {
    const result = await listCandidates({ offline: rest.includes("--offline"), log: (s) => console.error(s) });
    writeCandidates(result);
    process.stdout.write(result.report);
    return 0;
  }
  if (command === "sheet") {
    let seed = Math.floor(Date.now() / 1000) % 2147483647;
    let json = false;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--json") json = true;
      else if (rest[i] === "--seed" && i + 1 < rest.length) seed = Number(rest[++i]);
      else {
        console.error(USAGE);
        return 2;
      }
    }
    if (!Number.isInteger(seed) || seed < 0) throw new Error("refused: --seed must be a whole number");
    const s = cleanSheet(readJson(join(benchRoot, CANDIDATES)), { seed });
    console.log(json ? JSON.stringify(s, null, 2) : sheetMarkdown(s));
    return 0;
  }
  if (command === "admit" && rest.length === 0) {
    const result = admitClean();
    writeAdmit(result);
    process.stdout.write(result.report);
    return 0;
  }
  console.error(USAGE);
  return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => (process.exitCode = code),
    (error) => {
      console.error(error.message);
      process.exitCode = 2;
    },
  );
}
