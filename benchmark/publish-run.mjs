#!/usr/bin/env node
// Publishes one results folder as one asset, <run-id>.tar.gz, on the
// benchmark-data pre-release, and writes its index entry:
//
//   node benchmark/publish-run.mjs <results folder> [--dry-run] [--write-index] [--out <dir>]
//
// Steps: score the run when it has no score.json; for a legacy run (one with
// a recipe in benchmark/legacy/recipes.json) check that the folder is the one
// the recipe's commit holds, and add the scorer of every commit that wrote
// one of its score files under _archive/<commit>/benchmark/ with the recipe
// as _archive/recipe.json; keep only the files on the allowlist; inspect
// every kept file; package; unpack the package again and compare its file
// list; then, without --dry-run, upload it with gh (creating the pre-release
// on first use, never marked latest) and write benchmark/index/runs/<run-id>.json.
// --dry-run uploads nothing and prints the entry; --write-index writes the
// entry even so. The package is deterministic, so an entry written by a dry
// run names the very asset a later upload sends. Only the session uploads;
// a builder runs --dry-run. For a run that already has an entry,
// --write-index changes only the entry's board numbers (outside) and uploads
// nothing. It refuses a run that packages to another asset than the entry names.
// Board numbers enter an entry only when they equal what the run's board
// output gives. For an accepted entry, the refresh also records their hash
// (boardHash) in benchmark/index/accepted.json.
//
// Exit codes: 0 published (or, with --dry-run, ready); 1 refused (a hit in
// the inspection, a folder that is not the recipe's, an asset that differs
// from the committed entry, an asset already uploaded); 2 the tool failed.
//
// Failure list, written before the code:
// 1. A file nobody meant to publish leaves (a rendering, the judge's raw
//    answers, a new file kind): only the allowlist below is packaged; every
//    other file is named as left out.
// 2. A secret leaves: every packaged file, briefs, traces, transcripts,
//    submissions and rounds included, is searched for each case's generated
//    secret value, this machine's home folder path, a home folder path of any
//    platform (/Users/<name>/, /home/<name>/, C:\Users\<name>\), every value
//    of the model settings file (~/.config/openqodex-bench/azure.env, or
//    OPENQODEX_BENCH_MODEL_ENV) and its base URL's host, and the scrub
//    privacy patterns (scripts/scrub-patterns.txt and the private list); one hit
//    refuses the publish and nothing is written. The values themselves are
//    never printed.
// 3. A run with a model reviewer is published from a machine without the
//    model settings file, so its key and base URL are never looked for: such
//    a run is refused unless the file can be read and holds a value.
// Every case publishes in full regardless of its source licence class
// (Sid, 2026-10-12), including briefs, traces and quoted source code.
// 4. A legacy run is published from a folder that is not the committed one:
//    every file must match the blob the recipe's commit holds.
// 5. A legacy run is published without the scorer that wrote its numbers:
//    the scorer files come from git at each recipe commit and must hash to
//    the recipe's sha256.
// 6. The uploaded asset is not the one the committed entry names: the same
//    folder packages to the same bytes with the same Node (a tar written
//    here: sorted, fixed times, owners and modes; gzip with no name or
//    time), an existing entry whose file list differs refuses the publish,
//    and one whose bytes alone differ is rewritten and said so.
// 7. An asset is uploaded twice under one name: an existing asset of that
//    name refuses the upload.
// 8. Board numbers edited by hand in score.json reach the index: the board
//    block is computed again from <run>/outside/aacr, and a block that
//    differs refuses the publish.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { benchRoot, generatedValue, repoRoot } from "./lib/cases.mjs";
import { RELEASE, REPOSITORY, assetUrl, boardHash, buildEntry, byBytes, entryProblems, fileList, hashReviewedFolder, listHash, readEntry, runsRoot, reviewedBytes, sha256, writeEntry } from "./lib/index.mjs";
import { readAacrOutside } from "./lib/aacr-board.mjs";
import { readDecisions } from "./lib/rulings.mjs";
import { canonical } from "./lib/score.mjs";
import { archiveDir, readRecipes, scorerFiles, scorerHash } from "./legacy/rescore.mjs";
import { redactRowReasons } from "./lib/runner.mjs";
import { extractAsset } from "./fetch-run.mjs";
import { decisionsPath, loadRun, scoreRun } from "./score.mjs";

// The files a run may publish, by path inside the run folder.
export const ALLOWED = [
  /^[^/]+\.jsonl?$/, // manifest, rows, resumes, score files, judge.json, outcomes, unresolved, scanners
  /^cases(-[A-Za-z0-9._-]+)?\/[^/]+\.json$/, // the specs the run used, and amended copies such as cases-v2/
  /^samples\/[^/]+\/[^/]+\/[^/]+\/(sample\.json|stderr\.txt|receipt\.txt|usage\.json|dispositions\.json|completion\.json|transcript\.jsonl|progress\.jsonl)$/,
  /^samples\/[^/]+\/[^/]+\/[^/]+\/report\/(report|scan|trace|submission|reviewer|manifest|rounds)\.json$/,
  /^samples\/[^/]+\/[^/]+\/[^/]+\/report\/brief\.md$/,
];
const FIXED_MTIME = 1767225600; // 2026-01-01T00:00:00Z, the time every packaged file carries

const git = (args, opts = {}) => execFileSync("git", args, { cwd: repoRoot, maxBuffer: 1 << 30, ...opts });

// --- the package: a ustar tarball, the same bytes for the same files ---

function octal(n, width) {
  return `${n.toString(8).padStart(width - 1, "0")}\0`;
}

function header(name, size, type, prefix = "") {
  const h = Buffer.alloc(512, 0);
  h.write(name, 0, 100, "utf8");
  h.write(octal(0o644, 8), 100, "ascii");
  h.write(octal(0, 8), 108, "ascii");
  h.write(octal(0, 8), 116, "ascii");
  h.write(octal(size, 12), 124, "ascii");
  h.write(octal(FIXED_MTIME, 12), 136, "ascii");
  h.write("        ", 148, "ascii");
  h.write(type, 156, "ascii");
  h.write("ustar\0", 257, "ascii");
  h.write("00", 263, "ascii");
  h.write(prefix, 345, 155, "utf8");
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  return h;
}

const pad = (n) => Buffer.alloc((512 - (n % 512)) % 512, 0);

// One member: its header (a pax header first when the path does not fit the
// ustar name and prefix fields), its bytes, and the padding.
function member(path, bytes) {
  const out = [];
  let name = path;
  let prefix = "";
  if (Buffer.byteLength(path) > 100) {
    const cut = [...path.matchAll(/\//g)].map((m) => m.index).find((i) => Buffer.byteLength(path.slice(0, i)) <= 155 && Buffer.byteLength(path.slice(i + 1)) <= 100);
    if (cut === undefined) {
      const body = (n) => ` path=${path}\n`.length + String(n).length;
      let len = body(0);
      while (body(len) !== len) len = body(len);
      const record = Buffer.from(`${len} path=${path}\n`, "utf8");
      out.push(header("PaxHeader", record.length, "x"), record, pad(record.length));
      name = path.slice(-100);
    } else {
      prefix = path.slice(0, cut);
      name = path.slice(cut + 1);
    }
  }
  out.push(header(name, bytes.length, "0", prefix), bytes, pad(bytes.length));
  return out;
}

export function tarGz(files) {
  const parts = [];
  for (const f of [...files].sort((a, b) => byBytes(a.path, b.path))) parts.push(...member(f.path, f.bytes));
  parts.push(Buffer.alloc(1024, 0));
  const gz = gzipSync(Buffer.concat(parts), { level: 9 });
  // Byte 9 names the operating system that compressed it; zlib sets it by
  // the platform it was built for. 255 is "unknown" on every platform.
  gz[9] = 0xff;
  return gz;
}

// --- what a run publishes ---

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

// Each case's record in the run (its own copy of the spec or case entry),
// used to look for generated secrets in planted cases.
function caseRecords(folder, paths) {
  const out = new Map();
  for (const p of paths.filter((x) => /^cases\/[^/]+\.json$/.test(x))) {
    const record = readJson(join(folder, p));
    const name = p.slice("cases/".length, -".json".length);
    const planted = record.suite === undefined || record.suite === "planted";
    out.set(name, { name, record, planted });
  }
  return out;
}

// Privacy patterns from both lists. Quoted upstream punctuation is part
// of the saved review, so the public typography pattern does not apply.
// The private list beside the main checkout is shared by its worktrees.
function scrubPatterns() {
  const lists = [{ file: join(repoRoot, "scripts", "scrub-patterns.txt"), private: false }];
  const common = (() => {
    try {
      return resolve(repoRoot, git(["rev-parse", "--git-common-dir"]).toString("utf8").trim(), "..");
    } catch {
      return repoRoot;
    }
  })();
  for (const root of new Set([repoRoot, common])) lists.push({ file: join(root, ".private", "scrub-patterns.txt"), private: true });
  const out = [];
  const seen = new Set();
  for (const l of lists.filter((x) => existsSync(x.file))) {
    for (const source of readFileSync(l.file, "utf8").split("\n").map((s) => s.trim()).filter((s) => s && !s.startsWith("#"))) {
      if (seen.has(source)) continue;
      seen.add(source);
      if (!l.private && source === String.fromCodePoint(0x2014)) continue;
      out.push({ regex: new RegExp(source, "i"), label: l.private ? "matches a private scrub pattern" : `matches the scrub pattern ${source}` });
    }
  }
  return out;
}

// The reviewers of a run that call a model over HTTP: the server path, a
// `model:<deployment>` reviewer, or a reviewer recorded with an endpoint.
function modelReviewers(manifest) {
  const named = Object.entries(manifest?.reviewers ?? {})
    .filter(([name, r]) => name.startsWith("model:") || r?.endpoint !== undefined || r?.endpointHash !== undefined)
    .map(([name]) => name);
  return named.length === 0 && manifest?.path === "server" ? ["the server path"] : named;
}

// Every value of the model settings file, and the host of each URL in it.
// A run with a model reviewer is refused when the file cannot be read here,
// since that run may hold the key or base URL and nothing could find them.
function modelValues(env, runId, manifest) {
  const path = env.OPENQODEX_BENCH_MODEL_ENV ?? join(homedir(), ".config", "openqodex-bench", "azure.env");
  const model = modelReviewers(manifest);
  let text = null;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    if (model.length > 0) throw new Error(`refused: ${runId} uses a model reviewer (${model.join(", ")}), and the model settings file ${path} cannot be read here, so its key and base URL cannot be looked for; publish it where that file is`);
    return [];
  }
  const values = [];
  for (const line of text.split("\n")) {
    const m = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    const value = m[1].replace(/^(["'])(.*)\1$/, "$2");
    if (value.length < 8) continue;
    values.push(value);
    try {
      const host = new URL(value).host;
      if (host.length >= 8) values.push(host);
    } catch {
      // not a URL
    }
  }
  if (model.length > 0 && values.length === 0) throw new Error(`refused: ${runId} uses a model reviewer (${model.join(", ")}), and the model settings file ${path} holds no key or base URL to look for`);
  return values;
}

// The texts one line of a file may carry: the line itself and every JSON
// string in it, decoded and split into its own lines.
function textsOf(line) {
  const out = [line];
  for (const m of line.matchAll(/"(?:[^"\\]|\\.)*"/g)) {
    try {
      const s = JSON.parse(m[0]);
      if (s !== m[0].slice(1, -1)) out.push(s);
      if (s.includes("\n")) out.push(...s.split("\n"));
    } catch {
      // not a JSON string
    }
  }
  return out;
}

// A home folder of any platform, followed by a path inside it:
// /Users/<name>/, /home/<name>/, C:\Users\<name>\ (or with forward slashes).
// A name in angle brackets or starting with $ is a placeholder, not a home.
const HOME_PATH = /(?:^|[^\w.~-])(?:\/Users\/[^/\s"'`<>$]+\/|\/home\/[^/\s"'`<>$]+\/|[A-Za-z]:[\\/]Users[\\/][^\\/\s"'`<>$]+[\\/])/;

// Every hit in the files to publish, as "<path>:<line>: <what>", and how
// many values and patterns of each kind were looked for.
export async function inspect(folder, files, { cases, env = process.env, manifest = null } = {}) {
  const needles = [];
  for (const c of cases.values()) {
    if (!c.planted) continue;
    for (const g of c.record.generated ?? []) needles.push({ value: generatedValue(c.name, g.file, g.kind), label: `the generated secret of ${c.name}` });
  }
  const home = homedir();
  if (home.length > 1) needles.push({ value: home, label: "the home folder path" });
  for (const value of modelValues(env, basename(folder), manifest)) needles.push({ value, label: "a value from the model settings file" });
  const patterns = scrubPatterns();
  patterns.push({ regex: HOME_PATH, label: "a home folder path" });
  // What was looked for, by kind and count only, for the publish's report.
  const looked = {
    secrets: needles.filter((n) => n.label.startsWith("the generated secret")).length,
    modelValues: needles.filter((n) => n.label === "a value from the model settings file").length,
    patterns: patterns.filter((p) => p.label.startsWith("matches the scrub")).length,
    privatePatterns: patterns.filter((p) => p.label.startsWith("matches a private")).length,
  };
  const hits = [];
  for (const f of files) {
    const text = f.bytes.toString("utf8");
    text.split("\n").forEach((line, i) => {
      const at = `${f.path}:${i + 1}`;
      const texts = textsOf(line);
      for (const n of needles) if (texts.some((t) => t.includes(n.value))) hits.push(`${at}: ${n.label}`);
      for (const p of patterns) if (texts.some((t) => p.regex.test(t))) hits.push(`${at}: ${p.label}`);
    });
  }
  return { hits: [...new Set(hits)], looked };
}

// For a legacy run: every file of the folder must be the blob the recipe's
// commit holds at the same path, and the commit must hold no other file.
function originalsProblems(folder, recipe) {
  const listing = git(["ls-tree", "-r", "-z", recipe.originals.commit, "--", recipe.originals.path]).toString("utf8").split("\0").filter(Boolean);
  if (listing.length === 0) return [`commit ${recipe.originals.commit} holds no ${recipe.originals.path}; is this a full clone?`];
  const committed = new Map(listing.map((l) => [l.split("\t")[1].slice(recipe.originals.path.length + 1), l.split(" ")[2].split("\t")[0]]));
  const local = fileList(folder);
  const problems = [];
  for (const p of local) {
    if (!committed.has(p)) {
      if (ALLOWED.some((re) => re.test(p))) problems.push(`${p} is not in the folder ${recipe.originals.commit.slice(0, 7)} holds`);
      continue;
    }
    const bytes = readFileSync(join(folder, p));
    const blob = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    if (blob !== committed.get(p)) problems.push(`${p} differs from the file ${recipe.originals.commit.slice(0, 7)} holds`);
  }
  for (const p of committed.keys()) if (!local.includes(p)) problems.push(`${p} is missing; ${recipe.originals.commit.slice(0, 7)} holds it`);
  return problems;
}

// Packages a run into <out>/<run-id>.tar.gz after every check, and returns
// what the index entry records about it. Throws, writing nothing, on any hit.
export async function packageRun(folder, { out, env = process.env, recipes = readRecipes() } = {}) {
  folder = resolve(folder);
  const runId = basename(folder);
  if (!existsSync(join(folder, "manifest.json"))) throw new Error(`${folder} has no manifest.json; it is not a benchmark run`);
  const recipe = recipes.runs[runId] ?? null;
  const local = fileList(folder);
  const privateListHash = hashReviewedFolder(folder).listHash;
  if (recipe) {
    const problems = originalsProblems(folder, recipe);
    if (problems.length > 0) throw new Error(`refused: ${runId} is not the folder its recipe names:\n${problems.slice(0, 20).join("\n")}`);
  }
  const cases = caseRecords(folder, local);
  const left = [];
  const files = [];
  for (const path of local) {
    if (!ALLOWED.some((re) => re.test(path))) left.push(path);
    else files.push({ path, bytes: reviewedBytes(folder, path) });
  }
  if (recipe) {
    for (const commit of new Set(recipe.scores.map((s) => s.scorer.commit))) {
      const scorer = scorerFiles(commit);
      const want = recipe.scores.find((s) => s.scorer.commit === commit).scorer.sha256;
      if (scorerHash(scorer) !== want) throw new Error(`refused: the scorer at ${commit} hashes to ${scorerHash(scorer)}, not the recipe's ${want}`);
      for (const f of scorer) files.push({ path: `${archiveDir(commit)}/${f.path}`, bytes: f.bytes });
    }
    files.push({ path: "_archive/recipe.json", bytes: Buffer.from(`${JSON.stringify({ runId, ...recipe }, null, 2)}\n`) });
  }
  // Old runs keep a reason in the row, sample, reports and brief. Redact
  // the packaged copies only, preserving the source folder and its hash.
  // Only a line or file with a redacted reason is rewritten; one that does
  // not parse (a transcript cut by a killed run) keeps its bytes, and the
  // inspection below still refuses a home path in it.
  let reasonsRedacted = 0;
  const reasons = new Map();
  const redact = (text) => {
    let row;
    try {
      row = JSON.parse(text);
    } catch {
      return null;
    }
    const redacted = redactRowReasons(row, folder);
    if (redacted.count === 0) return null;
    reasonsRedacted += redacted.count;
    for (const [from, to] of redacted.reasons) reasons.set(from, to);
    return redacted.row;
  };
  for (const file of files) {
    if (!/\.jsonl?$/.test(file.path) || file.path.startsWith("_archive/")) continue;
    const text = file.bytes.toString("utf8");
    if (file.path.endsWith(".jsonl")) {
      const lines = text.split("\n").map((line) => {
        const row = line.trim() ? redact(line) : null;
        return row === null ? line : JSON.stringify(row);
      });
      file.bytes = Buffer.from(lines.join("\n"));
    } else {
      const row = redact(text);
      if (row !== null) file.bytes = Buffer.from(`${JSON.stringify(row, null, 2)}\n`);
    }
  }
  for (const file of files.filter((f) => f.path.endsWith("/brief.md"))) {
    let text = file.bytes.toString("utf8");
    for (const [from, to] of reasons) text = text.split(from).join(to);
    file.bytes = Buffer.from(text);
  }
  const inspected = files.map((f) => f.path === "score.json" ? { path: f.path, bytes: readFileSync(join(folder, f.path)) } : f);
  const { hits, looked } = await inspect(folder, inspected, { cases, env, manifest: readJson(join(folder, "manifest.json")) });
  if (hits.length > 0) throw new Error(`refused: ${hits.length} hit${hits.length === 1 ? "" : "s"} in the files to publish:\n${hits.slice(0, 40).join("\n")}`);
  const tar = tarGz(files.map((f) => ({ path: `${runId}/${f.path}`, bytes: f.bytes })));
  mkdirSync(out, { recursive: true });
  const tarPath = join(out, `${runId}.tar.gz`);
  writeFileSync(tarPath, tar);
  return {
    runId,
    reasonsRedacted,
    tarPath,
    sha256: sha256(tar),
    bytes: tar.length,
    files: files.length,
    listHash: listHash(files.map((f) => ({ path: f.path, sha256: sha256(f.bytes) }))),
    privateListHash,
    left,
    looked,
    legacy: recipe,
  };
}

// The score an entry cites: for a legacy run its recipe's headline file.
function citedScore(folder, recipe) {
  const file = recipe ? recipe.headline : "score.json";
  return readJson(join(folder, file));
}

// Why the board numbers a score carries are not the ones the run's board
// output gives, as score.mjs --outside aacr computes them (failure 8); null when they are.
function boardRefusal(folder, runId, outside) {
  if (outside === undefined) return null;
  const d = readDecisions(decisionsPath);
  const run = loadRun(folder);
  const { jobs } = scoreRun(run, { decisionsHash: d.hash, decisions: d.lines, people: d.people });
  let aacr = null;
  try {
    aacr = readAacrOutside(folder, jobs, run.specs);
  } catch {
    // score.mjs saves a board block it cannot read as null.
  }
  return canonical(outside) === canonical({ aacr }) ? null : `refused: ${runId}'s board numbers in score.json are not the ones its board output gives; run node benchmark/score.mjs ${folder} --outside aacr again`;
}

// Records an accepted entry's board numbers in the accepted pointer, in
// the order trend.mjs --accept writes them; the path when it changed.
function recordBoard(entry, runs) {
  const path = join(dirname(runs), "accepted.json");
  if (!existsSync(path)) return null;
  const before = readFileSync(path, "utf8");
  const pointer = JSON.parse(before);
  const board = boardHash(entry);
  const mark = (a) => (a?.runId !== entry.runId ? a : { runId: a.runId, commit: a.commit, scoreHash: a.scoreHash, ...(board === null ? {} : { boardHash: board }), acceptedAt: a.acceptedAt, acceptedBy: a.acceptedBy });
  const { version, groups, ...top } = pointer;
  const next = { version, ...mark(top), groups: Object.fromEntries(Object.entries(groups ?? {}).map(([k, a]) => [k, mark(a)])) };
  const after = `${JSON.stringify(next, null, 2)}\n`;
  if (after === before) return null;
  writeFileSync(path, after);
  return path;
}

const gh = (args) => spawnSync("gh", [...args, "--repo", REPOSITORY], { cwd: repoRoot, encoding: "utf8" });

function upload(tarPath, runId) {
  const view = gh(["release", "view", RELEASE, "--json", "assets", "--jq", ".assets[].name"]);
  if (view.status !== 0) {
    if (!/release not found/i.test(view.stderr)) throw new Error(`gh release view ${RELEASE} failed: ${view.stderr.trim()}`);
    const made = gh(["release", "create", RELEASE, "--prerelease", "--latest=false", "--title", "Benchmark data (not a product release)", "--notes", "One asset per benchmark run, <run-id>.tar.gz, named by benchmark/index/runs/<run-id>.json in the repository. Fetch one with node benchmark/fetch-run.mjs <run-id>. This is not a release of the package."]);
    if (made.status !== 0) throw new Error(`gh release create ${RELEASE} failed: ${made.stderr.trim()}`);
  } else if (view.stdout.split("\n").includes(`${runId}.tar.gz`)) {
    throw new Error(`refused: ${RELEASE} already holds ${runId}.tar.gz; fetch it with node benchmark/fetch-run.mjs ${runId} to check it`);
  }
  const sent = gh(["release", "upload", RELEASE, tarPath]);
  if (sent.status !== 0) throw new Error(`gh release upload failed: ${sent.stderr.trim()}`);
}

export async function publishRun(folder, { dryRun = false, writeIndex = false, out = null, env = process.env, runs = runsRoot } = {}) {
  folder = resolve(folder);
  const recipes = readRecipes();
  const runId = basename(folder);
  // A smoke run (run.mjs --smoke) checks that the runner works; its numbers are never indexed.
  if (existsSync(join(folder, "manifest.json")) && readJson(join(folder, "manifest.json")).smoke === true) throw new Error(`refused: ${runId} is a smoke run (run.mjs --smoke), which is never indexed or published`);
  const recipe = recipes.runs[runId] ?? null;
  if (!recipe && !existsSync(join(folder, "score.json"))) {
    const scored = spawnSync(process.execPath, [join(benchRoot, "score.mjs"), folder], { encoding: "utf8" });
    if (scored.status === 2) throw new Error(`scoring ${runId} failed:\n${scored.stderr.trim()}`);
  }
  const outDir = out ?? mkdtempSync(join(tmpdir(), "oq-publish-"));
  const asset = await packageRun(folder, { out: outDir, env, recipes });
  // The package must unpack, with the system tar, to the files it was made from.
  const check = mkdtempSync(join(tmpdir(), "oq-publish-check-"));
  try {
    extractAsset(asset.tarPath, asset, check, runId);
  } finally {
    rmSync(check, { recursive: true, force: true });
  }
  const manifest = readJson(join(folder, "manifest.json"));
  const resumes = existsSync(join(folder, "resumes.jsonl")) ? readFileSync(join(folder, "resumes.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  let entry = buildEntry({
    runId,
    manifest,
    resumes,
    score: citedScore(folder, recipe),
    asset: { url: assetUrl(runId), sha256: asset.sha256, bytes: asset.bytes, files: asset.files, listHash: asset.listHash },
    privateListHash: asset.privateListHash,
    legacy: recipe,
  });
  const problems = entryProblems(entry);
  if (problems.length > 0) throw new Error(`the entry for ${runId} is not sound:\n${problems.join("\n")}`);
  // The committed entry, when there is one, must name the same files. The
  // same files packaged by another zlib build may differ in their bytes; the
  // entry then gets the new sha256, and that change must be committed.
  const committed = readEntry(runId, runs);
  const boardOnly = committed !== null && writeIndex;
  if (boardOnly && committed.asset.sha256 !== entry.asset.sha256) throw new Error(`refused: ${runId} packages to sha256 ${entry.asset.sha256}, not the ${committed.asset.sha256} its entry names, so --write-index cannot refresh its board numbers`);
  if (committed && (committed.asset.listHash !== entry.asset.listHash || committed.privateListHash !== entry.privateListHash)) {
    throw new Error(`refused: the committed entry for ${runId} names other files (list hash ${committed.asset.listHash}, private ${committed.privateListHash}) than this folder packages (list hash ${entry.asset.listHash}, private ${entry.privateListHash})`);
  }
  const rebytes = committed !== null && committed.asset.sha256 !== entry.asset.sha256;
  const refusal = recipe ? null : boardRefusal(folder, runId, entry.outside);
  if (refusal) throw new Error(refusal);
  // An accepted run stays accepted: benchmark/index/accepted.json names it,
  // and only trend.mjs --accept sets the mark.
  if (committed?.accepted === true) Object.assign(entry, { accepted: true, acceptedAt: committed.acceptedAt, acceptedBy: committed.acceptedBy });
  if (boardOnly) {
    const outside = entry.outside;
    entry = { ...committed };
    if (outside !== undefined) entry.outside = outside;
    else delete entry.outside;
  }
  if (!dryRun && !boardOnly) upload(asset.tarPath, runId);
  const written = !dryRun || writeIndex ? writeEntry(entry, runs) : null;
  const pointer = written && entry.accepted === true ? recordBoard(entry, runs) : null;
  return { asset, entry, written, rebytes, boardOnly, pointer };
}

async function main() {
  const args = process.argv.slice(2);
  let dryRun = false;
  let writeIndex = false;
  let out = null;
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dry-run") dryRun = true;
    else if (args[i] === "--write-index") writeIndex = true;
    else if (args[i] === "--out") out = args[++i];
    else pos.push(args[i]);
  }
  if (pos.length !== 1 || out === undefined) {
    console.error("usage: node benchmark/publish-run.mjs <results folder> [--dry-run] [--write-index] [--out <dir>]");
    process.exit(2);
  }
  let r;
  try {
    r = await publishRun(pos[0], { dryRun, writeIndex, out });
  } catch (error) {
    console.error(error.message);
    process.exit(error.message.startsWith("refused") ? 1 : 2);
  }
  const { asset, entry, written, rebytes, boardOnly, pointer } = r;
  console.log(`${asset.runId}: ${asset.files} files in ${asset.tarPath} (${asset.bytes} bytes, sha256 ${asset.sha256}, list hash ${asset.listHash})`);
  console.log(`${asset.reasonsRedacted} reasons redacted`);
  if (rebytes) console.log(`The committed entry names the same files packaged to other bytes; ${written ? "the entry now names this asset's sha256, and the change must be committed" : "a publish rewrites its sha256"}.`);
  if (asset.left.length > 0) console.log(`Left out (not on the allowlist): ${asset.left.length} files, such as ${asset.left.slice(0, 3).join(", ")}`);
  const l = asset.looked;
  console.log(`Inspected every packaged file for: ${l.secrets} generated secrets, this machine's and any platform's home folder paths, ${l.modelValues} model settings values, ${l.patterns} public and ${l.privatePatterns} private scrub patterns. No hit.`);
  console.log(dryRun ? `Dry run: nothing uploaded. The asset unpacks to the same file list.` : boardOnly ? "Board numbers refreshed in the index entry. The asset is unchanged, and nothing was uploaded." : `Uploaded to ${entry.asset.url}`);
  if (written) {
    console.log(`Index entry written: ${written}`);
    if (pointer) console.log(`The accepted pointer now records these board numbers: ${pointer}`);
    console.log(`Commit it in a pull request: git add benchmark/index/runs/${asset.runId}.json${pointer ? " benchmark/index/accepted.json" : ""}`);
  } else console.log(JSON.stringify(entry, null, 2));
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
