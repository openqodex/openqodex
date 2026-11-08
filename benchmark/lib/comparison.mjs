#!/usr/bin/env node
// Failure cases are listed in test/comparison.test.mjs before this code.
// This module reads local fingerprints only. It never runs a reviewer or
// accepts a comparison on someone's behalf.
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { benchRoot, caseHash, git, readLock } from "./cases.mjs";
import { entryProblems, hashFolder, hashReviewedFolder, sha256 } from "./index.mjs";
import { toolName } from "./aacr-board.mjs";
import { boardConfigOf, boardToolName } from "./martian-board.mjs";
import { boardRefusal } from "./board-readback.mjs";
import { bundleHash } from "./runner.mjs";
import { isPersonName, readPeople } from "./rulings.mjs";
import { canonicalJson, entryHash, readSuite, SUITES } from "./suites.mjs";
import { agreementPercentages, validateCalibration } from "./calibration.mjs";

const HEX40 = /^[a-f0-9]{40}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const text = (v) => typeof v === "string" && v.trim() !== "";
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const json = (file) => JSON.parse(readFileSync(file, "utf8"));
const hash = (v) => sha256(canonicalJson(v));
const equal = (a, b) => canonicalJson(a) === canonicalJson(b);
const need = (condition, message) => { if (!condition) throw new Error(message); };
const date = (v) => typeof v === "string" && /^\d{4}-\d{2}(-\d{2})?$/.test(v) && Number.isFinite(Date.parse(`${v.length === 7 ? `${v}-01` : v}T00:00:00Z`)) && new Date(`${v.length === 7 ? `${v}-01` : v}T00:00:00Z`).toISOString().startsWith(v);
const url = (v) => { try { return ["http:", "https:"].includes(new URL(v).protocol); } catch { return false; } };

// Sign every field, including future fields and the person and date. Only
// the signature itself is omitted, so adding a field invalidates acceptance.
export function comparisonHash(record) {
  const signed = structuredClone(record);
  if (object(signed.acceptance)) delete signed.acceptance.hash;
  return hash(signed);
}

export function buildFingerprint({ root = benchRoot } = {}) {
  const p = json(join(root, ".build/provenance.json"));
  const cli = join(root, "..", "packages/cli");
  const version = json(join(cli, "package.json")).version;
  need(p.bundleHash === bundleHash(cli), "build bundle differs from its provenance; rebuild with node benchmark/build-cli.mjs");
  return { commit: p.commit, tree: p.tree, bundleHash: p.bundleHash, version };
}

const BOARD_SCORING = { greptile: { metric: "caught rate", profile: "greptile" }, martian: { metric: "F1", profile: "core" }, aacr: { metric: "semantic recall", profile: "accepted comments, test gaps excluded" }, reviewbench: { metric: "F1", profile: "official" } };
export function boardFingerprint(name, { root = benchRoot } = {}) {
  const metadata = json(join(root, "outside/boards.json"));
  const board = metadata.boards?.[name];
  need(board && HEX40.test(board.commit) && text(board.repo), `board ${name}: missing repository or commit pin`);
  const judge = board.judge;
  const deployment = judge?.deployment ? metadata.deployments?.[judge.deployment] : null;
  const model = deployment?.served ?? judge?.id;
  const promptHash = judge?.calibrationPrompts?.sha256 ?? judge?.prompt?.sha256 ?? judge?.sha256;
  need(text(model) && HEX64.test(promptHash ?? ""), `board ${name}: missing judge model or prompt hash`);
  need(BOARD_SCORING[name], `board ${name}: no metric and profile defined`);
  return { name, repository: board.repo, commit: board.commit, judgeModel: model, promptHash, ...BOARD_SCORING[name], pinHash: hash({ board, deployment }) };
}

export function suiteFingerprint(suite, { root = benchRoot } = {}) {
  if (suite === "planted") {
    const lock = readLock(join(root, "cases.lock.json"));
    const caseHashes = {};
    for (const [name, entry] of Object.entries(lock.cases).sort(([a], [b]) => a.localeCompare(b))) {
      const actual = caseHash(name, join(root, "cases"));
      need(actual === entry.hash, `suite planted: case ${name} differs from its frozen hash`);
      caseHashes[name] = actual;
    }
    return { caseHashes, splitHash: null, fileHash: hash(lock) };
  }
  const s = readSuite(suite, { root });
  const caseHashes = {};
  for (const entry of s.file.cases) {
    need(entryHash(entry) === entry.hash, `suite ${suite}: case ${entry.name} differs from its frozen hash`);
    need(!Object.hasOwn(caseHashes, entry.name), `suite ${suite}: duplicate case ${entry.name}`);
    caseHashes[entry.name] = entry.hash;
  }
  return { caseHashes, splitHash: s.splitHash, fileHash: hash(s.file) };
}

// Freeze the repository's current pins, never an inferred signer or run.
export function freezeComparison({ release, boards, suites, reviewers, capUsd }, { root = benchRoot, build = buildFingerprint({ root }) } = {}) {
  const record = {
    version: 1, release,
    boards: Object.fromEntries(boards.map((name) => [name, boardFingerprint(name, { root })])),
    suites: Object.fromEntries(suites.map((name) => [name, suiteFingerprint(name, { root })])),
    build, reviewers, calibrations: [], calibrationRulings: [], capUsd, runs: [],
    acceptance: { person: "", date: "", hash: "" },
  };
  validateComparison(record, { root, build });
  return record;
}

// References must stay under benchmark, including through symbolic links.
function reference(root, file, kind) {
  need(text(file) && !isAbsolute(file) && !file.split(/[\\/]/).includes(".."), `${kind}: file must be relative to benchmark`);
  const path = resolve(root, file);
  need(existsSync(path), `${kind}: ${file} does not exist`);
  need(realpathSync(path).startsWith(`${realpathSync(root)}${sep}`), `${kind}: ${file} leaves benchmark`);
  return path;
}
function committedRunEntry(root, runId) {
  const path = reference(root, `index/runs/${runId}.json`, "run");
  const bytes = readFileSync(path);
  const message = `run ${runId} entry is not committed at HEAD; commit it before attaching`;
  let committed;
  try {
    const repo = git(root, "rev-parse", "--show-toplevel").trim();
    committed = git(repo, "show", `HEAD:${relative(realpathSync(repo), realpathSync(path)).split(sep).join("/")}`);
  } catch { throw new Error(message); }
  need(bytes.equals(Buffer.from(committed, "utf8")), message);
  return bytes;
}
const buildProblems = (b) => object(b) && HEX40.test(b.commit ?? "") && HEX40.test(b.tree ?? "") && HEX64.test(b.bundleHash ?? "") && text(b.version);
const suiteCaseIds = (name, suite) => Object.entries(suite.caseHashes).map(([c, h]) => `${name}/${c}@${h.slice(0, 8)}`);
const sameIds = (a, b) => Array.isArray(a) && equal([...a].sort(), [...b].sort());

// These are the files the board readers hash, rather than every work file
// a board pipeline happened to leave behind.
function validateRunBoard(entry, folder, ids, casesNotRun, pin, options) {
  const name = SUITES[entry.suite]?.board;
  if (!name) return;
  const block = entry.outside?.[name];
  const at = `run ${entry.runId} outside.${name}`;
  need(object(block), `run ${entry.runId} needs a non-null outside.${name} block`);
  if (name === "greptile") {
    need(block.truthSet === pin.profile, `${at} truth set differs from the comparison profile`);
    need(block.board?.commit === pin.commit && block.board?.promptHash === pin.promptHash && block.board?.judgeModel === pin.judgeModel, `${at} board pins differ from the comparison pin`);
    need(block.judgeModel === null || block.judgeModel === pin.judgeModel, `${at} judge model differs from the comparison pin`);
  } else need(block.judge?.deployment === pin.judgeModel, `${at} judge model differs from the comparison pin`);
  if (name === "aacr") need(Array.isArray(block.problems) && block.problems.length === 0, `${at} has problems: ${block.problems?.join("; ") ?? "no problem list"}`);
  const tools = name === "aacr" ? Object.fromEntries(block.folders.map((t) => [t.tool, t])) : block.perTool;
  for (const [tool, t] of Object.entries(tools)) if (t.held?.length) {
    const why = Array.isArray(t.held) ? t.held.map((h) => `${h.case} index ${h.index}: lacks ${h.lacking.join(", ")}`).join("; ") : t.held;
    throw new Error(`${at} tool ${tool} is held by the judge: ${why}`);
  }
  const paths = name === "greptile" ? ["input.json", "eval.json", ...Object.keys(tools).map((tool) => `${tool}/verdicts.json`)]
    : name === "martian" ? ["convert.json", "eval.json", "benchmark_data.json", ...Object.keys(tools).map((tool) => `${tool}/evaluation.json`)]
      : ["convert.json", ...(existsSync(join(folder, "outside/aacr/eval.json")) ? ["eval.json"] : []), ...block.folders.flatMap((t) => t.metrics.map((file) => `${t.config}/r${t.repeat}/${file}`))];
  const evidence = paths.map((path) => `outside/${name}/${path}`);
  for (const path of evidence) reference(folder, path, `${at} evidence`);
  need(hashFolder(folder, evidence).listHash === block.evidenceHash, `${at} evidence hash differs from its board files`);
  const convert = name === "greptile" ? null : json(join(folder, "outside", name, "convert.json"));
  for (const config of entry.configs) for (let repeat = 1; repeat <= entry.repeat; repeat++) {
    const tool = name === "aacr" ? toolName(config, repeat) : boardToolName(config, repeat);
    const t = tools[tool];
    need(t && t.config === config && t.boardConfig === (name === "aacr" ? config : boardConfigOf(config)), `${at} is missing tool ${tool} or its configuration`);
    let accounted;
    if (name === "greptile") {
      const notRun = t.labels.filter((c) => c.reason === "not-run").map((c) => c.id);
      accounted = t.of === ids.length && t.planned === entry.caseIds.length && t.notRun === casesNotRun.length && t.planned + t.notRun === ids.length && sameIds(notRun, casesNotRun);
    }
    else if (name === "martian") {
      const notRun = t.empty.filter((c) => c.reason === "not-run").map((c) => c.caseId);
      accounted = sameIds(convert.cases?.map((c) => c.caseId), ids) && sameIds(notRun, casesNotRun) && entry.caseIds.length + notRun.length === ids.length;
    } else {
      need(t.judged === true, `${at} tool ${tool} is not judged: ${t.why}`);
      const converted = convert.folders?.find((f) => f.tool === tool);
      accounted = casesNotRun.length === 0 && converted?.files === ids.length && t.rounds.length > 0 && t.rounds.every((r) => r.evaluated === ids.length && r.missing === 0);
    }
    need(accounted, `${at} tool ${tool} has incomplete case accounting for the frozen suite`);
  }
  const refusal = boardRefusal(folder, entry.runId, { [name]: block }, options);
  need(refusal === null, refusal);
}

// Both judges check compatibility before forecasting or contacting a provider.
export function validateRunManifest(manifest, record) {
  const need = (ok, why) => { if (!ok) throw new Error(`the run's ${why}`); };
  const names = Object.keys(manifest.reviewers ?? {});
  need(names.length > 0, "reviewers are missing");
  for (const name of names) {
    const pin = Object.values(record.reviewers).find((r) => r.reviewer === name);
    need(pin, `reviewer ${name} has no comparison pin`);
    if (name !== "control") {
      const b = manifest.build;
      need(equal(b && { commit: b.commit, tree: b.tree, bundleHash: b.bundleHash, version: b.cliVersion ?? b.version }, record.build), "build differs from the comparison build");
    } else need(text(pin.version), "control reviewer must pin its Claude Code version");
    const saved = manifest.reviewers[name];
    need(saved.model === pin.model, `reviewer ${name} model differs from the comparison pin`);
    need(pin.version === undefined || saved.version === pin.version, `reviewer ${name} version differs from the comparison pin`);
    for (const field of ["effort", "maxOutputTokens"]) need((saved.settings?.[field] ?? null) === pin[field], `reviewer ${name} ${field} differs from the comparison pin`);
    need(manifest.path === pin.path, `path differs from reviewer ${name}'s comparison pin`);
    need(manifest.web === undefined || manifest.web === pin.web, `web setting differs from reviewer ${name}'s comparison pin`);
    const config = `${name.replace(/:/g, "-")}-graph-${pin.graph}`;
    need(Array.isArray(manifest.configs) && manifest.configs.length > 0 && manifest.configs.every((c) => (typeof c === "string" ? c : c?.id) === config), `configs differ from reviewer ${name}'s graph setting in the comparison pin`);
  }
}

// Refuse stale or incomplete fingerprints even while the record is unsigned.
// Empty acceptance is valid metadata, and always returns accepted: false.
export function validateComparison(record, { root = benchRoot, build } = {}) {
  need(object(record) && record.version === 1, "comparison version must be 1");
  need(text(record.release) && /^[a-z0-9][a-z0-9.-]*$/.test(record.release), "comparison release is missing or malformed");
  for (const field of ["boards", "suites", "reviewers"]) need(object(record[field]) && Object.keys(record[field]).length > 0, `comparison ${field} must not be empty`);
  need(buildProblems(record.build), "comparison build must give commit, tree, bundleHash and version");
  need(equal(record.build, build ?? buildFingerprint({ root })), "comparison build fingerprint no longer matches the build");
  for (const [name, pin] of Object.entries(record.boards)) need(equal(pin, boardFingerprint(name, { root })), `comparison board ${name} no longer matches its judge, prompt, metric or profile`);
  for (const [name, pin] of Object.entries(record.suites)) {
    need(name === "planted" || SUITES[name], `comparison suite ${name} is unknown`);
    need(equal(pin, suiteFingerprint(name, { root })), `comparison suite ${name} case hashes or split no longer match`);
    if (SUITES[name]?.board) need(record.boards[SUITES[name].board], `comparison suite ${name} has no board pin`);
  }
  for (const [name, r] of Object.entries(record.reviewers)) need(object(r) && ["server", "laptop"].includes(r.path) && text(r.reviewer) && text(r.model) && ["on", "off"].includes(r.graph) && ["on", "off"].includes(r.web) && (r.effort === null || text(r.effort)) && ((r.path === "laptop" && r.maxOutputTokens === null) || (Number.isInteger(r.maxOutputTokens) && r.maxOutputTokens > 0)), `comparison reviewers.${name} must pin path, reviewer, model, graph, web, effort and maxOutputTokens`);
  need(Number.isFinite(record.capUsd) && record.capUsd > 0, "comparison capUsd must be positive dollars");
  need(Array.isArray(record.calibrations), "comparison calibrations must be an array");
  need(record.calibrationRulings === undefined || Array.isArray(record.calibrationRulings), "comparison calibrationRulings must be an array");
  const rulings = new Map();
  for (const ruling of record.calibrationRulings ?? []) {
    need(object(ruling) && text(ruling.board), "calibration ruling must name a board");
    need(isPersonName(ruling.decidedBy, readPeople(join(root, "review-queue"))), "calibration ruling must name a person in review-queue/people.json");
    need(date(ruling.decidedOn) && ruling.decidedOn.length === 10, "calibration ruling must give a calendar date with a day");
    need(object(ruling.agreement) && Object.keys(ruling.agreement).length > 0 && Object.values(ruling.agreement).every((v) => Number.isFinite(v) && v >= 0 && v <= 100), "calibration ruling agreement must give per-class percentages");
    need(!rulings.has(ruling.board), `duplicate calibration ruling for ${ruling.board}`);
    rulings.set(ruling.board, ruling);
  }
  const boards = Object.fromEntries(Object.entries(record.boards).map(([name, board]) => [name, { ...board, judgeAgreement: null }]));
  const calibrationBoards = new Set();
  const calibrationFiles = new Set();
  for (const c of record.calibrations) {
    need(object(c) && HEX64.test(c.sha256 ?? "") && buildProblems(c.build) && object(c.agreement) && Object.keys(c.agreement).length > 0 && Object.values(c.agreement).every(Number.isFinite), "calibration must pin file, sha256, build and agreement numbers");
    need(equal(c.build, record.build), `calibration ${c.file} build differs from the comparison build`);
    need(!calibrationFiles.has(c.file), "duplicate calibration file"); calibrationFiles.add(c.file);
    const file = reference(root, c.file, "calibration");
    need(sha256(readFileSync(file)) === c.sha256, `calibration ${c.file} no longer matches its hash`);
    const calibration = json(file);
    need(equal(calibration.build, c.build), `calibration ${c.file} build differs from its reference`);
    need(equal(calibration.agreement, c.agreement), `calibration ${c.file} agreement differs from its reference`);
    const calibrationBoard = record.boards[calibration.board?.name];
    need(calibrationBoard, `calibration ${c.file} has no matching comparison board`);
    const name = calibrationBoard.name;
    const judgeAgreement = agreementPercentages(calibration.agreement);
    const ruling = rulings.get(name);
    if (ruling) need(equal(ruling.agreement, judgeAgreement), `calibration ruling ${name} agreement differs from its calibration record`);
    validateCalibration(calibration, { build: record.build, board: calibrationBoard, agreementRuling: ruling?.agreement });
    need(!calibrationBoards.has(name), `duplicate calibration board ${name}`);
    calibrationBoards.add(name);
    boards[name].judgeAgreement = judgeAgreement;
  }
  for (const name of rulings.keys()) need(calibrationBoards.has(name), `calibration ruling ${name} has no calibration record`);
  need(Array.isArray(record.runs), "comparison runs must be an array");
  const runs = new Set();
  for (const r of record.runs) {
    need(object(r) && /^\d{4}-\d{2}-\d{2}-[A-Za-z0-9._-]+$/.test(r.runId ?? "") && HEX64.test(r.sha256 ?? ""), "run must pin runId and sha256");
    need(!runs.has(r.runId), `duplicate run ${r.runId}`); runs.add(r.runId);
    const path = reference(root, `index/runs/${r.runId}.json`, "run");
    const bytes = readFileSync(path);
    need(sha256(bytes) === r.sha256, `run ${r.runId} no longer matches its hash`);
    const e = JSON.parse(bytes.toString("utf8"));
    need(e.runId === r.runId && entryProblems(e).length === 0, `run ${r.runId} has an invalid index entry`);
    const suite = record.suites[e.suite];
    need(suite && e.splitHash === suite.splitHash && Array.isArray(e.caseIds) && e.caseIds.length > 0 && e.caseIds.every((id) => Object.entries(suite.caseHashes).some(([name, h]) => id === `${e.suite}/${name}@${h.slice(0, 8)}`)), `run ${r.runId} differs from the comparison suite`);
    const ids = suiteCaseIds(e.suite, suite);
    need(Array.isArray(r.casesNotRun) && sameIds([...e.caseIds, ...r.casesNotRun], ids), `run ${r.runId} caseIds and casesNotRun must account for every frozen suite case exactly once`);
    const folder = reference(root, `results/${r.runId}`, "run folder");
    const { listHash } = hashReviewedFolder(folder);
    need(listHash === e.asset.listHash || listHash === e.privateListHash, `run ${r.runId} folder differs from its asset or private list hash`);
    const manifest = json(reference(root, `results/${r.runId}/manifest.json`, "run manifest"));
    need(manifest.build?.commit === e.build.commit && manifest.build?.bundleHash === e.build.bundleHash, `run ${r.runId} build differs from its manifest`);
    const tree = e.build?.tree ?? manifest.build?.tree;
    const reviewer = record.reviewers[r.reviewer];
    if (reviewer?.reviewer === "control") need(text(reviewer.version), `run ${r.runId} control reviewer must pin its Claude Code version`);
    else need(equal({ commit: e.build.commit, tree, bundleHash: e.build.bundleHash, version: e.build.cliVersion }, record.build), `run ${r.runId} build differs from the comparison build`);
    need(reviewer && e.path === reviewer.path && e.web === reviewer.web && e.reviewers?.[reviewer.reviewer]?.model === reviewer.model && (reviewer.version === undefined || e.reviewers[reviewer.reviewer].version === reviewer.version) && e.configs.every((c) => c === `${reviewer.reviewer.replace(/:/g, "-")}-graph-${reviewer.graph}`), `run ${r.runId} differs from its reviewer settings`);
    for (const [name, entryReviewer] of Object.entries(e.reviewers)) {
      const saved = manifest.reviewers?.[name];
      need(saved && saved.version === entryReviewer.version && saved.model === entryReviewer.model, `run ${r.runId} reviewer ${name} differs from its manifest`);
    }
    const settings = manifest.reviewers?.[reviewer.reviewer]?.settings;
    need((settings?.effort ?? null) === reviewer.effort && (settings?.maxOutputTokens ?? null) === reviewer.maxOutputTokens, `run ${r.runId} differs from its reviewer settings`);
    validateRunBoard(e, folder, ids, r.casesNotRun, record.boards[SUITES[e.suite]?.board], { root });
  }
  const a = record.acceptance;
  need(object(a) && ["person", "date", "hash"].every((f) => typeof a[f] === "string"), "comparison acceptance must give person, date and hash");
  const unsigned = a.person === "" && a.date === "" && a.hash === "";
  need(unsigned || (isPersonName(a.person, readPeople(join(root, "review-queue"))) && date(a.date) && a.date.length === 10 && HEX64.test(a.hash) && a.hash === comparisonHash(record)), "comparison acceptance must name a person in review-queue/people.json, give a date and hash the complete record");
  return { accepted: !unsigned, hash: comparisonHash(record), boards };
}

// A comparison release uses the accepted record committed on this branch.
// Admission checks the checkout; runtime access is logged in the cache.
// Conversion and a judge check the run's saved build against the record;
// only admission also checks the installed bundle and its provenance.
export function comparisonRelease(manifest, { root = benchRoot, admit = false } = {}) {
  const { release, suite, split, splitHash, build: b, package: p } = manifest;
  need(typeof release === "string" && /^[a-z0-9][a-z0-9.-]*$/.test(release), "comparison release is missing or malformed");
  const file = join(root, "index/comparisons", `${release}.json`);
  need(existsSync(file), `local build release ${release} has no committed comparison record`);
  const repo = git(root, "rev-parse", "--show-toplevel").trim();
  const bytes = readFileSync(file, "utf8");
  let committed;
  try { committed = git(repo, "show", `HEAD:${relative(realpathSync(repo), realpathSync(file)).split(sep).join("/")}`); }
  catch { throw new Error(`comparison ${release} must be committed on this branch`); }
  need(bytes === committed, `comparison ${release} differs from its committed record`);
  const record = JSON.parse(bytes);
  need(record.release === release, "comparison record names another release");
  // The record keeps the build its runs were made on: a conversion or a
  // judge on a later checkout validates it on that build (the run's own
  // build is checked against it below); only a run made now needs the
  // pinned build checked out and built.
  const checked = validateComparison(record, { root, build: record.build });
  need(checked.accepted, `comparison ${release} is not accepted`);
  if (admit) need(equal(record.build, buildFingerprint({ root })), "comparison release requires the pinned build checked out and built");
  for (const r of record.runs) committedRunEntry(root, r.runId);
  need(p?.spec === "local" && p.commit === record.build.commit && p.dirty === false, "comparison release requires its pinned clean local build");
  const fingerprint = b ? { commit: b.commit, tree: b.tree, bundleHash: b.bundleHash, version: b.cliVersion ?? b.version } : null;
  need(equal(fingerprint, record.build), "comparison build fingerprint differs from the run's build");
  need(b.dirty === false && b.commitTree === b.tree && git(repo, "rev-parse", `${b.commit}^{tree}`).trim() === b.tree, "comparison build must be clean and match its commit tree");
  if (admit) {
    const provenance = json(join(root, ".build/provenance.json"));
    need(provenance.dirty === false && provenance.commitTree === b.tree, "comparison build provenance must be clean");
  }
  need(record.suites[suite] && split === "test" && record.suites[suite].splitHash === splitHash, "comparison suite or test split differs from the accepted pins");
  if (admit) need(git(repo, "status", "--porcelain").trim() === "", "comparison release requires a clean checkout; the tree is dirty");
  return { release, package: p, comparison: { release, hash: checked.hash }, buildLabel: `local build ${b.commit}` };
}

// One product per board. Secondary metrics stay on that row, so F1 and
// precision cannot accidentally be printed as separate products.
export function validateOutsideRows(data, { root = benchRoot } = {}) {
  need(object(data) && data.version === 1 && Array.isArray(data.rows) && data.rows.length > 0, "outside rows version must be 1 with nonempty rows");
  const seen = new Set();
  for (const [i, row] of data.rows.entries()) {
    const at = `outside row ${i + 1}`;
    need(object(row), `${at} must be an object`);
    for (const field of ["board", "product", "metric", "measuredBy"]) need(text(row[field]), `${at}: ${field} is missing`);
    need(Number.isFinite(row.value) && row.value >= 0 && row.value <= 100, `${at}: value must be a percentage from 0 to 100`);
    for (const field of ["measurementDate", "readDate"]) need(date(row[field]), `${at}: ${field} must be a calendar date or month`);
    need(row.readDate.length === 10, `${at}: readDate must include the day`);
    need(url(row.source), `${at}: source must be a URL`);
    if (["greptile-original", "augment-corrected"].includes(row.board) || row.snapshot !== undefined) {
      const s = row.snapshot;
      need(object(s) && text(s.file) && s.file.startsWith("index/outside-sources/") && HEX64.test(s.sha256 ?? ""), `${at}: snapshot must pin a file under index/outside-sources and its sha256`);
      need(sha256(readFileSync(reference(root, s.file, `${at} snapshot`))) === s.sha256, `${at}: snapshot no longer matches its hash`);
    }
    const g = row.goldenSet;
    need(object(g) && text(g.identity) && text(g.revision) && url(g.source), `${at}: goldenSet must give identity, revision and source URL`);
    if (row.metrics !== undefined) need(object(row.metrics) && Object.entries(row.metrics).every(([k, v]) => text(k) && Number.isFinite(v) && v >= 0 && v <= 100), `${at}: metrics must be named percentages`);
    const key = `${row.board}\0${row.product}`;
    need(!seen.has(key), `${at}: duplicate product on board`); seen.add(key);
  }
  return data.rows;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [flag, file, ...extra] = process.argv.slice(2);
    need(file && ((extra.length === 0 && ["--outside-rows", "--comparison"].includes(flag)) || (flag === "--attach" && extra.length === 2)), "usage: node benchmark/lib/comparison.mjs --outside-rows <file> | --comparison <file> | --attach <record> <runId> <reviewer>");
    const record = json(file);
    let result;
    if (flag === "--attach") {
      const [runId, reviewer] = extra;
      need(Array.isArray(record.runs), "comparison runs must be an array");
      need(!record.runs.some((r) => r.runId === runId), `duplicate run ${runId}`);
      need(/^\d{4}-\d{2}-\d{2}-[A-Za-z0-9._-]+$/.test(runId), "run must pin runId and sha256");
      const bytes = committedRunEntry(benchRoot, runId);
      const entry = JSON.parse(bytes.toString("utf8"));
      // A stopped run lists the cases it planned, not the ones it reviewed, so
      // its unreviewed cases would count as misses under a full case list.
      need(entry.ended?.how === "finished", `run ${runId} ended ${entry.ended?.how ?? "unknown"}; only a finished run attaches`);
      need(record.suites?.[entry.suite], `run ${runId} differs from the comparison suite`);
      const casesNotRun = suiteCaseIds(entry.suite, record.suites[entry.suite]).filter((id) => !entry.caseIds?.includes(id));
      record.acceptance = { person: "", date: "", hash: "" };
      record.runs.push({ runId, sha256: sha256(bytes), reviewer, casesNotRun });
      result = validateComparison(record, { build: record.build });
      writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
    } else result = flag === "--outside-rows" ? validateOutsideRows(record) : validateComparison(record);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
