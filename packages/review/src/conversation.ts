// The conversation with the reviewer: the brief, then at most two
// correction rounds, each answer read and checked by script. Also the two
// things that keep secrets away from the reviewer: the snapshot's own
// redaction, and the check on every changed range the tool sends itself.
import { closeSync, fchmodSync, fstatSync, openSync, readSync, renameSync, rmSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { DELIVERY_ROW_BYTES, lineHeading, fragmentSources, lineFragments, fragmentLabel, OpenQodexError, deliveryRow, diffHunks, diffIndex, leftSnapshot, redactSecrets, redactSecretsKeepingLines, removedRuns, secretTexts } from "@openqodex/core";
import type { ByteLine, Change, Hunk, HunkRef, Report, TraceEntry } from "@openqodex/core";
import { TIMED_OUT } from "./agents/driver.js";
import type { Turn } from "./agents/driver.js";
import { classify } from "./agents/trace.js";
import { snapshotByteLines } from "./line-fragments.js";
import { lineIndex, readRows, snapshotFiles } from "./snapshot.js";
import type { ReviewerRole } from "./usage.js";

export const MAX_CORRECTIONS = 2;
const HEARTBEAT_MS = 15_000;
// An answer bigger than this is not read.
const MAX_ANSWER_BYTES = 2 * 1024 * 1024;

// Replaces every copy of a secret the scanners found, in every file of the
// snapshot, so the reviewer never reads one. The snapshot is the tool's own
// copy; the developer's files are never touched.
// Every file is checked, whatever the diff shows. Text gets "[redacted]" on
// each line the secret held, its line breaks kept, so scanner locations and
// citations still name the same lines; a file that is not UTF-8 text gets
// each secret's bytes overwritten. Files of every size are streamed.
// A file that still holds a secret afterwards, or
// cannot be read or written, stops the run: nothing unredacted is shown.
// `named`: how many snapshot paths hold a secret in a file or folder name.
// Names are not rewritten (the paths must match the change); the run refuses
// to start the reviewer instead, since a listing would show the secret.
export function redactSnapshot(dir: string, secrets: string[]): { redacted: number; named: number } {
  // Each secret and each line of a multi-line one, as every redaction looks for them.
  const usable = secretTexts(secrets).map((s) => Buffer.from(s, "utf8"));
  const out = { redacted: 0, named: 0 };
  if (usable.length === 0) return out;
  const chunkBytes = 64 * 1024;
  const carryBytes = Math.max(...usable.map((s) => s.length)) - 1;
  // Inspect the entire byte stream before choosing text markers or binary
  // overwrites. The same bounded carry checks the replacement afterwards.
  const inspect = (full: string): { text: boolean; secret: boolean } => {
    const fd = openSync(full, "r");
    const chunk = Buffer.allocUnsafe(chunkBytes);
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let text = true;
    let secret = false;
    let carry: Buffer = Buffer.alloc(0);
    try {
      for (let n = readSync(fd, chunk); n > 0; n = readSync(fd, chunk)) {
        const bytes = chunk.subarray(0, n);
        if (bytes.includes(0)) text = false;
        if (text) {
          try { decoder.decode(bytes, { stream: true }); } catch { text = false; }
        }
        const window = Buffer.concat([carry, bytes]);
        secret ||= usable.some((s) => window.includes(s));
        carry = Buffer.from(window.subarray(Math.max(0, window.length - carryBytes)));
      }
      if (text) {
        try { decoder.decode(); } catch { text = false; }
      }
      return { text, secret };
    } finally { closeSync(fd); }
  };
  for (const path of snapshotFiles(dir)) {
    if (usable.some((s) => Buffer.from(path, "utf8").includes(s))) out.named++;
    const full = join(dir, path);
    const temp = join(dirname(full), `.oq-redact-${randomUUID().slice(0, 8)}`);
    let input = -1;
    let output = -1;
    let created = false;
    try {
      const kind = inspect(full);
      if (!kind.secret) continue;
      input = openSync(full, "r");
      const mode = fstatSync(input).mode & 0o7777;
      output = openSync(temp, "wx", mode);
      created = true;
      const write = (bytes: Buffer): void => {
        for (let at = 0; at < bytes.length;) at += writeSync(output, bytes, at, bytes.length - at);
      };
      const chunk = Buffer.allocUnsafe(chunkBytes);
      let carry: Buffer = Buffer.alloc(0);
      let carryMask: Buffer = Buffer.alloc(0);
      let masked = false;
      let marked = false;
      let cr = false;
      const endMask = (): void => {
        if (cr) write(Buffer.from("\r"));
        masked = false;
        marked = false;
        cr = false;
      };
      // Emit only bytes whose matches are all known. Keep the original
      // carry and its mask, so overlapping secrets across a boundary are
      // merged before any of their bytes can reach the reviewer.
      for (;;) {
        const n = readSync(input, chunk);
        const window = Buffer.concat([carry, chunk.subarray(0, n)]);
        const mask = Buffer.alloc(window.length);
        carryMask.copy(mask);
        const safe = n === 0 ? window.length : Math.max(0, window.length - carryBytes);
        for (const secret of usable) {
          for (let at = window.indexOf(secret); at !== -1; at = window.indexOf(secret, at + 1)) mask.fill(1, at, at + secret.length);
        }
        for (let at = 0; at < safe;) {
          const hidden = mask[at] === 1;
          const next = mask.indexOf(hidden ? 0 : 1, at);
          const end = next === -1 ? safe : Math.min(safe, next);
          if (!hidden) {
            if (masked) endMask();
            write(window.subarray(at, end));
          } else if (!kind.text) {
            write(Buffer.alloc(end - at, 0x78));
          } else {
            masked = true;
            for (let i = at; i < end; i++) {
              const byte = window[i];
              if (byte === 10) {
                if (cr) write(Buffer.from("\r"));
                write(Buffer.from("\n"));
                marked = false;
                cr = false;
              } else {
                // A CR is kept only at a line or span end, as in the
                // brief's line-preserving redaction.
                if ((byte !== 13 || cr) && !marked) {
                  write(Buffer.from("[redacted]"));
                  marked = true;
                }
                cr = byte === 13;
              }
            }
          }
          at = end;
        }
        carry = Buffer.from(window.subarray(safe));
        carryMask = Buffer.from(mask.subarray(safe));
        if (n === 0) break;
      }
      if (masked) endMask();
      // Restore the original mode after writing, regardless of the umask.
      fchmodSync(output, mode);
      closeSync(output);
      output = -1;
      closeSync(input);
      input = -1;
      if (inspect(temp).secret) throw new Error("a secret is still there");
      renameSync(temp, full);
      created = false;
      out.redacted++;
    } catch (error) {
      throw new OpenQodexError(`could not redact secrets in the snapshot copy of ${path} (${(error as Error).message.split("\n")[0]}); the review stops so the reviewer never reads it`);
    } finally {
      if (output !== -1) closeSync(output);
      if (input !== -1) closeSync(input);
      if (created) rmSync(temp, { force: true });
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

// The most rows and bytes a correction round carries, context included.
export const DELIVER_LINES = 4000;
const DELIVER_BYTES = 512 * 1024;
const CONTEXT = 3;

// Shared with the part cutter, including context, labels and the final blank.
export function pageRows(path: string, start: number, end: number, lines: string[]): string[] {
  const from = Math.max(1, start - CONTEXT);
  const to = Math.min(lines.length, end + CONTEXT);
  const block = [`${path} lines ${start} to ${end} (with context ${from} to ${to}):`];
  for (let i = from; i <= to; i++) block.push(...deliveryRow(path, i, lines[i - 1] ?? "", `${i}\t`));
  return [...block, ""];
}

// The parts of `h` no earlier delivery covered.
function gaps(h: Hunk, earlier: Hunk[]): [number, number][] {
  const out: [number, number][] = [];
  let at = h.start;
  for (const d of earlier.filter((e) => e.path === h.path && !e.deletion && !e.fragment).sort((x, y) => x.start - y.start)) {
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
// deletion whose removed lines a hand-built change does not hold, a file
// the snapshot dropped, or a binary file. `later`:
// how many of `left` may still come in a round.
// The text then goes through the brief's redaction once more; if a found
// secret is still in it, nothing is sent and `leak` is set, which makes the
// run incomplete.
export function deliverRanges(args: { snapshotDir: string; unread: Hunk[]; earlier?: Hunk[]; secrets: string[]; change?: Pick<Change, "files" | "deletionPoints" | "diffs"> }): { text: string; delivered: Hunk[]; left: Hunk[]; later: number; leak: boolean } {
  const usable = secretTexts(args.secrets);
  let room = DELIVER_LINES;
  let bytes = DELIVER_BYTES;
  let later = 0;
  const out: string[] = [];
  const delivered: Hunk[] = [];
  const left: Hunk[] = [];
  let leak = false;
  const fileLines = (path: string): { length: number; read: (from: number, to: number) => Iterable<{ line: number; text: string | null }> } | null => {
    const index = lineIndex(args.snapshotDir, path);
    if (index === null || !index.text) return null;
    return {
      length: index.count,
      read: function* (from, to) {
        for (const { line, text } of readRows(args.snapshotDir, path, from, to, DELIVER_BYTES)) {
          // Check before chunk labels can split a secret. Oversized rows
          // are skipped as bytes, never materialised as strings.
          if (text !== null && usable.some((secret) => text.includes(secret))) {
            leak = true;
            throw new Error("a secret is still in the snapshot row");
          }
          yield { line, text: text === null ? null : text.replace(/\n$/, "") };
        }
      },
    };
  };
  // Oversized context cannot keep the changed lines beside it unsent.
  const context = (path: string, i: number, text: string | null): string[] => (text === null ? null : deliveryRow(path, i, text, `${i}\t`)) ?? [`${i}\t(not shown: a context line over ${DELIVER_BYTES / 1024} KB)`];
  // The lines that show deletion `h`, or null when the change does not hold
  // what it removed. A deleted file has no snapshot copy, so no context.
  const removedBlock = (h: Hunk): string[] | { first: number; last: number } | null => {
    const points = (args.change?.deletionPoints.get(h.path) ?? []).filter((p) => Math.min(...p.anchors) === h.start && Math.max(...p.anchors) === h.end);
    if (points.length === 0) return null;
    const file = args.change?.files.find((f) => f.path === h.path);
    const gone = file?.status === "deleted";
    const lines = gone ? { length: 0, read: () => [] } : fileLines(h.path);
    if (lines === null) return null;
    const count = lines.length;
    const block: string[] = [];
    for (const p of points) {
      // A deleted empty text file removed no line, and git shows it no hunk.
      const run = p.lines === 0 && gone && !file.binary ? { after: p.after, oldStart: 1, lines: [] } : args.change && diffIndex(args.change, h.path)?.removed.find((r) => r.after === p.after && r.count === p.lines);
      if (!run) return null;
      const n = typeof h.deletion === "object" ? h.deletion.oldEnd - h.deletion.oldStart + 1 : "count" in run ? run.count : run.lines.length;
      if (n > DELIVER_LINES) return null;
      if (n === 0) {
        block.push(`${h.path}: the file was deleted; it held no lines.`);
        continue;
      }
      const from = Math.max(1, p.after - CONTEXT + 1);
      const to = Math.min(count, p.after + CONTEXT);
      let rows: (string | null)[];
      try { rows = [...lines.read(from, to)].map((row) => row.text); }
      catch { return null; }
      const where = gone ? "with the file, which was deleted" : count === 0 ? "and the file is now empty" : p.after === 0 ? "above line 1" : p.after < count ? `between lines ${p.after} and ${p.after + 1}` : `below line ${p.after}`;
      // A renamed file's old lines are named by its old path, as its rows are.
      const renamed = file?.oldPath && file.oldPath !== h.path ? ` of ${file.oldPath}` : "";
      block.push(`${h.path}: ${n} ${n === 1 ? "line" : "lines"} removed ${where}${typeof h.deletion === "object" ? ` (old lines ${h.deletion.oldStart} to ${h.deletion.oldEnd}${renamed})` : renamed ? ` (from ${file!.oldPath})` : ""}${to >= from ? ` (with context ${from} to ${to})` : ""}:`);
      for (let i = from; i <= Math.min(p.after, to); i++) block.push(...context(h.path, i, rows[i - from] ?? null));
      // Redacted as the brief redacts its diff: the snapshot never held these lines.
      const first = typeof h.deletion === "object" ? h.deletion.oldStart : run.oldStart;
      const last = typeof h.deletion === "object" ? h.deletion.oldEnd : run.oldStart + ("count" in run ? run.count : run.lines.length) - 1;
      let skipped = false;
      const removed = redactSecretsKeepingLines(args.change ? [...diffHunks(args.change, h.path, { start: first, end: last, side: "old" }, DELIVER_BYTES, { onLimit: () => { skipped = true; } })].flatMap((text) => removedRuns(text)).filter((r) => r.oldStart <= last && r.oldStart + r.lines.length - 1 >= first).flatMap((r) => r.lines.slice(Math.max(0, first - r.oldStart), last - r.oldStart + 1)).join("\n") : "", args.secrets).split("\n");
      if (skipped) return { first, last };
      for (let i = 0; i < removed.length; i++) {
        block.push(...deliveryRow(args.change?.files.find((f) => f.path === h.path)?.oldPath ?? h.path, first + i, removed[i]!, "-\t", true));
      }
      for (let i = Math.max(from, p.after + 1); i <= to; i++) block.push(...context(h.path, i, rows[i - from] ?? null));
    }
    return block;
  };
  const oldPath = (path: string) => args.change?.files.find((f) => f.path === path)?.oldPath ?? path;
  // Sends fragments of one line from `from` to `to`, skipping what an earlier
  // round sent. Returns the first byte not sent, or past `to` when done.
  const sendFragments = (source: ByteLine, from: number, to: number, label: (f: { from: number; to: number; total: number }) => string, sent: { from: number; to: number }[], record: (f: { from: number; to: number }) => void): number => {
    const ranges: [number, number][] = [];
    let cursor = from;
    for (const d of [...sent].sort((a, b) => a.from - b.from)) {
      if (d.from > cursor) ranges.push([cursor, Math.min(to, d.from - 1)]);
      cursor = Math.max(cursor, d.to + 1);
      if (cursor > to) break;
    }
    if (cursor <= to) ranges.push([cursor, to]);
    for (const [a, b] of ranges) for (const f of lineFragments(source, a, b)) {
      if (usable.some((secret) => f.text.includes(secret))) { leak = true; return a; }
      const row = `${label(f)}\t${redactSecrets(f.text, args.secrets)}`;
      const size = Buffer.byteLength(row) + 1;
      if (size > bytes || room <= 1) return f.from;
      out.push(row);
      bytes -= size;
      room--;
      record(f);
    }
    return to + 1;
  };
  for (const h of args.unread) {
    if (h.deletion && h.fragment && args.change) {
      let next = h.fragment.from;
      for (const { line, source } of fragmentSources(args.change as Change, h as HunkRef, args.secrets)) {
        const sent = (args.earlier ?? []).filter((d) => d.deletion && d.path === h.path && d.old?.[0] === h.old?.[0] && d.fragment).map((d) => d.fragment!);
        next = sendFragments(source, next, h.fragment.to, (f) => `-${fragmentLabel(oldPath(h.path), line, f.from, f.to, f.total, "old")}`, sent, (f) => {
          const previous = delivered.at(-1);
          if (previous?.deletion && previous.path === h.path && previous.old?.[0] === h.old?.[0] && previous.fragment?.to === f.from - 1) previous.fragment.to = f.to;
          else delivered.push({ ...h, fragment: { ...h.fragment!, from: f.from, to: f.to } });
        });
      }
      if (next <= h.fragment.to) { left.push({ ...h, fragment: { ...h.fragment, from: next } }); later++; }
      continue;
    }
    if (h.deletion) {
      if (args.earlier?.some((d) => d.deletion && !d.fragment && d.path === h.path && d.start === h.start && d.end === h.end && (typeof h.deletion !== "object" || typeof d.deletion === "object" && d.deletion.id === h.deletion.id && d.deletion.oldStart <= h.deletion.oldStart && d.deletion.oldEnd >= h.deletion.oldEnd))) continue;
      const block = removedBlock(h);
      if (block !== null && !Array.isArray(block)) {
        // Removed lines over the page budget go as byte fragments of their
        // old lines. The deletion counts as paged once every byte went.
        const { first, last } = block;
        const header = `${first === last ? lineHeading(oldPath(h.path), first, "old") : `${oldPath(h.path)}: old lines ${first} to ${last}`}, removed, in byte fragments:`;
        const size = Buffer.byteLength(header) + 1;
        if (size > bytes || room <= 2) { left.push(h); later++; continue; }
        out.push(header);
        bytes -= size;
        room--;
        let done = true;
        const ref = { id: "", path: h.path, start: h.start, end: h.end, deletion: { id: "", oldStart: first, oldEnd: last }, old: [first, last] } as HunkRef;
        for (const { line, source } of fragmentSources(args.change as Change, ref, args.secrets)) {
          const mine = (d: Hunk) => d.deletion === h.deletion && d.path === h.path && d.start === h.start && d.end === h.end && d.fragment !== undefined && d.old?.[0] === line;
          const sent = [...(args.earlier ?? []), ...delivered].filter(mine).map((d) => d.fragment!);
          const next = sendFragments(source, 1, source.bytes, (f) => `-${fragmentLabel(oldPath(h.path), line, f.from, f.to, f.total, "old")}`, sent, (f) => delivered.push({ ...h, old: [line, line], lineBytes: source.bytes, fragment: { from: f.from, to: f.to } }));
          if (next <= source.bytes) { done = false; break; }
        }
        out.push("");
        bytes -= 1;
        room--;
        if (done) delivered.push(h);
        else { left.push(h); later++; }
        continue;
      }
      if (block === null) {
        left.push(h);
        continue;
      }
      const size = block.reduce((k, l) => k + Buffer.byteLength(l, "utf8") + 1, 1);
      if (block.length + 1 <= room && size <= bytes) {
        out.push(...block, "");
        room -= block.length + 1;
        bytes -= size;
        delivered.push(h);
      } else {
        left.push(h);
        if (block.length + 1 <= DELIVER_LINES && size <= DELIVER_BYTES) later++;
      }
      continue;
    }
    const index = lineIndex(args.snapshotDir, h.path);
    if (index === null || h.end < h.start) {
      left.push(h);
      continue;
    }
    // A file that is not UTF-8 text is sent as bytes, line by line.
    const lines = index.text ? fileLines(h.path) : null;
    const long = new Map<number, number>();
    for (let i = 0; i < index.long.length; i += 2) long.set(index.long[i]!, index.long[i + 1]!);
    // At most the bytes a line's page takes with its context, labels aside.
    const pageBytes = (line: number) => {
      let n = 0;
      for (let i = Math.max(1, line - CONTEXT); i <= Math.min(index.count, line + CONTEXT); i++) n += long.get(i) ?? DELIVERY_ROW_BYTES;
      return n;
    };
    for (const [first, last] of gaps(h, args.earlier ?? [])) {
      let at = first;
      // A missing source is never promised as a future page.
      let never = false;
      while (at <= last && room > 2 * CONTEXT + 2) {
        const resumed = h.fragment !== undefined || h.fromByte !== undefined && at === first;
        let page: { block: string[]; size: number; n: number } | "bytes" | null = resumed || lines === null ? "bytes" : null;
        if (page === null) {
          // One read from the first context row: each row's size is kept, so
          // the largest page that fits is chosen without reading again.
          const limit = Math.min(bytes, DELIVER_BYTES);
          const from = Math.max(1, at - CONTEXT);
          const most = Math.min(last - at + 1, room - (h.part ? 2 : 2 * CONTEXT + 1));
          const to = Math.min(lines!.length, at + most - 1 + CONTEXT);
          const rows: { line: number; rows: string[]; size: number }[] = [];
          let total = 0;
          let open = last;
          try {
            for (const { line: i, text } of lines!.read(from, to)) {
              const changed = i >= at && i <= last;
              if (changed && text === null) {
                // Over the row bound: sent by fragments when it comes first.
                if (i === at) { page = "bytes"; break; }
                open = i - 1;
              }
              const shown = changed && text !== null ? deliveryRow(h.path, i, text, `${i}\t`) : context(h.path, i, text);
              const size = shown.reduce((k, row) => k + Buffer.byteLength(row, "utf8") + 1, 0);
              rows.push({ line: i, rows: shown, size });
              total += size;
              if (total > limit + 1024 || rows.length > room) break;
            }
          } catch { page = { block: [], size: Infinity, n: 1 }; }
          if (page === null) {
            let best: { block: string[]; size: number; n: number } | null = null;
            for (let n = Math.min(most, open - at + 1); n >= 1; n--) {
              const end = Math.min(lines!.length, at + n - 1 + CONTEXT);
              const inside = rows.filter((r) => r.line <= end);
              if (inside.at(-1)?.line !== end && end <= to) continue;
              const head = `${h.path} lines ${at} to ${at + n - 1} (with context ${from} to ${end}):`;
              const block = [head, ...inside.flatMap((r) => r.rows)];
              const size = Buffer.byteLength(head, "utf8") + 2 + inside.reduce((k, r) => k + r.size, 0);
              best = { block, size, n };
              if (size <= bytes && block.length + 1 <= room) break;
            }
            // A read stopped at this round's bound only shows the page does not fit now.
            page = best ?? { block: rows.flatMap((r) => r.rows), size: total, n: 1 };
            // A long line whose page can never fit goes by fragments now; one
            // that only misses this round's room waits for a whole page.
            if (page.n === 1 && (page.size > bytes || page.block.length + 1 > room) && long.has(at) && pageBytes(at) > DELIVER_BYTES * 0.9) page = "bytes";
          }
        }
        if (page === "bytes") {
          // One line by byte fragments, between its context rows.
          let next = at === first ? h.fromByte ?? h.fragment?.from ?? 1 : 1;
          let total = h.lineBytes ?? 0;
          try {
            for (const { source } of snapshotByteLines(args.snapshotDir, h.path, at, at)) {
              total = source.bytes;
              const end = h.fragment?.to ?? total;
              // Context frames a line once: before its first byte and after its
              // last. Each side is read on its own, never the long line itself.
              // The first fragment row: its label, measured, and the most text a
              // row holds. A byte that is not UTF-8 decodes to three.
              const one = Buffer.byteLength(fragmentLabel(h.path, at, total, total, total)) + (index.text ? 1 : 3) * DELIVERY_ROW_BYTES + 2;
              const rowsOf = (from: number, to: number) => lines && from <= to ? [...lines.read(from, to)].flatMap(({ line: i, text }) => context(h.path, i, text)) : [];
              let before = next === 1 ? rowsOf(Math.max(1, at - CONTEXT), at - 1) : [];
              const heading = (shown: boolean) => `${lineHeading(h.path, at)}, in byte fragments${shown ? ` (with context ${Math.max(1, at - CONTEXT)} to ${at - 1} before it)` : ""}:`;
              const size = (rows: string[]) => rows.reduce((k, row) => k + Buffer.byteLength(row) + 1, 0);
              // Context that leaves no room for a fragment is left out, and
              // the heading says so by naming none.
              if (before.length && size([heading(true), ...before]) + one > bytes) before = [];
              const frame = [heading(before.length > 0), ...before];
              const frameSize = size(frame);
              // A page with no room for one fragment beside its heading waits.
              if (frameSize + one > bytes || frame.length + 2 > room) break;
              out.push(...frame);
              bytes -= frameSize;
              room -= frame.length;
              const sent = (args.earlier ?? []).filter((d) => d.path === h.path && d.start === at && d.fragment).map((d) => d.fragment!);
              next = sendFragments(source, next, end, (f) => fragmentLabel(h.path, at, f.from, f.to, f.total), sent, (f) => {
                const previous = delivered.at(-1);
                if (previous?.path === h.path && previous.start === at && previous.fragment?.to === f.from - 1) previous.fragment.to = f.to;
                else delivered.push({ ...h, start: at, end: at, lineBytes: total, fromByte: undefined, fragment: { ...(h.fragment?.of ?? h.id ? { of: h.fragment?.of ?? h.id } : {}), from: f.from, to: f.to } });
              });
              // Only the line's last byte, not a part's, is followed by its context.
              const after = next > total && at < index.count ? rowsOf(at + 1, Math.min(index.count, at + CONTEXT)) : [];
              const framed = after.length ? [`${lineHeading(h.path, at)}, context after it (${at + 1} to ${Math.min(index.count, at + CONTEXT)}):`, ...after] : [];
              const tail = framed.length && size([...framed, ""]) <= bytes && framed.length + 1 <= room ? [...framed, ""] : [""];
              const tailSize = size(tail);
              if (tailSize <= bytes && tail.length <= room) { out.push(...tail); bytes -= tailSize; room -= tail.length; }
            }
          } catch { /* Missing or invalid bytes keep this line unread. */ }
          if (next <= (h.fragment?.to ?? total) || total === 0) {
            // Only the line it names carries a byte position.
            left.push({ ...h, start: at, end: at, fromByte: next, lineBytes: total });
            if (at < last) left.push({ ...h, start: at + 1, end: last, fromByte: undefined, lineBytes: undefined });
            later += at < last ? 2 : 1;
            at = last + 1;
            break;
          }
          at++;
          continue;
        }
        if (page === null) break;
        if (page.size > bytes || page.block.length + 1 > room) {
          never = page.size > DELIVER_BYTES || page.block.length + 1 > DELIVER_LINES;
          break;
        }
        out.push(...page.block, "");
        room -= page.block.length + 1;
        bytes -= page.size;
        delivered.push({ ...h, start: at, end: at + page.n - 1, deletion: false });
        at += page.n;
      }
      if (at <= last) {
        left.push({ ...h, start: at, end: last });
        if (!never) later++;
      }
    }
  }
  const text = redactSecrets(out.join("\n").replace(/\n$/, ""), args.secrets);
  if (leak || usable.some((x) => text.includes(x)) || text !== out.join("\n").replace(/\n$/, "")) return { text: "", delivered: [], left: args.unread, later: 0, leak: true };
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

// One correction round, as the tool sent it. `by`: the reviewer it went to
// (the caller of `converse` adds it). `round`: the answer it corrects (1 for
// the answer to the brief). `errors`: every check that answer failed, as the
// reviewer was told it, without its number. `delivered`: the changed ranges
// the round carried. `later`: how many more it promised for a next round.
// `answer`: the answer the checks judged, as parsed, null when it was not
// one JSON object. Kept so a finding a check rejected, and the next answer
// left out, still shows it was raised.
export type CorrectionRound = { by: ReviewerRole; round: number; errors: string[]; delivered: Hunk[]; later: number; answer: unknown };

// The brief, then at most two correction rounds. A
// round goes back when the answer failed a check or when changed ranges are
// still unread: the tool then puts those ranges in the message itself
// (deliverRanges), so coverage never depends on the model choosing to open a
// file. The message is never printed or saved; its errors and ranges go to
// `onRound`. A read outside the snapshot ends the conversation when the
// driver's trace is complete.
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
  // Called with each correction round before it is sent.
  onRound?: (round: Omit<CorrectionRound, "by">) => void;
  // The failure of a turn the deadline stopped, in place of TIMED_OUT.
  timedOut?: string;
  heartbeat?: boolean;
  staged?: boolean;
  sessionName?: string;
  earlier?: Hunk[];
  // Seed a fresh verifier with its saved answer after assembly found an error.
  continuation?: { conversation: Conversation; errors: string[] };
}): Promise<Conversation> {
  const startedAt = args.now();
  const c: Conversation = args.continuation?.conversation ?? { rounds: 0, trace: [], usage: { turns: 0, input_tokens: null, output_tokens: null, cost_usd: null }, report: null, checked: null, errors: [], required: 0, disposed: 0, failure: null, submission: null, delivered: [], carried: [], startedAt, endedAt: startedAt };
  const heartbeat = args.heartbeat === false ? null : setInterval(() => args.say(`Reviewer still working: ${Math.round((args.now() - startedAt) / 1000)} s`), HEARTBEAT_MS);
  heartbeat?.unref();
  try {
    let text = args.brief;
    if (args.continuation) {
      if (c.rounds > MAX_CORRECTIONS) return c;
      c.errors = args.continuation.errors;
      args.onRound?.({ round: c.rounds, errors: c.errors, delivered: [], later: 0, answer: c.submission });
      args.say(`${args.sessionName ?? "Reviewer"}: correction round ${c.rounds} of ${MAX_CORRECTIONS}`);
      text = [args.brief, "Previous answer:", JSON.stringify(c.submission), "Your answer failed these assembly checks. Fix every one.", ...renumber(c.errors), "Then answer again with the whole JSON object and nothing else."].join("\n");
    }
    for (;;) {
      if ((args.staged || args.continuation) && args.now() >= args.deadline) { c.failure = args.timedOut ?? TIMED_OUT; break; }
      c.rounds++;
      let timer: NodeJS.Timeout | undefined;
      const late = new Promise<Turn>((done) => {
        timer = setTimeout(() => done({ finalText: "", calls: [], usage: c.usage, sessionId: null, failure: TIMED_OUT }), Math.max(0, args.deadline - args.now()));
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
        c.failure = turn.failure === TIMED_OUT ? (args.timedOut ?? TIMED_OUT) : turn.failure;
        break;
      }
      // A served read outside the snapshot ends the review. Refusals do not.
      if (args.traced && c.trace.some(leftSnapshot)) break;
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
      const given = args.deliver(result.unread, [...(args.earlier ?? []), ...c.delivered]);
      if (given.leak) {
        c.failure = "a secret the scanners found was still in the changed lines to send, so they were not sent";
        break;
      }
      if (problems.length === 0 && given.delivered.length === 0) break;
      c.delivered.push(...given.delivered);
      c.carried.push(given.delivered);
      args.say(args.sessionName ? `${args.sessionName}: correction round ${c.rounds} of ${MAX_CORRECTIONS}` : `Correction round ${c.rounds} of ${MAX_CORRECTIONS}: ${problems.length} ${problems.length === 1 ? "problem" : "problems"}, ${given.delivered.length} unread changed ${given.delivered.length === 1 ? "range" : "ranges"} sent to the reviewer`);
      args.onRound?.({ round: c.rounds, errors: result.errors.map((e) => e.replace(/^\d+\.\s+/, "")), delivered: given.delivered, later: given.later, answer: "value" in parsed ? parsed.value : null });
      text = [
        ...(problems.length > 0 ? ["Your answer failed these checks. Fix every one.", "", ...problems, ""] : []),
        ...(given.text !== "" ? ["These changed lines were not in front of you yet. Check them now, as part of the change.", "", given.text, ""] : []),
        ...(given.later > 0 ? [`${given.later} more changed ${given.later === 1 ? "range follows" : "ranges follow"} in the next round, if one is left.`, ""] : []),
        "Then answer again with the whole JSON object and nothing else.",
      ].join("\n");
    }
  } finally {
    if (heartbeat !== null) clearInterval(heartbeat);
    c.endedAt = args.now();
  }
  return c;
}
