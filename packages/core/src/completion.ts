// The completion record of a review run by `review` itself, and the
// coverage it is built from. Coverage comes from the reviewer's trace (the
// tool calls its agent reported), never from the reviewer's own word: a
// changed range counts as given to the reviewer when its file's diff was in
// the brief, when the run put it in a correction round, or when successful
// reads cover every line of it. A deletion has no line in the snapshot, so
// only the diff in the brief or a correction round can show it. A reviewer
// whose trace is not complete (Codex) reports no reads, so for it only the
// brief and the correction rounds count.
import { hunkFragmentLabel } from "./delivery.js";
import type { Change, CompletionRecord, HunkRef, ModelAttempt, ModelCompletionRecord, ModelToolEntry, ReviewerRecord, ReviewerSessionRecord } from "./types.js";

// One tool call of the reviewer. `path` is relative to the snapshot when
// `inside`, else as the agent named it. `range` is the first and last line a
// read delivered. For a reviewer whose trace is not complete (Codex),
// `inside` is null (not checked) and `detail` holds the call's input as
// reported (a command, a search), kept as a diagnostic only. `own`: a call
// outside the snapshot on the agent's own saved output of this session
// (Claude Code's tool-results folder), which reads no repository file.
// `session`: in a staged review, the ReviewerRole of the session that made
// the call (every session's calls are kept in one trace).
// `byteRanges`: the bytes a Read returned of each line of 2,000 bytes or more.
// `whole`: the tool returns every line whole, as the model's read_file does.
export type TraceEntry = { tool: string; path: string | null; inside: boolean | null; range: [number, number] | null; ok: boolean; byteRanges?: { line: number; from: number; to: number }[]; whole?: true; detail?: string; own?: true; session?: string };

// Whether a call names anything outside the snapshot, except the
// agent's own saved output of this session.
export function outsideSnapshot(t: TraceEntry): boolean {
  return t.inside !== true && t.own !== true;
}

// A missing result keeps ok true, so an unanswered call still fails closed.
export function leftSnapshot(t: TraceEntry): boolean {
  return outsideSnapshot(t) && t.ok;
}

export function refusedOutside(t: TraceEntry): boolean {
  return outsideSnapshot(t) && !t.ok;
}

export type Hunk = Pick<HunkRef, "path" | "start" | "end" | "deletion"> & Partial<Omit<HunkRef, "path" | "start" | "end" | "deletion">>;

export type Coverage = CompletionRecord["coverage"];

// The tools a reviewer is given. A successful call to anything else fails the run.
export const REVIEWER_TOOLS: readonly string[] = ["Read", "Grep", "Glob"];
// Added unless the user config sets `reviewer_web: off`.
export const REVIEWER_WEB_TOOLS: readonly string[] = ["WebSearch", "WebFetch"];

// Shown in `missing`, so a long list stays readable.
const MAX_LISTED = 10;

// Every changed range of the change: runs of added or modified lines, and
// each deletion point as the lines on either side of it.
export function changedHunks(change: Change): Hunk[] {
  const hunks: Hunk[] = [];
  for (const [path, lines] of change.coverage) {
    for (const [start, end] of lines.ranges()) hunks.push({ path, start, end, deletion: false });
  }
  for (const [path, points] of change.deletionPoints) {
    for (const p of points) hunks.push({ path, start: Math.min(...p.anchors), end: Math.max(...p.anchors), deletion: true });
  }
  return hunks;
}

// `ranges` with the given lines taken out.
function without(ranges: [number, number][], lines: number[]): [number, number][] {
  if (!lines.length) return ranges;
  const out: [number, number][] = [];
  const sorted = [...lines].sort((a, b) => a - b);
  for (const [a, b] of ranges) {
    let at = a;
    for (const line of sorted) {
      if (line < at || line > b) continue;
      if (line > at) out.push([at, line - 1]);
      at = line + 1;
    }
    if (at <= b) out.push([at, b]);
  }
  return out;
}

// Whether the reads cover every line from `start` to `end`.
function covers(ranges: [number, number][], start: number, end: number): boolean {
  let next = start;
  for (const [a, b] of [...ranges].sort((x, y) => x[0] - y[0])) {
    if (a > next) break;
    next = Math.max(next, b + 1);
    if (next > end) return true;
  }
  return next > end;
}

// `lineCount`: a file's line count in the snapshot, or null when it cannot be
// told. A file the change could not map (Change.uncovered) is one range from
// its first line to its last, read only when reads cover all of it; with no
// line count it can never be shown read.
// `delivered`: ranges the tool itself put in front of the reviewer in a
// correction round; a line range counts like a read, a deletion when the
// same deletion was delivered.
export type CoverageArgs = {
  change: Change;
  obligations?: Hunk[];
  briefCarried?: Hunk[];
  digestCarried?: Hunk[];
  trace: TraceEntry[];
  lineCount?: LineCount;
  delivered?: Hunk[];
  // A finder's own part checks only its assigned bytes. The final record
  // instead joins every part of a line before crediting that line once.
  fragmentParts?: boolean;
};

// A snapshot's line count, and where it can tell them, its lines of more
// than DELIVERY_ROW_BYTES in a range with their byte lengths.
// `text`: false for a file that is not valid UTF-8; a Read decodes such a
// file, so the bytes it returns are not the file's bytes.
export type LineCount = ((path: string) => number | null) & { longLines?: (path: string, start: number, end: number) => { line: number; bytes: number }[]; text?: (path: string) => boolean };

// The obligation each unread entry came from, so one range's gaps list together.
const unreadOwners = new WeakMap<Hunk, Hunk>();

export function readCoverage(args: CoverageArgs): Coverage {
  const reads = new Map<string, [number, number][]>();
  for (const t of args.trace) {
    if (t.tool !== "Read" || !t.ok || t.inside !== true || t.path === null || t.range === null) continue;
    reads.set(t.path, [...(reads.get(t.path) ?? []), t.range]);
  }
  const whole = (args.change.uncovered ?? []).map((path) => ({ path, start: 1, end: args.lineCount?.(path) ?? 0, deletion: false }));
  const entries: Hunk[] = args.obligations ?? [...changedHunks(args.change), ...whole];
  // The final record joins the parts of one line; it keeps every part's id,
  // so a fragment is matched to the hunk that owns it, never by line alone.
  const seen = new Map<string, Set<string>>();
  const ownIds = new Map<Hunk, Set<string>>();
  const hunks = entries.filter((h) => {
    if (!h.fragment || args.fragmentParts) return true;
    const key = `${h.path}:${h.deletion ? h.old?.[0] : h.start}:${Boolean(h.deletion)}`;
    const ids = seen.get(key);
    if (ids) { for (const id of [h.id, h.fragment.of]) if (id) ids.add(id); return false; }
    seen.set(key, new Set([h.id, h.fragment.of].filter((id): id is string => Boolean(id))));
    return true;
  }).map((h) => {
    const ids = h.fragment && !args.fragmentParts ? seen.get(`${h.path}:${h.deletion ? h.old?.[0] : h.start}:${Boolean(h.deletion)}`)! : new Set([h.id, h.fragment?.of].filter((id): id is string => Boolean(id)));
    const out = h.fragment && !args.fragmentParts ? { ...h, part: undefined, fragment: { ...h.fragment, from: 1, to: h.lineBytes! } } : h;
    ownIds.set(out, ids);
    return out;
  });
  const longLines = args.lineCount?.longLines;
  // Every id an obligation answers to, so a fragment names its one owner.
  const owners = new Map<string, Hunk>();
  for (const [h, ids] of ownIds) for (const id of ids) owners.set(id, h);
  const sources = [
    { by: "brief" as const, entries: args.briefCarried ?? [] },
    { by: "digest" as const, entries: args.digestCarried ?? [] },
    { by: "page" as const, entries: args.delivered ?? [] },
    { by: "read" as const, entries: [] as Hunk[] },
  ];
  const given: NonNullable<Coverage["given"]> = [];
  const unread: Hunk[] = [];
  const deletionId = (h: Hunk) => typeof h.deletion === "object" ? h.deletion.id : `${h.path}#${h.point ?? (args.change.deletionPoints.get(h.path) ?? []).findIndex((p) => Math.min(...p.anchors) === h.start && Math.max(...p.anchors) === h.end)}`;
  const inventory: NonNullable<Coverage["inventory"]> = hunks.map((h) => ({ path: h.path, start: h.start, end: h.end, ...(h.deletion ? { deletion: deletionId(h) } : {}) }));
  for (const [index, h] of hunks.entries()) {
    if (h.end < h.start && !h.deletion) { unread.push(h); continue; }
    let matching = sources.map((source) => ({ ...source, entries: source.entries.filter((d) => d.path === h.path && Boolean(d.deletion) === Boolean(h.deletion) && (!h.deletion || deletionId(d) === deletionId(h))) }));
    const range = (d: Hunk): [number, number] => typeof d.deletion === "object" ? [d.deletion.oldStart, d.deletion.oldEnd] : [d.start, d.end];
    const [start, end] = range(h);
    type ByteCredit = { by: "brief" | "digest" | "page" | "read"; fragment: { of?: string; from: number; to: number } };
    const byteCredit = new Map<number, { total: number; pieces: ByteCredit[] }>();
    const ids = ownIds.get(h)!;
    const byteLine = (d: Hunk) => d.deletion ? d.old![0] : d.start;
    // A fragment that names its hunk belongs to that hunk alone.
    // A single-pass deletion's own byte pages name no old range; they count
    // only through the whole deletion they complete.
    const fragments = matching.flatMap((s) => s.entries).filter((d) => d.fragment && (!d.deletion || typeof d.deletion === "object") && (d.fragment.of !== undefined && ids.size
      ? ids.has(d.fragment.of)
      : byteLine(d) >= start && byteLine(d) <= end));
    const partial: Hunk[] = [];
    // Long lines the snapshot names: a Read can return them cut, so they are
    // credited by bytes even when no fragment of them is on record yet.
    const known = h.deletion ? [] : longLines?.(h.path, start, end) ?? [];
    // A shared line whose fragments name another obligation is that one's to credit.
    const mine = new Set(fragments);
    const foreign = new Set(h.deletion ? [] : matching.flatMap((s) => s.entries).flatMap((d) => {
      const owner = d.fragment?.of === undefined || ids.has(d.fragment.of) ? undefined : owners.get(d.fragment.of);
      return owner && owner !== h && !owner.deletion && byteLine(d) >= Math.max(start, owner.start) && byteLine(d) <= Math.min(end, owner.end) ? [byteLine(d)] : [];
    }));
    for (const d of fragments) foreign.delete(byteLine(d));
    if (h.fragment) foreign.delete(byteLine(h));
    const elsewhere = [...foreign].map((line): [number, number] => [line, line]);
    const lines = [...new Set(fragments.map(byteLine).concat(h.fragment ? [byteLine(h)] : [], known.map((l) => l.line)))].filter((line) => !foreign.has(line));
    const plainOwn = (line: number) => matching.some((s) => s.by !== "read" && s.entries.some((d) => !d.fragment && range(d)[0] <= line && range(d)[1] >= line));
    for (const line of lines) {
      const pieces = fragments.filter((d) => byteLine(d) === line);
      const total = h.fragment && byteLine(h) === line ? h.lineBytes! : Math.max(0, ...pieces.map((d) => d.lineBytes ?? 0), ...known.filter((l) => l.line === line).map((l) => l.bytes));
      // A long line its own brief or page carried whole needs no byte credit.
      if (!pieces.length && !h.fragment && plainOwn(line)) continue;
      const first = args.fragmentParts && h.fragment ? h.fragment.from : 1;
      const last = args.fragmentParts && h.fragment ? h.fragment.to : total;
      const intervals: [number, number][] = [];
      const credits: ByteCredit[] = [];
      const of = h.fragment?.of ?? pieces[0]?.fragment?.of ?? h.id;
      const add = (by: ByteCredit["by"], a: number, b: number, id = of) => {
        let next = Math.max(first, a);
        const end = Math.min(last, b);
        for (const [from, to] of [...intervals].sort((x, y) => x[0] - y[0])) {
          if (from > next && next <= end) credits.push({ by, fragment: { ...(id ? { of: id } : {}), from: next, to: Math.min(end, from - 1) } });
          next = Math.max(next, to + 1);
          if (next > end) break;
        }
        if (next <= end) credits.push({ by, fragment: { ...(id ? { of: id } : {}), from: next, to: end } });
        if (a <= last && b >= first) intervals.push([Math.max(first, a), Math.min(last, b)]);
      };
      for (const source of matching) for (const d of source.entries) {
        const [a, b] = range(d);
        if (a > line || b < line) continue;
        if (d.fragment) { if (mine.has(d)) add(source.by, d.fragment.from, d.fragment.to, d.fragment.of); }
        else add(source.by, first, last);
      }
      // A Read credits a long line by the bytes it recorded for it. One with
      // no recorded bytes credits none of it, unless it returns lines whole.
      // A file that is not UTF-8 text is read decoded, so a Read credits none.
      if (!h.deletion && args.lineCount?.text?.(h.path) !== false) for (const t of args.trace) {
        if (t.tool !== "Read" || !t.ok || t.inside !== true || t.path !== h.path || t.range === null || line < t.range[0] || line > t.range[1]) continue;
        if (t.whole) add("read", first, last);
        else for (const row of (t.byteRanges ?? []).filter((row) => row.line === line)) add("read", row.from, row.to);
      }
      if (total > 0 && covers(intervals, first, last)) {
        byteCredit.set(line, { total, pieces: credits });
        // Only complete byte coverage credits the line itself.
        const by = credits.at(-1)!.by;
        matching = matching.map((s) => s.by === by ? { ...s, entries: [...s.entries, { ...h, fragment: undefined, ...(h.deletion ? { old: [line, line] as [number, number], deletion: { id: deletionId(h), oldStart: line, oldEnd: line } } : { start: line, end: line }) }] } : s);
      } else {
        let next = first;
        const gap = (from: number, to: number) => partial.push({ ...h, ...(!h.deletion ? { start: line, end: line } : {}), lineBytes: total, fragment: { ...(of ? { of } : {}), from, to } });
        for (const [a, b] of intervals.sort((x, y) => x[0] - y[0])) {
          if (a > next) gap(next, Math.min(last, a - 1));
          next = Math.max(next, b + 1);
          if (next > last) break;
        }
        if (next <= last) gap(next, last);
      }
    }
    matching = matching.map((s) => ({ ...s, entries: s.entries.filter((d) => !d.fragment) }));
    const own = matching.flatMap((s) => s.entries.map(range));
    // A long line is never credited as a line by a Read; only its bytes count.
    const read = h.deletion ? [] : without(reads.get(h.path) ?? [], lines);
    if (partial.length || (h.deletion && end < start ? !matching.some((s) => s.entries.length) : !covers([...own, ...read, ...elsewhere], start, end))) {
      const before = unread.length;
      if (!partial.length) unread.push(h);
      else {
        unread.push(...partial);
        // Byte gaps name their line precisely. Retain every other line
        // gap too, so the next page cannot silently skip a neighbour.
        let next = start;
        const covered = [...own, ...read, ...elsewhere, ...partial.map(range)].sort((a, b) => a[0] - b[0]);
        for (const [a, b] of covered) {
          if (a > next) unread.push({ ...h, start: next, end: Math.min(end, a - 1), fragment: undefined });
          next = Math.max(next, b + 1);
          if (next > end) break;
        }
        if (next <= end) unread.push({ ...h, start: next, end, fragment: undefined });
      }
      for (const piece of unread.slice(before)) unreadOwners.set(piece, h);
      continue;
    }
    const firstCredit = given.length;
    // Own deliveries win over reads. Subtract earlier credit so overlapping
    // finder pairs and repeated reads never list a line twice.
    let left: [number, number][] = [[start, end]];
    const credit = (by: "brief" | "page" | "digest" | "read", ranges: [number, number][]) => {
      const merged: [number, number][] = [];
      for (const [a, b] of [...ranges].sort((x, y) => x[0] - y[0])) {
        const prior = merged.at(-1);
        if (prior && a <= prior[1] + 1) prior[1] = Math.max(prior[1], b);
        else merged.push([a, b]);
      }
      for (const [a, b] of merged) {
        const next: [number, number][] = [];
        for (const [from, to] of left) {
          if (b < from || a > to) { next.push([from, to]); continue; }
          const first = Math.max(a, from);
          const last = Math.min(b, to);
          const plain = (a: number, b: number) => given.push({ path: h.path, start: h.deletion ? h.start : a, end: h.deletion ? h.end : b, ...(h.deletion ? { deletion: deletionId(h), ...(typeof h.deletion === "object" ? { old: [a, b] as [number, number] } : {}) } : {}), ...(h.part && h.part.of > 1 ? { part: h.part } : {}), by });
          // A byte line inside a merged run keeps its own byte credits.
          let at = first;
          for (const line of [...byteCredit.keys()].filter((n) => n >= first && n <= last).sort((x, y) => x - y)) {
            if (line > at) plain(at, line - 1);
            const bytes = byteCredit.get(line)!;
            const merged: ByteCredit[] = [];
            for (const c of bytes.pieces.sort((a, b) => a.fragment.from - b.fragment.from)) {
              const prior = merged.at(-1);
              if (prior && prior.by === c.by && prior.fragment.to + 1 === c.fragment.from) prior.fragment.to = c.fragment.to;
              else merged.push({ ...c, fragment: { ...c.fragment } });
            }
            for (const c of merged) given.push({ path: h.path, start: h.deletion ? h.start : line, end: h.deletion ? h.end : line, ...(h.deletion ? { deletion: deletionId(h), old: [line, line] as [number, number] } : {}), lineBytes: bytes.total, ...c });
            at = line + 1;
          }
          if (at <= last) plain(at, last);
          if (from < first) next.push([from, first - 1]);
          if (last < to) next.push([last + 1, to]);
        }
        left = next;
      }
    };
    if (h.deletion && end < start) {
      given.push({ path: h.path, start: h.start, end: h.end, deletion: deletionId(h), ...(h.part && h.part.of > 1 ? { part: h.part } : {}), by: matching.find((s) => s.entries.length > 0)!.by });
    } else {
      for (const source of matching) credit(source.by, source.entries.map(range));
      credit("read", read);
    }
    // A byte line names the source that finished it; other ranges the first.
    inventory[index]!.by = (byteCredit.size ? given.slice(firstCredit).at(-1) : given[firstCredit])!.by;

  }
  const readable = args.change.files.filter((f) => f.status !== "deleted" && !f.binary).map((f) => f.path);
  return {
    hunks: hunks.length,
    covered: inventory.filter((h) => h.by !== undefined).length,
    unread,
    given,
    inventory,
    files: args.change.files,
    files_read: [...reads.keys()].sort(),
    files_not_read: readable.filter((p) => !reads.has(p)).sort(),
  };
}

// The legacy single pass still has a file-diff renderer. Translate that
// renderer's receipt to intervals before it enters the coverage engine.
function singlePassRanges(args: { change: Change; diffFiles: ReadonlySet<string>; lineCount?: (path: string) => number | null }): Hunk[] {
  return [...changedHunks(args.change), ...(args.change.uncovered ?? []).map((path) => ({ path, start: 1, end: args.lineCount?.(path) ?? 0, deletion: false }))].filter((h) => args.diffFiles.has(h.path));
}

export function singlePassCoverage(args: CoverageArgs & { diffFiles: ReadonlySet<string> }): Coverage {
  const { diffFiles: _, ...rest } = args;
  const result = readCoverage({ ...rest, briefCarried: singlePassRanges(args) });
  if (args.delivered?.some((h) => h.fragment) || result.unread.some((h) => h.fragment)) return result;
  const { given: __, inventory: ___, files: ____, ...coverage } = result;
  return coverage;
}

export function singlePassModelCoverage(args: Omit<CoverageArgs, "trace"> & { diffFiles: ReadonlySet<string>; briefSent: boolean; toolLog: ModelToolEntry[] }): Coverage {
  const { diffFiles: _, ...rest } = args;
  const result = modelCoverage({ ...rest, briefCarried: singlePassRanges(args) });
  if (args.delivered?.some((h) => h.fragment) || result.unread.some((h) => h.fragment)) return result;
  const { given: __, inventory: ___, files: ____, ...coverage } = result;
  return coverage;
}

const rangeKey = (h: { path: string; start: number; end: number }) => `${h.path}:${h.start}:${h.end}`;

// Build once per report, including the single pass which saves no inventory.
export function deletionLabels(coverage: Coverage, change?: Pick<Change, "deletionPoints">): Map<string, string> {
  const ids = new Map<string, string>();
  for (const r of coverage.inventory ?? []) if (r.deletion) ids.set(rangeKey(r), r.deletion);
  for (const [path, points] of change?.deletionPoints ?? []) {
    points.forEach((p, point) => ids.set(rangeKey({ path, start: Math.min(...p.anchors), end: Math.max(...p.anchors) }), `${path}#${point}`));
  }
  return ids;
}

export function deletionLabel(h: Hunk, ids: ReadonlyMap<string, string>): string {
  if (typeof h.deletion === "object") return ` (deletion ${h.deletion.id}, old lines ${h.deletion.oldStart}-${h.deletion.oldEnd})`;
  if (h.deletion !== true) return "";
  const id = ids.get(rangeKey(h)) ?? (h.point === undefined ? undefined : `${h.path}#${h.point}`);
  return ` (deletion${id ? ` ${id}` : ""})`;
}

function where(h: Hunk, ids: ReadonlyMap<string, string>, files: readonly { path: string; oldPath?: string | null }[] = []): string {
  const deletion = deletionLabel(h, ids);
  const part = h.part ? ` (part ${h.part.n} of ${h.part.of})` : "";
  if (h.fragment) return `${hunkFragmentLabel({ ...h, fragment: h.fragment }, files.find((f) => f.path === h.path)?.oldPath ?? h.path)}${deletion}${part}`;
  return `${h.path}:${h.start}${h.end > h.start ? `-${h.end}` : ""}${deletion}${part}`;
}

// The unread entries of each changed range, in order. One range split into
// byte and line gaps is one group, however many gaps it has.
function unreadGroups(coverage: Coverage): { owner: Hunk; entries: Hunk[] }[] {
  const groups: { owner: Hunk; entries: Hunk[] }[] = [];
  for (const h of coverage.unread) {
    const owner = unreadOwners.get(h) ?? h;
    const last = groups.at(-1);
    if (last && last.owner === owner) last.entries.push(h);
    else groups.push({ owner, entries: [h] });
  }
  return groups;
}

export function unreadRangeCount(coverage: Coverage): number {
  return coverage.inventory ? coverage.hunks - coverage.covered : unreadGroups(coverage).length;
}

function unreadEntries(coverage: Coverage, change?: Pick<Change, "deletionPoints"> & { files?: Change["files"] }): string[] {
  const n = unreadRangeCount(coverage);
  const ids = deletionLabels(coverage, change);
  const files = coverage.files ?? change?.files ?? [];
  if (n === 0) return [];
  // A split range is named once; its gaps are listed beneath it, indented.
  const rows = unreadGroups(coverage).flatMap(({ owner, entries }) => entries.length === 1 && entries[0] === owner && !owner.fragment
    ? [where(owner, ids, files)]
    : [where({ ...owner, fragment: undefined, part: undefined }, ids, files), ...entries.map((h) => `  ${where(h, ids, files)}`)]);
  return [`${n} changed ${n === 1 ? "range was" : "ranges were"} not examined`, ...rows];
}

// The shapes `where` writes: a line range or a fragment label, then an
// optional deletion and part label. A gap row is the same, indented.
// A path never holds ": ", which every other failure line does.
const RANGE_ROW = /^(?: {2})?(?:(?:(?!: ).)+:\d+(?:-\d+)?|(?:(?!: ).)+: (?:old )?line \d+, bytes [\d,]+ to [\d,]+ of [\d,]+)(?: \(deletion(?: [^)]+)?\))?(?: \(part \d+ of \d+\))?$/;

// Only the unread block is shortened. Other failures keep their own entries.
// "and N more" counts ranges; a range keeps its indented gaps with it.
export function shortenedMissing(missing: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < missing.length; i++) {
    const line = missing[i]!;
    out.push(line);
    if (!/^(\d+) changed (?:range was|ranges were) not examined$/.test(line)) continue;
    let end = i + 1;
    let ranges = 0;
    while (end < missing.length && RANGE_ROW.test(missing[end]!)) {
      if (!missing[end]!.startsWith("  ")) ranges++;
      if (ranges <= MAX_LISTED) out.push(missing[end]!);
      end++;
    }
    if (ranges > MAX_LISTED) out.push(`and ${ranges - MAX_LISTED} more; the report names each one`);
    i = end - 1;
  }
  return out;
}

function listed(items: string[]): string {
  const more = items.length - MAX_LISTED;
  return items.slice(0, MAX_LISTED).join(", ") + (more > 0 ? ` and ${more} more` : "");
}

export function completionRecord(args: {
  change: Change;
  reviewer: ReviewerRecord | null;
  snapshot: { tree: string | null; before: string; after: string | null };
  candidates: { total: number; disposed: number };
  coverage: Coverage;
  trace: TraceEntry[];
  // The numbered rejections the last answer still had; empty when it passed.
  submissionErrors: string[];
  // `review --all`: no changed ranges, so coverage is reported, never required.
  wholeRepo: boolean;
  // Why the reviewer gave no answer that could be checked (it timed out, it
  // exited, it started with more than it was given).
  failure?: string | null;
  // The tools the reviewer was given; REVIEWER_TOOLS when left out.
  tools?: readonly string[];
  // False when the reviewer's event stream does not show every tool call
  // (Codex): the trace is then a diagnostic list, and neither its paths nor
  // its tool names can complete or fail the review. True when left out.
  traced?: boolean;
  missing?: string[];
}): CompletionRecord {
  const traced = args.traced ?? true;
  const missing: string[] = [...(args.missing ?? [])];
  if (args.reviewer === null) missing.push("no reviewer process was started by openqodex");
  if (args.failure) missing.push(args.failure);
  if (args.snapshot.after === null || args.snapshot.after !== args.snapshot.before) {
    missing.push("the snapshot changed while the reviewer read it");
  }
  const outside = traced ? [...new Set(args.trace.filter(outsideSnapshot).map((t) => t.path ?? "(no path)"))] : [];
  const reads = traced ? [...new Set(args.trace.filter(leftSnapshot).map((t) => t.path ?? "(no path)"))] : [];
  if (reads.length > 0) missing.push(`the reviewer read outside the snapshot: ${listed(reads)}`);
  const given = args.tools ?? REVIEWER_TOOLS;
  const tools = traced ? [...new Set(args.trace.filter((t) => t.ok && !given.includes(t.tool)).map((t) => t.tool))] : [];
  if (tools.length > 0) missing.push(`the reviewer used a tool it was not given: ${tools.join(", ")}`);
  const refused = traced ? [...new Set([
    ...args.trace.filter(refusedOutside).map((t) => t.path ?? "(no path)"),
    ...args.trace.filter((t) => !t.ok && !given.includes(t.tool)).map((t) => t.tool),
  ])] : [];
  const open = args.candidates.total - args.candidates.disposed;
  if (open > 0) missing.push(`${open} scanner ${open === 1 ? "candidate has" : "candidates have"} no disposition`);
  if (args.submissionErrors.length > 0) {
    const n = args.submissionErrors.length;
    missing.push(`the reviewer's answer still failed ${n} ${n === 1 ? "check" : "checks"} after the correction rounds`, ...args.submissionErrors.slice(0, MAX_LISTED));
  }
  if (!args.wholeRepo && args.coverage.unread.length > 0) {
    missing.push(...unreadEntries(args.coverage, args.change));
  }
  return {
    version: 1,
    contract: "openqodex-review-2",
    status: missing.length === 0 ? "complete" : "incomplete",
    missing,
    refused,
    reviewer: args.reviewer,
    snapshot: { change_id: args.change.id, ...args.snapshot },
    candidates: args.candidates,
    // Reads were not measured without a complete trace: no file is listed as read or not read.
    coverage: traced ? args.coverage : { ...args.coverage, files_read: [], files_not_read: [] },
    outside_reads: outside,
    trace_complete: traced,
  };
}

// The model record (contract "openqodex-model-review-1"): a review by a model
// reviewer, whose every request the brain built and whose every tool call
// the brain served. Coverage counts what a request that was sent carried:
// the brief's diff when the request carrying the brief was sent, a
// correction round's ranges, and the lines a read_file result carried once a
// later request carried that result. A result served but never sent counts
// for nothing.

export const MODEL_REVIEW_CONTRACT = "openqodex-model-review-1";
// The tool whose results count as reads.
export const MODEL_READ_TOOL = "read_file";

// The line a budget refusal leaves in `missing`, and in the conversation's
// failure. `call` counts the reviewer's calls from 1, the refused one included.
export function budgetRefusedLine(purpose: string, call: number): string {
  return `budget refused before ${purpose} call ${call}`;
}

// Coverage from the brain's delivery log, by the rules of readCoverage: the
// brief's diff counts only when `briefSent`; `delivered` holds the ranges of
// correction requests that were sent; a read_file result counts for the
// lines it carried, and only once `delivered`. A refused result carries
// nothing, and neither does one for a path outside the snapshot or outside
// the review's scopes.
export function modelCoverage(args: Omit<CoverageArgs, "trace"> & { briefSent: boolean; toolLog: ModelToolEntry[] }): Coverage {
  const reads: TraceEntry[] = args.toolLog
    .filter((t) => t.tool === MODEL_READ_TOOL && t.delivered && t.in_scope !== false)
    .map((t) => ({ tool: "Read", path: t.path, inside: t.inside, range: t.range, ok: t.ok, whole: true as const }));
  return readCoverage({ ...args, briefCarried: args.briefSent ? args.briefCarried : [], digestCarried: args.briefSent ? args.digestCarried : [], trace: reads });
}

export function modelCompletionRecord(args: {
  changeId: string;
  // The model the reviewer asked for (ModelReviewer.model).
  model: string;
  snapshot: { tree: string | null; before: string; after: string | null };
  candidates: { total: number; disposed: number };
  // From modelCoverage, on the same tool log.
  coverage: Coverage;
  // Every tool call the model asked for, in order.
  toolLog: ModelToolEntry[];
  // Every model attempt, in order, the refused ones included.
  attempts: ModelAttempt[];
  // The names of the tools the brain defined for the reviewer.
  tools: readonly string[];
  // The numbered rejections the last answer still had; empty when it passed.
  submissionErrors: string[];
  // Why the conversation ended without an answer that could be checked.
  failure?: string | null;
  second?: ModelCompletionRecord;
  sessions?: ReviewerSessionRecord[];
  missing?: string[];
  // The change's deletion points, so an unread deletion is named by its id
  // the way the agent record names it.
  deletionPoints?: Change["deletionPoints"];
}): ModelCompletionRecord {
  const missing: string[] = [...(args.missing ?? [])];
  const add = (line: string) => {
    if (!missing.includes(line)) missing.push(line);
  };
  // A refusal anywhere ends the review as incomplete; the attempts before
  // it keep their usage.
  args.attempts.forEach((a, i) => {
    if (a.outcome === "refused") add(budgetRefusedLine(a.purpose, i + 1));
  });
  args.second?.attempts.forEach((a, i) => {
    if (a.outcome === "refused") add(`the second reviewer: ${budgetRefusedLine(a.purpose, i + 1)}`);
  });
  if (args.failure) add(args.failure);
  if (args.attempts.length === 0) add("no model call was made");
  if (args.snapshot.after === null || args.snapshot.after !== args.snapshot.before) add("the snapshot changed while the reviewer read it");
  const defined = (t: ModelToolEntry) => args.tools.includes(t.tool);
  // Only successful calls fail the review. Refusal text is still served to the model.
  const outside = [...new Set(args.toolLog.filter((t) => t.ok && defined(t) && t.inside !== true).map((t) => t.path ?? "(no path)"))];
  if (outside.length > 0) add(`the reviewer read outside the snapshot: ${listed(outside)}`);
  const unscoped = [...new Set(args.toolLog.filter((t) => t.ok && defined(t) && t.inside === true && t.in_scope === false).map((t) => t.path ?? "(no path)"))];
  if (unscoped.length > 0) add(`the reviewer asked for a path outside the review's scopes: ${listed(unscoped)}`);
  const undefinedTools = [...new Set(args.toolLog.filter((t) => t.ok && !defined(t)).map((t) => t.tool))];
  if (undefinedTools.length > 0) add(`the reviewer returned a tool call the brain did not define: ${listed(undefinedTools)}`);
  const refused = [...new Set(args.toolLog.filter((t) => !t.ok && (!defined(t) || t.inside !== true || t.in_scope === false))
    .map((t) => defined(t) ? t.path ?? "(no path)" : t.tool))];
  const open = args.candidates.total - args.candidates.disposed;
  if (open > 0) add(`${open} scanner ${open === 1 ? "candidate has" : "candidates have"} no disposition`);
  if (args.submissionErrors.length > 0) {
    const n = args.submissionErrors.length;
    missing.push(`the reviewer's answer still failed ${n} ${n === 1 ? "check" : "checks"} after the correction rounds`, ...args.submissionErrors.slice(0, MAX_LISTED));
  }
  if (args.coverage.unread.length > 0) {
    missing.push(...unreadEntries(args.coverage, args.deletionPoints ? { deletionPoints: args.deletionPoints } : undefined));
  }
  // Only the names the responses gave: a model the provider did not name is not listed.
  const servedModels = [...new Set(args.attempts.map((a) => a.usage?.servedModel).filter((m): m is string => typeof m === "string" && m !== ""))];
  return {
    contract: MODEL_REVIEW_CONTRACT,
    status: missing.length === 0 ? "complete" : "incomplete",
    missing,
    refused,
    reviewer: { kind: "model", model: args.model, servedModels, calls: args.attempts.filter((a) => a.outcome !== "refused").length },
    snapshot: { change_id: args.changeId, ...args.snapshot },
    candidates: args.candidates,
    coverage: args.coverage,
    tool_log: args.toolLog,
    attempts: args.attempts,
    ...(args.second ? { second: args.second } : {}),
    ...(args.sessions ? { sessions: args.sessions } : {}),
    trace_complete: true,
  };
}
