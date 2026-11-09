import { DELIVERY_ROW_BYTES, registeredSecrets, fragmentSizes, fragmentSources, oldPathOf, setFragmentSource, changedHunks, diffEntry, indexedLines, fragmentLabel, textByteLine, diffText, hunkRows, partHeading, stagedDiffCache } from "@openqodex/core";
import type { ByteLines, Change, HunkRef, ReviewUnit } from "@openqodex/core";
import { jsonSections, recognise, storeSections, storeRoot } from "./digest.js";
import type { Digest, JsonEntry, JsonSections, StoreFile } from "./digest.js";
import { DELIVER_LINES, pageRows } from "./conversation.js";

export const GROUP_DIFF_BYTES = 30 * 1024;
export const MAX_UNIT_DIFF_BYTES = 120 * 1024;
export const MAX_BRIEF_BYTES = 256 * 1024;

type Read = ((path: string) => string | null) & { byteLines?: ByteLines };
type JsonPage = { start: number; end: number; entries: JsonEntry[]; omitted: Digest["omitted"] };
type DigestInput = { kind: "json" | "store"; root: string; text: string | null; previous?: string; secrets: string[]; oldUnavailable?: boolean; sections?: JsonSections; pages?: JsonPage[]; page?: number };
type DigestDetails = { fixed: string; entries: { path: string; lines: [number, number]; text: string }[] };
const digestDetails = new WeakMap<ReviewUnit, DigestDetails>();
const digestInputs = new WeakMap<HunkRef, DigestInput>();

// Restore the old JSON from paired diff rows and unchanged snapshot lines.
// A malformed old file cannot supply comparisons; the new side still digests.
function previousText(file: Change["files"][number], diff: string | undefined, text: string): string | undefined {
  if (file.status === "added") return undefined;
  if (!diff) return undefined;
  const next = text.replace(/\n$/, "").split("\n");
  const out: string[] = [];
  let cursor = 0;
  let inHunk = false;
  for (const row of diff.split("\n")) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(row);
    if (header) {
      const start = Number(header[1]) - Number(header[2] !== "0");
      for (let i = cursor; i < start; i++) out.push(next[i]!);
      cursor = start;
      inHunk = true;
    } else if (inHunk && row.startsWith("-")) out.push(row.slice(1));
    else if (inHunk && /^[ +]/.test(row)) { if (row[0] === " ") out.push(row.slice(1)); cursor++; }
    else if (inHunk && !row.startsWith("\\")) inHunk = false;
  }
  for (let i = cursor; i < next.length; i++) out.push(next[i]!);
  return out.join("\n");
}

// One inventory owns scheduling and coverage. Its parts retain the whole
// obligation's identity, and deletions retain their distinct old intervals.
// A change that already has a secrets list keeps it; see setFragmentSource.
export function obligations(change: Change, read: Read, cache = stagedDiffCache(change, registeredSecrets(change) ?? [])): HunkRef[] {
  return inventoryOf(change, read, cache, true);
}

// `register`: whether this inventory registers its byte source and secrets list.
function inventoryOf(change: Change, read: Read, cache: ReturnType<typeof stagedDiffCache>, register: boolean): HunkRef[] {
  let snapshotPath: string | null = null;
  let snapshotLines: string[] | null = null;
  const snapshotOf = (path: string) => {
    if (snapshotPath !== path) {
      snapshotLines = null;
      snapshotPath = path;
      snapshotLines = read(path)?.split("\n") ?? null;
    }
    return snapshotLines;
  };
  const byteRows = new Map<string, Map<number, ReturnType<typeof textByteLine>>>();
  if (register) setFragmentSource(change, read.byteLines ?? function* (path, from, to) {
    const rows = snapshotOf(path);
    if (!rows) return;
    let known = byteRows.get(path);
    if (!known) { known = new Map(); byteRows.set(path, known); }
    for (let line = from; line <= to; line++) {
      const text = rows[line - 1];
      if (text === undefined) break;
      let source = known.get(line);
      if (!source) { source = textByteLine(text); known.set(line, source); }
      yield { line, source };
    }
  }, cache.secrets);
  const filesByPath = new Map(change.files.map((f) => [f.path, f]));
  const order = new Map(change.files.map((f, i) => [f.path, i]));
  const points = new Map<string, number>();
  const whole: HunkRef[] = changedHunks(change).map((h) => {
    if (!h.deletion) return { ...h, id: "", old: null };
    const point = points.get(h.path) ?? 0;
    points.set(h.path, point + 1);
    const p = change.deletionPoints.get(h.path)![point]!;
    const run = cache.info(h.path)?.removed.find((r) => r.after === p.after && r.count === p.lines);
    const first = run?.oldStart ?? 1;
    return { ...h, id: "", point, old: [first, first + p.lines - 1], deletion: { id: `${h.path}#${point}`, oldStart: first, oldEnd: first + p.lines - 1 } };
  });
  for (const path of change.uncovered ?? []) {
    const snapshot = snapshotOf(path);
    const lines = snapshot === null ? 0 : snapshot.length - Number(snapshot.at(-1) === "");
    whole.push({ id: "", path, start: 1, end: lines, deletion: false, old: null });
  }
  whole.sort((a, b) => (order.get(a.path) ?? 0) - (order.get(b.path) ?? 0) || a.start - b.start || Number(Boolean(a.deletion)) - Number(Boolean(b.deletion)));
  whole.forEach((h, i) => { h.id = `h${i + 1}`; });
  const routes = new Map<string, DigestInput>();
  const measured = new Map<string, { rows: number; bytes: number }>();
  const candidates = new Map<string, DigestInput>();
  const over = new Set<string>();
  for (const h of whole) {
    const ref = { ...h, old: undefined };
    const overflow = cache.file(h.path, ref).overflow;
    const rows = overflow ? [] : hunkRows(change, ref, [], cache);
    const snapshot = overflow ? null : snapshotOf(h.path);
    const rendered = overflow ? null : rows.length ? rows : !h.deletion && snapshot ? pageRows(h.path, h.start, h.end, snapshot) : [];
    const size = { rows: rendered?.length ?? Infinity, bytes: rendered === null ? Infinity : Buffer.byteLength(rendered.join("\n"), "utf8") };
    const prior = measured.get(h.path) ?? { rows: 0, bytes: 0 };
    measured.set(h.path, { rows: prior.rows + size.rows, bytes: prior.bytes + size.bytes });
    if (size.rows > DELIVER_LINES || size.bytes > MAX_UNIT_DIFF_BYTES) over.add(h.path);
  }
  for (const path of measured.keys()) {
    const store = storeRoot(path);
    if (!store && !over.has(path)) continue;
    const entry = diffEntry(change, path);
    if (!store && entry) {
      // A first source line is enough to reject a non-JSON prefix. Do not
      // materialise a long code row merely to ask the JSON recogniser.
      let nonJson = false;
      for (const { source } of indexedLines(entry, { start: 1, end: 1 })) {
        const first = source.read(0, Math.min(source.bytes, 2000)).toString("utf8").trimStart()[0];
        nonJson = first !== undefined && !/[{["0-9tfn-]/.test(first);
      }
      if (nonJson) continue;
    }
    const snapshot = snapshotOf(path);
    // JSON can start with any JSON value, regardless of the file extension.
    // Under-budget files never need recognition or old-side reconstruction.
    const first = snapshot?.find((line) => line.trim().length)?.trimStart()[0];
    const file = filesByPath.get(path)!;
    if (!store && (!first || !/[{["0-9tfn-]/.test(first) || file.binary)) continue;
    const text = snapshot?.join("\n") ?? null;
    const kind = store ? "store" : recognise(path, text ?? "");
    if (kind === "store") candidates.set(path, { kind, root: store!, text, secrets: cache.secrets });
    else if (kind === "json" && text !== null && !file.binary) {
      // A patch streamed to disk has no text field; read it through the store.
      const rebuilt = previousText(file, diffText(change, path) ?? undefined, text);
      const previous = rebuilt !== undefined && recognise("", rebuilt) === "json" ? rebuilt : undefined;
      candidates.set(path, { kind, root: path, text, previous, secrets: cache.secrets, oldUnavailable: previous === undefined && file.status !== "added" });
    }
  }
  const stores = new Map<string, { rows: number; bytes: number }>();
  for (const [path, input] of candidates) if (input.kind === "store") {
    const prior = stores.get(input.root) ?? { rows: 0, bytes: 0 };
    const size = measured.get(path)!;
    stores.set(input.root, { rows: prior.rows + size.rows, bytes: prior.bytes + size.bytes });
  }
  for (const [path, input] of candidates) {
    const size = stores.get(input.root);
    if (input.kind === "json" ? over.has(path) : size!.rows > DELIVER_LINES || size!.bytes > MAX_UNIT_DIFF_BYTES) routes.set(path, input);
  }
  const wholeByPath = new Map<string, HunkRef[]>();
  for (const h of whole) {
    const refs = wholeByPath.get(h.path);
    if (refs) refs.push(h); else wholeByPath.set(h.path, [h]);
  }
  // Fix page boundaries before assigning ids. Entries sharing a source span
  // stay together, including every scalar inside an odd record.
  for (const [path, input] of routes) if (input.kind === "json") {
    const sections = jsonSections(path, input.text!, wholeByPath.get(path)!, input.previous, input.secrets, input.oldUnavailable);
    const fixedBytes = Buffer.byteLength(sections.fixed + "\n", "utf8") + 1024;
    if (fixedBytes >= MAX_UNIT_DIFF_BYTES / 2) { routes.delete(path); continue; }
    const groups: { start: number; end: number; entries: JsonEntry[]; bytes: number }[] = [];
    const refs = wholeByPath.get(path)!;
    const metadata = [
      ...refs.map((h) => ({ start: h.start, end: h.end, bytes: Buffer.byteLength(`${h.path}:${h.start}-${h.end} removed ${h.old?.join("-") ?? ""}\nh${whole.length + sections.entries.length} ${h.path}:${h.start}-${h.end} (removed ${h.old?.join("-") ?? ""})\n`, "utf8") })),
      ...sections.omitted.map((o) => ({ start: o.lines[0], end: o.lines[1], bytes: Buffer.byteLength(`${o.path}:${o.lines[0]}-${o.lines[1]}: ${o.why}\n`, "utf8") })),
    ];
    // Start and end prefix sums charge every overlapping metadata row without
    // scanning every changed range for every scalar group.
    const prefix = (side: "start" | "end") => {
      let bytes = 0;
      return [...metadata].sort((a, b) => a[side] - b[side]).map((row) => ({ line: row[side], bytes: bytes += row.bytes }));
    };
    const starts = prefix("start");
    const ends = prefix("end");
    const through = (rows: { line: number; bytes: number }[], line: number) => {
      let low = 0;
      let high = rows.length;
      while (low < high) { const mid = (low + high) >>> 1; if (rows[mid]!.line <= line) low = mid + 1; else high = mid; }
      return low ? rows[low - 1]!.bytes : 0;
    };
    const events = [
      ...sections.entries,
      ...metadata.flatMap((row) => [{ lines: [row.start, row.start] as [number, number], text: "" }, { lines: [row.end, row.end] as [number, number], text: "" }]),
    ].sort((a, b) => a.lines[0] - b.lines[0] || b.lines[1] - a.lines[1]);
    for (const entry of events) {
      const bytes = entry.text ? Buffer.byteLength(entry.text + "\n", "utf8") : 0;
      const prior = groups.at(-1);
      if (prior && entry.lines[0] <= prior.end) { if (entry.text) prior.entries.push(entry); prior.end = Math.max(prior.end, entry.lines[1]); prior.bytes += bytes; }
      else groups.push({ start: entry.lines[0], end: entry.lines[1], entries: entry.text ? [entry] : [], bytes });
    }
    for (const group of groups) group.bytes += through(starts, group.end) - through(ends, group.start - 1);
    if (groups.some((group) => fixedBytes + group.bytes > MAX_UNIT_DIFF_BYTES)) { routes.delete(path); continue; }
    const pages: JsonPage[] = [];
    let entries: JsonEntry[] = [];
    let bytes = fixedBytes;
    let start = 1;
    for (const group of groups) {
      if (bytes > fixedBytes && bytes + group.bytes > MAX_UNIT_DIFF_BYTES) {
        pages.push({ start, end: group.start - 1, entries, omitted: [] });
        start = group.start;
        entries = [];
        bytes = fixedBytes;
      }
      for (const entry of group.entries) entries.push(entry);
      bytes += group.bytes;
    }
    pages.push({ start, end: snapshotOf(path)!.length, entries, omitted: [] });
    // Unchanged anomalies belong to the page of their nearest changed line,
    // never to a new pair of finder sessions with no obligation to credit.
    const pageAt = (line: number) => {
      let low = 0;
      let high = pages.length;
      while (low < high) { const mid = (low + high) >>> 1; if (pages[mid]!.end < line) low = mid + 1; else high = mid; }
      return pages[Math.min(low, pages.length - 1)]!;
    };
    const anchorEnd = (h: HunkRef) => h.deletion ? h.start : h.end;
    const nearest = (line: number) => {
      let low = 0;
      let high = refs.length;
      while (low < high) { const mid = (low + high) >>> 1; if (anchorEnd(refs[mid]!) < line) low = mid + 1; else high = mid; }
      const before = refs[low - 1];
      const after = refs[low];
      if (!after || before && line - anchorEnd(before) <= after.start - line) return anchorEnd(before!);
      return Math.max(line, after.start);
    };
    const active = new Set(refs.flatMap((h) => pages.filter((page) => h.start <= page.end && anchorEnd(h) >= page.start)));
    const entriesByPage = new Map([...active].map((page) => [page, [] as JsonEntry[]]));
    for (const entry of sections.entries) {
      const page = pageAt(nearest(entry.lines[0]));
      entriesByPage.get(page)!.push(entry);
    }
    for (const omission of sections.omitted) {
      const intersecting = [...active].filter((page) => omission.lines[0] <= page.end && omission.lines[1] >= page.start);
      if (intersecting.length) for (const page of intersecting) page.omitted.push(omission);
      else pageAt(nearest(omission.lines[0])).omitted.push(omission);
    }
    for (const page of active) page.entries = entriesByPage.get(page)!;
    // Folding can concentrate an entire file's anomalies on one changed line.
    // Keep that look bounded too, falling back to parts when it cannot fit.
    if ([...active].some((page) => fixedBytes + page.entries.reduce((sum, e) => sum + Buffer.byteLength(e.text + "\n", "utf8"), 0)
      + page.omitted.reduce((sum, o) => sum + Buffer.byteLength(`${o.path}:${o.lines[0]}-${o.lines[1]}: ${o.why}\n`, "utf8"), 0)
      + through(starts, page.end) - through(ends, page.start - 1) > MAX_BRIEF_BYTES - MAX_UNIT_DIFF_BYTES)) { routes.delete(path); continue; }
    input.sections = sections;
    input.pages = [...active].sort((a, b) => a.start - b.start);
  }
  const out: HunkRef[] = [];
  const pagedInputs = new WeakMap<HunkRef, DigestInput>();
  for (const h of whole) {
    const input = routes.get(h.path);
    if (input?.kind === "json") {
      const parts: { ref: HunkRef; page: number }[] = [];
      for (const [page, span] of input.pages!.entries()) {
        if (h.deletion ? h.start < span.start || h.start > span.end : h.end < span.start || h.start > span.end) continue;
        parts.push({ ref: { ...h, ...(!h.deletion ? { start: Math.max(h.start, span.start), end: Math.min(h.end, span.end) } : {}), rows: 0, bytes: 0 }, page });
      }
      const whole = typeof h.deletion === "object" ? h.deletion.id : `${h.path}:${h.start}-${h.end}`;
      for (const [n, { ref, page }] of parts.entries()) {
        ref.part = { n: n + 1, of: parts.length, whole };
        pagedInputs.set(ref, { ...input, page });
        out.push(ref);
      }
      continue;
    }
    if (input) { const ref = { ...h, ...measured.get(h.path) }; pagedInputs.set(ref, input); out.push(ref); continue; }
    const [first, last] = h.deletion ? h.old! : [h.start, h.end];
    if (last < first) { out.push(h); continue; }
    const allReplacements = cache.info(h.path)?.replacements ?? [];
    let low = 0;
    let high = allReplacements.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (allReplacements[mid]!.start < h.start) low = mid + 1; else high = mid;
    }
    const replacements: typeof allReplacements = [];
    if (!h.deletion) for (let i = low; i < allReplacements.length && allReplacements[i]!.start <= h.end; i++) replacements.push(allReplacements[i]!);
    const snapshot = diffEntry(change, h.path) && over.has(h.path) ? null : snapshotOf(h.path);
    const measure = (ref: HunkRef): HunkRef => {
      if (cache.file(ref.path, ref).overflow) return { ...ref, rows: Infinity, bytes: Infinity };
      const rows = hunkRows(change, ref, [], cache);
      const rendered = rows.length ? rows : !ref.deletion && snapshot ? pageRows(ref.path, ref.start, ref.end, snapshot) : [];
      return { ...ref, rows: rendered.length, bytes: Buffer.byteLength(rendered.join("\n"), "utf8") + (rows.length ? 0 : 1) };
    };
    const fits = (ref: HunkRef) => ref.rows! <= DELIVER_LINES && ref.bytes! <= MAX_UNIT_DIFF_BYTES;
    const parts: HunkRef[] = [];
    // The old side of an oversized replacement is an explicit obligation,
    // rather than repeated in each slice of its new side.
    const external = new Set<typeof replacements[number]>();
    for (const r of replacements) {
      if (!fits(measure({ ...h, start: r.start, end: r.start, old: [r.oldStart, r.oldEnd] }))) external.add(r);
    }
    const cut = (base: HunkRef, first: number, last: number, oldSide: boolean) => {
      let at = first;
      do {
        const candidate = (end: number) => {
          const ref = { ...base, ...(oldSide ? { old: [at, end] as [number, number], deletion: { ...(base.deletion as Exclude<HunkRef["deletion"], boolean>), oldStart: at, oldEnd: end } } : { start: at, end }) };
          if (!oldSide) {
            const owners = replacements.filter((r) => !external.has(r) && r.start >= at && r.start <= end);
            ref.old = owners.length ? [owners[0]!.oldStart, owners.at(-1)!.oldEnd] : null;
          }
          return measure(ref);
        };
        let low = at;
        let high = Math.max(at, Math.min(last, at + DELIVER_LINES - 1));
        let best = candidate(at);
        while (low <= high) {
          const mid = Math.floor((low + high) / 2);
          const ref = candidate(mid);
          if (fits(ref)) { best = ref; low = mid + 1; } else high = mid - 1;
        }
        if (!fits(best)) {
          const target = { ...best, ...(oldSide ? { old: [at, at] as [number, number] } : { start: at, end: at }) };
          const sources = fragmentSources(change, target);
          const path = oldSide ? oldPathOf(change, base.path) : base.path;
          let fragmented = false;
          for (const { source } of sources) {
            if (source.bytes <= DELIVERY_ROW_BYTES) continue;
            let from = 1;
            let to = 0;
            let bytes = 0;
            let rows = 0;
            const flush = () => {
              if (!rows) return;
              parts.push({ ...target, lineBytes: source.bytes,
                fragment: { of: h.id, from, to }, rows, bytes });
              from = to + 1;
              bytes = 0;
              rows = 0;
            };
            // Sizes come from the line's one measuring pass where it has one.
            for (const fragment of fragmentSizes(source)) {
              const size = Buffer.byteLength(`${oldSide ? "-" : "+"}${fragmentLabel(path, at, fragment.from, fragment.to, source.bytes, oldSide ? "old" : "new")}\t\n`) + fragment.size;
              if (rows && (bytes + size > MAX_UNIT_DIFF_BYTES || rows + 1 > DELIVER_LINES)) flush();
              to = fragment.to;
              bytes += size;
              rows++;
            }
            flush();
            fragmented = true;
          }
          if (fragmented) { at++; continue; }
        }
        if (!fits(best)) best.note = oldSide
          ? "This removed row exceeds a part's budget. It remains unread unless its full text is carried or read."
          : "This single line exceeds a part's budget. It remains unread unless its full text is carried or read.";
        parts.push(best);
        at = oldSide ? best.old![1] + 1 : best.end + 1;
      } while (at <= last);
    };
    for (const [index, r] of replacements.entries()) if (external.has(r)) {
      // These fragments have no deletion point or anchor, so removedBlock
      // cannot page them. Only a brief carrying their rows can credit them.
      const deletion = { id: `${h.path}#replacement${index}:${h.start}`, oldStart: r.oldStart, oldEnd: r.oldEnd };
      cut({ ...h, start: r.start, end: r.start, old: [r.oldStart, r.oldEnd], deletion }, r.oldStart, r.oldEnd, true);
    }
    cut(h, h.deletion ? h.old![0] : h.start, h.deletion ? h.old![1] : h.end, Boolean(h.deletion));
    const key = h.deletion && typeof h.deletion === "object" ? h.deletion.id : `${h.path}:${h.start}-${h.end}`;
    parts.forEach((ref, i) => {
      ref.part = { n: i + 1, of: parts.length, whole: key };
      const replaced = replacements.find((r) => ref.start > r.start && ref.start <= r.end || external.has(r) && !ref.deletion && ref.start === r.start);
      if (replaced && !ref.deletion) {
        const owners = parts.flatMap((p, i) => p.old && p.old[0] <= replaced.oldEnd && p.old[1] >= replaced.oldStart ? [i + 1] : []);
        if (owners.length) ref.removedIn = owners.length === 1 ? owners[0]! : owners;
      }
      out.push(ref);
    });
  }
  const inventory = out.map((h, i) => {
    const ref = { ...h, id: `h${i + 1}` };
    if (ref.fragment) ref.fragment = { ...ref.fragment, of: ref.id };
    const input = pagedInputs.get(h);
    if (input) digestInputs.set(ref, input);
    return ref;
  });
  return inventory;
}

// Kept for callers without a snapshot. Staged review always supplies one.
// It registers nothing, so an inventory with the review's secrets can follow.
export function hunkRefs(change: Change): HunkRef[] {
  return inventoryOf(change, () => null, stagedDiffCache(change, registeredSecrets(change) ?? []), false);
}

// The finder brief a unit is measured by. A unit holding a fragment part, or
// `both`, is measured over both passes, the longer brief; any other unit by
// the local pass alone, so short units render one brief per measure.
export function longestBrief(unit: ReviewUnit, find: (unit: ReviewUnit, pass: "local" | "contracts") => { text: string }, both = unit.hunks.some((h) => h.fragment)): string {
  const local = find(unit, "local").text;
  if (!both) return local;
  const contracts = find(unit, "contracts").text;
  return Buffer.byteLength(contracts) > Buffer.byteLength(local) ? contracts : local;
}

// `brief`: a unit's finder brief, with its real file list and every fixed
// block; `both` asks for the longer of both passes, as longestBrief gives.
export function unitsOf(change: Change, hunks: HunkRef[], brief?: (unit: ReviewUnit, both?: boolean) => string): ReviewUnit[] {
  const out: ReviewUnit[] = [];
  if (!hunks.length) return out;
  const fragmented = hunks.some((h) => h.fragment);
  const base = brief ? Buffer.byteLength(brief({ id: "u1", files: [], hunks: [], diffBytes: 0 }, fragmented), "utf8") : 0;
  // A fragment part is cut down, never dropped: halved by fragments until
  // its own real brief fits, or until it holds a single fragment.
  const halves = (h: HunkRef): HunkRef[] => {
    for (const { line, source } of fragmentSources(change, h)) {
      const path = h.deletion ? oldPathOf(change, h.path) : h.path;
      const sizes = [...fragmentSizes(source, h.fragment!.from, h.fragment!.to)].map((f) => ({ ...f, size: f.size + Buffer.byteLength(`${h.deletion ? "-" : "+"}${fragmentLabel(path, line, f.from, f.to, source.bytes, h.deletion ? "old" : "new")}\t\n`) }));
      if (sizes.length < 2) return [h];
      const mid = Math.ceil(sizes.length / 2);
      return [sizes.slice(0, mid), sizes.slice(mid)].map((group) => ({ ...h, fragment: { ...h.fragment!, from: group[0]!.from, to: group.at(-1)!.to }, rows: group.length, bytes: group.reduce((n, f) => n + f.size, 0) }));
    }
    return [h];
  };
  // A path's fixed blocks, measured once; only a part near the bound is rendered.
  const fixed = new Map<string, number>();
  const fixedOf = (path: string): number => {
    let around = fixed.get(path);
    if (around === undefined) { around = brief ? Buffer.byteLength(brief({ id: "u1", files: [path], hunks: [], diffBytes: 0 }, true), "utf8") : 0; fixed.set(path, around); }
    return around;
  };
  const fitted = (h: HunkRef): HunkRef[] => {
    if (!h.fragment || !brief) return [h];
    const around = fixedOf(h.path);
    if (around + h.bytes! + Buffer.byteLength(partHeading(h, true, change), "utf8") + 1024 <= MAX_BRIEF_BYTES - 8 * 1024) return [h];
    const alone: ReviewUnit = { id: "u1", files: [h.path], hunks: [h], diffBytes: h.bytes! };
    if (Buffer.byteLength(brief(alone), "utf8") <= MAX_BRIEF_BYTES) return [h];
    const parts = halves(h);
    return parts.length === 1 ? parts : parts.flatMap(fitted);
  };
  const payload = Math.min(MAX_UNIT_DIFF_BYTES, MAX_BRIEF_BYTES - base - 8 * 1024);
  // Whether a path's fixed blocks of both passes leave no room for even one
  // fragment beside its heading. No halving can help such a line.
  const blocked = (h: HunkRef): boolean => {
    if (!brief) return false;
    return fixedOf(h.path) + Buffer.byteLength(partHeading(h, true, change), "utf8") + DELIVERY_ROW_BYTES + 1024 > MAX_BRIEF_BYTES;
  };
  const FIXED_NOTE = "The fixed blocks of this file's finder briefs exceed MAX_BRIEF_BYTES alone, so no fragment of this line fits a brief. It remains unread unless paged or read.";
  const sameLine = (a: HunkRef, b: HunkRef) => a.path === b.path && Boolean(a.deletion) === Boolean(b.deletion) && (a.deletion ? a.old?.[0] === b.old?.[0] : a.start === b.start);
  const recut: HunkRef[] = [];
  for (const h of hunks) {
    if (!h.fragment) { recut.push(h); continue; }
    if (blocked(h)) {
      // One note for the whole line: its parts join into one entry.
      const prior = recut.at(-1);
      if (prior?.note === FIXED_NOTE && prior.fragment && sameLine(prior, h) && prior.fragment.to + 1 === h.fragment.from) {
        prior.fragment = { ...prior.fragment, to: h.fragment.to };
        prior.bytes = prior.bytes! + h.bytes!;
        prior.rows = prior.rows! + h.rows!;
      } else recut.push({ ...h, note: FIXED_NOTE });
      continue;
    }
    let pieces = [h];
    while (payload > 0 && pieces.some((p) => p.bytes! > payload && p.fragment!.to > p.fragment!.from)) {
      const next = pieces.flatMap((p) => p.bytes! > payload ? halves(p) : [p]);
      if (next.length === pieces.length) break;
      pieces = next;
    }
    recut.push(...pieces.flatMap(fitted));
  }
  // A noted part replaces its ref even when the count stays the same.
  if (recut.length !== hunks.length || recut.some((h, i) => h !== hunks[i])) {
    const groups = new Map<string, HunkRef[]>();
    for (const h of recut) { const key = h.part?.whole ?? h.id; const group = groups.get(key) ?? []; group.push(h); groups.set(key, group); }
    for (const group of groups.values()) group.forEach((h, i) => { if (h.part) h.part = { ...h.part, n: i + 1, of: group.length }; });
    // Fragment parts name the final id, set here after renumbering.
    recut.forEach((h, i) => { h.id = `h${i + 1}`; if (h.fragment) h.fragment = { ...h.fragment, of: h.id }; });
    hunks.splice(0, hunks.length, ...recut);
  }
  let unit: ReviewUnit | null = null;
  let rows = 0;
  let estimate = base;
  // Include the per-entry answer example, file listing and diff framing.
  const weight = (ref: HunkRef) => ref.bytes! + Buffer.byteLength(partHeading(ref, true, change), "utf8") + 220 + Buffer.byteLength(ref.path, "utf8");
  const close = () => {
    if (!unit) return;
    // Estimates avoid growing trial renders. Check the real serialization only
    // at closure, and move the last entry out if metadata was underestimated.
    if (brief && Buffer.byteLength(brief(unit), "utf8") > MAX_BRIEF_BYTES) {
      const last = unit.hunks.pop()!;
      unit.diffBytes -= last.bytes!;
      unit.files = [...new Set(unit.hunks.map((h) => h.path))];
      if (unit.hunks.length) {
        close();
        unit = { id: `u${out.length + 1}`, files: [last.path], hunks: [last], diffBytes: last.bytes! };
        close();
      } else {
        last.note = "This entry's finder brief exceeds MAX_BRIEF_BYTES. Its rows remain unread unless carried or read.";
        unit = null;
      }
      return;
    }
    out.push(unit);
    unit = null;
  };
  const routes = new Map<string, DigestInput>();
  for (const h of hunks) { const input = digestInputs.get(h); if (input) routes.set(h.path, input); }
  const filesByPath = new Map(change.files.map((file) => [file.path, file]));
  const refsByRoot = new Map<string, HunkRef[]>();
  const refsByPath = new Map<string, HunkRef[]>();
  for (const ref of hunks) {
    const root = routes.get(ref.path)?.root;
    if (root) { const refs = refsByRoot.get(root); if (refs) refs.push(ref); else refsByRoot.set(root, [ref]); }
    const refs = refsByPath.get(ref.path);
    if (refs) refs.push(ref); else refsByPath.set(ref.path, [ref]);
  }
  const consumed = new Set<string>();
  const digestUnit = (refs: HunkRef[], digest: Digest): ReviewUnit => ({
    id: `u${out.length + 1}`, files: [...new Set(refs.map((h) => h.path))], hunks: refs, diffBytes: 0,
    digest: { id: "d1", kind: digest.kind, text: digest.text, processed: digest.processed.map((h) => h.id), omitted: digest.omitted },
  });
  const fitsDigest = (candidate: ReviewUnit) => Buffer.byteLength(brief ? brief(candidate) : JSON.stringify(candidate), "utf8") <= MAX_BRIEF_BYTES;
  for (const ref of hunks) {
    const input = routes?.get(ref.path);
    if (input) {
      if (consumed.has(input.root)) continue;
      consumed.add(input.root);
      close();
      const refs = refsByRoot.get(input.root)!;
      if (input.kind === "json") {
        for (const [index, page] of input.pages!.entries()) {
          const processed = refs.filter((h) => digestInputs.get(h)?.page === index);
          if (!processed.length) continue;
          const omitted = page.omitted;
          const candidate = digestUnit(processed, { kind: "json", text: [input.sections!.fixed, ...page.entries.map((e) => e.text), "Changed ranges:", ...processed.map((h) => `${h.path}:${h.start}-${h.end}${h.deletion ? ` removed ${h.old?.join("-") ?? ""}` : ""}`)].join("\n"), processed, omitted });
          if (!candidate.files.length) candidate.files = [ref.path];
          digestDetails.set(candidate, { fixed: input.sections!.fixed, entries: page.entries.map((e) => ({ ...e, path: ref.path })) });
          if (!fitsDigest(candidate)) for (const h of processed) h.note = "This JSON digest and its fixed blocks exceed MAX_BRIEF_BYTES; it remains unread.";
          out.push(candidate);
        }
      } else {
        const files: StoreFile[] = [...new Set(refs.map((h) => h.path))].map((path) => ({ path, text: routes!.get(path)!.text, status: filesByPath.get(path)!.status, changed: refsByPath.get(path)! }));
        const sections = storeSections(input.root, files, input.secrets);
        const pageOf = (first: number, end: number) => {
          const entries = sections.entries.slice(first, end);
          const processed = entries.flatMap((e) => e.file.changed);
          const unit = digestUnit(processed, {
            kind: "store", text: [sections.summary, "File list:", ...entries.map((e) => e.text)].join("\n"),
            processed, omitted: entries.flatMap((e) => e.omitted),
          });
          digestDetails.set(unit, { fixed: sections.summary, entries: entries.map((e) => ({ path: e.file.path, lines: [1, Infinity], text: e.text })) });
          return unit;
        };
        // A page cannot carry more source text than the whole brief. This
        // upper bound avoids rendering the rest of a large store per probe.
        const payload = [0];
        for (const entry of sections.entries) payload.push(payload.at(-1)! + Buffer.byteLength(entry.text, "utf8") + 1);
        for (let first = 0; first < files.length;) {
          let low = first + 1;
          let high = files.length;
          while (low <= high) {
            const mid = (low + high) >>> 1;
            if (payload[mid]! - payload[first]! <= MAX_BRIEF_BYTES) low = mid + 1; else high = mid - 1;
          }
          high = Math.max(first + 1, high);
          low = first + 1;
          let end = first + 1;
          while (low <= high) {
            const mid = (low + high) >>> 1;
            if (fitsDigest(pageOf(first, mid))) { end = mid; low = mid + 1; } else high = mid - 1;
          }
          const page = pageOf(first, end);
          if (!fitsDigest(page)) for (const h of page.hunks) h.note = "This store summary and file block exceed MAX_BRIEF_BYTES; they remain unread.";
          out.push(page);
          first = end;
        }
      }
      continue;
    }
    // A noted entry starts no finder session; its note goes straight to the record.
    if (ref.note) continue;
    if (ref.bytes === undefined || ref.rows === undefined) {
      const rendered = hunkRows(change, ref);
      ref.bytes ??= Buffer.byteLength(rendered.join("\n"), "utf8");
      ref.rows ??= rendered.length;
    }
    const limit = unit?.files.includes(ref.path) ? MAX_UNIT_DIFF_BYTES : GROUP_DIFF_BYTES;
    if (unit && (unit.diffBytes + ref.bytes > limit || rows + ref.rows > DELIVER_LINES || estimate + weight(ref) > MAX_BRIEF_BYTES)) close();
    if (!unit) {
      unit = { id: `u${out.length + 1}`, files: [], hunks: [], diffBytes: 0 };
      rows = 0;
      estimate = base;
    }
    if (!unit.files.includes(ref.path)) unit.files.push(ref.path);
    unit.hunks.push(ref);
    unit.diffBytes += ref.bytes;
    rows += ref.rows;
    estimate += weight(ref);
  }
  close();
  return out;
}

// A verifier receives only entries relevant to its citations. Finder pages
// remain intact for coverage and developer copies.
export function citedDigest(units: ReviewUnit[], file: string, lines: [number, number][], citedFiles: string[] = []): ReviewUnit["digest"] {
  const first = units.find((u) => u.digest && u.files.includes(file));
  if (!first?.digest) return undefined;
  const details = digestDetails.get(first);
  if (!details) return first.digest;
  const files = new Set(first.digest.kind === "store" ? [file, ...citedFiles] : [file]);
  const pages = units.filter((u) => u.digest?.kind === first.digest!.kind && u.files.some((path) => files.has(path)));
  const entries = pages.flatMap((u) => digestDetails.get(u)?.entries ?? []).filter((e) => files.has(e.path) && (first.digest!.kind === "store" || lines.some(([a, b]) => e.lines[0] <= b && e.lines[1] >= a)));
  const refs = pages.flatMap((u) => u.hunks).filter((h) => h.path === file && lines.some(([a, b]) => h.start <= b && h.end >= a));
  return { ...first.digest, text: [details.fixed, ...entries.map((e) => e.text)].join("\n"), processed: refs.map((h) => h.id), omitted: pages.flatMap((u) => u.digest!.omitted).filter((o) => files.has(o.path) && (first.digest!.kind === "store" || lines.some(([a, b]) => o.lines[0] <= b && o.lines[1] >= a))) };
}
