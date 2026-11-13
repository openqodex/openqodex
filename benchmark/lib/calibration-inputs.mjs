// Public calibration inputs only. No product reviews or model settings.
// Failure cases: benchmark/test/calibration-failures.md.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { benchRoot } from "./cases.mjs";
import { cacheRoot } from "./licence.mjs";
import { checkedBytes, hash } from "./calibration.mjs";
import { canonicalJson, greptileTruth, readSuite, truthHashOf } from "./suites.mjs";
import { GREPTILE_REPOS, greptileRows } from "./greptile.mjs";

const json = (file) => JSON.parse(readFileSync(file, "utf8"));
const run = promisify(execFile);
export async function publicSource(board, pin, { root = benchRoot } = {}) {
  const local = join(root, "results/calibration-sources", board, pin.path);
  const raw = join(cacheRoot(), "raw", board, pin.path);
  for (const file of [local, raw]) if (existsSync(file)) return checkedBytes(readFileSync(file), pin);
  let body;
  if (new URL(pin.url).hostname === "raw.githubusercontent.com") {
    ({ stdout: body } = await run("curl", ["--fail", "--silent", "--show-error", "--max-time", "30", pin.url], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 }));
  } else {
    const response = await fetch(pin.url, { redirect: "error", signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`${board} public source ${pin.path}: HTTP ${response.status}`);
    body = Buffer.from(await response.arrayBuffer());
  }
  const bytes = checkedBytes(body, pin);
  mkdirSync(dirname(local), { recursive: true }); writeFileSync(local, bytes);
  return bytes;
}

async function commentsAt(url) {
  const match = /^https:\/\/github.com\/([^/]+\/[^/]+)\/pull\/(\d+)$/.exec(url);
  if (!match) throw new Error("invalid public review fork URL");
  const endpoint = `repos/${match[1]}/pulls/${match[2]}/comments?per_page=100`;
  const { stdout } = await run("gh", ["api", "--paginate", "--slurp", endpoint], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024, timeout: 30_000 });
  const pages = JSON.parse(stdout);
  if (!Array.isArray(pages) || !pages.every(Array.isArray)) throw new Error(`${url}: invalid comments response`);
  const comments = pages.flat().filter((c) => c.user?.login === "greptile-apps[bot]").map((c) => c.body);
  return { comments, sources: [{ url: `https://api.github.com/${endpoint}`, sha256: hash(stdout), encoding: "Paginated JSON from gh api --slurp" }] };
}

export async function greptileInputs({ root = benchRoot } = {}) {
  const { file: suite, split, def } = readSuite("greptile", { root });
  const count = Object.values(split?.cases ?? {}).flat().length;
  if (suite.cases.length !== count) throw new Error(`Greptile requires all ${count} cases from ${def.split}`);
  const sources = json(join(root, "suites/greptile/sources.json"));
  const asset = await publicSource("greptile", sources.original.asset, { root });
  const originals = greptileRows(asset.toString("utf8"));
  const corrected = new Map();
  for (const pin of sources.corrected.files) corrected.set(pin.path, JSON.parse(await publicSource("greptile", pin, { root })));
  const cases = []; const reviewSources = [];
  for (const c of suite.cases) {
    const original = originals.find((r) => r.prUrl === c.prUrl);
    if (!original) throw new Error(`${c.id}: missing original truth`);
    const pin = c.truthSets.augment;
    const matches = corrected.get(pin.file)?.filter((r) => r.pr_title === c.correctedTitle);
    if (matches?.length !== 1) throw new Error(`${c.id}: missing or ambiguous corrected truth`);
    const truth = greptileTruth(original, matches[0], { greptile: c.truthSets.greptile.source, augment: pin.source });
    if (truthHashOf(truth.sets) !== c.truthHash) throw new Error(`${c.id}: truth differs from suite pin`);
    const review = await commentsAt(c.prUrl);
    cases.push({ id: c.id, comments: review.comments, truthSets: truth.sets });
    reviewSources.push(...review.sources);
  }
  // The closure is called only after judging. Neither the adapter nor its
  // model provider receives the original asset or any vendor label.
  const published = () => {
    const text = asset.toString("utf8"); const labels = [];
    for (const dataset of Object.keys(GREPTILE_REPOS)) {
      const start = text.indexOf(`{id:"${dataset}",label:`);
      const at = text.indexOf("toolResults:[", start);
      const matched = /name:"Greptile",href:"[^"]+",catches:\[([^\]]+)\]/.exec(text.slice(at));
      const caught = matched?.[1].split(",").map((s) => s === "!0" ? true : s === "!1" ? false : null);
      const rows = originals.filter((r) => r.dataset === dataset);
      if (caught?.length !== 10 || caught.some((v) => v === null)) throw new Error(`${dataset}: missing vendor labels`);
      rows.forEach((r, i) => {
        const c = suite.cases.find((c) => c.prUrl === r.prUrl);
        if (!c) throw new Error(`${r.prUrl}: extra vendor label`);
        labels.push({ id: c.id, label: caught[i] ? "caught" : "missed" });
      });
    }
    return labels;
  };
  return { cases, published, sources: { original: sources.original, corrected: sources.corrected, reviews: reviewSources } };
}

export async function martianInputs({ root = benchRoot } = {}) {
  const { split, def } = readSuite("martian", { root });
  const count = Object.values(split?.cases ?? {}).flat().length;
  const pin = json(join(root, "suites/martian/verification-source.json"));
  const all = JSON.parse(await publicSource("martian", pin, { root }));
  if (Object.keys(all).length !== count) throw new Error(`Martian requires all ${count} public reviews from ${def.split}`);
  const manifest = json(join(root, "suites/martian/calibration-sources.json"));
  const pipeline = join(root, "results/calibration-sources/martian");
  const files = new Map();
  for (const pin of manifest.files) files.set(pin.path, await publicSource("martian", pin, { root }));
  // publicSource may have read a raw cache file. The complete immutable
  // pipeline is materialised under results, without modifying their code.
  for (const [path, bytes] of files) { mkdirSync(dirname(join(pipeline, path)), { recursive: true }); writeFileSync(join(pipeline, path), bytes); }
  const data = {};
  for (const [url, entry] of Object.entries(all)) {
    const reviews = entry.reviews.filter((r) => r.tool === "augment");
    if (reviews.length !== 1) throw new Error(`${url}: missing or duplicate Augment review`);
    const review = reviews[0];
    data[url] = { ...entry, openqodex: { caseId: url }, reviews: [{ ...review, openqodex: { findingIds: review.review_comments.map((_, i) => `${url}#comment${i}`) } }] };
  }
  const prompts = manifest.files.filter((p) => /step[23]/.test(p.path));
  const promptHash = hash(canonicalJson(prompts));
  return { data, checkout: join(pipeline, "offline"), state: { commit: manifest.revision, tree: manifest.tree }, promptHash, sources: { ...manifest, data: pin }, published: () => JSON.parse(files.get("offline/results/anthropic_claude-opus-4-5-20251101/evaluations.json")) };
}
