// Martian's offline Code Review Bench into the martian suite and its split.
//
//   node benchmark/ingest/martian.mjs [--offline]
//   node benchmark/ingest/martian.mjs --freeze-merge-base <name>
//
// --freeze-merge-base freezes the merge base of a case whose base and head
// have more than one, as for AACR (benchmark/ingest/aacr.mjs,
// docs/benchmark.md "Two merge bases").
//
// Reads the golden files pinned in benchmark/outside/boards.json (the cache
// keeps them under $OPENQODEX_BENCH_CACHE/raw/martian/<path>), and only from
// their pinned URLs; asks GitHub once per repository for its licence and
// current name, once per pull request for its base and head commits, and
// once per head whether it is still served (lib/licence.mjs, all cached);
// and writes:
//   benchmark/suites/martian/cases.json         one entry per pull request:
//                                               links, commits, licence,
//                                               group, hashes; never a
//                                               golden comment's text
//   benchmark/suites/martian/ingest-report.txt  every exclusion with its
//                                               reason and count (also printed)
//   benchmark/splits/martian-v1.json            every pull request held out
// --offline reads only the cache and stops at the first thing missing.
//
// Martian publishes 50 pull requests (upstream ones and evaluation copies
// with bugs injected) with 173 golden comments: prose with a severity and a
// category, and no file or line. So every case is origin "injected" and its
// truth is prose (PLAN-benchmark 4.2).
//
// Failure list, written before the code:
// 1. A Martian case runs on the dev split: its golden comments are public,
//    so tuning on them is contamination. The split file lists every entry
//    as held out and none in development, and lib/suites.mjs refuses a
//    request for development cases and a split file that places one there.
// 2. An upstream edit to the golden files changes the truth under a frozen
//    id: every golden file, downloaded or cached, must hash to its pin, or
//    the ingest stops and keeps nothing of it; each case's id carries a hash
//    over its truth hash.
// 3. A golden file is read from somewhere other than its pin: a pin whose
//    URL is not the board's raw file at the board's commit is refused before
//    anything is fetched.
// 4. A pull request with no licence is used: the licence of the repository
//    the code is fetched from is read the way AACR's is (lib/licence.mjs);
//    none excludes the pull request, with the reason in the entry and the
//    count in the report. A licence GitHub cannot name (Sentry's) is usable
//    as unverified, used and published in full (Sid, 2026-10-12), and
//    the report names it with a person's reading of the file.
// 5. A case is read at another commit on the next ingest, or after the pull
//    request moves: its base and head come from GitHub's cached answer for
//    the pull request (Martian names no commit), frozen in the entry.
// 6. A pull request GitHub no longer serves, or whose head it no longer
//    serves, is offered to a run: it is excluded with the reason. Martian's
//    own note on a pull request (az_comment, such as "reviewed commit is not
//    in the repo") excludes it only when its head is not served (PLAN P1
//    open question 14); the note is kept in the entry and the report.
// 7. A golden comment's text reaches a committed file: entries hold counts
//    and hashes, and the report prints counts by severity and category.
// 8. Two ingests of the same pins and cache write different files: nothing
//    reads the clock, a Map's order or a directory listing; every list is
//    sorted; a split file already written is never rewritten with other
//    content. The split depends on the golden files alone.
// 9. A row that cannot be a case (no pull request link, a link listed
//    twice, no golden comment) is used or dropped silently: it is left out
//    and named in the report with its reason.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { benchRoot } from "../lib/cases.mjs";
import { cacheRoot, commitAnswer, licenceExclusion, licenceNote, licenceRecord, pullAnswer, repoAnswer } from "../lib/licence.mjs";
import { HASHED, MARTIAN_SEVERITY, SUITES, canonicalJson, entryHash, freezeMergeBase, martianTruth, realCaseId, splitRewriteProblems, truthHashOf } from "../lib/suites.mjs";
import { HEAD_GONE, UnionFind, fetchPinned } from "./aacr.mjs";

export const SPLIT_NAME = "martian-v1";
export const PULL_GONE = "pull request not served";
const BOARDS_PATH = join(benchRoot, "outside", "boards.json");
const REPORT = "suites/martian/ingest-report.txt";

const PR_URL = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)\/?$/;
const REPO_URL = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s#?]+)/;
const key = (repo) => repo.toLowerCase();
const byBytes = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const prRef = (url) => {
  const m = PR_URL.exec(url);
  return m ? `${m[1]}/${m[2]}#${m[3]}` : url;
};
const countBy = (list, f) => {
  const m = new Map();
  for (const x of list) m.set(f(x), (m.get(f(x)) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1] || byBytes(String(a[0]), String(b[0])));
};

// W8-2 failure list: benchmark/test/greptile-failures.md. Equal totals do
// not prove a mapping: compare each identity and each complete comment.
export function verifyMartianMapping({ suite, published, rows, proofs }) {
  const differences = [];
  const byUrl = new Map(rows.map((r) => [r.row.url, r]));
  const expectedUrls = new Set(suite.cases.map((e) => e.prUrl));
  let mappedCases = 0;
  let mappedComments = 0;
  let mappedProofs = 0;
  const mappings = [];
  for (const entry of suite.cases) {
    const before = differences.length;
    const golden = byUrl.get(entry.prUrl);
    const pub = published[entry.prUrl];
    if (!pub) differences.push(`${entry.name}: missing published case ${entry.prUrl}`);
    if (!golden) differences.push(`${entry.name}: missing pinned golden row ${entry.prUrl}`);
    if (!pub || !golden) continue;
    for (const [field, expected] of [["pr_title", golden.row.pr_title], ["original_url", golden.row.original_url ?? null], ["az_comment", golden.row.az_comment ?? null], ["golden_source_file", golden.file.split("/").pop()]]) {
      if ((pub[field] ?? null) !== expected) differences.push(`${entry.name}: published ${field} differs from the pinned golden file`);
    }
    if (golden.file !== entry.goldenFile || (golden.row.original_url ?? null) !== entry.originalUrl) differences.push(`${entry.name}: suite identity differs from the pinned golden row`);
    const match = PR_URL.exec(entry.prUrl);
    if (!match || entry.repo !== `${match[1]}/${match[2]}` || entry.prRef !== `refs/pull/${match[3]}/head`) differences.push(`${entry.name}: suite repository or pull request ref differs from its published identity`);
    const comments = Array.isArray(pub.golden_comments) ? pub.golden_comments : [];
    const want = golden.row.comments;
    for (let i = 0; i < Math.max(comments.length, want.length); i++) {
      if (!comments[i]) differences.push(`${entry.name} comment g${i + 1}: missing published comment`);
      else if (!want[i]) differences.push(`${entry.name} comment g${i + 1}: extra published comment`);
      else if (canonicalJson(comments[i]) !== canonicalJson(want[i])) differences.push(`${entry.name} comment g${i + 1}: published comment differs from the pinned golden file`);
      else mappedComments++;
    }
    if (entry.truth.items !== want.length || entry.truthHash !== truthHashOf(martianTruth(golden.row).items)) differences.push(`${entry.name}: suite comment count or truth hash differs from the pinned golden file`);
    const proof = proofs.find((p) => p.name === entry.name && p.caseId === entry.id);
    if (!proof) differences.push(`${entry.name}: no proof for the suite's case id`);
    else if (proof.baseSha !== entry.baseSha || proof.headSha !== entry.headSha || (entry.mergeBaseSha && proof.mergeBaseSha !== entry.mergeBaseSha) || proof.ok !== true || proof.ancestorOfHead !== true || !["mergeBase", "builtBase", "head", "builtHead"].every((key) => typeof proof.trees?.[key] === "string" && /^[0-9a-f]{40}$/.test(proof.trees[key])) || proof.trees.mergeBase !== proof.trees.builtBase || proof.trees.head !== proof.trees.builtHead) differences.push(`${entry.name}: committed tree proof differs from the suite's frozen commits or is not proved`);
    else mappedProofs++;
    if (before === differences.length) mappedCases++;
    mappings.push(`${entry.name}: ${entry.prUrl}; ${want.length} comments g1-g${want.length}; ${before === differences.length ? "mapped" : "differs"}`);
  }
  for (const url of Object.keys(published).sort()) if (!expectedUrls.has(url)) differences.push(`${url}: extra published case outside the suite`);
  for (const { row } of rows) if (!expectedUrls.has(row.url)) differences.push(`${row.url}: pinned golden row outside the suite`);
  if (suite.cases.length !== 50 || Object.keys(published).length !== 50 || rows.length !== 50) differences.push(`case totals: suite ${suite.cases.length}, published ${Object.keys(published).length}, golden ${rows.length}; expected 50 each`);
  const comments = rows.reduce((n, r) => n + r.row.comments.length, 0);
  const publishedComments = Object.values(published).reduce((n, r) => n + (r.golden_comments?.length ?? 0), 0);
  if (comments !== 173 || publishedComments !== 173) differences.push(`comment totals: golden ${comments}, published ${publishedComments}; expected 173 each`);
  return { counts: { cases: suite.cases.length, comments, mappedCases, mappedComments, mappedProofs }, differences, mappings };
}

export async function verifyPublishedMartian({ cache = cacheRoot(), offline = false, root = benchRoot } = {}) {
  const source = JSON.parse(readFileSync(join(root, "suites/martian/verification-source.json"), "utf8"));
  const suite = JSON.parse(readFileSync(join(root, SUITES.martian.cases), "utf8"));
  const board = JSON.parse(readFileSync(join(root, "outside/boards.json"), "utf8")).boards.martian;
  if (source.revision !== board.commit || suite.dataset.revision !== source.revision || source.url !== pinnedUrl(board, source.path)) throw new Error("Martian verification source is not the suite's pinned published revision");
  const published = JSON.parse(await fetchPinned(cache, "martian", source, { offline }));
  const rows = [];
  for (const pin of board.data) {
    if (pin.url !== pinnedUrl(board, pin.path)) throw new Error(`${pin.path}: not a raw golden file at the pinned Martian revision`);
    const suitePin = suite.dataset.files.find((p) => p.path === pin.path);
    if (suitePin?.sha256 !== pin.sha256) throw new Error(`${pin.path}: suite and board pins differ`);
    for (const row of JSON.parse(await fetchPinned(cache, "martian", pin, { offline }))) rows.push({ file: pin.path, row });
  }
  const proofs = [];
  const proofDir = join(root, "index/proof");
  for (const file of readdirSync(proofDir).filter((f) => /^martian.*\.json$/.test(f)).sort()) proofs.push(...JSON.parse(readFileSync(join(proofDir, file), "utf8")).cases);
  const verified = verifyMartianMapping({ suite, published, rows, proofs });
  const report = [
    "Published Martian verification (W8-2)",
    `Source: ${source.url}; revision ${source.revision}; read ${source.readDate}; sha256 ${source.sha256}.`,
    `Cases: ${verified.counts.mappedCases}/${verified.counts.cases} mapped. Golden comments: ${verified.counts.mappedComments}/${verified.counts.comments} mapped. Tree proofs: ${verified.counts.mappedProofs}/${verified.counts.cases} mapped. Differences: ${verified.differences.length}.`,
    "The published results name URLs, titles, original URLs, golden source files and comments, but no base or head commits. Frozen commits are checked against the committed tree proofs, not inferred from the published results.",
    ...verified.mappings, ...verified.differences.map((d) => `Difference: ${d}`),
  ].join("\n") + "\n";
  return { ...verified, report, source, published, rows, proofs };
}

// The raw file of `path` at the board's commit: the only URL a golden file
// is fetched from.
const pinnedUrl = (board, path) => `https://raw.githubusercontent.com/${board.repo}/${board.commit}/${path}`;

// Why a golden row cannot be a case, or null.
function rowProblem(r) {
  if (!r || typeof r !== "object") return "the row is not an object";
  if (!PR_URL.test(r.url ?? "")) return `url ${JSON.stringify(r.url)} is not a pull request link`;
  if (!Array.isArray(r.comments) || r.comments.length === 0) return "it has no golden comment";
  for (const [i, g] of r.comments.entries()) if (typeof g?.comment !== "string" || g.comment.trim() === "") return `golden comment ${i + 1} has no text`;
  return null;
}

export async function ingestMartian({ boards, cache = cacheRoot(), offline = false, previous = null, log = () => {} }) {
  const board = boards.boards.martian;
  if (!board || !Array.isArray(board.data) || board.data.length === 0) throw new Error("benchmark/outside/boards.json pins no golden file for martian");
  for (const pin of board.data) {
    if (pin.url !== pinnedUrl(board, pin.path)) throw new Error(`${pin.path}: ${pin.url} is not the pinned URL ${pinnedUrl(board, pin.path)} (the board's raw file at ${board.commit}), so it is not fetched`);
  }
  const pins = [...board.data].sort((a, b) => byBytes(a.path, b.path));
  const files = [];
  for (const pin of pins) {
    const rows = JSON.parse((await fetchPinned(cache, "martian", pin, { offline })).toString("utf8"));
    if (!Array.isArray(rows)) throw new Error(`${pin.path} is not a list of pull requests`);
    files.push({ pin, rows });
  }

  // Rows that cannot be cases, each with its reason.
  const notCases = [];
  const urlCount = new Map();
  for (const { rows } of files) for (const r of rows) urlCount.set(r?.url, (urlCount.get(r?.url) ?? 0) + 1);
  const rows = [];
  for (const { pin, rows: list } of files) {
    for (const r of list) {
      let problem = rowProblem(r);
      if (!problem && urlCount.get(r.url) > 1) problem = `the pull request appears ${urlCount.get(r.url)} times in the golden files`;
      if (problem) notCases.push({ ref: `${pin.path}: ${typeof r?.url === "string" ? r.url : "(no link)"}`, why: problem });
      else rows.push({ file: pin.path, row: r });
    }
  }

  // GitHub's answers: licence and name for each repository a pull request is
  // in, name and fork source for each original Martian names.
  const parts = (url) => {
    const m = PR_URL.exec(url);
    return { repo: `${m[1]}/${m[2]}`, number: Number(m[3]), name: `${m[1]}__${m[2]}-${m[3]}` };
  };
  const repoOfUrl = (url) => {
    const m = REPO_URL.exec(url ?? "");
    return m ? `${m[1]}/${m[2]}` : null;
  };
  const prRepos = [...new Set(rows.map((x) => parts(x.row.url).repo))].sort(byBytes);
  const originalRepos = [...new Set(rows.map((x) => repoOfUrl(x.row.original_url)).filter(Boolean))].filter((r) => !prRepos.some((p) => key(p) === key(r))).sort(byBytes);
  const answers = new Map();
  for (const repo of prRepos) answers.set(key(repo), repoAnswer(repo, { cache, offline, licence: true }));
  for (const repo of originalRepos) answers.set(key(repo), repoAnswer(repo, { cache, offline }));

  // Groups: a repository with its current name, its fork source and the
  // original Martian names for its evaluation copy. A group is named by its
  // smallest member that is not an evaluation copy.
  const uf = new UnionFind();
  for (const repo of [...prRepos, ...originalRepos]) {
    uf.add(key(repo));
    const a = answers.get(key(repo));
    if (a?.found && a.fullName) uf.union(key(repo), key(a.fullName));
    if (a?.found && a.fork && a.source) uf.union(key(repo), key(a.source));
  }
  const copies = new Set();
  for (const { row } of rows) {
    const original = repoOfUrl(row.original_url);
    if (!original) continue;
    copies.add(key(parts(row.url).repo));
    uf.union(key(parts(row.url).repo), key(original));
  }
  const members = new Map();
  for (const k of [...uf.up.keys()].sort(byBytes)) {
    const root = uf.find(k);
    if (!members.has(root)) members.set(root, []);
    members.get(root).push(k);
  }
  const groupOf = (repo) => {
    const list = members.get(uf.find(key(repo)));
    return list.find((m) => !copies.has(m)) ?? list[0];
  };

  // Entries.
  const prevByName = new Map((previous?.cases ?? []).map((e) => [e.name, e]));
  const entries = [];
  let asked = 0;
  for (const { file, row } of rows) {
    const { repo, number, name } = parts(row.url);
    const truth = martianTruth(row);
    const truthHash = truthHashOf(truth.items);
    const answer = answers.get(key(repo));
    const licence = licenceRecord(answer);
    const pull = pullAnswer(repo, number, { cache, offline });
    if (++asked % 25 === 0) log(`GitHub's answer ready, from the cache or GitHub, for ${asked} pull requests`);
    const note = typeof row.az_comment === "string" && row.az_comment.trim() !== "" ? row.az_comment.trim() : null;
    let excludedWhy = answer?.found ? licenceExclusion(licence) : "GitHub does not know the repository (deleted, private, or moved without a redirect), so neither its licence nor its code can be read";
    if (excludedWhy === null && !pull.found) excludedWhy = `${PULL_GONE}: GitHub does not serve the pull request ${repo}#${number} (deleted, or its repository moved without a redirect), so its commits cannot be read`;
    if (excludedWhy === null && !commitAnswer(repo, pull.headSha, { cache, offline }).served) excludedWhy = `${HEAD_GONE}: GitHub no longer has the head commit ${pull.headSha.slice(0, 12)} of ${repo}, so its code cannot be fetched${note ? ` (Martian notes: ${note})` : ""}`;
    const prev = prevByName.get(name);
    const entry = {
      name,
      id: null,
      hash: null,
      status: excludedWhy ? "excluded" : "usable",
      excludedWhy,
      prUrl: row.url,
      repo,
      cloneUrl: `https://github.com/${repo}.git`,
      prRef: `refs/pull/${number}/head`,
      baseSha: pull.baseSha ?? null,
      headSha: pull.headSha ?? null,
      mergeBaseSha: prev && prev.headSha === pull.headSha && prev.baseSha === pull.baseSha ? (prev.mergeBaseSha ?? null) : null,
      language: pull.language ?? null,
      changeLines: Number.isInteger(pull.additions) && Number.isInteger(pull.deletions) ? pull.additions + pull.deletions : null,
      prCreatedAt: pull.createdAt ?? null,
      repoGroup: groupOf(repo),
      licence,
      goldenFile: file,
      originalUrl: typeof row.original_url === "string" ? row.original_url : null,
      note,
      truth: { kind: truth.kind, items: truth.items.length },
      truthHash,
      matchSignatures: null,
    };
    entry.hash = entryHash(entry);
    entry.id = realCaseId("martian", name, entry.hash);
    entries.push(entry);
  }
  entries.sort((a, b) => byBytes(a.name, b.name));
  const usable = entries.filter((e) => e.status === "usable");

  // The split: every pull request held out, from the golden files alone.
  const names = entries.map((e) => e.name);
  const split = {
    version: 1,
    name: SPLIT_NAME,
    suite: "martian",
    rule: "Every Martian pull request is held out (test): its golden comments are public, so any tuning on them is contamination. The development side is empty and there is no subset. Each pull request of the golden files is listed whatever its status; listCases offers only the usable ones, and lib/suites.mjs refuses a split that places one in development.",
    dataset: { repo: board.repo, revision: board.commit, files: pins.map((p) => ({ path: p.path, sha256: p.sha256 })) },
    cases: { dev: [], test: names },
    subsets: {},
    counts: { dev: 0, test: names.length },
  };

  const suite = {
    version: 1,
    suite: "martian",
    dataset: { name: "Martian Code Review Bench (offline)", repo: board.repo, url: board.source ?? `https://github.com/${board.repo}/tree/${board.commit}`, revision: board.commit, licence: board.licence, files: pins.map((p) => ({ path: p.path, sha256: p.sha256 })) },
    hashCovers: HASHED,
    cases: entries,
  };

  // The report.
  const lines = [];
  const say = (s = "") => lines.push(s);
  const golden = rows.flatMap((x) => x.row.comments);
  say(`Martian offline ingest: ${board.repo} at ${board.commit} (${board.licence})`);
  for (const { pin, rows: list } of files) say(`${pin.path} sha256 ${pin.sha256}: ${plural(list.length, "pull request")}, ${plural(list.reduce((n, r) => n + (Array.isArray(r?.comments) ? r.comments.length : 0), 0), "golden comment")}`);
  say();
  say(`Golden comments: ${golden.length} in ${plural(rows.length, "pull request")}.`);
  say(`  by severity: ${countBy(golden, (g) => g.severity).map(([s, n]) => `${s} ${n}`).join(", ")}`);
  say(`  by category: ${countBy(golden, (g) => g.category).map(([c, n]) => `${c} ${n}`).join(", ")}`);
  const unmapped = countBy(martianTruth({ comments: golden }).items.filter((t) => t.category === null), (t) => t.rawCategory);
  say(`  categories with no product counterpart (category null, raw kept): ${unmapped.length ? unmapped.map(([c, n]) => `${c} ${n}`).join(", ") : "none"}`);
  const offScale = golden.filter((g) => !Object.hasOwn(MARTIAN_SEVERITY, g.severity)).length;
  say(`  severities off Martian's four (severity null, raw kept): ${offScale}`);
  say();
  say(`Cases: ${plural(entries.length, "pull request")} in ${plural(prRepos.length, "repository", "repositories")}. Usable: ${usable.length}. Excluded: ${entries.length - usable.length}.`);
  say("Excluded, by reason:");
  const reasons = [
    ["licence none (no licence file)", (e) => e.excludedWhy?.startsWith("licence none"), "licence"],
    ["licence of no class this benchmark uses", (e) => e.excludedWhy?.startsWith("licence ") && !e.excludedWhy.startsWith("licence none"), "licence"],
    ["repository unknown to GitHub", (e) => e.excludedWhy?.startsWith("GitHub does not know"), "licence"],
    [`${PULL_GONE} by GitHub`, (e) => e.excludedWhy?.startsWith(PULL_GONE), "pull"],
    [HEAD_GONE, (e) => e.excludedWhy?.startsWith(HEAD_GONE), "pull"],
  ];
  for (const [label, test, kind] of reasons) {
    const hit = entries.filter((e) => e.status === "excluded" && test(e));
    const detail = kind === "pull"
      ? hit.map((e) => prRef(e.prUrl))
      : countBy(hit, (e) => e.repo).map(([r, n]) => {
          const l = hit.find((e) => e.repo === r).licence;
          return `${r} ${n}${l.spdx ? ` (${l.spdx}, ${l.file ?? "no file"})` : ""}`;
        });
    say(`  ${label}: ${plural(hit.length, "pull request")}${detail.length ? `: ${detail.join(", ")}` : ""}`);
  }
  const unverified = usable.filter((e) => e.licence.class === "unverified");
  say(`Usable with an unverified licence (GitHub names no licence it can classify; recorded as unverified, used and published in full like any other): ${plural(unverified.length, "pull request")}${unverified.length ? `: ${countBy(unverified, (e) => e.repo).map(([r, n]) => `${r} ${n} (${licenceNote(unverified.find((e) => e.repo === r).licence)})`).join(", ")}` : ""}`);
  const noted = entries.filter((e) => e.note !== null);
  say(`Martian's notes on a pull request (az_comment), kept in the entry; a noted pull request is excluded only when its head is not served: ${noted.length}${noted.length ? `: ${noted.map((e) => `${prRef(e.prUrl)} "${e.note}" (${e.status})`).join("; ")}` : ""}`);
  say(`Left out before the cases (not cases): ${notCases.length}${notCases.length ? `: ${notCases.map((x) => `${x.ref} (${x.why})`).join("; ")}` : ""}`);
  say();
  const groups = countBy(entries, (e) => e.repoGroup).sort((a, b) => byBytes(a[0], b[0]));
  say(`Repository groups (the cluster for intervals): ${groups.map(([g, n]) => `${g} ${n}${members.get(uf.find(g)).length > 1 ? ` (${members.get(uf.find(g)).join(", ")})` : ""}`).join("; ")}`);
  say(`Languages (GitHub's, of the base repository): ${countBy(entries, (e) => e.language ?? "unknown").map(([l, n]) => `${l} ${n}`).join(", ")}`);
  say();
  say(`Split ${SPLIT_NAME}: Held out: ${names.length} of ${plural(entries.length, "pull request")} (${usable.length} usable); development: none.`);
  say("No Martian pull request was materialised, reviewed or scored by this ingest.");
  const report = `${lines.join("\n")}\n`;

  return {
    suite,
    split,
    report,
    files: {
      [SUITES.martian.cases]: `${JSON.stringify(suite, null, 2)}\n`,
      [SUITES.martian.split]: `${JSON.stringify(split, null, 2)}\n`,
      [REPORT]: report,
    },
  };
}

// Writes the ingest's files under `root` (the benchmark folder). A split
// file that exists is only ever extended (lib/suites.mjs
// splitRewriteProblems): a moved or dropped case needs a new split, which is
// a new file.
export function writeMartianIngest(result, { root = benchRoot } = {}) {
  const splitPath = join(root, SUITES.martian.split);
  const old = existsSync(splitPath) ? JSON.parse(readFileSync(splitPath, "utf8")) : null;
  const problems = old ? splitRewriteProblems(old, JSON.parse(result.files[SUITES.martian.split])) : [];
  // The exposure on record comes from saved reading notes, not the golden
  // files, so a re-ingest keeps it as the file holds it.
  if (old?.exposure) result.files[SUITES.martian.split] = `${JSON.stringify({ ...JSON.parse(result.files[SUITES.martian.split]), exposure: old.exposure }, null, 2)}\n`;
  if (problems.length > 0) {
    throw new Error(`${splitPath} exists, and a new split is a new file: write it as ${SPLIT_NAME.replace(/\d+$/, (n) => String(Number(n) + 1))}, or move the old file to the Trash if no run has used it. The new split would change it:\n  ${problems.join("\n  ")}`);
  }
  const written = [];
  for (const [rel, text] of Object.entries(result.files)) {
    const path = join(root, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    written.push(path);
  }
  return written;
}

async function main(args) {
  const usage = "usage: node benchmark/ingest/martian.mjs [--offline]\n       node benchmark/ingest/martian.mjs --freeze-merge-base <name>\n       node benchmark/ingest/martian.mjs --verify-published [--offline]";
  if (args.includes("--verify-published")) {
    if (args.some((a) => !["--verify-published", "--offline"].includes(a))) throw new Error(usage);
    const verified = await verifyPublishedMartian({ offline: args.includes("--offline") });
    const path = join(benchRoot, "suites/martian/verification-report.txt");
    writeFileSync(path, verified.report);
    process.stdout.write(verified.report);
    return verified.differences.length ? 1 : 0;
  }
  if (args[0] === "--freeze-merge-base") {
    if (args.length !== 2) {
      console.error(usage);
      return 2;
    }
    const r = freezeMergeBase("martian", args[1]);
    if (r.frozen) console.log(`${r.name}: git finds ${r.bases.length} merge bases (${r.bases.join(", ")}); froze ${r.mergeBaseSha}, the first by the rule: ${r.rule}. ${r.from} is now ${r.to}.`);
    else console.log(`${r.name}: nothing frozen; ${r.mergeBaseSha ? `the entry already freezes ${r.mergeBaseSha}` : "git finds one merge base"}. The id stays ${r.from}.`);
    return 0;
  }
  const unknown = args.filter((a) => a !== "--offline");
  if (unknown.length > 0) {
    console.error(usage);
    return 2;
  }
  const boards = JSON.parse(readFileSync(BOARDS_PATH, "utf8"));
  const casesPath = join(benchRoot, SUITES.martian.cases);
  const previous = existsSync(casesPath) ? JSON.parse(readFileSync(casesPath, "utf8")) : null;
  const result = await ingestMartian({ boards, offline: args.includes("--offline"), previous, log: (s) => console.error(s) });
  writeMartianIngest(result);
  process.stdout.write(result.report);
  return 0;
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
