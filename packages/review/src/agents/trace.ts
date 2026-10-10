// Turns the tool calls a driver reports into trace entries, deciding by
// script, never by the driver, whether each call stayed inside the snapshot.
// It fails closed: a call whose input cannot be read, a path that cannot be
// placed (a NUL, a `~user`), a path holding `$` or `%` that names no file in
// the snapshot, a pattern too large to check, or any path-bearing field that
// leaves the snapshot marks the whole call as outside. The agent's own
// permission rules are the boundary; this check is the alarm that fails the
// run when the trace shows the boundary was not where it should be. One
// place outside is the agent's own: the output it saved for this session
// (OwnFiles), which holds no repository file.
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { TraceEntry } from "@openqodex/core";

// What a driver saw for one tool call: its name, its input as the agent sent
// it, whether it succeeded, and for a read what was delivered.
export type ToolCall = { tool: string; input: unknown; ok: boolean; read: { path: string; start: number; lines: number } | null };

// Where the reviewing agent saves its own output for one session. Claude Code
// saves a tool result too large to hand the model at
// <configuration folder>/projects/<its name for the working folder>/<session
// id>/tool-results/<tool call id>.txt and tells the model to read it back
// (seen with 2.1.296, which then refused that read under dontAsk). That
// folder holds only the output of this session's own calls, each checked
// here already. The rest of the configuration folder (the login, other
// sessions' transcripts and output) stays outside.
export type OwnFiles = { configDir: string; sessionId: string };

// Input fields that name a path, and those that hold a file pattern. Grep's
// `pattern` is the expression it searches for, not a path, so for Grep only
// `glob` is a file pattern.
const PATH_FIELDS = ["file_path", "path", "notebook_path", "cwd", "directory"];
const PATTERN_FIELDS = ["pattern", "glob"];
const GREP_PATTERN_FIELDS = ["glob"];

// The real path of `abs`: the deepest part that exists, resolved through
// links, with the rest appended.
function realDeep(abs: string): string {
  let head = abs;
  const rest: string[] = [];
  while (!existsSync(head)) {
    const up = dirname(head);
    if (up === head) break;
    rest.unshift(head.slice(up.length).replace(/^[\\/]/, ""));
    head = up;
  }
  let real = head;
  try {
    real = realpathSync(head);
  } catch {
    // unreadable: compared as written
  }
  return rest.length > 0 ? join(real, ...rest) : real;
}

// Whether the volume that holds the snapshot compares names without case,
// asked once per snapshot. The evidence: the snapshot's last name with its
// case flipped (`tree` as `TREE`) is, without following a link, the same
// folder, same device and inode. A link so named is no evidence. A platform
// says nothing: macOS and Windows volumes can keep case. When the evidence
// cannot be read, or the name has no letter to flip, names compare exactly,
// the stricter answer.
const caseFolding = new Map<string, boolean>();
function foldsCase(snapshot: string): boolean {
  const known = caseFolding.get(snapshot);
  if (known !== undefined) return known;
  const name = basename(snapshot);
  const flipped = [...name].map((c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase())).join("");
  let folds = false;
  if (flipped !== name) {
    try {
      const own = lstatSync(snapshot, { bigint: true });
      const other = lstatSync(join(dirname(snapshot), flipped), { bigint: true });
      folds = !other.isSymbolicLink() && own.dev === other.dev && own.ino === other.ino;
    } catch {
      // no folder by the flipped name, or unreadable: exact
    }
  }
  caseFolding.set(snapshot, folds);
  return folds;
}

// True when `path` is `root` or below it. A name that starts with two dots
// (`..env`) is below; only a `..` step climbs.
function within(root: string, path: string, fold: boolean): boolean {
  const rel = fold ? relative(root.toLowerCase(), path.toLowerCase()) : relative(root, path);
  return rel === "" || (!isAbsolute(rel) && !rel.split(sep).includes(".."));
}

// Bounds on the work one file pattern may cost before the check gives up
// and marks the call outside: the alternatives its brace lists expand to
// (`{a,b}` ten times over is 1024), the characters of the pattern and across
// all its alternatives, the pieces Claude Code would split a Grep file glob
// into, and the parser's steps (characters read and alternatives built)
// across all of them.
const MAX_PATTERN_ALTERNATIVES = 256;
const MAX_PATTERN_CHARS = 65_536;
const MAX_GLOB_PIECES = 256;
const MAX_PATTERN_STEPS = 1_000_000;

// How our reading of a tool call compares with the real one. Claude Code
// 2.1.289 (read in its binary) reads every path field through its
// `expandPath`: trimmed of white space, `~` and `~/` as the home folder, and
// on Windows `/c/x` as `C:\x`; the folder an absolute Glob pattern is
// searched from goes through it too. It sends both tools through ripgrep:
// Grep's `glob` goes to `rg --glob` after Claude Code splits it at spaces,
// and at commas in a piece without both braces, dropping empty pieces;
// Glob's pattern goes to `rg --files --glob`, searched from the folder before
// its first `*?[{` when it is absolute. ripgrep (14.1.1 checked on this Mac)
// only filters what it walks under that folder. Each place the two readings
// could differ, and why ours is the same or stricter:
// - A path as written and as `expandPath` reads it: we check both.
// - Escapes: ripgrep reads `\x` as `x`. We check every reading both with its
//   escapes removed and as written, with `\` taken as a separator.
// - A brace inside a bracket class (`[{]`): a character to ripgrep, a list to
//   us, which leaves the braces unbalanced (outside) or adds alternatives we
//   also check, besides the whole pattern.
// - Nested lists: ripgrep 14.1.1 refuses them; we expand and check each.
// - A comma outside braces: plain text to ripgrep, a split point to Claude
//   Code's Grep; we check the whole and every piece.
// - A leading `!`: ripgrep's negation, which lists everything else under the
//   same folder; we check the pattern with and without it.
// - Windows separators: we root an alternative that starts with `\` as one
//   that starts with `/`, and `resolve` places it as the platform does: the
//   drive's root on Windows, a name in the snapshot on macOS and Linux.
// - The folder Claude Code searches from: we check the whole pattern, braces
//   unexpanded, as well as each alternative.
// - Wildcards: a wildcard never climbs. ripgrep and node's glob match the
//   names a folder listing yields, and a listing never holds `..`, so only a
//   literal `..` step leaves a folder (`locales/??` and `.*` stay below). The
//   folder Claude Code searches from is the part before the first wildcard,
//   so it holds none, and a `..` in it is a literal step.

// Alternatives and the characters across them.
type Expansion = { alts: string[]; chars: number };
// The parser steps one file pattern has taken, against MAX_PATTERN_STEPS.
type Budget = { steps: number };

// Every alternative of `a` followed by every alternative of `b`, or null when
// the result would pass a bound; nothing is built past one.
function product(a: Expansion, b: Expansion, budget: Budget): Expansion | null {
  const count = a.alts.length * b.alts.length;
  const chars = a.chars * b.alts.length + b.chars * a.alts.length;
  budget.steps += count;
  if (count > MAX_PATTERN_ALTERNATIVES || chars > MAX_PATTERN_CHARS || budget.steps > MAX_PATTERN_STEPS) return null;
  return { alts: a.alts.flatMap((s) => b.alts.map((t) => s + t)), chars };
}

// Every alternative a file pattern's brace lists name, nested lists included:
// `{src,lib/{a,b}}/*.ts` is `src/*.ts`, `lib/a/*.ts` and `lib/b/*.ts`. A
// backslash escapes the next character and is kept in the alternative. Null
// when the braces do not balance or the expansion would pass a bound.
function alternatives(pattern: string, budget: Budget): string[] | null {
  let i = 0;
  // One alternative's text up to a `,` or `}` of the list it is in, or to the
  // end of the pattern at the top level, where a `,` is plain text. Plain
  // text is gathered in `run` and joined to every alternative at once.
  const sequence = (inList: boolean): Expansion | null => {
    let out: Expansion | null = { alts: [""], chars: 0 };
    let run = "";
    const flush = (): Expansion | null => {
      out = out === null ? null : product(out, { alts: [run], chars: run.length }, budget);
      run = "";
      return out;
    };
    while (i < pattern.length) {
      if (++budget.steps > MAX_PATTERN_STEPS) return null;
      const c = pattern[i]!;
      if (c === "\\") {
        run += pattern.slice(i, i + 2);
        i += 2;
      } else if (c === "{") {
        i++;
        const listed = flush() === null ? null : list();
        out = listed === null || out === null ? null : product(out, listed, budget);
        if (out === null) return null;
      } else if (c === "}" || (c === "," && inList)) {
        return inList ? flush() : null;
      } else {
        run += c;
        i++;
      }
      if (out === null || out.chars + run.length * out.alts.length > MAX_PATTERN_CHARS) return null;
    }
    return inList ? null : flush();
  };
  // The alternatives of one list, from after its `{` to after its `}`.
  const list = (): Expansion | null => {
    const all: Expansion = { alts: [], chars: 0 };
    for (;;) {
      const part = sequence(true);
      if (part === null || all.alts.length + part.alts.length > MAX_PATTERN_ALTERNATIVES || all.chars + part.chars > MAX_PATTERN_CHARS) return null;
      for (const alt of part.alts) all.alts.push(alt);
      all.chars += part.chars;
      if (pattern[i++] === "}") return all;
    }
  };
  return sequence(false)?.alts ?? null;
}

// The folder one reading of a pattern is rooted in, outside when it may
// reach out, or null for a relative one: it stays below its folder. A `..`
// step and a home pattern are outside whatever else they say. An absolute
// reading is rooted at the last folder before its first wildcard:
// `/a/snap*/x` is rooted at `/a/`, since `snap*` also matches `snapshot-2`.
function readingRoot(reading: string): string | null {
  const outside = "/";
  if (reading.split(/[\\/]/).includes("..") || reading.startsWith("~")) return outside;
  if (!(reading.startsWith("/") || reading.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(reading))) return null;
  const cut = reading.search(/[*?[{]/);
  if (cut === -1) return reading;
  const slash = Math.max(reading.lastIndexOf("/", cut), reading.lastIndexOf("\\", cut));
  return reading.slice(0, slash + 1) || outside;
}

// The texts a file pattern is matched as: the whole, and for Grep's `glob`
// each non-empty piece Claude Code hands ripgrep; each with and without a
// leading `!`. Null past MAX_GLOB_PIECES pieces.
function texts(value: string, grepGlob: boolean): string[] | null {
  const all = new Set([value]);
  if (grepGlob) {
    let pieces = 0;
    for (const word of value.split(/\s+/)) {
      for (const piece of word.includes("{") && word.includes("}") ? [word] : word.split(",")) {
        if (piece === "") continue;
        if (++pieces > MAX_GLOB_PIECES) return null;
        all.add(piece);
      }
    }
  }
  const plain: string[] = [];
  for (const text of all) if (text.startsWith("!")) plain.push(text.slice(1));
  for (const text of plain) all.add(text);
  return [...all];
}

// The folders a file pattern is rooted in: one for each reading that is
// absolute or may reach out. The readings of a text are the text itself and
// each alternative of its brace lists, each as written and with its escapes
// removed (`\/etc` is `/etc` to ripgrep). Empty when every reading is
// relative. Outside when braces do not balance or a bound is passed; a
// pattern longer than MAX_PATTERN_CHARS is not read at all.
function patternRoots(value: string, grepGlob: boolean): string[] {
  const outside = ["/"];
  if (value.length > MAX_PATTERN_CHARS) return outside;
  const all = texts(value, grepGlob);
  if (all === null) return outside;
  const budget: Budget = { steps: 0 };
  const roots = new Set<string>();
  for (const text of all) {
    const alts = alternatives(text, budget);
    if (alts === null) return outside;
    for (const reading of [text, ...alts]) {
      for (const form of [reading, reading.replace(/\\(.)/gs, "$1")]) {
        const root = readingRoot(form);
        if (root !== null) roots.add(root);
      }
    }
  }
  return [...roots];
}

// A raw path as Claude Code's `expandPath` reads it: trimmed, and on Windows
// `/c/x` as `C:\x`.
function expanded(raw: string): string {
  const trimmed = raw.trim();
  const drive = /^\/([A-Za-z])\//.exec(trimmed);
  return process.platform === "win32" && drive ? `${drive[1]}:\\${trimmed.slice(3)}` : trimmed;
}

// The paths a raw path may name: as written, trimmed, and as `expandPath`
// reads it.
function pathReadings(raw: string): string[] {
  return [...new Set([raw, raw.trim(), expanded(raw)])];
}

// The folders a pattern root may name: as written, and as the folder Claude
// Code searches from, which drops the root's last separator before
// `expandPath` trims it (`/snap/link   /` is searched as `/snap/link`).
function rootReadings(root: string): string[] {
  const bare = root.length > 1 && /[\\/]$/.test(root) ? root.slice(0, -1) : root;
  return [...new Set([...pathReadings(root), ...pathReadings(bare)])];
}

// A path as written, joined to the snapshot, `~/` read as the home folder;
// null when it cannot be placed: a NUL, or `~user`.
function literal(snapshot: string, path: string): string | null {
  if (path.includes("\0")) return null;
  if (path === "~" || path.startsWith("~/")) return join(homedir(), path.slice(1));
  return path.startsWith("~") ? null : resolve(snapshot, path);
}

// A path placed: its real form, or null when it cannot be placed.
function place(snapshot: string, path: string): string | null {
  const abs = literal(snapshot, path);
  return abs === null ? null : realDeep(abs);
}

// A path holding `$` or `%` may be a variable the agent expanded (`$HOME`,
// `%USERPROFILE%`) or a real name (Remix's `posts.$slug.tsx`, `100%.md`).
// It is taken as the name only when that name exists. Asked of the path as
// `expandPath` reads it, the one Claude Code opens.
function named(snapshot: string, path: string): boolean {
  if (!path.includes("$") && !path.includes("%")) return true;
  const abs = literal(snapshot, path);
  if (abs === null) return false;
  try {
    lstatSync(abs);
    return true;
  } catch {
    return false;
  }
}

// A path in this session's own saved output, in every reading of it.
function savedOutput(own: OwnFiles | null, snapshot: string, raw: string): boolean {
  if (own === null || !/^[A-Za-z0-9_-]+$/.test(own.sessionId) || !named(snapshot, expanded(raw))) return false;
  const base = realDeep(resolve(own.configDir));
  return pathReadings(raw).every((r) => {
    const real = place(snapshot, r);
    if (real === null) return false;
    const parts = relative(base, real).split(sep);
    return parts.length >= 4 && parts[0] === "projects" && parts[2] === own.sessionId && parts[3] === "tool-results";
  });
}

// `own`: where the agent saves its own output for this session, or null.
export function classify(snapshotDir: string, call: ToolCall, own: OwnFiles | null = null): TraceEntry {
  let snapshot = snapshotDir;
  try {
    snapshot = realpathSync(snapshotDir);
  } catch {
    // compared as given
  }
  const fold = foldsCase(snapshot);
  const inside = (path: string | null) => path !== null && within(snapshot, path, fold);
  const range: [number, number] | null = call.read && call.read.lines > 0 ? [call.read.start, call.read.start + call.read.lines - 1] : null;
  const input = call.input;
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { tool: call.tool, path: "(a tool input that could not be read)", inside: false, range: null, ok: true };
  }
  const fields = input as Record<string, unknown>;
  // Path fields and the path a read delivered; the folders patterns are rooted in.
  const paths: string[] = [];
  const roots: string[] = [];
  // A pattern rooted outside only in this session's saved output.
  let ownPattern: string | null = null;
  for (const k of PATH_FIELDS) {
    if (fields[k] === undefined || fields[k] === null) continue;
    if (typeof fields[k] !== "string") return { tool: call.tool, path: `(a ${k} that is not text)`, inside: false, range: null, ok: true };
    paths.push(fields[k] as string);
  }
  for (const k of call.tool === "Grep" ? GREP_PATTERN_FIELDS : PATTERN_FIELDS) {
    if (fields[k] === undefined || fields[k] === null) continue;
    if (typeof fields[k] !== "string") return { tool: call.tool, path: `(a ${k} that is not text)`, inside: false, range: null, ok: true };
    let found: string[];
    try {
      found = patternRoots(fields[k] as string, call.tool === "Grep");
    } catch {
      // anything the analysis could not finish, lists nested deeper than the stack can follow among them
      found = ["/"];
    }
    // Named by the pattern itself in the trace, so the record says what was asked.
    const out = found.flatMap((root) => rootReadings(root)).filter((r) => !inside(place(snapshot, r)));
    if (out.length > 0 && !out.every((r) => savedOutput(own, snapshot, r))) return { tool: call.tool, path: fields[k] as string, inside: false, range: null, ok: call.ok };
    if (out.length > 0) ownPattern ??= fields[k] as string;
    else roots.push(...found);
  }
  if (call.read) paths.push(call.read.path);
  if (call.tool === "Read" && typeof fields.file_path !== "string") {
    return { tool: call.tool, path: "(a read with no file_path)", inside: false, range: null, ok: true };
  }
  const outside = paths.filter((raw) => pathReadings(raw).some((r) => !inside(place(snapshot, r))) || !named(snapshot, expanded(raw)));
  if (outside.length > 0) {
    const saved = outside.every((raw) => savedOutput(own, snapshot, raw));
    return { tool: call.tool, path: outside[0]!, inside: false, range, ok: call.ok, ...(saved ? { own: true as const } : {}) };
  }
  if (ownPattern !== null) return { tool: call.tool, path: ownPattern, inside: false, range, ok: call.ok, own: true };
  const first = paths[0] ?? roots[0] ?? null;
  const real = first === null ? null : place(snapshot, call.read?.path ?? first);
  const rel = real === null ? null : (fold ? relative(snapshot.toLowerCase(), real.toLowerCase()) : relative(snapshot, real)) === "" ? "." : real.slice(snapshot.length + 1);
  return { tool: call.tool, path: rel, inside: true, range, ok: call.ok };
}
