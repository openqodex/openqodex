// `openqodex review`: the whole review in one run, owned by the tool.
//
//   prepare   the change, and a frozen snapshot of it under
//             <openqodex home>/checkouts/<run>/: committed, uncommitted and
//             untracked work (or a target's head), links as plain files
//   scan      the scanners and the code graph, on the snapshot
//   redact    secrets the scanners found, in the snapshot copy only
//   review    a reviewer process the tool starts (reviewers/), given the
//             brief, reading the snapshot alone
//   check     the answer, by script, with at most two correction rounds;
//             coverage from the brief, the correction rounds and, for a
//             reviewer whose trace is complete, its reads
//   report    one standard report, the report files and the completion record
//   clean     the snapshot is deleted, whatever happened
//
// The developer's files are never written. A tool failure, an incomplete
// review and a missing reviewer all exit 2.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  MANIFEST_VERSION,
  OpenQodexError,
  STATE_DIR,
  buildInventory,
  buildReviewerBrief,
  checkSubmission,
  REVIEWER_TOOLS,
  REVIEWER_WEB_TOOLS,
  completionRecord,
  gateReceipt,
  configHash,
  getChange,
  getTreeChange,
  getWholeRepo,
  openReportDir,
  readCoverage,
  redactSecrets,
  redactSecretsKeepingLines,
  safeGit,
  selectLenses,
  writeLatest,
  writeReportFiles,
} from "@openqodex/core";
import type { Change, ChangeScope, Config, Hunk, ImpactSummary, Latest, Report, ReviewerRecord, RunManifest, RunTarget, ScanResult, SelectedLens, Severity, TraceEntry, WholeRepo } from "@openqodex/core";
import { renderImpactBlock } from "@openqodex/graph";
import { announceRepoFiles } from "./agents/repo-folder.js";
import { addTargetCheckout, checkoutOwner, lfsPaths, placeSettings, removeTargetCheckout } from "./checkout.js";
import type { Checkout } from "./checkout.js";
import { EXIT_OK, EXIT_TOOL_FAILED } from "./exit-codes.js";
import { scannerList } from "./flags.js";
import type { GlobalFlags } from "./flags.js";
import { buildHotSpots, buildImpact, emitReport, exitFor, loadRepo, nothingToReview, ownersInstructions, progress, redactStored, reportFiles, scanChange, warn, wholeRepoLenses, writeReportCopies } from "./pipeline.js";
import type { PipelineResult } from "./pipeline.js";
import { keepRunStateOutOfRepo } from "./feedback.js";
import { directRunner, launcherPath, launcherRunner, launcherStarted, openqodexHomeDir, shQuote } from "./launcher.js";
import { writeHomeReceipt } from "./receipts.js";
import { claudeDriver } from "./reviewers/claude.js";
import { codexDriver } from "./reviewers/codex.js";
import { cursorDriver } from "./reviewers/cursor.js";
import { readReviewerSettings } from "./reviewers/settings.js";
import { DEPTH_ENV, REVIEWER_NAMES, hostAgent } from "./reviewers/driver.js";
import type { ReviewerDriver, ReviewerSession, Turn } from "./reviewers/driver.js";
import { classify } from "./reviewers/trace.js";
import { dropTempRef, resolveTarget } from "./target.js";

export const DEFAULT_TIMEOUT_SECONDS = 600;
const MAX_CORRECTIONS = 2;
const HEARTBEAT_MS = 15_000;
// An answer bigger than this is not read.
const MAX_ANSWER_BYTES = 2 * 1024 * 1024;
// Snapshot files bigger than this are neither redacted nor hashed by content.
const MAX_FILE_BYTES = 5 * 1024 * 1024;
// Snapshot files bigger than this cannot be checked for secrets and are removed from it.
const MAX_REDACT_BYTES = 64 * 1024 * 1024;
// redactSecrets ignores shorter matches; so does the byte check.
const MIN_SECRET_LENGTH = 6;

// The order `auto` tries them in, after the agent running the command.
const DRIVERS: ReviewerDriver[] = [claudeDriver, codexDriver, cursorDriver];

// Every file a review writes in its run folder may quote the code under review.
const PRIVATE = 0o600;

export type ReviewOptions = {
  flags: GlobalFlags;
  scope: ChangeScope;
  target?: string;
  base?: string;
  all?: boolean;
  only?: string;
  skip?: string;
  noGraph: boolean;
  // --reviewer; when left out, `reviewer:` in the user config, else auto.
  reviewer?: string;
  timeoutMs: number;
  // The drivers to choose from; tests pass a model provider stand-in.
  drivers?: ReviewerDriver[];
  // Files to review as they were before `init` wrote them (getChange overlay).
  overlay?: { path: string; content: string | null }[];
  // --block-on-severity: wins over review.block_on_severity in the config, as for scan.
  blockOn?: Severity;
  // --instructions: the owners' instructions from this file instead of the
  // repository's .openqodex/custom-instructions.md (the Action passes the
  // base branch's copy, so a pull request cannot supply its own).
  instructions?: string;
  // --report-dir: every file of this run goes to this folder alone, and
  // nothing under .openqodex/ in the checkout is created, read or written
  // (without --config and --instructions, the built-in defaults and no
  // instructions), so a caller takes this run's report and never one a
  // branch planted there, and a link a branch committed there cannot stop
  // the run.
  // reviewer.json there says whether a reviewer started (and which), and
  // why none could when none did.
  reportDir?: string;
  // --reviewer-web: the reviewer's web tools for this run, over the user
  // config's reviewer_web.
  web?: boolean;
};

type Chosen = { driver: ReviewerDriver; version: string; bin: string } | { unavailable: string[] };

// --reviewer or the user config, else the agent running this command when
// its driver is enabled, else the first enabled driver. A driver is enabled
// when detect() says its agent is installed, logged in and isolated; one
// that is not (Cursor, or Codex inside its own sandbox) says why and is
// passed by.
async function chooseReviewer(choice: string, drivers: ReviewerDriver[], repoRoot: string): Promise<Chosen> {
  if (choice !== "auto" && !(REVIEWER_NAMES as readonly string[]).includes(choice)) {
    throw new OpenQodexError(`--reviewer must be auto or one of ${REVIEWER_NAMES.join(", ")}, not ${choice}`);
  }
  const host = hostAgent();
  const order =
    choice !== "auto"
      ? drivers.filter((d) => d.name === choice)
      : [...drivers.filter((d) => d.name === host), ...drivers.filter((d) => d.name !== host)];
  const unavailable: string[] = [];
  for (const driver of order) {
    const d = await driver.detect(repoRoot);
    if (d.ok) return { driver, version: d.version, bin: d.bin };
    unavailable.push(`${driver.name}: ${d.missing}; ${d.fix}`);
  }
  return { unavailable: unavailable.length > 0 ? unavailable : [`${choice}: no driver of that name`] };
}

// Every regular file under `dir` but the work tree's .git link file, by
// path relative to `dir`. Links (there are none: they were written as
// plain files) and anything else are skipped.
function snapshotFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const path = rel === "" ? e.name : `${rel}/${e.name}`;
      if (path === ".git") continue;
      if (e.isDirectory()) walk(path);
      else if (e.isFile()) out.push(path);
    }
  };
  walk("");
  return out.sort();
}

// Replaces every copy of a secret the scanners found, in every file of the
// snapshot, so the reviewer never reads one. The snapshot is the tool's own
// copy; the developer's files are never touched.
// Every file is checked, whatever the diff shows. Text gets "[redacted]" on
// each line the secret held, its line breaks kept, so scanner locations and
// citations still name the same lines; a file that is not UTF-8 text gets
// each secret's bytes overwritten in place. A file too large to check is removed from the snapshot, so the
// reviewer cannot read it. A file that still holds a secret afterwards, or
// cannot be read or written, stops the run: nothing unredacted is shown.
// `named`: how many snapshot paths hold a secret in a file or folder name.
// Names are not rewritten (the paths must match the change); the run refuses
// to start the reviewer instead, since a listing would show the secret.
export function redactSnapshot(dir: string, secrets: string[]): { redacted: number; removed: string[]; named: number } {
  const usable = [...new Set(secrets)].filter((s) => s.length >= MIN_SECRET_LENGTH).map((s) => Buffer.from(s, "utf8"));
  const out = { redacted: 0, removed: [] as string[], named: 0 };
  if (usable.length === 0) return out;
  for (const path of snapshotFiles(dir)) {
    if (usable.some((s) => Buffer.from(path, "utf8").includes(s))) out.named++;
    const full = join(dir, path);
    try {
      if (lstatSync(full).size > MAX_REDACT_BYTES) {
        rmSync(full, { force: true });
        out.removed.push(path);
        continue;
      }
      const buf = readFileSync(full);
      if (!usable.some((s) => buf.includes(s))) continue;
      const text = buf.toString("utf8");
      let next: Buffer;
      if (Buffer.from(text, "utf8").equals(buf) && !buf.includes(0)) {
        next = Buffer.from(redactSecretsKeepingLines(text, secrets), "utf8");
      } else {
        next = Buffer.from(buf);
        for (const s of usable) for (let at = next.indexOf(s); at !== -1; at = next.indexOf(s, at + 1)) next.fill(0x78, at, at + s.length);
      }
      writeFileSync(full, next);
      if (usable.some((s) => readFileSync(full).includes(s))) throw new Error("a secret is still there");
      out.redacted++;
    } catch (error) {
      throw new OpenQodexError(`could not redact secrets in the snapshot copy of ${path} (${(error as Error).message.split("\n")[0]}); the review stops so the reviewer never reads it`);
    }
  }
  return out;
}

// One hash over every snapshot file's path and content (size and time for a
// file over the limit): taken before the reviewer starts and after it ends.
function hashSnapshot(dir: string): string {
  const h = createHash("sha256");
  for (const path of snapshotFiles(dir)) {
    const st = lstatSync(join(dir, path));
    h.update(`${path}\0`);
    h.update(st.size > MAX_FILE_BYTES ? `${st.size}:${st.mtimeMs}` : readFileSync(join(dir, path)));
    h.update("\0");
  }
  return h.digest("hex");
}

// Line counts of snapshot files, for the cited lines of dropped candidates.
function lineCounter(dir: string): (path: string) => number | null {
  const cache = new Map<string, number | null>();
  return (path) => {
    if (cache.has(path)) return cache.get(path) ?? null;
    let n: number | null = null;
    const full = resolve(dir, path);
    const rel = relative(dir, full);
    if (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel) && rel !== ".git") {
      try {
        const st = lstatSync(full);
        if (st.isFile() && st.size <= MAX_FILE_BYTES) {
          const buf = readFileSync(full);
          n = 0;
          for (let i = buf.indexOf(10); i !== -1; i = buf.indexOf(10, i + 1)) n++;
          if (buf.length > 0 && buf[buf.length - 1] !== 10) n++;
        }
      } catch {
        n = null;
      }
    }
    cache.set(path, n);
    return n;
  };
}

// The answer's JSON object: the whole text, a fenced block, or the outermost braces.
export function parseAnswer(text: string): { value: unknown } | { error: string } {
  if (Buffer.byteLength(text, "utf8") > MAX_ANSWER_BYTES) return { error: "the answer is over 2 MB" };
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n```/.exec(text)?.[1];
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  for (const candidate of [text.trim(), fenced, start !== -1 && end > start ? text.slice(start, end + 1) : undefined]) {
    if (candidate === undefined) continue;
    try {
      return { value: JSON.parse(candidate) as unknown };
    } catch {
      // try the next form
    }
  }
  return { error: "the answer is not one JSON object; answer with the JSON object only" };
}

// The most lines and bytes a correction round carries of changed ranges the
// reviewer was not given, context included; a range holding a line longer
// than MAX_DELIVER_LINE_CHARS is never carried.
export const DELIVER_LINES = 4000;
const DELIVER_BYTES = 512 * 1024;
const MAX_DELIVER_LINE_CHARS = 2000;
const CONTEXT = 3;

// The parts of `h` no earlier delivery covered.
function gaps(h: Hunk, earlier: Hunk[]): [number, number][] {
  const out: [number, number][] = [];
  let at = h.start;
  for (const d of earlier.filter((e) => e.path === h.path && !e.deletion).sort((x, y) => x.start - y.start)) {
    if (d.end < at) continue;
    if (d.start > h.end) break;
    if (d.start > at) out.push([at, d.start - 1]);
    at = Math.max(at, d.end + 1);
  }
  if (at <= h.end) out.push([at, h.end]);
  return out;
}

// Changed ranges put in front of the reviewer by the tool itself, read from
// the redacted snapshot only (never the developer's folder or git objects),
// numbered as the snapshot holds them, with a few lines of context. Up to
// DELIVER_LINES lines and DELIVER_BYTES bytes; a range split at the bound
// continues next round. Never carried, so left unread: a deletion (its lines
// exist only in git objects), a file the snapshot dropped, a binary file, a
// range with a very long line. The text then goes through the brief's
// redaction once more; if a found secret is still in it, nothing is sent and
// `leak` is set, which makes the run incomplete.
export function deliverRanges(args: { snapshotDir: string; unread: Hunk[]; earlier?: Hunk[]; secrets: string[] }): { text: string; delivered: Hunk[]; left: Hunk[]; leak: boolean } {
  let room = DELIVER_LINES;
  let bytes = DELIVER_BYTES;
  const out: string[] = [];
  const delivered: Hunk[] = [];
  const left: Hunk[] = [];
  const files = new Map<string, string[] | null>();
  const fileLines = (path: string): string[] | null => {
    if (!files.has(path)) {
      let lines: string[] | null = null;
      try {
        const full = join(args.snapshotDir, path);
        const st = lstatSync(full);
        if (st.isFile() && st.size <= MAX_FILE_BYTES) {
          const buf = readFileSync(full);
          if (!buf.includes(0) && Buffer.from(buf.toString("utf8"), "utf8").equals(buf)) lines = buf.toString("utf8").split("\n");
        }
      } catch {
        lines = null;
      }
      files.set(path, lines);
    }
    return files.get(path) ?? null;
  };
  for (const h of args.unread) {
    const lines = h.deletion ? null : fileLines(h.path);
    if (lines === null || h.end < h.start) {
      left.push(h);
      continue;
    }
    for (const [first, last] of gaps(h, args.earlier ?? [])) {
      let at = first;
      while (at <= last && room > 2 * CONTEXT + 2) {
        const n = Math.min(last - at + 1, room - 2 * CONTEXT - 1);
        const from = Math.max(1, at - CONTEXT);
        const to = Math.min(lines.length, at + n - 1 + CONTEXT);
        const block = [`${h.path} lines ${at} to ${at + n - 1} (with context ${from} to ${to}):`];
        for (let i = from; i <= to; i++) block.push(`${i}\t${lines[i - 1] ?? ""}`);
        const size = block.reduce((k, l) => k + Buffer.byteLength(l, "utf8") + 1, 1);
        if (block.some((l) => l.length > MAX_DELIVER_LINE_CHARS) || size > bytes) break;
        out.push(...block, "");
        room -= block.length + 1;
        bytes -= size;
        delivered.push({ path: h.path, start: at, end: at + n - 1, deletion: false });
        at += n;
      }
      if (at <= last) left.push({ ...h, start: at, end: last });
    }
  }
  const text = redactSecrets(out.join("\n").trimEnd(), args.secrets);
  const usable = args.secrets.filter((x) => x.length >= MIN_SECRET_LENGTH);
  if (usable.some((x) => text.includes(x)) || text !== out.join("\n").trimEnd()) return { text: "", delivered: [], left: args.unread, leak: true };
  return { text, delivered, left, leak: false };
}

// How much of one untraced call's input trace.json keeps.
const MAX_DETAIL_CHARS = 2000;

const renumber = (errors: string[]) => errors.map((e, i) => `${i + 1}. ${e.replace(/^\d+\.\s+/, "")}`);

type Prepared = {
  p: PipelineResult;
  snapshot: Checkout;
  tree: string | null;
  target?: RunTarget;
  whole?: WholeRepo;
};

type Conversation = {
  rounds: number;
  trace: TraceEntry[];
  usage: Turn["usage"];
  report: Report | null;
  errors: string[];
  required: number;
  disposed: number;
  failure: string | null;
  submission: unknown;
  // Changed ranges the tool put in front of the reviewer in a correction.
  delivered: Hunk[];
  startedAt: number;
  endedAt: number;
};

// The brief, then at most two correction rounds. A
// round goes back when the answer failed a check or when changed ranges are
// still unread: the tool then puts those ranges in the message itself
// (deliverRanges), so coverage never depends on the model choosing to open a
// file. The message is never printed or saved. A read outside the snapshot
// ends the conversation when the driver's trace is complete.
async function converse(args: {
  session: ReviewerSession;
  snapshotDir: string;
  brief: string;
  deadline: number;
  // The driver's trace shows every tool call: a read outside the snapshot
  // in it ends the conversation. Without that, the trace is diagnostic only.
  traced: boolean;
  check: (submission: unknown, trace: TraceEntry[], delivered: Hunk[]) => { report: Report | null; errors: string[]; unread: Hunk[]; required: number; disposed: number };
  deliver: (unread: Hunk[], earlier: Hunk[]) => { text: string; delivered: Hunk[]; left: Hunk[]; leak: boolean };
  say: (line: string) => void;
}): Promise<Conversation> {
  const startedAt = Date.now();
  const c: Conversation = { rounds: 0, trace: [], usage: { turns: 0, input_tokens: null, output_tokens: null, cost_usd: null }, report: null, errors: [], required: 0, disposed: 0, failure: null, submission: null, delivered: [], startedAt, endedAt: startedAt };
  const heartbeat = setInterval(() => args.say(`Reviewer still working: ${Math.round((Date.now() - startedAt) / 1000)} s`), HEARTBEAT_MS);
  heartbeat.unref();
  try {
    let text = args.brief;
    for (;;) {
      c.rounds++;
      let timer: NodeJS.Timeout | undefined;
      const late = new Promise<Turn>((done) => {
        timer = setTimeout(() => done({ finalText: "", calls: [], usage: c.usage, sessionId: null, failure: "the reviewer timed out and was stopped" }), Math.max(0, args.deadline - Date.now()));
      });
      let turn: Turn;
      try {
        turn = await Promise.race([args.session.send(text), late]);
      } catch (error) {
        turn = { finalText: "", calls: [], usage: c.usage, sessionId: null, failure: `the reviewer failed: ${(error as Error).message}` };
      } finally {
        clearTimeout(timer);
      }
      c.trace.push(...turn.calls.map((call): TraceEntry => (args.traced ? classify(args.snapshotDir, call) : { tool: call.tool, path: null, inside: null, range: null, ok: call.ok, detail: JSON.stringify(call.input ?? null).slice(0, MAX_DETAIL_CHARS) })));
      c.usage = turn.usage;
      if (turn.failure !== null) {
        c.failure = turn.failure;
        break;
      }
      // An attempt outside the snapshot ends the review: it never completes.
      if (args.traced && c.trace.some((t) => t.inside !== true)) break;
      const parsed = parseAnswer(turn.finalText);
      const result = "error" in parsed ? { report: null, errors: [`1. ${parsed.error}`], unread: [] as Hunk[], required: c.required, disposed: 0 } : args.check(parsed.value, c.trace, c.delivered);
      if ("value" in parsed) c.submission = parsed.value;
      c.report = result.report;
      c.errors = result.errors;
      c.required = result.required;
      c.disposed = result.disposed;
      const problems = renumber(result.errors);
      if ((problems.length === 0 && result.unread.length === 0) || c.rounds > MAX_CORRECTIONS) break;
      const given = args.deliver(result.unread, c.delivered);
      if (given.leak) {
        c.failure = "a secret the scanners found was still in the changed lines to send, so they were not sent";
        break;
      }
      if (problems.length === 0 && given.delivered.length === 0) break;
      c.delivered.push(...given.delivered);
      args.say(`Correction round ${c.rounds} of ${MAX_CORRECTIONS}: ${problems.length} ${problems.length === 1 ? "problem" : "problems"}, ${given.delivered.length} unread changed ${given.delivered.length === 1 ? "range" : "ranges"} sent to the reviewer`);
      text = [
        ...(problems.length > 0 ? ["Your answer failed these checks. Fix every one.", "", ...problems, ""] : []),
        ...(given.text !== "" ? ["These changed lines were not in front of you yet. Check them now, as part of the change.", "", given.text, ""] : []),
        ...(given.left.length > 0 ? [`${given.left.length} more changed ${given.left.length === 1 ? "range follows" : "ranges follow"} in the next round, if one is left.`, ""] : []),
        "Then answer again with the whole JSON object and nothing else.",
      ].join("\n");
    }
  } finally {
    clearInterval(heartbeat);
    c.endedAt = Date.now();
  }
  return c;
}

// A report that carries no finding: an incomplete review.
function incompleteReport(change: Change, scan: ScanResult, config: Config): Report {
  return {
    version: 1,
    kind: "review",
    change_id: change.id,
    base: { ref: change.baseRef, sha: change.baseSha },
    generated_at: new Date().toISOString(),
    verdict: "incomplete",
    block_on_severity: config.blockOnSeverity,
    summary: null,
    findings: [],
    below_threshold: 0,
    outside_change: [],
    low_confidence: [],
    not_reviewed: [],
    dropped: [],
    scanners: scan.scanners,
    impact: null,
    not_reviewed_paths: change.notReviewed,
    stats: change.stats,
  };
}

async function headOf(repoRoot: string): Promise<string> {
  const r = await safeGit(repoRoot, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  const sha = r.stdout.toString("utf8").trim();
  if (r.code !== 0 || sha === "") throw new OpenQodexError("the repository has no commit yet; commit once, then review");
  return sha;
}

// The change and its snapshot. `keep` receives the snapshot as soon as it
// exists, so the caller removes it whatever fails later.
async function prepare(o: ReviewOptions, repoRoot: string, config: Config, keep: (c: Checkout) => void): Promise<Prepared | null> {
  const flags = o.flags;
  const only = scannerList("--only", o.only);
  const skip = scannerList("--skip", o.skip);
  if (o.target !== undefined) {
    const t = await resolveTarget({ repoRoot, spec: o.target, offline: flags.offline, base: o.base, defaultBase: config.defaultBase });
    try {
      for (const note of t.notes) warn(note);
      progress(flags)(`Reviewing ${o.target} at ${t.headSha.slice(0, 12)}: base ${t.baseRef} (from ${t.baseSource}), merge base ${t.mergeBase.slice(0, 12)}`);
      const change = await getTreeChange({ repoRoot, baseRef: t.baseRef, baseSha: t.mergeBase, headSha: t.headSha, exclude: config.exclude });
      if (change.files.length === 0) {
        nothingToReview(change);
        return null;
      }
      const snapshot = await addTargetCheckout(repoRoot, t.headSha, `${change.shortId}-`);
      keep(snapshot);
      placeSettings(repoRoot, snapshot.tree, false, o.reportDir === undefined);
      const lfs = await lfsPaths(snapshot.tree, change.changedPaths);
      if (lfs > 0) warn(`${lfs} changed ${lfs === 1 ? "file is" : "files are"} stored in Git LFS and not fetched: the review sees the pointer files`);
      const target: RunTarget = { spec: o.target, base_ref: t.baseRef, base_source: t.baseSource, base_sha: t.baseSha, merge_base: t.mergeBase, head_sha: t.headSha, repo_root: repoRoot, checkout: snapshot.tree };
      const p = await scanChange({ repoRoot, workDir: snapshot.tree, config, change, flags, only, skip });
      return { p, snapshot, tree: null, target };
    } finally {
      if (t.tmpRef !== null) await dropTempRef(repoRoot, t.tmpRef);
    }
  }

  const head = await headOf(repoRoot);
  let snapshot: Checkout | null = null;
  let treeSha: string | null = null;
  const change = await getChange({
    repoRoot,
    scope: o.all ? { uncommitted: true } : o.scope,
    exclude: config.exclude,
    defaultBase: config.defaultBase,
    overlay: o.overlay,
    onTree: async (tree) => {
      treeSha = tree.sha;
      snapshot = await addTargetCheckout(repoRoot, head, "work-", tree);
      keep(snapshot);
    },
  });
  if (snapshot === null) throw new OpenQodexError("the snapshot of the change was not made");
  const snap: Checkout = snapshot;
  if (o.all) {
    // The whole repository as the snapshot holds it, so nothing written in
    // the developer's folder from here on is part of the review.
    const whole = await getWholeRepo({ repoRoot: snap.tree, exclude: config.exclude });
    const p = await scanChange<WholeRepo>({ repoRoot, workDir: snap.tree, config, change: whole, wholeRepo: true, flags, only, skip });
    return p.scan === null ? null : { p, snapshot: snap, tree: treeSha, whole: p.change };
  }
  if (change.files.length === 0) {
    nothingToReview(change);
    return null;
  }
  progress(flags)(`Reviewing the change against ${change.baseRef}: ${change.stats.files} ${change.stats.files === 1 ? "file" : "files"}, +${change.stats.additions} -${change.stats.deletions}`);
  const p = await scanChange({ repoRoot, workDir: snap.tree, config, change, flags, only, skip });
  return { p, snapshot: snap, tree: treeSha };
}

// The two-step review through the agent the developer works in, for when no
// reviewer can start: the same scope, folder, config and network limits,
// through the launcher, the pinned npx form, or a local build's own node and
// entry file (directRunner).
function fallbackCommand(o: ReviewOptions): string {
  const runner = launcherStarted() ? launcherRunner(launcherPath(openqodexHomeDir())) : directRunner();
  const base = o.base ?? o.scope.base;
  const scope = o.all
    ? ["--all"]
    : [...(o.target !== undefined ? [shQuote(o.target)] : []), ...(base !== undefined ? ["--base", shQuote(base)] : []), ...(o.scope.uncommitted ? ["--uncommitted"] : [])];
  const f = o.flags;
  const kept = [
    ...(f.cwd !== process.cwd() ? ["--cwd", shQuote(f.cwd)] : []),
    ...(f.config !== undefined ? ["--config", shQuote(resolve(f.config))] : []),
    ...(f.offline ? ["--offline"] : []),
    ...(f.noInstall ? ["--no-install"] : []),
  ];
  return [runner, "review", "--agent", ...scope, ...kept].join(" ");
}

// Where a run's files go: a new folder under .openqodex/reviews/ in the
// repository, or with --report-dir that folder alone, so nothing under
// .openqodex/ in the checkout is created, read or written (a branch can
// commit links there). `shown`: the folder as the receipts name it.
function runFolder(o: ReviewOptions, repoRoot: string, shortId: string): { dir: string; shown: string; write: (files: Record<string, string>) => void } {
  if (o.reportDir !== undefined) {
    const dir = resolve(o.reportDir);
    return { dir, shown: dir, write: (files) => writeReportCopies(dir, repoRoot, files) };
  }
  const dir = openReportDir(repoRoot, shortId);
  return { dir, shown: relative(repoRoot, dir), write: (files) => writeReportFiles(repoRoot, dir, files, PRIVATE) };
}

export async function runReview(o: ReviewOptions): Promise<number> {
  if (process.env[DEPTH_ENV]) throw new OpenQodexError("openqodex review cannot run inside an openqodex reviewer");
  const say = progress(o.flags);
  const loaded = await loadRepo(o.flags, o.reportDir === undefined);
  const repoRoot = loaded.repoRoot;
  const config: Config = o.blockOn === undefined ? loaded.config : { ...loaded.config, blockOnSeverity: o.blockOn };
  const owner = checkoutOwner(repoRoot);
  if (owner !== null) throw new OpenQodexError(`this folder is the temporary checkout of a review; run review from ${owner}`);
  if (o.reportDir === undefined) announceRepoFiles(repoRoot);
  else keepRunStateOutOfRepo();
  const settings = readReviewerSettings();
  const web = o.web ?? settings.web;
  const chosen = await chooseReviewer(o.reviewer ?? settings.reviewer, o.drivers ?? DRIVERS, repoRoot);
  const deadline = Date.now() + o.timeoutMs;

  let snapshot: Checkout | null = null;
  let session: ReviewerSession | null = null;
  // Ctrl-C or a kill: the reviewer's process group and the snapshot go too,
  // synchronously, since the process exits right after. The reviewer runs in
  // a group of its own, so nothing else would stop it. Git then forgets the
  // snapshot's work tree.
  // A driver's boundary check that is running (Codex's sandbox probe): its
  // process group and files, ended synchronously.
  let checking: (() => void) | null = null;
  const onSignal = (signal: NodeJS.Signals): void => {
    checking?.();
    session?.kill?.();
    if (snapshot !== null) {
      rmSync((snapshot as Checkout).folder, { recursive: true, force: true });
      spawnSync("git", ["worktree", "prune"], { cwd: repoRoot, stdio: "ignore", timeout: 5_000 });
    }
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    const prep = await prepare(o, repoRoot, config, (c) => (snapshot = c));
    if (prep === null) {
      if (o.all) warn("Nothing to review: the repository has no files");
      return EXIT_OK;
    }
    const { p } = prep;
    const scan = p.scan as ScanResult;
    const change = p.change;
    const folder = runFolder(o, repoRoot, change.shortId);
    const dir = folder.dir;
    // --report-dir: whether a reviewer started, and which, so a caller tells
    // a review that stopped from one that never began without reading stderr.
    const noteReviewer = (record: { started: boolean; reasons?: string[]; driver?: string; version?: string }): void => {
      if (o.reportDir !== undefined) folder.write({ "reviewer.json": `${JSON.stringify(redactStored(record, p.secrets))}\n` });
    };

    // No reviewer can start: the scanner candidates are saved as unchecked,
    // never as a review, and the fallback through the agent the developer is in is named.
    const unavailable = (reasons: string[]): number => {
      const path = join(dir, "unchecked-candidates.json");
      folder.write({
        "unchecked-candidates.json": `${JSON.stringify({ label: "unchecked scanner candidates, not a review: no reviewer checked them", change_id: change.id, candidates: scan.candidates }, null, 2)}\n`,
      });
      noteReviewer({ started: false, reasons });
      warn("Full review unavailable: openqodex could not start a reviewer.");
      for (const line of reasons) warn(`- ${line}`);
      warn(`Unchecked scanner candidates, not a review: ${path}`);
      warn(`To review with the agent you are in instead, run \`${fallbackCommand(o)}\` and follow the brief it prints.`);
      return EXIT_TOOL_FAILED;
    };
    if ("unavailable" in chosen) return unavailable(chosen.unavailable);

    const redaction = redactSnapshot(prep.snapshot.tree, p.secrets);
    if (redaction.redacted > 0) say(`Redacted secrets in ${redaction.redacted} ${redaction.redacted === 1 ? "file" : "files"} of the snapshot`);
    if (redaction.removed.length > 0) warn(`Left out of the review, too large to check for secrets: ${redaction.removed.join(", ")}`);
    // --report-dir without --instructions: none, never the checkout's file.
    const instructions = o.reportDir !== undefined && o.instructions === undefined ? { text: "", hash: null } : ownersInstructions(repoRoot, p.secrets, o.instructions);
    let lenses: SelectedLens[];
    let impact: ImpactSummary;
    let brief: { text: string; diffFiles: Set<string> };
    if (prep.whole) {
      const hot = await buildHotSpots(p, o.flags, o.noGraph);
      impact = hot.impact;
      lenses = wholeRepoLenses(prep.whole);
      brief = buildReviewerBrief({ change, scan, lenses, config, secrets: p.secrets, instructions: instructions.text, whole: { hot: hot.hot, graphNote: hot.note, inventory: buildInventory(prep.whole, scan) } });
    } else {
      impact = await buildImpact(p, o.flags, o.noGraph);
      lenses = selectLenses(change);
      brief = buildReviewerBrief({ change, scan, lenses, config, secrets: p.secrets, impactBlock: renderImpactBlock(impact), instructions: instructions.text, target: prep.target });
    }
    const manifest: RunManifest = {
      version: MANIFEST_VERSION,
      change_id: change.id,
      config_hash: configHash(config),
      created_at: new Date().toISOString(),
      lenses: lenses.map((l) => ({ name: l.name, confidenceFloor: l.confidenceFloor })),
      instructions_hash: instructions.hash,
      runtime_version: __OPENQODEX_VERSION__,
      ...(prep.target ? { target: prep.target } : {}),
    };
    folder.write({
      "manifest.json": `${JSON.stringify(manifest, null, 2)}\n`,
      "scan.json": `${JSON.stringify(scan, null, 2)}\n`,
      "brief.md": brief.text,
      "impact.json": `${JSON.stringify(impact, null, 2)}\n`,
    });

    // A reviewer whose trace is not complete (Codex) has no read counted:
    // coverage is the brief and the correction rounds only.
    const traced = chosen.driver.traced;
    // The driver's per-run proof of its boundary (Codex's sandbox probe),
    // on the redacted snapshot, before its hash is taken.
    const unsafe = (await chosen.driver.check?.({ snapshotDir: prep.snapshot.tree, bin: chosen.bin, register: (cleanup) => (checking = cleanup) })) ?? null;
    if (unsafe !== null) return unavailable([`${chosen.driver.name}: ${unsafe}`]);
    const before = hashSnapshot(prep.snapshot.tree);
    const lineCount = lineCounter(prep.snapshot.tree);
    // A secret in a path would reach the reviewer through any listing: the
    // reviewer is not started and the review is incomplete.
    const refused = redaction.named > 0 ? "a file name in the change holds a secret the scanners found, so the reviewer was not started; rename the file" : null;
    if (refused === null) session = chosen.driver.start({ snapshotDir: prep.snapshot.tree, deadline, bin: chosen.bin, web });
    if (session !== null) noteReviewer({ started: true, driver: chosen.driver.name, version: chosen.version });
    const pid = session?.pid ?? null;
    if (session !== null) say(`Reviewer: ${chosen.driver.name} ${chosen.version} started${pid !== null ? ` (process ${pid})` : ""}; this takes one to three minutes`);
    const startedIso = new Date().toISOString();
    const now = Date.now();
    const talk: Conversation = session === null ? { rounds: 0, trace: [], usage: { turns: 0, input_tokens: null, output_tokens: null, cost_usd: null }, report: null, errors: [], required: 0, disposed: 0, failure: refused, submission: null, delivered: [], startedAt: now, endedAt: now } : await converse({
      session,
      snapshotDir: prep.snapshot.tree,
      brief: brief.text,
      deadline,
      traced,
      say,
      check: (submission, trace, delivered) => {
        const r = checkSubmission({ change, scan, manifest, config, submission, lineCount, wholeRepo: prep.whole ? { lines: prep.whole.lines } : undefined });
        const unread = prep.whole ? [] : readCoverage({ change, briefFiles: brief.diffFiles, trace: traced ? trace : [], lineCount, delivered }).unread;
        return { report: r.ok ? r.report : null, errors: r.ok ? [] : r.errors, unread, required: r.required, disposed: r.disposed };
      },
      deliver: (unread, earlier) => deliverRanges({ snapshotDir: prep.snapshot.tree, unread, earlier, secrets: p.secrets }),
    }).finally(async () => {
      await session?.close();
    });
    if (talk.failure !== null) warn(`openqodex: ${talk.failure}`);
    const after = hashSnapshot(prep.snapshot.tree);

    const reviewer: ReviewerRecord | null = session === null ? null : {
      driver: chosen.driver.name,
      version: chosen.version,
      pid,
      started_at: startedIso,
      ended_at: new Date(talk.endedAt).toISOString(),
      duration_ms: talk.endedAt - talk.startedAt,
      rounds: talk.rounds,
      usage: talk.usage,
    };
    const coverage = readCoverage({ change, briefFiles: brief.diffFiles, trace: traced ? talk.trace : [], lineCount, delivered: talk.delivered });
    // Redacted like the report: a path or a tool input may hold a secret.
    const completion = redactStored(completionRecord({
      change,
      reviewer,
      snapshot: { tree: prep.tree, before, after },
      candidates: { total: talk.required, disposed: talk.disposed },
      coverage,
      trace: talk.trace,
      submissionErrors: talk.report ? [] : talk.errors,
      wholeRepo: prep.whole !== undefined,
      failure: talk.failure,
      tools: web ? [...REVIEWER_TOOLS, ...REVIEWER_WEB_TOOLS] : REVIEWER_TOOLS,
      traced,
    }), p.secrets);
    // An incomplete review keeps the findings of an answer that passed every
    // check: the report prints them as the findings so far.
    const report: Report = {
      ...(talk.report ?? incompleteReport(change, scan, config)),
      impact: prep.whole ? null : impact,
      completion,
    };
    if (completion.status !== "complete") report.verdict = "incomplete";

    folder.write({
      ...reportFiles(report),
      "submission.json": `${JSON.stringify(redactStored(talk.submission, p.secrets), null, 2)}\n`,
      "trace.json": `${JSON.stringify(redactStored(talk.trace, p.secrets), null, 2)}\n`,
    });
    const receipt: Latest = {
      dir: folder.shown,
      change_id: change.id,
      kind: "review",
      finalized: completion.status === "complete",
      verdict: completion.status === "complete" ? report.verdict : null,
      completion: completion.status,
    };
    // The push gate's receipt is the developer's own change only. With
    // --report-dir no receipt is written in the checkout; the one in the
    // developer's home still is.
    const inCheckout = o.reportDir === undefined;
    if (prep.whole) {
      if (inCheckout) writeReportFiles(repoRoot, join(repoRoot, STATE_DIR), { "latest-all.json": `${JSON.stringify(receipt, null, 2)}\n` });
    } else if (!prep.target) {
      // A link a branch put at .openqodex/latest.json stops this record only,
      // never the review: the report is written, and the push hooks trust the
      // record in the developer's home below.
      if (inCheckout) {
        try {
          writeLatest(repoRoot, receipt);
        } catch (error) {
          warn(`openqodex: could not write the review record in .openqodex: ${(error as Error).message.split("\n")[0]}`);
        }
      }
      // The record the push hooks trust, in the developer's home: a branch
      // cannot plant it the way it can carry files under .openqodex/.
      try {
        writeHomeReceipt(openqodexHomeDir(), repoRoot, gateReceipt(report, completion.status, folder.shown));
      } catch (error) {
        warn(`openqodex: could not record this review for the push hooks: ${(error as Error).message.split("\n")[0]}`);
      }
    }
    emitReport(report, o.flags, repoRoot);
    say(`Report: ${inCheckout ? relative(repoRoot, join(dir, "report.md")) : join(dir, "report.md")}`);
    return exitFor(report);
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    if (snapshot !== null) await removeTargetCheckout(repoRoot, (snapshot as Checkout).tree);
  }
}
