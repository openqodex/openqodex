// A run leaves the machine as one asset on the benchmark-data pre-release,
// and its committed index entry is the only record of it in the tree. Three
// failures are guarded here, each on a run folder of the shape run.mjs
// writes, built in a temp folder:
// 1. A published run cannot be fetched back to the same files: the asset
//    is packaged, checked by its sha256 and file list, unpacked again, and
//    every exported file must come back byte for byte. The same folder must
//    package to the same bytes twice, because the index entry is committed
//    before the session uploads the asset.
// 2. An exported file carrying a secret, a home path or the model key
//    is published: each refuses the publish without printing the key.
// 3. A licence class removes code or refuses a run: every class publishes
//    every allowed file, even without a cached source repository.
// 4. Upstream punctuation in a saved brief or spec refuses a run, or
//    packaging alters the text the reviewer saw: both retain their bytes.
// 5. Publishing drops the outside block or changes other fields during a refresh.
// 6. A board-only refresh accepts changed files or changed asset bytes.
// 7. Board output changes the reviewed asset or its scrub inspects excluded files.
// 8. Board numbers edited by hand in score.json reach the index, or a
//    refresh of an accepted entry leaves its board hash unrecorded.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { casesRoot, generatedValue, repoRoot } from "../lib/cases.mjs";
import { boardHash, hashFolder } from "../lib/index.mjs";
import { specCopy } from "../lib/suites.mjs";
import { packageRun, publishRun } from "../publish-run.mjs";
import { extractAsset } from "../fetch-run.mjs";
import { removeTempDirs, tempDir } from "../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

const write = (path, text) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

// One review of one case, with every file a sample folder holds.
function addSample(run, name, config, extra = {}) {
  const dir = join(run, "samples", name, config, "1");
  write(join(dir, "sample.json"), JSON.stringify({ case: name, config, repeat: 1, attempt: 1, exit: 0, wallMs: 21000, status: "complete" }));
  write(join(dir, "stderr.txt"), "");
  write(join(dir, "receipt.txt"), "Reviewing the change against HEAD: 2 files\n");
  for (const file of ["report.json", "scan.json", "submission.json", "reviewer.json", "manifest.json"]) write(join(dir, "report", file), JSON.stringify({ file }));
  write(join(dir, "report", "brief.md"), "# Review brief\n\n## The changed lines\n");
  write(join(dir, "report", "trace.json"), JSON.stringify({ calls: [] }));
  // A rendering of report.json: it stays on the machine that ran.
  write(join(dir, "report", "report.html"), "<html></html>");
  for (const [file, text] of Object.entries(extra)) write(join(dir, file), text);
  return dir;
}

// A planted run: its manifest, its own copy of each spec, two samples, the
// rows and a score, the way run.mjs and score.mjs leave them.
function plantedRun(runId = "2026-10-10-abc1234", manifest = {}) {
  const run = join(tempDir("oq-publish-"), runId);
  write(join(run, "manifest.json"), JSON.stringify({ version: 2, started_at: "2026-10-10T10:00:00.000Z", build: { commit: "a".repeat(40), short: "abc1234", dirty: false, cliVersion: "0.13.0" }, configs: ["claude-graph-on"], repeat: 1, planned: 2, cases: ["demo-polyglot", "flask-path-traversal"], ended: { how: "finished", why: null }, ...manifest }));
  for (const name of ["demo-polyglot", "flask-path-traversal"]) {
    write(join(run, "cases", `${name}.json`), readFileSync(join(casesRoot, name, "case.json"), "utf8"));
    addSample(run, name, "claude-graph-on");
  }
  write(join(run, "rows.jsonl"), '{"case":"demo-polyglot"}\n{"case":"flask-path-traversal"}\n');
  write(join(run, "score.json"), JSON.stringify({ byConfig: {} }));
  return run;
}

const files = (dir) => {
  const out = [];
  const walk = (rel) => {
    for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const path = rel === "" ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) walk(path);
      else out.push(path);
    }
  };
  walk("");
  return out.sort();
};

describe("a published run comes back as the same files", () => {
  it("packages a run, unpacks it with tar after the sha256 and list checks, and gets every exported file back byte for byte", async () => {
    const run = plantedRun();
    const out = tempDir("oq-publish-out-");
    const asset = await packageRun(run, { out });
    expect(asset.files).toBeGreaterThan(10);
    expect(asset.left).toEqual(["samples/demo-polyglot/claude-graph-on/1/report/report.html", "samples/flask-path-traversal/claude-graph-on/1/report/report.html"]);
    const into = tempDir("oq-fetch-");
    const back = extractAsset(asset.tarPath, { sha256: asset.sha256, listHash: asset.listHash, files: asset.files }, into, "2026-10-10-abc1234");
    expect(back).toBe(join(into, "2026-10-10-abc1234"));
    const exported = files(run).filter((p) => !asset.left.includes(p));
    expect(files(back)).toEqual(exported);
    for (const p of exported) expect(readFileSync(join(back, p)).equals(readFileSync(join(run, p)))).toBe(true);
    expect(hashFolder(back).listHash).toBe(asset.listHash);
  });

  it("packages the same folder to the same bytes, so the index entry committed before the upload names the asset the session uploads", async () => {
    const run = plantedRun();
    const a = await packageRun(run, { out: tempDir("oq-publish-out-") });
    const b = await packageRun(run, { out: tempDir("oq-publish-out-") });
    expect(b.sha256).toBe(a.sha256);
    expect(b.listHash).toBe(a.listHash);
  });

  it("refuses an asset whose bytes or file list are not the ones the index entry names", async () => {
    const run = plantedRun();
    const asset = await packageRun(run, { out: tempDir("oq-publish-out-") });
    const bytes = readFileSync(asset.tarPath);
    bytes[bytes.length - 20] ^= 0xff;
    const bad = join(tempDir("oq-publish-bad-"), "2026-10-10-abc1234.tar.gz");
    writeFileSync(bad, bytes);
    const into = tempDir("oq-fetch-");
    expect(() => extractAsset(bad, { sha256: asset.sha256, listHash: asset.listHash, files: asset.files }, into, "2026-10-10-abc1234")).toThrow(/sha256/);
    expect(() => extractAsset(asset.tarPath, { sha256: asset.sha256, listHash: "0".repeat(64), files: asset.files }, into, "2026-10-10-abc1234")).toThrow(/file list/);
    expect(existsSync(join(into, "2026-10-10-abc1234"))).toBe(false);
  });
});

describe("nothing private leaves in an asset", () => {
  const refused = async (run, env = {}) => {
    const out = tempDir("oq-publish-out-");
    let message = null;
    try {
      await packageRun(run, { out, env });
    } catch (error) {
      message = error.message;
    }
    expect(readdirSync(out)).toEqual([]);
    return message;
  };

  it("refuses a run whose trace holds the case's generated secret", async () => {
    const run = plantedRun();
    const spec = JSON.parse(readFileSync(join(run, "cases", "demo-polyglot.json"), "utf8"));
    const secret = generatedValue("demo-polyglot", spec.generated[0].file, spec.generated[0].kind);
    write(join(run, "samples/demo-polyglot/claude-graph-on/1/report/trace.json"), JSON.stringify({ read: `STRIPE_KEY = "${secret}"` }));
    const message = await refused(run);
    expect(message).toMatch(/samples\/demo-polyglot\/claude-graph-on\/1\/report\/trace\.json:1: the generated secret of demo-polyglot/);
    expect(message).not.toContain(secret);
  });

  it("refuses a run whose stderr holds this machine's home folder", async () => {
    const run = plantedRun();
    write(join(run, "samples/flask-path-traversal/claude-graph-on/1/stderr.txt"), `warning: ${join(homedir(), "Projects", "x")} is not a git repository\n`);
    expect(await refused(run)).toMatch(/samples\/flask-path-traversal\/claude-graph-on\/1\/stderr\.txt:1: the home folder path/);
  });

  it("refuses a run whose transcript holds the model key or base URL, without printing either", async () => {
    const run = plantedRun();
    const envFile = join(tempDir("oq-model-env-"), "azure.env");
    // Made at run time, so no secret scanner reading this file takes it for a real key.
    const key = `test-model-key-${randomBytes(16).toString("hex")}`;
    const base = "https://test-resource.openai.example/openai/v1";
    writeFileSync(envFile, `AZURE_OPENAI_KEY=${key}\nAZURE_OPENAI_BASE=${base}\n`);
    addSample(run, "flask-path-traversal", "model-gpt-6.1-sol", { "transcript.jsonl": `{"role":"system","note":"sent with api-key ${key}"}\n` });
    const keyMessage = await refused(run, { OPENQODEX_BENCH_MODEL_ENV: envFile });
    expect(keyMessage).toMatch(/samples\/flask-path-traversal\/model-gpt-6\.1-sol\/1\/transcript\.jsonl:1: a value from the model settings file/);
    expect(keyMessage).not.toContain(key);
    const run2 = plantedRun();
    addSample(run2, "flask-path-traversal", "model-gpt-6.1-sol", { "progress.jsonl": `{"at":"t","url":"${base}/responses"}\n` });
    const baseMessage = await refused(run2, { OPENQODEX_BENCH_MODEL_ENV: envFile });
    expect(baseMessage).toMatch(/progress\.jsonl:1: a value from the model settings file/);
    expect(baseMessage).not.toContain(base);
  });

  it("refuses a run holding a pattern from the scrub list", async () => {
    // A word from the public list, read from it: written here, it would fail the repository's own scrub.
    const word = readFileSync(join(repoRoot, "scripts", "scrub-patterns.txt"), "utf8").split("\n").map((l) => l.trim()).find((l) => /^[a-z]+$/i.test(l));
    const run = plantedRun();
    write(join(run, "samples/demo-polyglot/claude-graph-on/1/receipt.txt"), `sent to ${word}\n`);
    expect(await refused(run)).toMatch(new RegExp(`receipt\\.txt:1: matches the scrub pattern ${word}`));
  });

  it("refuses a run with a model reviewer when the model settings file cannot be read here, since its key and base URL cannot be looked for", async () => {
    const run = plantedRun("2026-10-10-abc1234", { path: "server", configs: ["model-gpt-6.1-sol"], reviewers: { "model:gpt-6.1-sol": { version: null, model: "gpt-6.1-sol", endpoint: "azure-openai-v1" } } });
    addSample(run, "flask-path-traversal", "model-gpt-6.1-sol", { "transcript.jsonl": `{"role":"system","note":"sent with api-key test-model-key-${randomBytes(16).toString("hex")}"}\n` });
    const missing = join(tempDir("oq-model-env-"), "azure.env");
    expect(await refused(run, { OPENQODEX_BENCH_MODEL_ENV: missing })).toMatch(/uses a model reviewer \(model:gpt-6\.1-sol\), and the model settings file .*azure\.env cannot be read here/);
  });

  it("refuses home folder paths of every platform, not only this machine's", async () => {
    for (const path of ["/home/alice/project/app.py", "/Users/bob/src/app.py", "C:\\Users\\carol\\src\\app.py"]) {
      const run = plantedRun();
      write(join(run, "samples/flask-path-traversal/claude-graph-on/1/stderr.txt"), `warning: ${path} is not a git repository\n`);
      expect(await refused(run)).toMatch(/samples\/flask-path-traversal\/claude-graph-on\/1\/stderr\.txt:1: a home folder path/);
    }
  });

});

describe("source data in published runs", () => {
  it.each(["permissive", "copyleft", "source-available", "unverified", "unknown"])("does not omit code or refuse a %s case without a source cache", async (licence) => {
    const run = plantedRun();
    const name = "acme__ledger-42";
    write(join(run, "cases", `${name}.json`), JSON.stringify({ suite: "aacr", name, source: { licence: { class: licence } } }));
    const quote = "return x * 3\n";
    addSample(run, name, "claude-graph-on", { "report/brief.md": quote, "report/trace.json": JSON.stringify({ code: quote }), "transcript.jsonl": JSON.stringify({ code: quote }) });
    const asset = await packageRun(run, { out: tempDir("oq-publish-out-"), env: { OPENQODEX_BENCH_CACHE: tempDir("oq-empty-cache-") } });
    const back = extractAsset(asset.tarPath, asset, tempDir("oq-fetch-"), asset.runId);
    for (const file of ["report/brief.md", "report/trace.json", "transcript.jsonl"]) {
      const path = `samples/${name}/claude-graph-on/1/${file}`;
      expect(asset.left).not.toContain(path);
      expect(readFileSync(join(back, path))).toEqual(readFileSync(join(run, path)));
    }
  });

  it("does not refuse a copied spec with an upstream em dash or change the source spec", async () => {
    const run = plantedRun();
    const name = "acme__ledger-42";
    const dash = String.fromCodePoint(0x2014);
    const source = { id: `aacr/${name}@bbbbbbbb`, suite: "aacr", name, title: `Invoice${dash}total`, truthCount: { accepted: 1 }, source: { licence: { class: "copyleft" } } };
    const truth = { items: [{ id: "c1", valid: true, description: `Refunds  ${dash}  count` }] };
    const before = JSON.stringify({ source, truth });
    const copy = specCopy(source, truth);
    expect(copy.title).toBe("Invoice - total");
    expect(copy.bugs[0].description).toBe("Refunds - count");
    expect(JSON.stringify({ source, truth })).toBe(before);
    write(join(run, "cases", `${name}.json`), JSON.stringify(copy));
    const asset = await packageRun(run, { out: tempDir("oq-publish-out-"), env: {} });
    const back = extractAsset(asset.tarPath, asset, tempDir("oq-fetch-"), asset.runId);
    expect(JSON.parse(readFileSync(join(back, "cases", `${name}.json`), "utf8"))).toEqual(copy);
  });
});

// A board refresh that tried to upload would reach the real release; a bad token makes gh fail first.
async function noUpload(work) {
  const token = process.env.GH_TOKEN;
  process.env.GH_TOKEN = "invalid-token-for-tests";
  try {
    return await work();
  } finally {
    if (token === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = token;
  }
}

function boardRun() {
  const folder = plantedRun("2026-10-10-aaaaaaa", { caseIds: ["planted/demo-polyglot@aaaaaaaa", "planted/flask-path-traversal@bbbbbbbb"], caseHashes: { "demo-polyglot": "a".repeat(64), "flask-path-traversal": "b".repeat(64) }, build: { commit: "a".repeat(40), short: "aaaaaaa", dirty: false } });
  const scored = spawnSync(process.execPath, [join(repoRoot, "benchmark/score.mjs"), folder], { encoding: "utf8" });
  expect(scored.status, scored.stderr).not.toBe(2);
  // A board output in the shape AACR-Bench's evaluator leaves it, which score.mjs --outside aacr reads.
  write(join(folder, "outside/aacr/convert.json"), JSON.stringify({ reader: "ocr", lineK: 1, references: { total: 2, left: 0, share: 0 }, withoutLine: [], folders: [{ dir: "claude-graph-on/r1", config: "claude-graph-on", repeat: 1, tool: "openqodex-claude-graph-on-r1" }] }));
  write(join(folder, "outside/aacr/claude-graph-on/r1/metrics_ocr_20261010_000000.json"), JSON.stringify({ summary: { evaluated_instances: 2, missing_instances: 0, expected_notes: 2, generated_notes: 4, matched_line_notes: 1, matched_semantic_notes: 1 } }));
  const boarded = spawnSync(process.execPath, [join(repoRoot, "benchmark/score.mjs"), folder, "--outside", "aacr"], { encoding: "utf8" });
  expect(boarded.status, boarded.stderr).toBe(0);
  const score = JSON.parse(readFileSync(join(folder, "score.json"), "utf8"));
  expect(score.outside.aacr.byConfig["claude-graph-on"].mean.line).toMatchObject({ precision: 0.25, recall: 0.5 });
  return { folder, outside: score.outside };
}

it("does not drop board numbers when publishing or change other entry fields when refreshing them", async () => {
  const { folder, outside } = boardRun();
  const index = tempDir("oq-board-index-");
  const runs = join(index, "runs");
  const options = { runs, out: tempDir("oq-board-asset-"), env: { OPENQODEX_BENCH_MODEL_ENV: join(runs, "missing") } };
  const first = await publishRun(folder, { ...options, dryRun: true, writeIndex: true });
  expect(first.entry.outside).toEqual(outside);
  // The pointer of a run accepted before its board run, as trend.mjs --accept wrote it.
  const record = { runId: first.entry.runId, commit: "a".repeat(40), scoreHash: "c".repeat(64), acceptedAt: "2026-10-10T12:00:00Z", acceptedBy: "Sid" };
  write(join(index, "accepted.json"), `${JSON.stringify({ version: 1, ...record, groups: { group: record } }, null, 2)}\n`);
  const committed = { ...first.entry, accepted: true, acceptedAt: "2026-10-10T12:00:00Z", acceptedBy: "Sid", scannersComplete: true };
  delete committed.outside;
  writeFileSync(first.written, JSON.stringify(committed));
  const dry = await publishRun(folder, { ...options, dryRun: true });
  expect(dry.entry.outside).toEqual(outside);
  const refreshed = await noUpload(() => publishRun(folder, { ...options, writeIndex: true }));
  expect(refreshed.entry).toEqual({ ...committed, outside });
  expect(JSON.parse(readFileSync(first.written, "utf8"))).toEqual(refreshed.entry);
  const pointer = JSON.parse(readFileSync(join(index, "accepted.json"), "utf8"));
  expect(boardHash(refreshed.entry)).toMatch(/^[0-9a-f]{64}$/);
  expect(pointer).toMatchObject({ ...record, boardHash: boardHash(refreshed.entry), groups: { group: { ...record, boardHash: boardHash(refreshed.entry) } } });
});

it("refuses board numbers edited by hand in score.json, at publish and at refresh", async () => {
  const { folder } = boardRun();
  const runs = tempDir("oq-board-index-");
  const options = { runs, out: tempDir("oq-board-asset-"), env: { OPENQODEX_BENCH_MODEL_ENV: join(runs, "missing") } };
  const first = await publishRun(folder, { ...options, dryRun: true, writeIndex: true });
  const before = readFileSync(first.written, "utf8");
  const scoreFile = join(folder, "score.json");
  const score = JSON.parse(readFileSync(scoreFile, "utf8"));
  score.outside.aacr.byConfig["claude-graph-on"].mean.line.precision = 0.9;
  writeFileSync(scoreFile, `${JSON.stringify(score, null, 2)}\n`);
  const refused = /^refused: 2026-10-10-aaaaaaa's board numbers in score.json are not the ones its board output gives; run node benchmark\/score.mjs .+ --outside aacr again$/;
  await expect(noUpload(() => publishRun(folder, { ...options, writeIndex: true }))).rejects.toThrow(refused);
  expect(readFileSync(first.written, "utf8")).toBe(before);
  await expect(publishRun(folder, { ...options, runs: tempDir("oq-board-index-"), dryRun: true, writeIndex: true })).rejects.toThrow(refused);
});

it("refuses a board-only refresh when run files or asset bytes have changed", async () => {
  for (const change of ["files", "bytes"]) {
    const { folder } = boardRun();
    const runs = tempDir("oq-board-index-");
    const options = { runs, out: tempDir("oq-board-asset-"), env: { OPENQODEX_BENCH_MODEL_ENV: join(runs, "missing") } };
    const first = await publishRun(folder, { ...options, dryRun: true, writeIndex: true });
    if (change === "files") writeFileSync(join(folder, "rows.jsonl"), "{}\n");
    else {
      first.entry.asset.sha256 = "0".repeat(64);
      writeFileSync(first.written, JSON.stringify(first.entry));
    }
    const before = readFileSync(first.written, "utf8");
    await expect(noUpload(() => publishRun(folder, { ...options, writeIndex: true }))).rejects.toThrow(/^refused: 2026-10-10-aaaaaaa packages to sha256 [0-9a-f]{64}, not the [0-9a-f]{64} its entry names, so --write-index cannot refresh its board numbers$/);
    expect(readFileSync(first.written, "utf8")).toBe(before);
  }
});

it("does not change the reviewed asset or scrub excluded board output", async () => {
  const { folder } = boardRun();
  const scoreFile = join(folder, "score.json");
  const score = JSON.parse(readFileSync(scoreFile, "utf8"));
  const outside = score.outside;
  delete score.outside;
  writeFileSync(scoreFile, `${JSON.stringify(score, null, 2)}\n`);
  const options = { out: tempDir("oq-board-asset-"), env: { OPENQODEX_BENCH_MODEL_ENV: join(folder, "missing") } };
  const before = await packageRun(folder, options);
  score.outside = outside;
  writeFileSync(scoreFile, `${JSON.stringify(score, null, 2)}\n`);
  write(join(folder, "outside/aacr/output.json"), JSON.stringify({ path: join(homedir(), "evaluator"), note: String.fromCodePoint(0x2014) }));
  const after = await packageRun(folder, options);
  expect(after.sha256).toBe(before.sha256);
  expect(after.privateListHash).toBe(before.privateListHash);
  expect(after.left).toContain("outside/aacr/output.json");
});

// Failure cases: an older row, its saved reports or its rendered reason
// cannot publish, the count is wrong, packaging rewrites the source, a
// transcript line cut by a killed run stops the publish, or a line with
// nothing to redact is rewritten.
it("publishes saved scanner reasons with placeholders without changing the run", async () => {
  const run = plantedRun();
  const reason = `could not type-check: ${homedir()}/checkouts/tree/a.go and ${run}/repo/b.go`;
  const row = { scanners: [{ reason }, { reason: null }] };
  write(join(run, "rows.jsonl"), `${JSON.stringify(row)}\n`);
  const dir = join(run, "samples", "demo-polyglot", "claude-graph-on", "1");
  for (const file of ["sample.json", "report/report.json", "report/scan.json"]) write(join(dir, file), JSON.stringify(row));
  write(join(dir, "report/brief.md"), `- Scanners: golangci: ${reason}\n`);
  const transcript = '{"text":"\\u00e9"}\n{"type":"assist';
  write(join(dir, "transcript.jsonl"), transcript);
  const before = hashFolder(run);
  const asset = await packageRun(run, { out: tempDir("oq-publish-out-") });
  expect(asset.reasonsRedacted).toBe(4);
  const back = extractAsset(asset.tarPath, asset, tempDir("oq-fetch-"), asset.runId);
  const saved = JSON.parse(readFileSync(join(back, "rows.jsonl"), "utf8"));
  expect(saved.scanners[0].reason).toBe("could not type-check: <home>/checkouts/tree/a.go and <run>/repo/b.go");
  expect(saved.scanners[1].reason).toBeNull();
  expect(readFileSync(join(back, "samples/demo-polyglot/claude-graph-on/1/report/brief.md"), "utf8")).toContain(saved.scanners[0].reason);
  expect(readFileSync(join(back, "samples/demo-polyglot/claude-graph-on/1/transcript.jsonl"), "utf8")).toBe(transcript);
  expect(hashFolder(run)).toEqual(before);
});

it("preserves quoted punctuation in saved briefs and specs when publishing", async () => {
  const run = plantedRun();
  const punctuation = String.fromCodePoint(0x2014);
  const brief = `Quoted description: before ${punctuation} after\n`;
  const spec = JSON.stringify({ suite: "real", golden: [{ comment: `before ${punctuation} after` }] });
  const briefPath = "samples/demo-polyglot/claude-graph-on/1/report/brief.md";
  const specPath = "cases/demo-polyglot.json";
  write(join(run, briefPath), brief);
  write(join(run, specPath), spec);
  const before = hashFolder(run);
  const asset = await packageRun(run, { out: tempDir("oq-publish-out-") });
  const back = extractAsset(asset.tarPath, asset, tempDir("oq-fetch-"), asset.runId);
  expect(readFileSync(join(back, briefPath), "utf8")).toBe(brief);
  expect(readFileSync(join(back, specPath), "utf8")).toBe(spec);
  expect(hashFolder(run)).toEqual(before);
});
