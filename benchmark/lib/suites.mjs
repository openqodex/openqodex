// One case interface over every suite (PLAN-benchmark 4.2): listCases,
// readCase and truthOf return the same shape for planted cases and for real
// pull requests. A real suite commits only references in
// benchmark/suites/<suite>/cases.json; its truth text stays in the pinned raw
// file in the cache ($OPENQODEX_BENCH_CACHE/raw/<board>/<path>) and is read
// from there, checked by sha256, every time. The split side and the subsets
// come from the suite's split file under benchmark/splits/.
//
// Failure list, written before the code:
// 1. An upstream edit to the dataset changes the truth under a frozen id:
//    the raw file must hash to its pin, the truth built from it must hash to
//    the entry's truthHash, and the id carries the first 8 hex of a hash that
//    covers truthHash. A mismatch anywhere refuses the read.
// 2. An id names a case whose entry has since changed (new truth, a new
//    merge base): readCase refuses, because a changed case is a new case.
// 3. A case with no licence, or one the split leaves out, is listed for a
//    run: listCases returns usable cases that the split file places only.
// 4. Third-party comment text reaches a committed file: entries hold counts
//    and hashes, never a comment.
// 5. A truth item is read with a severity, a class or matching words nobody
//    froze: real truth has severity, class and mentions null; matchSignatures
//    come only from the committed entry.
// 6. A Martian case runs on the dev split: its golden comments are public,
//    so tuning on them is contamination. A suite marked heldOutOnly lists no
//    development cases (a request for them is refused), and a split file
//    that places one of its cases in development is refused on every read.
//    Martian's prose truth keeps the dataset's severity, mapped to the
//    product's scale, beside the raw value.
// Selecting a run's cases and the truth copy each run saves (run.mjs):
// 7. A held-out (test split) case is run before a release: selectCases
//    refuses the test split and any case on it, before anything is fetched,
//    unless the caller builds and proves cases only (heldOut, run.mjs
//    --materialise-only), which reviews none and logs the access.
// 8. A case outside the subset a run names, or one the suite excludes, is
//    run under that subset's name: every case --cases names is checked
//    against the split and the subset, and each refusal names its reason.
// 9. A run's truth copy lacks a comment the suite lists, or holds a
//    rejected one, so recall is counted over the wrong set: specCopy copies
//    the accepted comments only and refuses a truth whose accepted comments
//    are not exactly the ones the suite entry counts; realSpecProblems checks
//    a saved copy the same way, and against the committed suite while it
//    still holds the case.
// The clean suite (benchmark/ingest/clean.mjs):
// 10. A clean case enters a run without a person's ruling: every read of
//    the clean suite (listCases, readCase, selectCases, realSpecProblems)
//    refuses an entry whose standing ruling in review-queue/decisions.jsonl
//    is not clean, signed by a person on review-queue/people.json
//    (lib/rulings.mjs). A clean case is clean and has no truth.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { benchRoot, buildCase, caseIdFromHash, casesRoot, git, parseCaseId, readCase as readPlantedSpec, readLock } from "./cases.mjs";
import { cacheRoot } from "./licence.mjs";
import { comparisonRelease } from "./comparison.mjs";
import { greptileEntryProblems, greptileRows } from "./greptile.mjs";
import { MERGE_BASE_RULE, materialisePr, mergeBasesOf } from "./materialise.mjs";
import { readDecisions, resolveRulings } from "./rulings.mjs";

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// JSON with object keys sorted at every level: the form every hash here is over.
export function canonicalJson(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(",")}}`;
  return JSON.stringify(v === undefined ? null : v);
}

// The real suites: where each keeps its entries and its split, the board in
// benchmark/outside/boards.json that pins its raw files, the kind of case it
// holds (PLAN-benchmark 4.2), whether every case is held out, and whether
// every case is a clean control a person ruled clean (P1-T21).
export const SUITES = {
  aacr: { board: "aacr", cases: "suites/aacr/cases.json", split: "splits/aacr-v1.json", origin: "real", heldOutOnly: false },
  martian: { board: "martian", cases: "suites/martian/cases.json", split: "splits/martian-v1.json", origin: "injected", heldOutOnly: true },
  greptile: { board: "greptile", cases: "suites/greptile/cases.json", split: "splits/greptile-v1.json", origin: "injected", heldOutOnly: false },
  clean: { board: null, cases: "suites/clean/cases.json", split: "splits/clean-v1.json", origin: "real", heldOutOnly: false, clean: true },
};

// ---------- Martian truth ----------

// Martian's golden severities and categories to the product's (PLAN-benchmark
// 4.2). A category with no counterpart is null, with the raw value kept.
export const MARTIAN_SEVERITY = { Critical: "critical", High: "major", Medium: "minor", Low: "nitpick" };
export const MARTIAN_CATEGORY = { bug: "bug", security: "security", perf: "performance", style: "style" };

// The truth of one pull request of Martian's golden files: its golden
// comments (g1, g2, ...), in the file's order.
export function martianTruth(row) {
  return {
    kind: "prose",
    items: row.comments.map((g, i) => ({
      id: `g${i + 1}`,
      text: g.comment,
      severity: MARTIAN_SEVERITY[g.severity] ?? null,
      rawSeverity: g.severity ?? null,
      category: MARTIAN_CATEGORY[g.category] ?? null,
      rawCategory: g.category ?? null,
    })),
  };
}

// Original labels and corrected comments stay in separately named sets.
// Neither set silently becomes the other's scoring denominator.
export function greptileTruth(original, corrected, sources) {
  return {
    kind: "lines",
    items: [],
    sets: {
      greptile: { kind: "prose", source: sources.greptile, items: [{ id: "g1", text: original.bugDescription, file: original.filePath, severity: MARTIAN_SEVERITY[original.severity] ?? null, rawSeverity: original.severity, severityDetail: original.severityDetail ?? null }] },
      augment: { ...martianTruth(corrected), source: sources.augment },
    },
  };
}

// ---------- AACR truth ----------

// AACR-Bench's comment categories to the product's (PLAN-benchmark 4.2).
export const AACR_CATEGORIES = { "Code Defect": "bug", "Security Vulnerability": "security", Performance: "performance", "Maintainability and Readability": "maintainability" };

function lineTruth(c, id, valid) {
  const [a, b] = [c.from_line, c.to_line];
  return {
    id,
    file: c.path,
    lines: [Math.min(a, b), Math.max(a, b)],
    also: [],
    side: c.side,
    text: c.note,
    categories: AACR_CATEGORIES[c.category] ? [AACR_CATEGORIES[c.category]] : [],
    class: null,
    severity: null,
    expectedFinder: null,
    mentions: null,
    matchSignatures: null,
    tags: c.side === "left" ? ["deletion"] : [],
    evidence: [],
    valid,
    meta: { rawCategory: c.category ?? null, context: c.context ?? null, isAi: c.is_ai_comment === true, sourceModel: c.source_model || null, ...(a > b ? { reversedLines: [a, b] } : {}) },
  };
}

// The truth of one pull request: its accepted comments (c1, c2, ...) then
// its rejected ones (r1, r2, ...), in the dataset's order.
export function aacrTruth(positiveRow, negativeRow) {
  const items = positiveRow.comments.map((c, i) => lineTruth(c, `c${i + 1}`, true));
  if (negativeRow) items.push(...negativeRow.comments.map((c, i) => lineTruth(c, `r${i + 1}`, false)));
  return { kind: "lines", items };
}

export const truthHashOf = (items) => sha256(canonicalJson(items));

// The fields a real case's hash covers: what is reviewed and what it is
// scored against. Licence, group, split and status are bookkeeping that
// never changes a review or a score, so a new licence reading keeps the id.
export const HASHED = ["name", "prUrl", "repo", "cloneUrl", "prRef", "baseSha", "headSha", "mergeBaseSha", "language", "changeLines", "truthHash", "matchSignatures"];
export const GREPTILE_HASHED = [...HASHED, "title", "body", "change", "truthSets", "correctedTitle"];
export const entryHash = (entry) => sha256(canonicalJson(Object.fromEntries((entry.truthSets ? GREPTILE_HASHED : HASHED).map((k) => [k, entry[k] ?? null]))));
export const suiteHashOf = (cases) => sha256(canonicalJson([...cases].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0).map((e) => ({ name: e.name, hash: entryHash(e) }))));
export const realCaseId = (suite, name, hash) => `${suite}/${name}@${hash.slice(0, 8)}`;

// ---------- pinned raw files ----------

export const rawPath = (cache, board, pin) => join(cache, "raw", board, pin.path);

// Throws unless `bytes` hash to the pin.
export function checkPinned(bytes, pin, where) {
  const got = sha256(bytes);
  if (got !== pin.sha256) throw new Error(`${pin.path} (${where}) has sha256 ${got}, not the pinned ${pin.sha256}. An upstream edit never changes the truth behind a frozen id: move the file to the Trash and fetch it again, or pin the new revision in benchmark/outside/boards.json, which makes new case ids.`);
  return bytes;
}

const parsed = new Map();

// A pinned raw file from the cache, checked, parsed once per process.
export function readPinned(cache, board, pin) {
  const path = rawPath(cache, board, pin);
  if (!existsSync(path)) throw new Error(`${pin.path} of board ${board} is not in the cache (${path}); run node benchmark/ingest/${board}.mjs to fetch it`);
  const bytes = checkPinned(readFileSync(path), pin, path);
  const key = `${path}\0${pin.sha256}`;
  if (!parsed.has(key)) parsed.set(key, JSON.parse(bytes.toString("utf8")));
  return parsed.get(key);
}

// ---------- reading a suite ----------

export function readSuite(suite, { root = benchRoot } = {}) {
  const def = SUITES[suite];
  if (!def) throw new Error(`no real suite named ${suite}; the real suites are ${Object.keys(SUITES).join(", ")}`);
  const path = join(root, def.cases);
  if (!existsSync(path)) throw new Error(`${path} is missing; run node benchmark/ingest/${suite}.mjs`);
  const file = JSON.parse(readFileSync(path, "utf8"));
  if (suite === "greptile") {
    for (const entry of file.cases) {
      const problems = greptileEntryProblems(entry);
      if (problems.length > 0) throw new Error(`${entry.name}: ${problems.join("; ")}`);
    }
    if (suiteHashOf(file.cases) !== file.hash) throw new Error(`${path}: the suite hash differs; a changed case changes the suite hash`);
  }
  const split = existsSync(join(root, def.split)) ? JSON.parse(readFileSync(join(root, def.split), "utf8")) : null;
  const splitBytes = split ? readFileSync(join(root, def.split)) : null;
  const dev = split?.cases?.dev ?? [];
  if (def.heldOutOnly && dev.length > 0) throw new Error(`${def.split} places ${dev.length} ${suite} case${dev.length === 1 ? "" : "s"} in development (${dev.join(", ")}), but every ${suite} case is held out: its truth is public, so tuning on it is contamination. Write the split with node benchmark/ingest/${suite}.mjs`);
  if (def.clean) {
    // Failure 10: only a person's standing clean ruling keeps an entry.
    const { lines, people } = readDecisions(join(root, "review-queue", "decisions.jsonl"));
    const R = resolveRulings(lines, people);
    const unruled = file.cases.filter((e) => R.cases.get(realCaseId(suite, e.name, e.hash))?.status !== "clean").map((e) => e.name);
    if (unruled.length > 0) throw new Error(`${def.cases} holds ${unruled.join(", ")} with no standing clean ruling by a person in review-queue/decisions.jsonl: a clean case enters a run only through a person's ruling (node benchmark/queue.mjs decide clean <case id>) and node benchmark/ingest/clean.mjs admit, never by hand`);
  }
  return { def, file, split, splitHash: splitBytes ? sha256(splitBytes) : null, byName: new Map(file.cases.map((e) => [e.name, e])) };
}

// Why `next` may not replace the split file `old`: a split file is only
// ever extended. Every case it placed keeps its side, every subset stays as
// it is, and its name and salt stay; a case may only be added. Empty when
// the rewrite is an extension (or no change).
export function splitRewriteProblems(old, next) {
  const out = [];
  for (const k of ["name", "suite", "salt"]) if ((old?.[k] ?? null) !== (next?.[k] ?? null)) out.push(`its ${k} would change from ${JSON.stringify(old?.[k] ?? null)} to ${JSON.stringify(next?.[k] ?? null)}`);
  for (const side of ["dev", "test"]) {
    for (const name of old?.cases?.[side] ?? []) {
      const now = sideIn(next, name);
      if (now !== side) out.push(now === null ? `${name} would no longer be listed (it was ${side})` : `${name} would move from ${side} to ${now}`);
    }
  }
  for (const [subset, names] of Object.entries(old?.subsets ?? {})) {
    if (JSON.stringify(next?.subsets?.[subset] ?? null) !== JSON.stringify(names)) out.push(`the subset ${subset} would change`);
  }
  return out;
}

const sideIn = (split, name) => (split?.cases?.dev?.includes(name) ? "dev" : split?.cases?.test?.includes(name) ? "test" : null);
const subsetsOf = (split, name) => Object.entries(split?.subsets ?? {}).filter(([, names]) => names.includes(name)).map(([s]) => s).sort();

// The dataset a case's truth is read from. A Martian entry names its golden
// file, so its dataset carries that file and its pin (PLAN-benchmark 4.2);
// an AACR entry reads the two files its suite's dataset names.
function datasetOf(s, entry) {
  if (!entry.goldenFile) return s.file.dataset;
  const pin = (s.file.dataset.files ?? []).find((f) => f.path === entry.goldenFile);
  return { ...s.file.dataset, file: entry.goldenFile, sha256: pin?.sha256 ?? null };
}

function realCase(suite, s, entry) {
  return {
    id: realCaseId(suite, entry.name, entry.hash),
    suite,
    name: entry.name,
    hash: entry.hash,
    split: entry.status === "usable" ? sideIn(s.split, entry.name) : null,
    splitHash: s.splitHash,
    subsets: subsetsOf(s.split, entry.name),
    origin: s.def.origin,
    repoGroup: entry.repoGroup,
    language: entry.language,
    framework: null,
    clean: s.def.clean === true,
    changeLines: entry.changeLines,
    status: entry.status,
    excludedWhy: entry.excludedWhy,
    source: { dataset: datasetOf(s, entry), repo: entry.repo, prUrl: entry.prUrl, cloneUrl: entry.cloneUrl, licence: entry.licence },
    materialise: { kind: "pr", cloneUrl: entry.cloneUrl, prRef: entry.prRef, baseSha: entry.baseSha, headSha: entry.headSha, mergeBaseSha: entry.mergeBaseSha },
    prCreatedAt: entry.prCreatedAt ?? null,
    headCommittedAt: null,
    truthHash: entry.truthHash,
    matchSignatures: entry.matchSignatures,
    truthCount: entry.truth,
    ...(suite === "greptile" ? { title: entry.title, body: entry.body, change: entry.change, truthSets: entry.truthSets, correctedTitle: entry.correctedTitle } : {}),
  };
}

// ---------- planted ----------

function plantedCase(name, lockEntry) {
  const spec = readPlantedSpec(name);
  return {
    id: caseIdFromHash(name, lockEntry.hash),
    suite: "planted",
    name,
    hash: lockEntry.hash,
    split: "dev",
    splitHash: null,
    subsets: [],
    origin: "planted",
    repoGroup: `planted/${name}`,
    language: spec.language,
    framework: spec.framework === "none" ? null : spec.framework,
    clean: spec.clean,
    changeLines: null,
    status: lockEntry.retired ? "excluded" : "usable",
    excludedWhy: lockEntry.retired ? "retired in benchmark/cases.lock.json" : null,
    source: { kind: "authored" },
    materialise: { kind: "folders", base: spec.base ?? "base", change: spec.change ?? "change", delete: "delete.txt" },
    prCreatedAt: null,
    headCommittedAt: null,
    spec,
  };
}

function plantedTruth(spec) {
  return {
    kind: "lines",
    items: spec.bugs.map((b) => ({
      id: b.id,
      file: b.file,
      lines: b.lines,
      also: b.also ?? [],
      side: "right",
      text: b.truth,
      categories: b.kind,
      class: b.class ?? null,
      severity: b.severity,
      expectedFinder: b.found_by,
      mentions: b.mentions,
      matchSignatures: null,
      tags: b.tags ?? [],
      evidence: b.evidence ?? [],
      valid: true,
      onChangedLines: null,
      meta: { anchor: b.anchor },
    })),
  };
}

// ---------- the interface ----------

// The ids of the usable cases of a suite, sorted; split "dev" or "test" and
// a subset narrow the list. A real case is listed only when its split file
// places it.
export function listCases({ suite, split = null, subset = null, root = benchRoot } = {}) {
  if (suite === "planted") {
    if (subset !== null && subset !== "all") throw new Error(`the planted suite lists no subsets (asked for ${subset})`);
    if (split === "test") return [];
    const lock = readLock(join(root, "cases.lock.json"));
    return Object.entries(lock.cases)
      .filter(([, e]) => !e.retired)
      .map(([name, e]) => caseIdFromHash(name, e.hash))
      .sort();
  }
  if (SUITES[suite]?.heldOutOnly && split === "dev") throw new Error(`every ${suite} case is held out, so the ${suite} suite has no development cases: its truth is public, and a run on it is a release run on the test split`);
  const s = readSuite(suite, { root });
  const out = [];
  for (const entry of s.file.cases) {
    if (entry.status !== "usable") continue;
    const side = sideIn(s.split, entry.name);
    if (side === null || (split !== null && side !== split)) continue;
    if (subset !== null && subset !== "all" && !(s.split?.subsets?.[subset] ?? []).includes(entry.name)) continue;
    out.push(realCaseId(suite, entry.name, entry.hash));
  }
  return out.sort();
}

// The case an id names, refused when the suite now holds that name under
// another hash (a changed case is a new case).
export function readCase(id, { root = benchRoot } = {}) {
  const p = parseCaseId(id);
  if (!p) throw new Error(`${JSON.stringify(id)} is not a case id (<suite>/<name>@<8 hex>)`);
  if (p.suite === "planted") {
    const lock = readLock(join(root, "cases.lock.json"));
    const entry = lock.cases[p.name];
    if (!entry) throw new Error(`${id}: the case lock holds no ${p.name}`);
    if (!entry.hash.startsWith(p.hash8)) throw new Error(`${id}: the lock holds ${p.name} at ${entry.hash.slice(0, 8)}, and a spec edit after a run is a new case`);
    return plantedCase(p.name, entry);
  }
  const s = readSuite(p.suite, { root });
  const entry = s.byName.get(p.name);
  if (!entry) throw new Error(`${id}: suite ${p.suite} holds no case named ${p.name}`);
  if (entryHash(entry) !== entry.hash) throw new Error(`${id}: the entry for ${p.name} in ${s.def.cases} does not hash to its own hash; an entry is written by the ingest, never by hand`);
  if (!entry.hash.startsWith(p.hash8)) throw new Error(`${id}: suite ${p.suite} now holds ${p.name} at ${entry.hash.slice(0, 8)}, and a changed case is a new case; runs of the old id compare with nothing new`);
  return realCase(p.suite, s, entry);
}

/**
 * Freezes the merge base of a case whose base and head have more than one
 * (docs/benchmark.md, "Two merge bases"): the first by MERGE_BASE_RULE,
 * the newest committer date and then the smaller commit id, found on
 * commits only in the clone cache (lib/materialise.mjs mergeBasesOf), so two
 * machines freeze the same one. The entry gets it as mergeBaseSha and a new
 * hash and id, written to the suite's cases.json; the split names cases by
 * name, so no case moves, and a later ingest keeps it while the base and the
 * head stay the same. A case with one merge base, or one already frozen, is
 * left as it is. Returns { name, from, to, bases (in the rule's order),
 * mergeBaseSha, frozen, rule }.
 */
export function freezeMergeBase(suite, name, { root = benchRoot, cache = cacheRoot(), allowFileUrl = false } = {}) {
  const s = readSuite(suite, { root });
  const entry = s.byName.get(name);
  if (!entry) throw new Error(`suite ${suite} holds no case named ${name}`);
  if (entryHash(entry) !== entry.hash) throw new Error(`the entry for ${name} in ${s.def.cases} does not hash to its own hash; an entry is written by the ingest, never by hand`);
  const from = realCaseId(suite, name, entry.hash);
  const rule = MERGE_BASE_RULE;
  if (entry.mergeBaseSha) return { name, from, to: from, bases: null, mergeBaseSha: entry.mergeBaseSha, frozen: false, rule };
  const { bases, pick } = mergeBasesOf(realCase(suite, s, entry), { cache, allowFileUrl });
  if (bases.length === 1) return { name, from, to: from, bases, mergeBaseSha: null, frozen: false, rule };
  const next = { ...entry, mergeBaseSha: pick };
  next.hash = entryHash(next);
  next.id = realCaseId(suite, name, next.hash);
  const file = { ...s.file, cases: s.file.cases.map((e) => (e.name === name ? next : e)) };
  if (suite === "greptile") file.hash = suiteHashOf(file.cases);
  writeFileSync(join(root, s.def.cases), `${JSON.stringify(file, null, 2)}\n`);
  return { name, from, to: next.id, bases, mergeBaseSha: pick, frozen: true, rule };
}

// The truth a case is scored against. A real case's truth is rebuilt from
// the pinned raw files and must hash to the entry's truthHash.
export function truthOf(c, { cache = cacheRoot() } = {}) {
  if (c.suite === "planted") return plantedTruth(c.spec ?? readPlantedSpec(c.name));
  const def = SUITES[c.suite];
  if (!def) throw new Error(`no real suite named ${c.suite}`);
  if (def.clean) {
    const truth = { kind: "lines", items: [] };
    if (truthHashOf(truth.items) !== c.truthHash) throw new Error(`${c.id}: a clean case has no truth, and its entry's truthHash is not the hash of none`);
    return truth;
  }
  if (c.suite === "greptile") {
    const sets = c.truthSets;
    const originalPin = sets.greptile;
    const originalPath = rawPath(cache, def.board, { path: originalPin.file });
    if (!existsSync(originalPath)) throw new Error(`${originalPath} is not in the cache; run node benchmark/ingest/greptile.mjs --data-only`);
    const text = checkPinned(readFileSync(originalPath), { path: originalPin.file, sha256: originalPin.sha256 }, originalPath).toString("utf8");
    const original = greptileRows(text).find((r) => r.prUrl === c.source.prUrl);
    const corrected = readPinned(cache, def.board, { path: sets.augment.file, sha256: sets.augment.sha256 }).find((r) => r.pr_title === c.correctedTitle);
    if (!original || !corrected) throw new Error(`${c.id}: a pinned truth set has no row for this case`);
    const sources = Object.fromEntries(Object.entries(sets).map(([name, set]) => [name, set.source]));
    const truth = greptileTruth(original, corrected, sources);
    for (const [name, set] of Object.entries(truth.sets)) {
      if (set.items.length !== sets[name].items || truthHashOf(set.items) !== sets[name].hash) throw new Error(`${c.id}: ${name} truth differs from its frozen count or hash`);
    }
    if (truthHashOf(truth.sets) !== c.truthHash) throw new Error(`${c.id}: its two truth sets differ from their frozen hash`);
    return truth;
  }
  if (c.suite === "martian") {
    const { file, sha256: pinned } = c.source.dataset;
    const row = readPinned(cache, def.board, { path: file, sha256: pinned }).find((r) => r.url === c.source.prUrl);
    if (!row) throw new Error(`${c.id}: ${file} holds no pull request ${c.source.prUrl}`);
    const truth = martianTruth(row);
    const hash = truthHashOf(truth.items);
    if (hash !== c.truthHash) throw new Error(`${c.id}: its truth now hashes to ${hash.slice(0, 8)}, not the frozen ${c.truthHash.slice(0, 8)}; an upstream edit never changes the truth behind a frozen id`);
    return truth;
  }
  const files = c.source.dataset.files;
  const positive = readPinned(cache, def.board, files.positive);
  const negative = readPinned(cache, def.board, files.negative);
  const at = (rows) => rows.find((r) => r.githubPrUrl === c.source.prUrl && r.target_commit === c.materialise.headSha) ?? null;
  const row = at(positive);
  if (!row) throw new Error(`${c.id}: ${files.positive.path} holds no row for ${c.source.prUrl} at ${c.materialise.headSha}`);
  const truth = aacrTruth(row, at(negative));
  const hash = truthHashOf(truth.items);
  if (hash !== c.truthHash) throw new Error(`${c.id}: its truth now hashes to ${hash.slice(0, 8)}, not the frozen ${c.truthHash.slice(0, 8)}; an upstream edit never changes the truth behind a frozen id`);
  for (const item of truth.items) {
    item.matchSignatures = c.matchSignatures?.[item.id] ?? null;
    item.onChangedLines = null;
  }
  return truth;
}

// ---------- a run's cases and its truth copies ----------

const FULL_ID = /^[a-z][a-z0-9-]*\/[^@\s]+@[0-9a-f]{8}$/;

// The cases of a real suite one run uses (failures 7 and 8): every usable
// case on the split's development side, or the subset the split file names,
// or the cases `refs` names (<suite>/<name> or a full case id), each of
// which must be on that side and in that subset. An accepted comparison
// release admits the test split on its pinned clean build and logs access.
// `heldOut` true
// (run.mjs --materialise-only, which builds and proves cases and reviews
// none, and logs the access) may select the test split. Throws one error
// whose lines name every refusal; nothing is fetched or built here.
export function selectCases({ suite, split = "dev", subset = null, refs = null, root = benchRoot, heldOut = false, release = null, build = null, packageRecord = null, runId = null, by = null, accessLog = join(cacheRoot(), "heldout-access.jsonl") }) {
  if (!SUITES[suite]) throw new Error(`no real suite named ${suite}; the real suites are ${Object.keys(SUITES).join(", ")}`);
  if (split === "test" && !heldOut && release === null) throw new Error(`the ${suite} test split is held out: no held-out case runs before a release; use --release with an accepted comparison, or --materialise-only to prove cases without a review`);
  if (split !== "dev" && split !== "test") throw new Error(`--split takes dev or test, not ${JSON.stringify(split)}`);
  const s = readSuite(suite, { root });
  const gate = split === "test" && !heldOut ? comparisonRelease({ release, suite, split, splitHash: s.splitHash, build, package: packageRecord }, { root, admit: true }) : null;
  const admitted = (cases) => {
    if (gate) {
      const access = { at: new Date().toISOString(), suite, caseCount: cases.length, caseIds: cases.map((c) => c.id), purpose: "release-run", runId, release, by, comparisonHash: gate.comparison.hash, build: gate.buildLabel };
      try {
        mkdirSync(dirname(accessLog), { recursive: true });
        appendFileSync(accessLog, `${JSON.stringify(access)}\n`);
      } catch (error) { throw new Error(`the held-out access log cannot be written (${error.message.split("\n")[0]}), so no truth is read`); }
    }
    return cases;
  };
  if (!s.split) throw new Error(`${s.def.split} is missing; run node benchmark/ingest/${suite}.mjs`);
  const subsets = Object.keys(s.split.subsets ?? {}).sort();
  if (subset !== null && subset !== "all" && !subsets.includes(subset)) throw new Error(`${s.def.split} lists no subset ${subset}; its subsets are ${subsets.join(", ")}, or all`);
  const ids = listCases({ suite, split, subset, root });
  if (refs === null) {
    if (ids.length === 0) throw new Error(`the ${split} split of ${suite}${subset ? `, subset ${subset},` : ""} holds no usable case`);
    return admitted(ids.map((id) => readCase(id, { root })));
  }
  const problems = [];
  const chosen = [];
  for (const ref of refs) {
    const full = FULL_ID.test(ref);
    const [refSuite, rest] = [ref.slice(0, ref.indexOf("/")), ref.slice(ref.indexOf("/") + 1)];
    const name = full ? rest.slice(0, rest.lastIndexOf("@")) : rest;
    const entry = s.byName.get(name);
    const why =
      refSuite !== suite ? `names a case of ${refSuite}, and this run selects ${suite}`
      : !entry ? `suite ${suite} holds no case named ${name}`
      : full && !entry.hash.startsWith(ref.slice(-8)) ? `suite ${suite} now holds ${name} at ${entry.hash.slice(0, 8)}, and a changed case is a new case`
      : entry.status !== "usable" ? `is excluded: ${entry.excludedWhy ?? "no reason recorded"}`
      : sideIn(s.split, name) === null ? "is on no side of its split"
      : sideIn(s.split, name) === "test" && split !== "test" ? "is held out: only a release run runs it"
      : sideIn(s.split, name) !== split ? `is on the development side, and this run selects the ${split} split`
      : chosen.some((c) => c.name === name) ? "is named twice"
      : !ids.includes(realCaseId(suite, name, entry.hash)) ? `is not in the subset ${subset}`
      : null;
    if (why !== null) problems.push(`${ref}: ${why}`);
    else chosen.push(readCase(realCaseId(suite, name, entry.hash), { root }));
  }
  if (problems.length > 0) throw new Error(problems.join("\n"));
  return admitted(chosen);
}

// The truth copy of a real case that a run saves as cases/<name>.json and
// scores against: the case record with its accepted comments as `bugs`
// (failure 9). The rejected comments are left out, so recall counts over the
// accepted set. The location diagnostic's knownNoise (candidates on a
// rejected comment's lines and on no accepted one) therefore reads 0 for
// now: lib/score.mjs lineMatches finds rejected comments only among `bugs`,
// and putting them there would put them in the recall denominator of the
// scanner-only score too, a scan rules change (a new SCAN_RULES_VERSION and
// a new accepted scan entry).
export function specCopy(c, truth) {
  if (c.suite === "greptile") return { ...c, bugs: [], truthSets: Object.fromEntries(Object.entries(truth.sets).map(([name, set]) => [name, { ...c.truthSets[name], ...set }])) };
  if (truth.kind === "prose") {
    // Martian: the board judge reads the golden comments (g1, g2, ...) from
    // the pinned file at conversion; the copy carries no line truth. The
    // suite's count must be the count read, or the copy would score against
    // another set.
    const want = c.truthCount?.kind === "prose" ? c.truthCount.items : undefined;
    const ids = truth.items.map((t) => t.id);
    const expected = Number.isInteger(want) ? Array.from({ length: want }, (_, i) => `g${i + 1}`) : null;
    if (expected === null || ids.join("\n") !== expected.join("\n")) {
      throw new Error(`${c.id}: its suite lists ${want ?? "no count of"} golden comments, and the truth read holds ${ids.length === 0 ? "none" : ids.join(", ")}; the copy would score against another set`);
    }
    return { ...c, bugs: [] };
  }
  const accepted = truth.items.filter((t) => t.valid !== false);
  const want = c.truthCount?.accepted;
  const ids = accepted.map((t) => t.id);
  const expected = Number.isInteger(want) ? Array.from({ length: want }, (_, i) => `c${i + 1}`) : null;
  if (expected === null || ids.join("\n") !== expected.join("\n")) {
    throw new Error(`${c.id}: its suite lists ${want ?? "no count of"} accepted comments, and the truth read holds ${ids.length === 0 ? "none" : ids.join(", ")}; the copy would score against another set`);
  }
  // Normalise quoted upstream text on the copy, leaving the pinned data intact.
  return JSON.parse(JSON.stringify({ ...c, bugs: accepted }, (_key, value) => typeof value === "string" ? value.replace(/ *\u2014 */g, " - ") : value));
}

// What is wrong with a real case's saved truth copy, as cases/<name>.json
// holds it (failure 9): a list of problems, empty when it can be scored.
// Checked on its own, then against the committed suite while the suite
// still holds the case at the copy's hash.
export function realSpecProblems(spec, name, { suite, root = benchRoot } = {}) {
  const p = [];
  const need = (cond, what) => {
    if (!cond) p.push(`${name}: ${what}`);
  };
  need(spec && typeof spec === "object", "the truth copy is not an object");
  if (!spec || typeof spec !== "object") return p;
  const id = parseCaseId(spec.id);
  need(SUITES[suite] !== undefined, `the suite ${suite} has no truth copy rules`);
  need(id !== null && id.suite === suite && id.name === name, `id must be the case id of ${suite}/${name}, not ${JSON.stringify(spec.id)}`);
  const clean = SUITES[suite]?.clean === true;
  if (suite === "greptile") {
    need(spec.origin === "injected" && spec.clean === false, "a Greptile case is injected and never clean");
    need(typeof spec.repoGroup === "string" && spec.repoGroup !== "", "repoGroup is missing");
    need(Array.isArray(spec.bugs) && spec.bugs.length === 0, "Greptile has no line truth; its board judge scores the prose sets");
    const sets = spec.truthSets;
    need(sets && Object.keys(sets).sort().join(",") === "augment,greptile", "both named judge truth sets are required");
    const truth = {};
    for (const name of ["greptile", "augment"]) {
      const set = sets?.[name];
      need(Array.isArray(set?.items) && set.items.length > 0 && truthHashOf(set.items) === set.hash, `${name}: judge truth does not match its frozen hash`);
      truth[name] = { kind: set?.kind, source: set?.source, items: set?.items };
    }
    need(truthHashOf(truth) === spec.truthHash, "the judge truth sets differ from their combined identity");
    if (id !== null) {
      const entry = readSuite(suite, { root }).byName.get(id.name);
      if (entry?.hash.startsWith(id.hash8)) need(entry.truthHash === spec.truthHash, "its truthHash is not the suite's");
    }
    return p;
  }
  const origin = SUITES[suite]?.origin ?? "real";
  need(spec.origin === origin && spec.clean === clean, clean ? "a clean suite case is real and clean" : `a pull request case is ${origin} and never clean`);
  need(typeof spec.repoGroup === "string" && spec.repoGroup !== "", "repoGroup is missing");
  if (spec.truthCount?.kind === "prose") {
    const golden = spec.truthCount.items;
    need(Number.isInteger(golden), "truthCount.items, the number of golden comments its suite lists, is missing");
    need(Array.isArray(spec.bugs) && spec.bugs.length === 0, "prose truth carries no line truth: bugs must be empty; the board judge reads the golden comments from the pinned file");
    if (id !== null && SUITES[suite]) {
      const entry = readSuite(suite, { root }).byName.get(id.name);
      if (entry?.hash.startsWith(id.hash8)) {
        need(entry.truth?.items === golden, `the suite lists ${entry.truth?.items} golden comments, and the copy says ${golden}`);
        need(entry.truthHash === spec.truthHash, "its truthHash is not the suite's");
      }
    }
    return p;
  }
  const count = spec.truthCount?.accepted;
  need(Number.isInteger(count), "truthCount.accepted, the number of accepted comments its suite lists, is missing");
  need(Array.isArray(spec.bugs), "bugs must be the list of its accepted comments");
  if (!Array.isArray(spec.bugs) || !Number.isInteger(count)) return p;
  const ids = spec.bugs.map((b) => b?.id);
  const want = Array.from({ length: count }, (_, i) => `c${i + 1}`);
  const missing = want.filter((x) => !ids.includes(x));
  const extra = ids.filter((x) => !want.includes(x));
  need(missing.length === 0, `the truth copy lacks ${missing.join(", ")} of the ${count} accepted comments its suite lists`);
  need(extra.length === 0, `the truth copy holds ${extra.join(", ")}, which ${extra.length === 1 ? "is not an accepted comment" : "are not accepted comments"}; a rejected comment would enter the recall denominator`);
  need(new Set(ids).size === ids.length, "a comment is copied twice");
  for (const b of spec.bugs) {
    need(b?.valid === true, `${b?.id}: only accepted comments are copied`);
    need(typeof b?.file === "string" && b.file !== "" && Array.isArray(b.lines) && b.lines.length === 2 && b.lines.every(Number.isInteger) && b.lines[0] <= b.lines[1], `${b?.id}: file and lines [first, last] are missing`);
    need(b?.side === "left" || b?.side === "right", `${b?.id}: side must be left or right`);
  }
  if (id !== null && SUITES[suite]) {
    const entry = readSuite(suite, { root }).byName.get(id.name);
    if (entry?.hash.startsWith(id.hash8)) {
      need(entry.truth?.accepted === count, `the suite lists ${entry.truth?.accepted} accepted comments, and the copy says ${count}`);
      need(entry.truthHash === spec.truthHash, "its truthHash is not the suite's");
    }
  }
  return p;
}

// The repository a review of the case reads, built into `into` (a new or
// empty folder) in the shape asked: laptop, the base committed and the
// change uncommitted; server, the base and the change as two commits.
// Returns { dir, shape, base, head }, the commits a server review names
// (head is null in the laptop shape of a planted case, whose change is
// never committed). A pull request case goes through the clone cache
// (lib/materialise.mjs), and its result also names upstream's commits;
// `allowFileUrl` lets a test fetch it from a local upstream.
export function materialise(c, into, { shape = "laptop", cache = cacheRoot(), heldOut = false, casesDir = casesRoot, allowFileUrl = false } = {}) {
  if (c.materialise?.kind === "pr") return materialisePr(c, into, { shape, cache, heldOut, allowFileUrl });
  if (shape !== "laptop" && shape !== "server") throw new Error(`the shape is laptop or server, not ${JSON.stringify(shape)}`);
  const { dir } = buildCase(c.name, into, casesDir);
  if (shape === "server") {
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "Change");
  }
  const at = (rev) => git(dir, "rev-parse", rev).trim();
  return shape === "server" ? { dir, shape, base: at("HEAD~1"), head: at("HEAD") } : { dir, shape, base: at("HEAD"), head: null };
}
