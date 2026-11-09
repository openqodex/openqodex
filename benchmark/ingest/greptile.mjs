// Greptile's reconstructed pull requests, with two separately pinned truths.
// node benchmark/ingest/greptile.mjs [--offline | --data-only]
// Failure list, written before this code: benchmark/test/greptile-failures.md.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { benchRoot } from "../lib/cases.mjs";
import { greptileEntryProblems, greptileRows } from "../lib/greptile.mjs";
import { cacheRoot, licenceExclusion, licenceRecord } from "../lib/licence.mjs";
import { GREPTILE_HASHED, SUITES, canonicalJson, checkPinned, entryHash, exposureSplitProblems, greptileTruth, rawPath, realCaseId, sha256, suiteHashOf, truthHashOf } from "../lib/suites.mjs";
import { fetchPinned } from "./aacr.mjs";

const SOURCES = join(benchRoot, "suites/greptile/sources.json");
export const SPLIT_NAME = "greptile-v2";
const byBytes = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const cleanText = (s) => s.replace(/ *\u2014 */g, " - ");

export function validateGreptileEntry(entry, expected = entry.change) {
  const problems = greptileEntryProblems(entry, expected);
  if (problems.length > 0) throw new Error(`${entry.name}: ${problems.join("; ")}`);
}

function pinsOf(sources) {
  const corrected = sources.corrected;
  for (const pin of corrected.files) {
    const url = `https://raw.githubusercontent.com/${corrected.repo}/${corrected.revision}/${pin.path}`;
    if (pin.url !== url) throw new Error(`${pin.path}: not the corrected dataset's raw file at its pinned revision`);
  }
  if (sources.original.revision !== `sha256:${sources.original.asset.sha256}`) throw new Error("the original page revision is not its asset's content hash");
  return [sources.original.asset, ...corrected.files, ...sources.pullFiles];
}

export async function fetchGreptileData({ sources = JSON.parse(readFileSync(SOURCES, "utf8")), cache = cacheRoot(), offline = false } = {}) {
  const files = new Map();
  for (const pin of pinsOf(sources)) {
    if (pin.snapshot) {
      // GitHub's PR metadata is mutable. Keep the exact selected fields of
      // the observed response with its source response hash, rather than
      // requesting today's branch tips on a fresh cache.
      const bytes = checkPinned(Buffer.from(`${JSON.stringify(pin.snapshot, null, 2)}\n`), pin, SOURCES);
      const path = rawPath(cache, "greptile", pin);
      if (existsSync(path)) checkPinned(readFileSync(path), pin, path);
      else {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, bytes);
      }
      files.set(pin.path, bytes);
    } else files.set(pin.path, await fetchPinned(cache, "greptile", pin, { offline }));
  }
  if (sha256(canonicalJson(sources.repositories)) !== sources.repositoriesSha256) throw new Error("the saved real GitHub licence answers differ from their pin");
  return { sources, files };
}

export async function ingestGreptile({ sources, cache = cacheRoot(), offline = false, previous = null, root = benchRoot } = {}) {
  const data = await fetchGreptileData({ sources, cache, offline });
  sources = data.sources;
  const rows = greptileRows(data.files.get(sources.original.asset.path).toString("utf8"));
  const corrected = new Map(sources.corrected.files.map((pin) => [pin.path.split("/").pop(), { pin, rows: JSON.parse(data.files.get(pin.path)) }]));
  const pulls = new Map(sources.pullFiles.map((pin) => [pin.repo, { pin, rows: JSON.parse(data.files.get(pin.path)) }]));
  const repositories = new Map(sources.repositories.map((answer) => [answer.asked.toLowerCase(), answer]));
  const licences = new Map();
  const titleJoins = [];
  const entries = [];
  const seenCorrected = new Set();
  for (const original of rows) {
    const [, repo, number] = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)$/.exec(original.prUrl);
    const rawPull = pulls.get(repo);
    const matchingPulls = rawPull?.rows.filter((p) => p.number === Number(number));
    if (matchingPulls?.length !== 1) throw new Error(`${original.prUrl}: the pinned fork metadata has no unique pull request`);
    const pull = matchingPulls[0];
    if (pull.html_url !== original.prUrl || pull.base.repo.full_name.toLowerCase() !== repo.toLowerCase()) throw new Error(`${original.prUrl}: metadata describes another repository or pull request; an upstream fix is refused`);
    const rawGolden = corrected.get(original.file);
    const title = sources.titleAliases[`${original.dataset}-${number}`] ?? original.prTitle;
    const matches = rawGolden?.rows.filter((r) => r.pr_title === title);
    if (matches?.length !== 1 || seenCorrected.has(`${original.file}:${title}`)) throw new Error(`${original.prUrl}: expected one distinct corrected row titled ${JSON.stringify(title)}`);
    const golden = matches[0];
    seenCorrected.add(`${original.file}:${title}`);
    if (!Array.isArray(golden.comments) || golden.comments.length === 0 || golden.comments.some((g) => typeof g.comment !== "string" || !g.comment.trim())) throw new Error(`${original.prUrl}: corrected truth has no valid golden comments`);
    if (title !== original.prTitle) titleJoins.push(`${original.prUrl}: page title ${JSON.stringify(original.prTitle)} maps to corrected title ${JSON.stringify(title)}`);
    if (!licences.has(repo)) {
      const answer = repositories.get(repo.toLowerCase());
      if (answer?.found !== true || answer.fullName?.toLowerCase() !== repo.toLowerCase() || answer.licence === undefined) throw new Error(`${original.prUrl}: no complete pinned repository and licence answer; refusing to shrink the fifty-case suite`);
      licences.set(repo, licenceRecord(answer));
    }
    const licence = licences.get(repo);
    const excludedWhy = licenceExclusion(licence);
    if (excludedWhy) throw new Error(`${original.prUrl}: ${excludedWhy}; refusing to shrink the fifty-case suite`);
    const truthSources = {
      greptile: { url: sources.original.url, revision: sources.original.revision, readDate: sources.original.readDate, assetUrl: sources.original.asset.url },
      augment: { url: rawGolden.pin.url, revision: sources.corrected.revision, readDate: sources.corrected.readDate },
    };
    const truth = greptileTruth(original, golden, truthSources);
    const truthSets = Object.fromEntries(Object.entries(truth.sets).map(([name, set]) => {
      const pin = name === "greptile" ? sources.original.asset : rawGolden.pin;
      return [name, { kind: set.kind, items: set.items.length, hash: truthHashOf(set.items), file: pin.path, sha256: pin.sha256, source: set.source }];
    }));
    const name = `${repo.replace("/", "__")}-${number}`;
    const prev = previous?.cases.find((e) => e.name === name);
    const entry = {
      name, id: null, hash: null,
      status: excludedWhy ? "excluded" : "usable", excludedWhy,
      prUrl: original.prUrl, repo, cloneUrl: `https://github.com/${repo}.git`, prRef: `refs/pull/${number}/head`,
      baseSha: pull.base.sha, headSha: pull.head.sha,
      mergeBaseSha: prev?.baseSha === pull.base.sha && prev?.headSha === pull.head.sha ? prev.mergeBaseSha : null,
      title: cleanText(pull.title), body: cleanText(pull.body ?? ""),
      correctedTitle: golden.pr_title,
      language: original.language, changeLines: Number.isInteger(pull.additions) && Number.isInteger(pull.deletions) ? pull.additions + pull.deletions : null, prCreatedAt: pull.created_at,
      repoGroup: original.upstream.toLowerCase(), licence,
      change: { kind: "defect-bearing", prUrl: original.prUrl, baseSha: pull.base.sha, headSha: pull.head.sha, source: { url: original.prUrl, revision: pull.head.sha, readDate: rawPull.pin.readDate, file: rawPull.pin.path, sha256: rawPull.pin.sha256 } },
      truth: { kind: "prose", greptile: truthSets.greptile.items, augment: truthSets.augment.items },
      truthSets, truthHash: truthHashOf(truth.sets), matchSignatures: null,
    };
    validateGreptileEntry(entry);
    entry.hash = entryHash(entry);
    entry.id = realCaseId("greptile", name, entry.hash);
    entries.push(entry);
  }
  for (const [file, data] of corrected) {
    if (data.rows.length !== 10 || data.rows.some((r) => !seenCorrected.has(`${file}:${r.pr_title}`))) throw new Error(`${file}: not all ten corrected rows map to a reconstructed pull request`);
  }
  entries.sort((a, b) => byBytes(a.name, b.name));
  const files = pinsOf(sources).map(({ path, sha256 }) => ({ path, sha256 }));
  const dataset = { name: "Greptile's 50 reconstructed pull requests", repo: sources.corrected.repo, revision: sources.corrected.revision, url: sources.corrected.url, readDate: sources.corrected.readDate, licence: sources.corrected.licence, original: sources.original, files };
  const suite = { version: 1, suite: "greptile", dataset, hashCovers: GREPTILE_HASHED, hash: suiteHashOf(entries), cases: entries };
  // The split is not made here: its exposure comes from saved reading notes
  // (docs/benchmark.md, "Tune and score"), so the ingest reads the committed
  // file and refuses one that does not place exactly these cases.
  const splitPath = join(root, SUITES.greptile.split);
  if (!existsSync(splitPath)) throw new Error(`${splitPath} is missing: the ${SPLIT_NAME} split records exposure from saved files and is never generated`);
  const split = JSON.parse(readFileSync(splitPath, "utf8"));
  const splitProblems = [...(split.name === SPLIT_NAME ? [] : [`it is named ${split.name}`]), ...(canonicalJson(split.dataset) === canonicalJson({ repo: dataset.repo, revision: dataset.revision, files }) ? [] : ["its dataset differs from the pinned sources"]), ...exposureSplitProblems(split, entries)];
  if (splitProblems.length > 0) throw new Error(`${splitPath} does not split this suite: ${splitProblems.join("; ")}`);
  const lines = [
    `Greptile ingest: ${entries.length} cases. Usable: ${entries.filter((e) => e.status === "usable").length}. Excluded: ${entries.filter((e) => e.status !== "usable").length}.`,
    `Original labels: ${entries.reduce((n, e) => n + e.truthSets.greptile.items, 0)}. Corrected Augment comments: ${entries.reduce((n, e) => n + e.truthSets.augment.items, 0)}. Kept as two truth sets.`,
    `Original source: ${sources.original.url}; revision ${sources.original.revision}; read ${sources.original.readDate}.`,
    `Corrected source: ${sources.corrected.url}; revision ${sources.corrected.revision}; read ${sources.corrected.readDate}; licence ${sources.corrected.licence}.`,
    "The corrected JSON totals differ from its README table (145 claimed, 137 present); the JSON files are the truth source.",
    "Fork metadata snapshots and the real GitHub licence answers are retained in sources.json. The full API response hashes are recorded; a fresh cache uses the frozen selected metadata, never today's branch tips.",
    `Explicit title joins: ${titleJoins.length}.`, ...titleJoins,
    `Suite hash: ${suite.hash}. Split ${SPLIT_NAME}: tune ${split.counts.tune}, score ${split.counts.score}; ${split.counts.exposed} exposed, ${split.counts.clean} clean, exposure on record in the split file.`,
    "This suite overlaps Martian's public cases and repository groups. Materialisation is not a held-out model evaluation.",
    "Materialisation reservation: Sentry #3 introduces a gitlink at sentry-repo that the laptop shape cannot preserve. Use --reviewers model:scripted with --materialise-only to select the server shape. No model runs.",
    ...entries.map((e) => `${e.id}: greptile ${e.truthSets.greptile.items}, augment ${e.truthSets.augment.items}; ${e.status}; ${e.licence.class}${e.excludedWhy ? ` (${e.excludedWhy})` : ""}`),
  ];
  const report = `${lines.join("\n")}\n`;
  return { suite, split, report, files: { [SUITES.greptile.cases]: `${JSON.stringify(suite, null, 2)}\n`, "suites/greptile/ingest-report.txt": report } };
}

export function writeGreptileIngest(result, { root = benchRoot } = {}) {
  for (const [rel, text] of Object.entries(result.files)) {
    const path = join(root, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
}

async function main(args) {
  if (args.some((a) => !["--offline", "--data-only"].includes(a))) throw new Error("usage: node benchmark/ingest/greptile.mjs [--offline] [--data-only]");
  if (args.includes("--data-only")) {
    const { files } = await fetchGreptileData({ offline: args.includes("--offline") });
    console.log(`Greptile: ${files.size} pinned raw files ready. No suite rewritten.`);
    return;
  }
  const previousPath = join(benchRoot, SUITES.greptile.cases);
  const previous = existsSync(previousPath) ? JSON.parse(readFileSync(previousPath, "utf8")) : null;
  const result = await ingestGreptile({ offline: args.includes("--offline"), previous });
  writeGreptileIngest(result);
  process.stdout.write(result.report);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 2; });
