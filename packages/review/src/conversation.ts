// The conversation with the reviewer: the brief, then at most two
// correction rounds, each answer read and checked by script. Also the two
// things that keep secrets away from the reviewer: the snapshot's own
// redaction, and the check on every changed range the tool sends itself.
import { lstatSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OpenQodexError, outsideSnapshot, redactSecrets, redactSecretsKeepingLines, removedRuns, secretTexts } from "@openqodex/core";
import type { Change, Hunk, Report, TraceEntry } from "@openqodex/core";
import type { Turn } from "./agents/driver.js";
import { classify } from "./agents/trace.js";
import { MAX_FILE_BYTES, snapshotFiles } from "./snapshot.js";

const MAX_CORRECTIONS = 2;
const HEARTBEAT_MS = 15_000;
// An answer bigger than this is not read.
const MAX_ANSWER_BYTES = 2 * 1024 * 1024;
// Snapshot files bigger than this cannot be checked for secrets and are removed from it.
const MAX_REDACT_BYTES = 64 * 1024 * 1024;

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
  // Each secret and each line of a multi-line one, as every redaction looks for them.
  const usable = secretTexts(secrets).map((s) => Buffer.from(s, "utf8"));
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
// the redacted snapshot (never the developer's folder or git objects),
// numbered as the snapshot holds them, with a few lines of context. A
// deletion is shown as its removed lines between its anchors, taken from the
// diff the change already holds (`change.diffs`, the text the brief carries),
// with the anchors and context from the snapshot. Up to DELIVER_LINES lines
// and DELIVER_BYTES bytes; a range split at the bound continues next round,
// and a deletion goes whole or waits. Never carried, so left unread: a
// deletion whose removed lines the change does not hold (its file was past
// the diff cap), a file the snapshot dropped, a binary file, a range with a
// very long line. `later`: how many of `left` may still come in a round.
// The text then goes through the brief's redaction once more; if a found
// secret is still in it, nothing is sent and `leak` is set, which makes the
// run incomplete.
export function deliverRanges(args: { snapshotDir: string; unread: Hunk[]; earlier?: Hunk[]; secrets: string[]; change?: Pick<Change, "files" | "deletionPoints" | "diffs"> }): { text: string; delivered: Hunk[]; left: Hunk[]; later: number; leak: boolean } {
  let room = DELIVER_LINES;
  let bytes = DELIVER_BYTES;
  let later = 0;
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
  const runs = new Map<string, { after: number; lines: string[] }[]>();
  // The lines that show deletion `h`, or null when the change does not hold
  // what it removed. A deleted file has no snapshot copy, so no context.
  const removedBlock = (h: Hunk): string[] | null => {
    const points = (args.change?.deletionPoints.get(h.path) ?? []).filter((p) => Math.min(...p.anchors) === h.start && Math.max(...p.anchors) === h.end);
    if (points.length === 0) return null;
    const diff = args.change?.diffs?.find((d) => d.path === h.path);
    if (diff !== undefined && !runs.has(h.path)) runs.set(h.path, removedRuns(diff.text));
    const file = args.change?.files.find((f) => f.path === h.path);
    const gone = file?.status === "deleted";
    const lines = gone ? [] : fileLines(h.path);
    if (lines === null) return null;
    const count = lines.length > 0 && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
    const block: string[] = [];
    for (const p of points) {
      // A deleted empty text file removed no line, and git shows it no hunk.
      const run = p.lines === 0 && gone && !file.binary ? { after: p.after, lines: [] } : runs.get(h.path)?.find((r) => r.after === p.after && r.lines.length === p.lines);
      if (run === undefined) return null;
      const n = run.lines.length;
      if (n === 0) {
        block.push(`${h.path}: the file was deleted; it held no lines.`);
        continue;
      }
      const from = Math.max(1, p.after - CONTEXT + 1);
      const to = Math.min(count, p.after + CONTEXT);
      const where = gone ? "with the file, which was deleted" : count === 0 ? "and the file is now empty" : p.after === 0 ? "above line 1" : p.after < count ? `between lines ${p.after} and ${p.after + 1}` : `below line ${p.after}`;
      block.push(`${h.path}: ${n} ${n === 1 ? "line" : "lines"} removed ${where}${to >= from ? ` (with context ${from} to ${to})` : ""}:`);
      for (let i = from; i <= Math.min(p.after, to); i++) block.push(`${i}\t${lines[i - 1] ?? ""}`);
      // Redacted as the brief redacts its diff: the snapshot never held these lines.
      for (const r of redactSecretsKeepingLines(run.lines.join("\n"), args.secrets).split("\n")) block.push(`-\t${r}`);
      for (let i = Math.max(from, p.after + 1); i <= to; i++) block.push(`${i}\t${lines[i - 1] ?? ""}`);
    }
    return block;
  };
  for (const h of args.unread) {
    if (h.deletion) {
      const block = removedBlock(h);
      if (block === null) {
        left.push(h);
        continue;
      }
      const size = block.reduce((k, l) => k + Buffer.byteLength(l, "utf8") + 1, 1);
      const long = block.some((l) => l.length > MAX_DELIVER_LINE_CHARS);
      if (!long && block.length + 1 <= room && size <= bytes) {
        out.push(...block, "");
        room -= block.length + 1;
        bytes -= size;
        delivered.push(h);
      } else {
        left.push(h);
        if (!long && block.length + 1 <= DELIVER_LINES && size <= DELIVER_BYTES) later++;
      }
      continue;
    }
    const lines = fileLines(h.path);
    if (lines === null || h.end < h.start) {
      left.push(h);
      continue;
    }
    for (const [first, last] of gaps(h, args.earlier ?? [])) {
      let at = first;
      let long = false;
      while (at <= last && room > 2 * CONTEXT + 2) {
        // Halved until it fits the bytes left, so a range of wide lines is
        // sent in parts rather than promised for a round that cannot carry it.
        let n = Math.min(last - at + 1, room - 2 * CONTEXT - 1);
        let block: string[];
        let size: number;
        for (;;) {
          const from = Math.max(1, at - CONTEXT);
          const to = Math.min(lines.length, at + n - 1 + CONTEXT);
          block = [`${h.path} lines ${at} to ${at + n - 1} (with context ${from} to ${to}):`];
          for (let i = from; i <= to; i++) block.push(`${i}\t${lines[i - 1] ?? ""}`);
          size = block.reduce((k, l) => k + Buffer.byteLength(l, "utf8") + 1, 1);
          long = block.some((l) => l.length > MAX_DELIVER_LINE_CHARS);
          if (long || size <= bytes || n === 1) break;
          n = Math.ceil(n / 2);
        }
        if (long || size > bytes) break;
        out.push(...block, "");
        room -= block.length + 1;
        bytes -= size;
        delivered.push({ path: h.path, start: at, end: at + n - 1, deletion: false });
        at += n;
      }
      if (at <= last) {
        left.push({ ...h, start: at, end: last });
        if (!long) later++;
      }
    }
  }
  const text = redactSecrets(out.join("\n").trimEnd(), args.secrets);
  const usable = secretTexts(args.secrets);
  if (usable.some((x) => text.includes(x)) || text !== out.join("\n").trimEnd()) return { text: "", delivered: [], left: args.unread, later: 0, leak: true };
  return { text, delivered, left, later, leak: false };
}

// How much of one untraced call's input trace.json keeps.
const MAX_DETAIL_CHARS = 2000;

const renumber = (errors: string[]) => errors.map((e, i) => `${i + 1}. ${e.replace(/^\d+\.\s+/, "")}`);

export type Conversation = {
  rounds: number;
  trace: TraceEntry[];
  usage: Turn["usage"];
  // The latest answer's report, null when it failed a check; `errors` are
  // that answer's. `checked`: the last answer that passed every check and
  // its submission, kept when a later answer fails, so an incomplete
  // review still shows the findings already checked.
  report: Report | null;
  checked: { report: Report; submission: unknown } | null;
  errors: string[];
  required: number;
  disposed: number;
  failure: string | null;
  submission: unknown;
  // Changed ranges the tool put in front of the reviewer in a correction.
  delivered: Hunk[];
  // The same, by the correction round that carried them: the first entry is
  // the second answer's message. A model reviewer counts a round's ranges
  // only when the request carrying them was invoked.
  carried: Hunk[][];
  startedAt: number;
  endedAt: number;
};

// What the conversation talks to: an agent reviewer, or a model reviewer's
// session in the brain's own loop. Each `send` asks for one answer.
export type Speaker = { send(text: string): Promise<Turn> };

// The brief, then at most two correction rounds. A
// round goes back when the answer failed a check or when changed ranges are
// still unread: the tool then puts those ranges in the message itself
// (deliverRanges), so coverage never depends on the model choosing to open a
// file. The message is never printed or saved. A read outside the snapshot
// ends the conversation when the driver's trace is complete.
export async function converse(args: {
  session: Speaker;
  snapshotDir: string;
  brief: string;
  deadline: number;
  // The driver's trace shows every tool call: a read outside the snapshot
  // in it ends the conversation. Without that, the trace is diagnostic only.
  traced: boolean;
  check: (submission: unknown, trace: TraceEntry[], delivered: Hunk[]) => { report: Report | null; errors: string[]; unread: Hunk[]; required: number; disposed: number };
  deliver: (unread: Hunk[], earlier: Hunk[]) => { text: string; delivered: Hunk[]; left: Hunk[]; later: number; leak: boolean };
  say: (line: string) => void;
  // The run's clock, epoch milliseconds; `deadline` is on it.
  now: () => number;
}): Promise<Conversation> {
  const startedAt = args.now();
  const c: Conversation = { rounds: 0, trace: [], usage: { turns: 0, input_tokens: null, output_tokens: null, cost_usd: null }, report: null, checked: null, errors: [], required: 0, disposed: 0, failure: null, submission: null, delivered: [], carried: [], startedAt, endedAt: startedAt };
  const heartbeat = setInterval(() => args.say(`Reviewer still working: ${Math.round((args.now() - startedAt) / 1000)} s`), HEARTBEAT_MS);
  heartbeat.unref();
  try {
    let text = args.brief;
    for (;;) {
      c.rounds++;
      let timer: NodeJS.Timeout | undefined;
      const late = new Promise<Turn>((done) => {
        timer = setTimeout(() => done({ finalText: "", calls: [], usage: c.usage, sessionId: null, failure: "the reviewer timed out and was stopped" }), Math.max(0, args.deadline - args.now()));
      });
      let turn: Turn;
      try {
        turn = await Promise.race([args.session.send(text), late]);
      } catch (error) {
        turn = { finalText: "", calls: [], usage: c.usage, sessionId: null, failure: `the reviewer failed: ${(error as Error).message}` };
      } finally {
        clearTimeout(timer);
      }
      // A model reviewer's turn carries the brain's own log, already checked.
      c.trace.push(...(turn.brain?.trace ?? turn.calls.map((call): TraceEntry => (args.traced ? classify(args.snapshotDir, call, turn.own ?? null) : { tool: call.tool, path: null, inside: null, range: null, ok: call.ok, detail: JSON.stringify(call.input ?? null).slice(0, MAX_DETAIL_CHARS) }))));
      c.usage = turn.usage;
      if (turn.failure !== null) {
        c.failure = turn.failure;
        break;
      }
      // An attempt outside the snapshot ends the review: it never completes.
      if (args.traced && c.trace.some(outsideSnapshot)) break;
      const parsed = parseAnswer(turn.finalText);
      const result = "error" in parsed ? { report: null, errors: [`1. ${parsed.error}`], unread: [] as Hunk[], required: c.required, disposed: 0 } : args.check(parsed.value, c.trace, c.delivered);
      if ("value" in parsed) c.submission = parsed.value;
      c.report = result.report;
      if (result.report !== null && "value" in parsed) c.checked = { report: result.report, submission: parsed.value };
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
      c.carried.push(given.delivered);
      args.say(`Correction round ${c.rounds} of ${MAX_CORRECTIONS}: ${problems.length} ${problems.length === 1 ? "problem" : "problems"}, ${given.delivered.length} unread changed ${given.delivered.length === 1 ? "range" : "ranges"} sent to the reviewer`);
      text = [
        ...(problems.length > 0 ? ["Your answer failed these checks. Fix every one.", "", ...problems, ""] : []),
        ...(given.text !== "" ? ["These changed lines were not in front of you yet. Check them now, as part of the change.", "", given.text, ""] : []),
        ...(given.later > 0 ? [`${given.later} more changed ${given.later === 1 ? "range follows" : "ranges follow"} in the next round, if one is left.`, ""] : []),
        "Then answer again with the whole JSON object and nothing else.",
      ].join("\n");
    }
  } finally {
    clearInterval(heartbeat);
    c.endedAt = args.now();
  }
  return c;
}
