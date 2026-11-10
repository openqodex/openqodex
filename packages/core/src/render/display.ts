// The display model report.html is drawn from: each changed file of the
// review with its hunks as rows, old and new line numbers kept apart. It is
// built while the diff and the matched secrets are still in memory, so every
// row and name is redacted (redact.ts, the one redaction every output shares)
// before anything is written.
//
// Bounded, so its serialised form (display.json) always fits
// DISPLAY_MAX_BYTES and a page drawn from it stays quick to open: at most
// DISPLAY_MAX_FILES files and FILES_BUDGET bytes of their names, the rest
// counted in `omitted_files`; at most DISPLAY_MAX_ROWS rows and ROWS_BUDGET
// bytes of them, a file past either keeping its name with a note. Every
// bound is checked before the rows it would cost are made.
//
// The normal review renders it at once and keeps it only inside report.html.
// The two-step review (`review --agent`, then `--finalize`) saves it as
// display.json beside the brief; finalize uses it only when this machine's
// record of the run still vouches for it (the CLI checks), and only for the
// change it was made for (checkDisplay).
import { diffHunks, diffIndex } from "../diff.js";
import { REDACTED, redactSecrets, redactSecretsKeepingLines, secretTexts } from "../redact.js";
import type { Change, ChangedFile } from "../types.js";

export const DISPLAY_VERSION = 1;
// Rows of source the page shows at most, over every file.
export const DISPLAY_MAX_ROWS = 50_000;
// Characters of one row; a longer row is cut and marked.
export const DISPLAY_MAX_ROW_CHARS = 5_000;
// Files the display lists at most; the rest are counted, not listed.
export const DISPLAY_MAX_FILES = 5_000;
// Bytes of display.json at most.
export const DISPLAY_MAX_BYTES = 8 * 1024 * 1024;
// Of those, what the file names and their other fields may take, and what
// the rows may take; the rest is room for the frame.
const FILES_BUDGET = 1024 * 1024;
const ROWS_BUDGET = DISPLAY_MAX_BYTES - FILES_BUDGET - 64 * 1024;
// Lines shown above and below a finding in a whole-repository review.
const EXCERPT_CONTEXT = 3;

export type DisplayRow = {
  kind: "context" | "add" | "del";
  old: number | null;
  new: number | null;
  text: string;
  // The file has no newline after this line.
  noNewline?: true;
  // The line was longer than DISPLAY_MAX_ROW_CHARS and is cut.
  cut?: true;
};

export type DisplayHunk = {
  old_start: number;
  old_lines: number;
  new_start: number;
  new_lines: number;
  // The text git prints after the second @@, such as the enclosing function.
  section: string;
  rows: DisplayRow[];
};

export type DisplayFile = {
  path: string;
  old_path: string | null;
  status: ChangedFile["status"];
  binary: boolean;
  // From the rows; null when no rows were read.
  additions: number | null;
  deletions: number | null;
  hunks: DisplayHunk[];
  // Why some or all of the file's lines are left out, in a few plain words;
  // null when all requested lines are shown, or when it has none to show
  // (a rename or a mode change with no line changed).
  note: string | null;
};

export type Display = {
  version: typeof DISPLAY_VERSION;
  change_id: string;
  // "change": a diff; "excerpts": lines around each finding of a review of
  // the whole repository, which has no diff.
  kind: "change" | "excerpts";
  files: DisplayFile[];
  // Files of the review past DISPLAY_MAX_FILES or FILES_BUDGET, not listed.
  omitted_files: number;
  rows: number;
};

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

// The hunks of one file's unified diff. Rows are counted from the hunk
// header, so a source line that looks like a header (a removed "-- x" shows
// as "--- x") is read as the row it is. Lines before the first hunk are the
// file's headers. A line that fits no row ends the parse.
export function parseHunks(text: string): DisplayHunk[] {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const hunks: DisplayHunk[] = [];
  let i = 0;
  while (i < lines.length) {
    const m = HUNK.exec(lines[i] as string);
    i++;
    if (m === null) continue;
    const hunk: DisplayHunk = {
      old_start: Number(m[1]),
      old_lines: m[2] === undefined ? 1 : Number(m[2]),
      new_start: Number(m[3]),
      new_lines: m[4] === undefined ? 1 : Number(m[4]),
      section: m[5] ?? "",
      rows: [],
    };
    let oldLeft = hunk.old_lines;
    let newLeft = hunk.new_lines;
    let oldAt = hunk.old_start;
    let newAt = hunk.new_start;
    while (i < lines.length && (oldLeft > 0 || newLeft > 0 || (lines[i] as string).startsWith("\\"))) {
      const line = lines[i] as string;
      const mark = line[0];
      if (mark === "\\") {
        const last = hunk.rows.at(-1);
        if (last) last.noNewline = true;
      } else if ((mark === " " || line === "") && oldLeft > 0 && newLeft > 0) {
        hunk.rows.push({ kind: "context", old: oldAt++, new: newAt++, text: line.slice(1) });
        oldLeft--;
        newLeft--;
      } else if (mark === "-" && oldLeft > 0) {
        hunk.rows.push({ kind: "del", old: oldAt++, new: null, text: line.slice(1) });
        oldLeft--;
      } else if (mark === "+" && newLeft > 0) {
        hunk.rows.push({ kind: "add", old: null, new: newAt++, text: line.slice(1) });
        newLeft--;
      } else {
        break;
      }
      i++;
    }
    hunks.push(hunk);
  }
  return hunks;
}

// Redacts one hunk's rows. Each side (old: context and removed rows; new:
// context and added rows) is joined back into the text it was in the file,
// so a secret over several lines is found whole, and redacted line by line
// so every row keeps its number; a line of a multi-line secret that only
// partly falls inside the hunk is one of the texts redaction looks for too
// (redact.ts). A row that still holds any of them is replaced whole.
function redactHunk(hunk: DisplayHunk, secrets: string[], texts: string[]): DisplayHunk {
  if (texts.length === 0) return hunk;
  const side = (keep: (r: DisplayRow) => boolean): Map<DisplayRow, string> => {
    const rows = hunk.rows.filter(keep);
    const red = redactSecretsKeepingLines(rows.map((r) => r.text).join("\n"), secrets).split("\n");
    return new Map(rows.map((r, k) => [r, red[k] ?? REDACTED]));
  };
  const olds = side((r) => r.old !== null);
  const news = side((r) => r.new !== null);
  const rows = hunk.rows.map((r) => {
    const fromNew = news.get(r);
    const fromOld = olds.get(r);
    let text = redactSecrets(fromNew !== undefined && fromNew !== r.text ? fromNew : (fromOld ?? fromNew ?? r.text), secrets);
    if (texts.some((s) => text.includes(s))) text = REDACTED;
    return { ...r, text };
  });
  return { ...hunk, section: redactSecrets(hunk.section, secrets), rows };
}

function cutRow(row: DisplayRow): DisplayRow {
  return row.text.length > DISPLAY_MAX_ROW_CHARS ? { ...row, text: row.text.slice(0, DISPLAY_MAX_ROW_CHARS), cut: true } : row;
}

const LIMIT_NOTE = `this page holds at most ${DISPLAY_MAX_ROWS.toLocaleString("en-US")} lines of code, the display limit, and this file is past it`;
const BYTES_NOTE = `this page holds at most ${Math.floor(ROWS_BUDGET / (1024 * 1024))} MB of code, the display limit, and this file is past it`;

// The fewest bytes the file's rows can take once each is cut: a row keeps
// all its bytes or at least DISPLAY_MAX_ROW_CHARS of them.
function cutBytes(index: NonNullable<ReturnType<typeof diffIndex>>): number {
  let n = 0;
  for (let r = 0; r < index.rows.count; r++) n += Math.min(index.rows.offsets[2 * r + 1]! - index.rows.offsets[2 * r]!, DISPLAY_MAX_ROW_CHARS);
  return n;
}

function noteFor(f: ChangedFile, tooLarge: boolean): string | null {
  if (f.binary) return "binary file";
  if (tooLarge) return "the change to this file is over the size the review takes";
  return null;
}

const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");

// The running totals every bound is checked against before anything is added.
class Budget {
  rows = 0;
  rowBytes = 0;
  fileBytes = 0;
  listed = 0;
  omitted = 0;

  // Whether one more file of this size may be listed; when not, it is counted.
  list(file: DisplayFile): boolean {
    const bytes = this.listed >= DISPLAY_MAX_FILES ? 0 : jsonBytes(file) + 1;
    if (this.listed >= DISPLAY_MAX_FILES || this.fileBytes + bytes > FILES_BUDGET) {
      this.omitted++;
      return false;
    }
    this.listed++;
    this.fileBytes += bytes;
    return true;
  }

  // Whether `count` more rows may be made, before they are made.
  roomFor(count: number): boolean {
    return this.rows + count <= DISPLAY_MAX_ROWS;
  }

  // Whether these rows fit the byte budget; when they do, they are counted.
  take(hunks: DisplayHunk[], count: number): boolean {
    const bytes = jsonBytes(hunks);
    if (this.rowBytes + bytes > ROWS_BUDGET) return false;
    this.rows += count;
    this.rowBytes += bytes;
    return true;
  }
}

// The display of a change, from its per-file diffs, every row and name redacted.
export function buildDisplay(args: { change: Change; secrets: string[] }): Display {
  const { change, secrets } = args;
  const texts = secretTexts(secrets);
  const red = (s: string) => redactSecrets(s, secrets);
  const tooLarge = new Set(change.notReviewed);
  const budget = new Budget();
  const files: DisplayFile[] = [];
  for (const f of change.files) {
    const meta: DisplayFile = { path: red(f.path), old_path: f.oldPath === null ? null : red(f.oldPath), status: f.status, binary: f.binary, additions: null, deletions: null, hunks: [], note: LIMIT_NOTE };
    // The name is listed first, with the longest note it can get, so the
    // file bound holds whatever happens to its rows.
    if (!budget.list(meta)) continue;
    const index = f.binary ? null : diffIndex(change, f.path);
    if (!index?.hunks.length) {
      files.push({ ...meta, note: noteFor(f, tooLarge.has(f.path)) });
      continue;
    }
    const sums = { additions: index.hunks.reduce((n, h) => n + h.additions, 0), deletions: index.hunks.reduce((n, h) => n + h.deletions, 0) };
    const count = index.hunks.reduce((n, h) => n + h.rows, 0);
    // Refuse display work before parsing payloads that cannot fit the page.
    if (index.bytes > ROWS_BUDGET - budget.rowBytes && cutBytes(index) > ROWS_BUDGET - budget.rowBytes) { files.push({ ...meta, ...sums, note: BYTES_NOTE }); continue; }
    if (!budget.roomFor(count)) {
      files.push({ ...meta, ...sums });
      continue;
    }
    let skipped = false;
    const parsed = [...diffHunks(change, f.path, undefined, 512 * 1024, { onLimit: () => { skipped = true; } })].flatMap(parseHunks);
    const hunks = parsed.map((h) => redactHunk(h, secrets, texts)).map((h) => ({ ...h, rows: h.rows.map(cutRow) }));
    const shownCount = hunks.reduce((n, h) => n + h.rows.length, 0);
    if (!budget.take(hunks, shownCount)) {
      files.push({ ...meta, ...sums, note: BYTES_NOTE });
      continue;
    }
    files.push({ ...meta, ...sums, hunks, note: skipped ? "skipped diff pages over the 512 KB byte budget" : null });
  }
  return { version: DISPLAY_VERSION, change_id: change.id, kind: "change", files, omitted_files: budget.omitted, rows: budget.rows };
}

// The lines of `text`, counted by walking its line breaks, never by
// splitting the lines out.
function lineCount(text: string): number {
  let n = 0;
  for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) n++;
  return text.length > 0 && !text.endsWith("\n") ? n + 1 : n;
}

// The lines of each span (1-based, inclusive; sorted, apart) of `text`, cut
// out in one forward walk: the cursor never goes back, so all spans
// together cost one pass over the file, however many there are.
function linesOf(text: string, spans: [number, number][]): string[][] {
  const out: string[][] = spans.map(() => []);
  let start = 0;
  let line = 1;
  for (const [k, [from, to]] of spans.entries()) {
    while (line <= to && start <= text.length) {
      const end = text.indexOf("\n", start);
      const stop = end === -1 ? text.length : end;
      if (line >= from) out[k]!.push(text.slice(start, stop));
      line++;
      if (end === -1) return out;
      start = end + 1;
    }
  }
  return out;
}

// The display of a review of the whole repository: a few lines around each
// cited line, read through `read` (the redacted snapshot), redacted again.
// The spans are merged and measured against the file's line count before
// any row is made. Spans past the byte budget keep earlier spans on the page.
export function buildExcerptDisplay(args: {
  changeId: string;
  cited: { file_path: string; line_number: number; line_end: number }[];
  read: ((path: string) => string | null) & { lineCount?: (path: string) => number | null; readLines?: (path: string, from: number, to: number, maxBytes?: number) => string | null };
  secrets: string[];
}): Display {
  const { secrets } = args;
  const texts = secretTexts(secrets);
  const byFile = new Map<string, [number, number][]>();
  for (const c of args.cited) {
    const spans = byFile.get(c.file_path) ?? [];
    spans.push([Math.max(1, c.line_number - EXCERPT_CONTEXT), Math.max(c.line_number, c.line_end) + EXCERPT_CONTEXT]);
    byFile.set(c.file_path, spans);
  }
  const budget = new Budget();
  const files: DisplayFile[] = [];
  for (const path of [...byFile.keys()].sort()) {
    const meta: DisplayFile = { path: redactSecrets(path, secrets), old_path: null, status: "modified", binary: false, additions: null, deletions: null, hunks: [], note: LIMIT_NOTE };
    if (!budget.list(meta)) continue;
    const readLines = args.read.lineCount ? args.read.readLines : undefined;
    const raw = readLines ? null : args.read(path);
    const total = readLines ? args.read.lineCount!(path) : raw === null ? null : lineCount(raw);
    if (total === null) {
      files.push({ ...meta, note: "the file could not be read for this page" });
      continue;
    }
    // Overlapping or touching spans become one; each is cut at the file's end.
    const merged: [number, number][] = [];
    for (const [s, e] of (byFile.get(path) ?? []).sort((a, b) => a[0] - b[0])) {
      const last = merged.at(-1);
      if (last && s <= last[1] + 1) last[1] = Math.max(last[1], e);
      else merged.push([s, e]);
    }
    let spans = merged.map(([s, e]): [number, number] => [s, Math.min(e, total)]).filter(([s, e]) => s <= e);
    let count = spans.reduce((n, [s, e]) => n + (e - s + 1), 0);
    if (spans.length === 0) {
      files.push({ ...meta, note: "the cited lines are past the end of the file" });
      continue;
    }
    if (!budget.roomFor(count)) {
      files.push(meta);
      continue;
    }
    let cut: string[][];
    let limited = false;
    if (readLines) {
      cut = [];
      let bytesLeft = ROWS_BUDGET - budget.rowBytes;
      for (const [s, e] of spans) {
        const text = readLines(path, s, e, bytesLeft);
        if (text === null) { limited = true; break; }
        bytesLeft -= Buffer.byteLength(text, "utf8");
        const lines = text === "" ? [] : text.split("\n");
        if (lines.at(-1) === "") lines.pop();
        cut.push(lines);
      }
      // A bounded range read stops at EOF; keep only actual rows and numbers.
      spans = spans.slice(0, cut.length).map(([s], k): [number, number] => [s, s + cut[k]!.length - 1]).filter(([s, e]) => s <= e);
      cut = cut.filter((lines) => lines.length > 0);
      count = cut.reduce((n, lines) => n + lines.length, 0);
      if (count === 0) {
        files.push({ ...meta, note: limited ? LIMIT_NOTE : "the cited lines are past the end of the file" });
        continue;
      }
    } else cut = linesOf(raw!, spans);
    const hunks = spans.map(([s], k): DisplayHunk => {
      const lines = redactSecretsKeepingLines(cut[k]!.join("\n"), secrets).split("\n");
      const rows = lines.map((text, k): DisplayRow => {
        const clean = redactSecrets(text, secrets);
        return cutRow({ kind: "context", old: null, new: s + k, text: texts.some((t) => clean.includes(t)) ? REDACTED : clean });
      });
      return { old_start: 0, old_lines: 0, new_start: s, new_lines: rows.length, section: "", rows };
    });
    if (!budget.take(hunks, count)) {
      files.push(meta);
      continue;
    }
    files.push({ ...meta, hunks, note: limited ? LIMIT_NOTE : null });
  }
  return { version: DISPLAY_VERSION, change_id: args.changeId, kind: "excerpts", files, omitted_files: budget.omitted, rows: budget.rows };
}

// display.json for the two-step review. The bounds keep it under
// DISPLAY_MAX_BYTES; should it still be over, every file loses its rows.
export function displayJson(display: Display): string {
  const text = `${JSON.stringify(display)}\n`;
  if (Buffer.byteLength(text, "utf8") <= DISPLAY_MAX_BYTES) return text;
  return `${JSON.stringify({ ...display, rows: 0, files: display.files.map((f) => ({ ...f, hunks: [], note: f.hunks.length > 0 ? LIMIT_NOTE : f.note })) })}\n`;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;
const isNumOrNull = (v: unknown) => v === null || isNum(v);
const isStr = (v: unknown): v is string => typeof v === "string";

// A saved display, parsed, when it is in the saved shape, within the bounds,
// and was made for `changeId`; else null, and the page shows no code.
export function checkDisplay(value: unknown, changeId: string): Display | null {
  if (value === null || typeof value !== "object") return null;
  const d = value as Partial<Display>;
  if (d.version !== DISPLAY_VERSION || d.change_id !== changeId || (d.kind !== "change" && d.kind !== "excerpts") || !Array.isArray(d.files) || !isNum(d.rows) || !isNum(d.omitted_files)) return null;
  if (d.files.length > DISPLAY_MAX_FILES) return null;
  let rows = 0;
  for (const f of d.files as unknown[]) {
    if (f === null || typeof f !== "object") return null;
    const file = f as Partial<DisplayFile>;
    if (!isStr(file.path) || !(file.old_path === null || isStr(file.old_path)) || !["added", "modified", "deleted", "renamed"].includes(file.status as string)) return null;
    if (typeof file.binary !== "boolean" || !isNumOrNull(file.additions) || !isNumOrNull(file.deletions) || !(file.note === null || isStr(file.note)) || !Array.isArray(file.hunks)) return null;
    for (const h of file.hunks as unknown[]) {
      if (h === null || typeof h !== "object") return null;
      const hunk = h as Partial<DisplayHunk>;
      if (!isNum(hunk.old_start) || !isNum(hunk.old_lines) || !isNum(hunk.new_start) || !isNum(hunk.new_lines) || !isStr(hunk.section) || !Array.isArray(hunk.rows)) return null;
      for (const r of hunk.rows as unknown[]) {
        if (r === null || typeof r !== "object") return null;
        const row = r as Partial<DisplayRow>;
        if (!["context", "add", "del"].includes(row.kind as string) || !isNumOrNull(row.old) || !isNumOrNull(row.new) || !isStr(row.text)) return null;
        rows++;
      }
    }
  }
  return rows <= DISPLAY_MAX_ROWS ? (d as Display) : null;
}
