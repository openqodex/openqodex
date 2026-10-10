// Frozen normalisation contract for the laptop golden runs.
//
// Each rule below replaces a value that changes between two identical runs,
// with the reason it changes. Nothing else is touched.
//
// Exact values, replaced wherever they appear in any file:
// - the temporary home, demo and snapshot folders (<HOME>, <DEMO>,
//   <SNAPSHOT>): each run makes new ones with mkdtemp;
// - the review run id (<RUN_ID>): the run folder's name, made of the UTC
//   clock and random characters;
// - the repo id (<REPO_ID>): the SHA-256 of the demo's real path, which is a
//   new temporary folder each run;
// - the graph generation (<GRAPH_GENERATION>): the graph store names each
//   build from the clock, a counter, the process id and random bytes
//   (packages/graph/src/store/store.ts);
// - the snapshot hash: replaced by the hash of the normalised snapshot, by
//   the two-step rule below.
//
// JSON fields, in .json and .sarif files and in the JSON printed on stdout:
// - clocks (<TIMESTAMP>): created_at, generated_at, written_at, started_at,
//   ended_at, createdAt and builtAt, as ISO strings or epoch milliseconds;
// - durations (<DURATION_MS>): durationMs and duration_ms (scanner, graph
//   build and reviewer wall time), predictedMs (the graph's estimate, made
//   from the earlier builds' wall time) and every value of a "stages" object
//   (the graph build's time per stage);
// - the reviewer's process id (<REVIEWER_PID>), inside the reviewer record
//   only: the operating system gives each review a new process.
//
// The same times as rendered text, each where its renderer prints it:
// - stderr: the reviewer's process number, the code graph's build time
//   (packages/graph/src/build.ts), and every "Reviewer still working" line,
//   which is printed every 15 seconds of wall time, so how many there are
//   depends on the machine's speed;
// - brief.md: the graph build time in "Built on this machine from ... in
//   0.2 s" (packages/graph/src/render.ts); the rest of that line and of the
//   brief stays;
// - report.md: the reviewer's seconds (packages/core/src/render/review.ts)
//   and the scanner table's seconds (packages/core/src/render/markdown.ts);
// - report.html: the reviewer's seconds, the scanner table's seconds, the
//   graph build time and the two "Generated" times
//   (packages/core/src/render/html.ts).
// Rendered seconds become <SECONDS> and keep their unit.
//
// Never replaced: change ids, candidate ids, contract versions, coverage
// fields, finding content, the brief's text (beyond the paths and the graph
// build time above) and receipt kinds.
//
// Two hashes are made from files that hold the values above, so they follow
// a two-step rule. Capture first checks the raw hash against the raw files
// it captured (a mismatch fails the capture), then records the hash of the
// normalised files. A check applies the same rule to its fresh capture.
// - last-review.json's report_sha256 is the SHA-256 of the raw report.json.
// - The completion record's snapshot hash (before and after) covers every
//   file of the snapshot the reviewer was given, the graph files with their
//   timing among them (packages/cli/src/review-run.ts, hashSnapshot). The
//   model provider stand-in copies that snapshot when it starts.
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

export const sha256 = (text) => createHash("sha256").update(text).digest("hex");

const CLOCK_KEYS = "created_at|generated_at|written_at|started_at|ended_at|createdAt|builtAt";
const DURATION_KEYS = "durationMs|duration_ms|predictedMs";
const SECONDS = String.raw`\d+(?:\.\d+)? s`;

export function normalize(name, raw, context) {
  let text = raw;
  // Longest paths first, so replacing the home does not hide the snapshot.
  const paths = [[context.snapshot, "<SNAPSHOT>"], [context.demo, "<DEMO>"], [context.home, "<HOME>"]]
    .filter(([path]) => path).sort((a, b) => b[0].length - a[0].length);
  for (const [path, token] of paths) text = text.split(path).join(token);
  const values = [[context.runId, "<RUN_ID>"], [context.repoId, "<REPO_ID>"], [context.generation, "<GRAPH_GENERATION>"], [context.snapshotHash?.raw, context.snapshotHash?.normalized]];
  for (const [value, token] of values) {
    if (value && token) text = text.split(value).join(token);
  }
  if (name.endsWith(".json") || name.endsWith(".sarif")) {
    text = text.replace(new RegExp(String.raw`("(?:${CLOCK_KEYS})"\s*:\s*)("\d{4}-\d{2}-\d{2}T[^"\n]+"|\d{13})`, "g"), '$1"<TIMESTAMP>"');
    text = text.replace(new RegExp(String.raw`("(?:${DURATION_KEYS})"\s*:\s*)\d+(?:\.\d+)?`, "g"), '$1"<DURATION_MS>"');
    text = text.replace(/("stages"\s*:\s*\{)([^{}]*)(\})/g, (_, open, inner, close) => `${open}${inner.replace(/(:\s*)\d+(?:\.\d+)?/g, '$1"<DURATION_MS>"')}${close}`);
    // Only a pid within the reviewer record, not arbitrary provider input.
    text = text.replace(/("reviewer"\s*:\s*\{[^{}]*?"pid"\s*:\s*)\d+/g, '$1"<REVIEWER_PID>"');
  }
  if (name === "stderr.txt") {
    text = text.replace(/(Reviewer: (?:claude|codex) [\d.]+ started \(process )\d+(\))/g, "$1<REVIEWER_PID>$2");
    text = text.replace(new RegExp(String.raw`(Code graph: [^\n]*? in )${SECONDS}`, "g"), "$1<SECONDS> s");
    text = text.replace(/^Reviewer still working: \d+ s\n/gm, "");
  }
  if (name === "brief.md") {
    text = text.replace(new RegExp(String.raw`(Built on this machine from [^\n]*? in )${SECONDS}`, "g"), "$1<SECONDS> s");
  }
  if (name === "report.md") {
    text = text.replace(/(Reviewer: (?:claude|codex) [\d.]+, )\d+ s/g, "$1<SECONDS> s");
    text = text.replace(new RegExp(String.raw`(\| \d+ \| \d+ \| )${SECONDS}( \|)`, "g"), "$1<SECONDS> s$2");
  }
  if (name === "report.html") {
    text = text.replace(/((?:claude|codex) [\d.]+, )\d+ s/g, "$1<SECONDS> s");
    text = text.replace(/(<section class="scanners"[\s\S]*?<\/section>)/g, (section) => section.replace(new RegExp(String.raw`(<td class="n">)${SECONDS}(</td>)`, "g"), "$1<SECONDS> s$2"));
    text = text.replace(new RegExp(String.raw`(Built on this machine from the call graph of \d+ files? in )${SECONDS}`, "g"), "$1<SECONDS> s");
    text = text.replace(/(<dt>Generated<\/dt><dd>)\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC(<\/dd>)/g, "$1<TIMESTAMP>$2");
    text = text.replace(/(\. Generated )\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/g, "$1<TIMESTAMP>");
  }
  return text;
}

export function normalizedLastReview(rawReceipt, rawReport, normalizedReport, context) {
  const receipt = JSON.parse(rawReceipt);
  if (receipt.report_sha256 !== sha256(rawReport)) throw new Error("last-review.json raw report hash does not match captured report.json");
  const normalized = normalize("last-review.json", rawReceipt, context);
  return normalized.replace(receipt.report_sha256, sha256(normalizedReport));
}

// review-run.ts reads a file over this size by its size and time instead.
const MAX_FILE_BYTES = 5 * 1024 * 1024;

// The snapshot's files as review-run.ts lists them: every regular file, the
// top-level .git left out, sorted by path.
function snapshotFiles(dir) {
  const out = [];
  const walk = (rel) => {
    for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const path = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (path === ".git") continue;
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) out.push(path);
    }
  };
  walk("");
  return out.sort();
}

function hashFiles(dir, content) {
  const h = createHash("sha256");
  for (const path of snapshotFiles(dir)) {
    if (lstatSync(join(dir, path)).size > MAX_FILE_BYTES) throw new Error(`snapshot file ${path} is over 5 MB; its hash would hold its modification time`);
    h.update(`${path}\0`);
    h.update(content(path, readFileSync(join(dir, path))));
    h.update("\0");
  }
  return h.digest("hex");
}

// The snapshot hash the way review-run.ts takes it.
export const snapshotHash = (dir) => hashFiles(dir, (_, bytes) => bytes);

// Step one: the copy's raw hash must equal every raw hash the run recorded.
// Step two: the hash of the same files, each normalised by its own name.
export function normalizedSnapshotHash(dir, rawHashes, context) {
  const raw = snapshotHash(dir);
  if (rawHashes.some((h) => h !== raw)) throw new Error(`the snapshot hash ${rawHashes.join(", ")} does not match the snapshot the reviewer was given (${raw})`);
  const { snapshotHash: _, ...rest } = context;
  return hashFiles(dir, (path, bytes) => {
    const text = bytes.toString("utf8");
    return Buffer.from(text, "utf8").equals(bytes) ? Buffer.from(normalize(basename(path), text, rest), "utf8") : bytes;
  });
}
