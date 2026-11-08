// Audited clean real changes (benchmark/ingest/clean.mjs): candidates come
// by script from the development repository groups of the AACR split, each
// with its evidence, and a candidate enters the clean suite only through a
// person's signed ruling (queue.mjs decide). Every test runs the real
// listing on GitHub answers written here in GitHub's own shapes, placed in a
// temp cache and read offline, so nothing reaches the network; the patches
// are made by the real git. The failures guarded:
//
// 1. A pull request with a later fix on the same lines is offered as clean:
//    a later commit that changes its lines excludes it whatever its message
//    says (a fix said only in the body, a subject that quotes its title),
//    and so do a fix-up commit that names it and a bug report that links it.
// 2. A line that cannot be followed is read as untouched: a later commit
//    whose parent has lost the pull request's lines, though that parent
//    holds the pull request, and a commit too large to read, exclude it.
// 3. A fix word on a line that does not name the pull request excludes it.
// 4. A candidate from a held-out repository group is offered or admitted.
// 5. A clean case enters the suite, or a run, without a person's ruling, or
//    on a ruling made on another sheet or other evidence.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { PATHS, admitClean, candidateEntry, candidateRefusal, cleanSheet, listCandidates, saveApi, writeAdmit, writeCandidates } from "../ingest/clean.mjs";
import { publishRefusal, saveRepoAnswer } from "../lib/licence.mjs";
import { listCases, readCase, realSpecProblems, selectCases, specCopy, truthOf } from "../lib/suites.mjs";
import { decide } from "../queue.mjs";
import { removeTempDirs, tempDir } from "../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

const READ_ON = "2026-10-11";
const sha1 = (s) => createHash("sha1").update(s).digest("hex");
const writeJson = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
};
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const text = (lines) => `${lines.join("\n")}\n`;

// GitHub's patch for one file: the hunks of `git diff` with three lines of
// context, without the header, and without a final newline.
function patchOf(before, after) {
  const dir = tempDir("oq-clean-patch-");
  writeFileSync(join(dir, "a"), before);
  writeFileSync(join(dir, "b"), after);
  const r = spawnSync("git", ["diff", "--no-index", "--no-color", "-U3", "a", "b"], { cwd: dir, encoding: "utf8" });
  return r.stdout.slice(r.stdout.indexOf("@@")).replace(/\n$/, "");
}

// The file each pull request here changes (its own, so the history of one
// is not the history of another): before it, at its head (two lines added
// after "three"), on the default branch later (two lines added at the top,
// so every line of the pull request moved down by two), and after a later
// fix of one of its own lines or of another line.
const fileOf = (n) => `src/app${n}.go`;
const TEN = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const BEFORE = text(TEN);
const HEAD = text([...TEN.slice(0, 3), "pr one", "pr two", ...TEN.slice(3)]);
const LATER = text(["intro a", "intro b", ...HEAD.trimEnd().split("\n")]);
const FIX_OWN = LATER.replace("pr two\n", "pr two, fixed\n");
const FIX_OTHER = LATER.replace("nine\n", "nine, fixed\n");
const REWORK = BEFORE.replace("five\n", "five, reworked\n");

const MERGED = "2026-02-10T12:00:00Z";
const LATER_DAY = "2026-03-01T09:00:00Z";
const UNTIL = "2026-05-11T12:00:00Z";

const SPLIT = {
  version: 1,
  name: "aacr-v1",
  suite: "aacr",
  groups: [
    { group: "acme/app", members: ["acme/app"], language: "Go", prs: 1, split: "dev", reserved: null },
    { group: "beta/lib", members: ["beta/lib", "old/lib"], language: "Python", prs: 1, split: "dev", reserved: null },
    { group: "held/out", members: ["held/out"], language: "Go", prs: 1, split: "test", reserved: null },
  ],
  cases: { dev: ["acme__app-1", "beta__lib-1"], test: ["held__out-1"] },
  subsets: {},
};
const aacrEntry = (name, repo, changeLines) => ({ name, status: "usable", excludedWhy: null, repo, repoGroup: repo.toLowerCase(), language: "Go", changeLines });
const AACR = { version: 1, suite: "aacr", cases: [aacrEntry("acme__app-1", "acme/app", 2), aacrEntry("beta__lib-1", "beta/lib", 900), aacrEntry("held__out-1", "held/out", 50)] };

// One pull request's GitHub answers, in GitHub's shapes. `later` are the
// commits on the default branch that touch its file after the merge, oldest
// first: [message, the file before (its parent's), the file after, and
// options: compare, GitHub's compare status of the merge against the
// parent; capped, a file list of 300 other files].
function pullRequest(cache, repo, n, { title = `Add the pr lines ${n}`, additions = 2, deletions = 0, reviews = [["APPROVED", "rev"]], timeline = [], later = [], bot = false } = {}) {
  const head = sha1(`${repo} head ${n}`);
  const merge = sha1(`${repo} merge ${n}`);
  const own = sha1(`${repo} own ${n}`);
  const author = bot ? "dependabot[bot]" : `author${n}`;
  saveApi(cache, "pull", PATHS.pull(repo, n), { number: n, html_url: `https://github.com/${repo}/pull/${n}`, title, user: { login: author, type: bot ? "Bot" : "User" }, merged_at: MERGED, merge_commit_sha: merge, base: { ref: "main", sha: sha1(`${repo} base ${n}`) }, head: { sha: head }, additions, deletions, changed_files: 1, commits: 1, created_at: "2026-02-01T08:00:00Z" }, READ_ON);
  saveApi(cache, "reviews", PATHS.reviews(repo, n), reviews.map(([state, login], i) => ({ user: { login }, state, submitted_at: `2026-02-0${i + 2}T10:00:00Z` })), READ_ON);
  saveApi(cache, "prCommits", PATHS.prCommits(repo, n), [{ sha: own, commit: { message: title } }], READ_ON);
  saveApi(cache, "prFiles", PATHS.prFiles(repo, n), [{ filename: fileOf(n), status: "modified", additions: 2, deletions: 0, patch: patchOf(BEFORE, HEAD) }], READ_ON);
  saveApi(cache, "timeline", PATHS.timeline(repo, n), timeline, READ_ON);
  saveApi(cache, "contents", PATHS.contents(repo, fileOf(n), head), { type: "file", encoding: "base64", content: Buffer.from(HEAD).toString("base64"), sha: sha1(HEAD), size: HEAD.length }, READ_ON);
  const commits = later.map(([message, before, after, opts = {}], i) => {
    const sha = sha1(`${repo} later ${n} ${i}`);
    const parent = sha1(`${repo} parent ${n} ${i}`);
    const date = `2026-03-0${i + 1}T09:00:00Z`;
    const files = opts.capped ? Array.from({ length: 300 }, (_, k) => ({ filename: `gen/file${k}.go`, status: "modified", patch: "@@ -1 +1 @@\n-a\n+b" })) : [{ filename: fileOf(n), status: "modified", patch: patchOf(before, after) }];
    saveApi(cache, "commit", PATHS.commit(repo, sha), { sha, parents: [{ sha: parent }], commit: { message, committer: { date } }, files }, READ_ON);
    saveApi(cache, "contents", PATHS.contents(repo, fileOf(n), parent), { type: "file", encoding: "base64", content: Buffer.from(before).toString("base64"), sha: sha1(before), size: before.length }, READ_ON);
    if (opts.compare) saveApi(cache, "compare", PATHS.compare(repo, merge, parent), { status: opts.compare, ahead_by: 3, behind_by: opts.compare === "ahead" ? 0 : 2 }, READ_ON);
    return { sha, parents: [{ sha: parent }], commit: { message, committer: { date } } };
  });
  saveApi(cache, "history", PATHS.history(repo, "main", fileOf(n), MERGED, UNTIL), [...commits].reverse(), READ_ON);
  return { head, merge, own };
}

// A dev group of two repositories and a held-out group, with the AACR
// suite and split they come from, and every GitHub answer the listing needs
// for the dev groups. Nothing is written for the held-out repository, so a
// listing that asked about it would stop on the offline cache. beta/lib's
// licence file is one GitHub cannot name, so its pull requests are usable
// and published in full.
function setup() {
  const root = tempDir("oq-clean-root-");
  const cache = tempDir("oq-clean-cache-");
  writeJson(join(root, "splits", "aacr-v1.json"), SPLIT);
  writeJson(join(root, "suites", "aacr", "cases.json"), AACR);
  writeJson(join(root, "review-queue", "people.json"), { v: 1, people: ["Sid"] });
  for (const [repo, spdx] of [["acme/app", "MIT"], ["beta/lib", "NOASSERTION"], ["held/out", "MIT"]]) {
    saveRepoAnswer(cache, { asked: repo, readOn: READ_ON, found: true, fullName: repo, fork: false, source: null, licence: { spdx, key: spdx.toLowerCase(), file: "LICENSE", fileSha256: sha1(repo).padEnd(64, "0") } });
    saveApi(cache, "repo", PATHS.repo(repo), { full_name: repo, default_branch: "main" }, READ_ON);
  }
  const item = (n, extra = {}) => ({ number: n, title: `pr ${n}`, user: { type: extra.bot ? "Bot" : "User" }, created_at: "2026-02-01T08:00:00Z", pull_request: { merged_at: MERGED } });
  const acme = [11, 12, 13, 14, 15, 16, 17, 18, 19, 23, 24, 25, 26, 27, 28];
  saveApi(cache, "search", PATHS.search("acme/app", "main"), { total_count: acme.length, incomplete_results: false, items: acme.map((n) => item(n, { bot: n === 17 })) }, READ_ON);
  saveApi(cache, "search", PATHS.search("beta/lib", "main"), { total_count: 2, incomplete_results: false, items: [item(21), item(22)] }, READ_ON);

  pullRequest(cache, "acme/app", 11);
  pullRequest(cache, "acme/app", 12, { later: [["docs: add the intro lines", HEAD, LATER], ["Fix the second line the parser reads", LATER, FIX_OWN]] });
  pullRequest(cache, "acme/app", 13, { later: [["fix: nine is off by one", LATER, FIX_OTHER]] });
  const fixup = sha1("acme/app fixup 14");
  saveApi(cache, "commit", PATHS.commit("acme/app", fixup), { sha: fixup, parents: [{ sha: sha1("p") }], commit: { message: "Follow-up to #14: handle the empty list", committer: { date: LATER_DAY } }, files: [{ filename: "src/other.go", status: "modified", patch: "@@ -1 +1 @@\n-a\n+b" }] }, READ_ON);
  pullRequest(cache, "acme/app", 14, { timeline: [{ event: "referenced", created_at: LATER_DAY, commit_id: fixup, commit_url: `https://api.github.com/repos/acme/app/commits/${fixup}` }] });
  pullRequest(cache, "acme/app", 15, { reviews: [["CHANGES_REQUESTED", "rev"], ["APPROVED", "rev"]] });
  pullRequest(cache, "acme/app", 16, { additions: 1500, deletions: 200 });
  pullRequest(cache, "acme/app", 17, { bot: true });
  // A fix-up that quotes the title still names it as a fix; a release note
  // that only quotes the title, beside another entry's fix, does not; nor
  // does a commit whose fix word sits on a line that does not name it.
  const referencing = (n, message) => {
    const sha = sha1(`acme/app referencing ${n}`);
    saveApi(cache, "commit", PATHS.commit("acme/app", sha), { sha, parents: [{ sha: sha1("p") }], commit: { message, committer: { date: LATER_DAY } }, files: [{ filename: "CHANGELOG.md", status: "modified", patch: "@@ -1 +1 @@\n-a\n+b" }] }, READ_ON);
    return [{ event: "referenced", created_at: LATER_DAY, commit_id: sha, commit_url: `https://api.github.com/repos/acme/app/commits/${sha}` }];
  };
  pullRequest(cache, "acme/app", 18, { timeline: referencing(18, 'Fix the regression from "Add the pr lines 18" (#18)') });
  pullRequest(cache, "acme/app", 19, { title: "feat: keep the pr lines 19", timeline: referencing(19, "Version Packages (#90)\n\n- feat: keep the pr lines 19 (#19)\n- fix: an unrelated crash (#88)") });
  pullRequest(cache, "acme/app", 28, { timeline: referencing(28, "Update the docs\n\nSee #28 for the background.\nFix a typo in the README.") });
  // Later commits on its own lines, whatever they say.
  pullRequest(cache, "acme/app", 23, { later: [["Tidy the parser\n\nThis fixes the second line.", LATER, FIX_OWN]] });
  pullRequest(cache, "acme/app", 24, { later: [["Add the pr lines 24, reworded", LATER, FIX_OWN]] });
  // A parent without its lines: on the default branch's line (its first
  // parent holds the merge), they cannot be followed; on another branch's
  // line, the commit does not touch them.
  pullRequest(cache, "acme/app", 25, { later: [["Rework the parser", BEFORE, REWORK, { compare: "ahead" }]] });
  pullRequest(cache, "acme/app", 26, { later: [["Rework the parser", BEFORE, REWORK, { compare: "diverged" }]] });
  // A commit of 300 files or more whose list leaves out its file.
  pullRequest(cache, "acme/app", 27, { later: [["Regenerate the bindings", HEAD, HEAD, { capped: true }]] });
  pullRequest(cache, "beta/lib", 21);
  pullRequest(cache, "beta/lib", 22, {
    timeline: [{ event: "cross-referenced", created_at: LATER_DAY, source: { type: "issue", issue: { number: 30, title: "Crash on startup", created_at: LATER_DAY, state: "open", labels: [{ name: "bug" }], repository: { full_name: "beta/lib" } } } }],
  });
  return { root, cache, queue: join(root, "review-queue") };
}

async function listed(ctx) {
  const result = await listCandidates({ root: ctx.root, cache: ctx.cache, offline: true, perGroup: 20, maxEval: 30 });
  writeCandidates(result, { root: ctx.root });
  return { result, file: readJson(join(ctx.root, "suites", "clean", "candidates.json")), report: readFileSync(join(ctx.root, "suites", "clean", "ingest-report.txt"), "utf8") };
}
const names = (file) => file.candidates.map((c) => c.name).sort();
const excludedWhy = (file, name) => file.excluded.find((e) => e.name === name)?.why ?? null;
const CANDIDATES = ["acme__app-11", "acme__app-13", "acme__app-19", "acme__app-26", "acme__app-28", "beta__lib-21"];

describe("a pull request with a later fix on the same lines is offered as clean", () => {
  it("leaves out a later fix of its own lines, a fix-up naming it and a bug report linking it, and keeps a fix of other lines", async () => {
    const ctx = setup();
    const { file, report } = await listed(ctx);
    expect(names(file)).toEqual(CANDIDATES);
    expect(excludedWhy(file, "acme__app-18")).toMatch(/later commit names it/);
    expect(excludedWhy(file, "acme__app-12")).toMatch(/later commit changed lines it changed/);
    expect(file.excluded.find((e) => e.name === "acme__app-12").detail).toMatch(/Fix the second line the parser reads/);
    expect(excludedWhy(file, "acme__app-14")).toMatch(/later commit names it/);
    expect(excludedWhy(file, "beta__lib-22")).toMatch(/later issue or pull request links it/);
    expect(excludedWhy(file, "acme__app-15")).toMatch(/requested changes/);
    expect(excludedWhy(file, "acme__app-16")).toMatch(/outside AACR's range/);
    expect(excludedWhy(file, "acme__app-17")).toMatch(/bot/);
    // Every later commit on its files was checked, and is evidence.
    const kept = file.candidates.find((c) => c.name === "acme__app-13");
    const checked = kept.evidence.files[0];
    expect(checked.laterCommits).toHaveLength(1);
    expect(checked.laterCommits[0]).toMatchObject({ subject: "fix: nine is off by one" });
    expect(checked.laterCommits[0].how).toMatch(/miss the pull request's lines, which sit at 6 to 7/);
    expect(checked.laterCommits[0].url).toMatch(/^https:\/\/github\.com\/acme\/app\/commit\/[0-9a-f]{40}$/);
    expect(kept).toMatchObject({ status: "usable", repoGroup: "acme/app", language: "Go", changeLines: 2, truth: { kind: "lines", accepted: 0, rejected: 0 }, mergeBaseSha: null, prRef: "refs/pull/13/head" });
    expect(kept.id).toMatch(/^clean\/acme__app-13@[0-9a-f]{8}$/);
    expect(kept.evidence.window).toEqual({ mergedAt: MERGED, until: UNTIL });
    // The report counts every candidate and every exclusion by reason.
    expect(report).toMatch(/Listed: 6 candidates/);
    expect(report).toMatch(/a later commit changed lines it changed: 3/);
    // A second listing of the same cache writes the same files.
    const again = await listCandidates({ root: ctx.root, cache: ctx.cache, offline: true, perGroup: 20, maxEval: 30 });
    for (const [rel, body] of Object.entries(again.files)) expect(body).toBe(readFileSync(join(ctx.root, rel), "utf8"));
    // The sheet carries every candidate once, in an order its seed draws again.
    const sheet = cleanSheet(file, { seed: 7 });
    expect(sheet.items.map((i) => i.caseId).sort()).toEqual(file.candidates.map((c) => c.id).sort());
    expect(cleanSheet(file, { seed: 7 }).items.map((i) => i.caseId)).toEqual(sheet.items.map((i) => i.caseId));
  });

  it("leaves out a later commit on its lines whose fix is said only in the body, or whose subject quotes its title", async () => {
    const { file } = await listed(setup());
    expect(excludedWhy(file, "acme__app-23")).toMatch(/later commit changed lines it changed/);
    expect(file.excluded.find((e) => e.name === "acme__app-23").detail).toMatch(/Tidy the parser/);
    expect(excludedWhy(file, "acme__app-24")).toMatch(/later commit changed lines it changed/);
  });
});

describe("a line that cannot be followed is read as untouched", () => {
  it("leaves out a commit whose parent lost its lines on the default branch's line, and one too large to read", async () => {
    const { file } = await listed(setup());
    expect(excludedWhy(file, "acme__app-25")).toMatch(/lines could not be followed/);
    expect(excludedWhy(file, "acme__app-27")).toMatch(/too large to check/);
    // On another branch's line, the same commit does not touch its lines.
    const kept = file.candidates.find((c) => c.name === "acme__app-26");
    expect(kept.evidence.files[0].laterCommits[0].how).toMatch(/first parent does not hold the pull request/);
  });
});

describe("a fix word on a line that does not name the pull request", () => {
  it("keeps a pull request whose referencing commit fixes something else on another line", async () => {
    const { file } = await listed(setup());
    expect(names(file)).toContain("acme__app-28");
    expect(file.candidates.find((c) => c.name === "acme__app-28").evidence.referencedCommits).toHaveLength(1);
  });
});

describe("a candidate from a held-out repository group is refused", () => {
  it("never reads a held-out group, refuses one by name, and admit refuses one a person ruled clean", async () => {
    const ctx = setup();
    expect(candidateRefusal("acme/app", SPLIT)).toBeNull();
    expect(candidateRefusal("OLD/lib", SPLIT)).toBeNull();
    expect(candidateRefusal("held/out", SPLIT)).toMatch(/held-out group held\/out/);
    expect(candidateRefusal("stranger/repo", SPLIT)).toMatch(/no repository group/);
    // The offline cache holds nothing for held/out, so a listing that asked would stop.
    const { file } = await listed(ctx);
    expect(file.candidates.filter((c) => c.repoGroup === "held/out")).toEqual([]);
    expect(file.groups.map((g) => g.group)).toEqual(["acme/app", "beta/lib"]);
    // A candidates file edited by hand to hold a held-out pull request.
    const pull = { number: 5, baseSha: sha1("held base"), headSha: sha1("held head"), additions: 10, deletions: 2, createdAt: "2026-02-01T08:00:00Z", mergedAt: MERGED, title: "A held-out change" };
    const planted = candidateEntry({ pull, repo: "held/out", group: "held/out", language: "Go", licence: file.candidates[0].licence, evidence: {} });
    const edited = { ...file, candidates: [...file.candidates, planted] };
    writeJson(join(ctx.root, "suites", "clean", "candidates.json"), edited);
    decide("clean", [planted.id], { by: "Sid", queue: ctx.queue, sheet: cleanSheet(edited, { seed: 1 }).sheet });
    expect(() => admitClean({ root: ctx.root })).toThrow(/held-out group held\/out/);
  });
});

describe("a clean case enters a run without a person's ruling", () => {
  it("admits only a standing clean ruling a listed person signed, and every read refuses an entry without one", async () => {
    const ctx = setup();
    const { file } = await listed(ctx);
    const sheet = cleanSheet(file, { seed: 7 }).sheet;
    const id = (name) => file.candidates.find((c) => c.name === name).id;
    // No ruling: the suite is empty and a run has nothing to select.
    writeAdmit(admitClean({ root: ctx.root }), { root: ctx.root });
    expect(readJson(join(ctx.root, "suites", "clean", "cases.json")).cases).toEqual([]);
    expect(listCases({ suite: "clean", root: ctx.root })).toEqual([]);
    expect(() => selectCases({ suite: "clean", root: ctx.root })).toThrow(/holds no usable case/);
    // A model's name is refused by decide, and a line written past decide is ignored.
    expect(() => decide("clean", [id("acme__app-11")], { by: "Claude", queue: ctx.queue, sheet })).toThrow(/refused/);
    appendFileSync(join(ctx.queue, "decisions.jsonl"), `${JSON.stringify({ v: 1, caseId: id("acme__app-11"), fromSheet: null, target: { kind: "case" }, status: "clean", by: "ChatGPT", at: "2026-10-11T10:00:00Z", note: "", evidence: null })}\n`);
    const ignored = admitClean({ root: ctx.root });
    expect(ignored.suite.cases).toEqual([]);
    expect(ignored.report).toMatch(/1 line of the adjudication file is not a ruling/);
    // A person's signed rulings: two clean, one not clean.
    decide("clean", [id("acme__app-11")], { by: "Sid", queue: ctx.queue, sheet });
    decide("clean", [id("beta__lib-21")], { by: "Sid", queue: ctx.queue, sheet });
    decide("not-clean", [id("acme__app-13")], { by: "Sid", queue: ctx.queue, sheet });
    const admitted = admitClean({ root: ctx.root });
    writeAdmit(admitted, { root: ctx.root });
    expect(admitted.suite.cases.map((c) => c.name)).toEqual(["acme__app-11", "beta__lib-21"]);
    expect(admitted.suite.cases[0].ruling).toMatchObject({ by: "Sid", sheet });
    expect(admitted.report).toMatch(/Admitted: 2/);
    expect(admitted.report).toMatch(/Ruled not clean: 1/);
    expect(listCases({ suite: "clean", root: ctx.root })).toEqual([id("acme__app-11"), id("beta__lib-21")].sort());
    const c = readCase(id("acme__app-11"), { root: ctx.root });
    expect(c).toMatchObject({ suite: "clean", split: "dev", origin: "real", clean: true, repoGroup: "acme/app" });
    expect(truthOf(c).items).toEqual([]);
    const copy = specCopy(c, truthOf(c));
    expect(copy.bugs).toEqual([]);
    expect(realSpecProblems(JSON.parse(JSON.stringify(copy)), c.name, { suite: "clean", root: ctx.root })).toEqual([]);
    expect(selectCases({ suite: "clean", root: ctx.root }).map((x) => x.id)).toEqual([id("acme__app-11"), id("beta__lib-21")].sort());
    // The licence class travels with the case, so a run holding the
    // unverified one is refused at board submission.
    const unverified = readCase(id("beta__lib-21"), { root: ctx.root });
    expect(unverified.source.licence.class).toBe("unverified");
    expect(publishRefusal([{ name: unverified.name, licence: specCopy(unverified, truthOf(unverified)).source.licence.class }])).toMatch(/beta__lib-21/);
    // An entry added by hand, with no ruling, stops every read of the suite.
    const suitePath = join(ctx.root, "suites", "clean", "cases.json");
    const handAdded = { ...file.candidates.find((x) => x.name === "acme__app-19") };
    delete handAdded.evidence;
    writeJson(suitePath, { ...readJson(suitePath), cases: [...readJson(suitePath).cases, handAdded] });
    expect(() => listCases({ suite: "clean", root: ctx.root })).toThrow(/acme__app-19.*no standing clean ruling/);
    expect(() => selectCases({ suite: "clean", root: ctx.root })).toThrow(/no standing clean ruling/);
    writeAdmit(admitted, { root: ctx.root });
    // A person who changes their mind takes the case out of every run.
    decide("not-clean", [id("acme__app-11")], { by: "Sid", queue: ctx.queue, sheet });
    expect(() => readCase(id("acme__app-11"), { root: ctx.root })).toThrow(/no standing clean ruling/);
  });

  it("refuses a ruling on another version of the sheet, and admits nothing whose sheet or evidence moved since the ruling", async () => {
    const ctx = setup();
    const { file } = await listed(ctx);
    const path = join(ctx.root, "suites", "clean", "candidates.json");
    const original = readFileSync(path, "utf8");
    const id = (name) => file.candidates.find((c) => c.name === name).id;
    const sheet = cleanSheet(file, { seed: 7 }).sheet;
    expect(sheet).toMatch(/^clean@7@[0-9a-f]{12}$/);
    // A sheet that names no version of the candidates, or another one, is refused.
    expect(() => decide("clean", [id("acme__app-11")], { by: "Sid", queue: ctx.queue, sheet: "clean@7" })).toThrow(/refused: .*sheet/);
    expect(() => decide("clean", [id("acme__app-11")], { by: "Sid", queue: ctx.queue, sheet: "clean@7@000000000000" })).toThrow(/refused: .*sheet/);
    decide("clean", [id("acme__app-11")], { by: "Sid", queue: ctx.queue, sheet });
    expect(admitClean({ root: ctx.root }).suite.cases.map((c) => c.name)).toEqual(["acme__app-11"]);
    // Its evidence moved after the ruling.
    const moved = (name) => ({ ...file, candidates: file.candidates.map((c) => (c.name === name ? { ...c, evidence: { ...c.evidence, readOn: "2026-10-12" } } : c)) });
    writeJson(path, moved("acme__app-11"));
    expect(() => admitClean({ root: ctx.root })).toThrow(/acme__app-11: its evidence moved/);
    // Another candidate's evidence moved: the sheet the ruling was made on is gone.
    writeJson(path, moved("acme__app-13"));
    expect(() => admitClean({ root: ctx.root })).toThrow(/acme__app-11: ruled clean on sheet clean@7@[0-9a-f]{12}, and the candidates are now/);
    writeFileSync(path, original);
    expect(admitClean({ root: ctx.root }).suite.cases.map((c) => c.name)).toEqual(["acme__app-11"]);
  });
});
