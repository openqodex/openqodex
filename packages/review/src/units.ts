import { changedHunks, hunkRows, stagedDiffCache, partHeading } from "@openqodex/core";
import type { Change, HunkRef, ReviewUnit } from "@openqodex/core";
import { DELIVER_LINES, pageRows } from "./conversation.js";

export const GROUP_DIFF_BYTES = 30 * 1024;
export const MAX_UNIT_DIFF_BYTES = 120 * 1024;
export const MAX_BRIEF_BYTES = 256 * 1024;

type Read = (path: string) => string | null;

// One inventory owns scheduling and coverage. Its parts retain the whole
// obligation's identity, and deletions retain their distinct old intervals.
export function obligations(change: Change, read: Read, cache = stagedDiffCache(change)): HunkRef[] {
  const snapshots = new Map<string, string[] | null>();
  const snapshotOf = (path: string) => {
    if (!snapshots.has(path)) snapshots.set(path, read(path)?.split("\n") ?? null);
    return snapshots.get(path)!;
  };
  const order = new Map(change.files.map((f, i) => [f.path, i]));
  const points = new Map<string, number>();
  const whole: HunkRef[] = changedHunks(change).map((h) => {
    if (!h.deletion) return { ...h, id: "", old: null };
    const point = points.get(h.path) ?? 0;
    points.set(h.path, point + 1);
    const p = change.deletionPoints.get(h.path)![point]!;
    const run = cache.file(h.path).removed.find((r) => r.after === p.after && r.lines.length === p.lines);
    const first = run?.oldStart ?? 1;
    return { ...h, id: "", point, old: [first, first + p.lines - 1], deletion: { id: `${h.path}#${point}`, oldStart: first, oldEnd: first + p.lines - 1 } };
  });
  for (const path of change.uncovered ?? []) {
    const snapshot = snapshotOf(path);
    const lines = snapshot === null ? 0 : snapshot.length - Number(snapshot.at(-1) === "");
    whole.push({ id: "", path, start: 1, end: lines, deletion: false, old: null });
  }
  whole.sort((a, b) => (order.get(a.path) ?? 0) - (order.get(b.path) ?? 0) || a.start - b.start || Number(Boolean(a.deletion)) - Number(Boolean(b.deletion)));
  const out: HunkRef[] = [];
  for (const h of whole) {
    const [first, last] = h.deletion ? h.old! : [h.start, h.end];
    if (last < first) { out.push(h); continue; }
    const allReplacements = cache.file(h.path).replacements;
    let low = 0;
    let high = allReplacements.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (allReplacements[mid]!.start < h.start) low = mid + 1; else high = mid;
    }
    const replacements: typeof allReplacements = [];
    if (!h.deletion) for (let i = low; i < allReplacements.length && allReplacements[i]!.start <= h.end; i++) replacements.push(allReplacements[i]!);
    const snapshot = snapshotOf(h.path);
    const measure = (ref: HunkRef): HunkRef => {
      const rows = hunkRows(change, ref, [], cache);
      const rendered = rows.length ? rows : !ref.deletion && snapshot ? pageRows(ref.path, ref.start, ref.end, snapshot) : [];
      return { ...ref, rows: rendered?.length ?? Infinity, bytes: rendered === null ? Infinity : Buffer.byteLength(rendered.join("\n"), "utf8") + (rows.length ? 0 : 1) };
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
        let high = Math.max(at, last);
        let best = candidate(at);
        while (low <= high) {
          const mid = Math.floor((low + high) / 2);
          const ref = candidate(mid);
          if (fits(ref)) { best = ref; low = mid + 1; } else high = mid - 1;
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
  return out.map((h, i) => ({ ...h, id: `h${i + 1}` }));
}

// Kept for callers without a snapshot. Staged review always supplies one.
export function hunkRefs(change: Change): HunkRef[] {
  return obligations(change, () => null);
}

export function unitsOf(change: Change, hunks: HunkRef[], brief?: (unit: ReviewUnit) => string): ReviewUnit[] {
  const out: ReviewUnit[] = [];
  if (!hunks.length) return out;
  const cache = stagedDiffCache(change);
  const base = brief ? Buffer.byteLength(brief({ id: "u1", files: [], hunks: [], diffBytes: 0 }), "utf8") : 0;
  let unit: ReviewUnit | null = null;
  let rows = 0;
  let estimate = base;
  // Include the per-entry answer example, file listing and diff framing.
  const weight = (ref: HunkRef) => ref.bytes! + Buffer.byteLength(partHeading(ref), "utf8") + 220 + Buffer.byteLength(ref.path, "utf8");
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
  for (const ref of hunks) {
    if (ref.bytes === undefined || ref.rows === undefined) {
      const rendered = hunkRows(change, ref, [], cache);
      ref.bytes ??= Buffer.byteLength(rendered.join("\n"), "utf8");
      ref.rows ??= rendered.length;
    }
    const limit = unit?.files.includes(ref.path) ? MAX_UNIT_DIFF_BYTES : GROUP_DIFF_BYTES;
    if (unit && (ref.note || unit.hunks[0]?.note || unit.diffBytes + ref.bytes > limit || rows + ref.rows > DELIVER_LINES || estimate + weight(ref) > MAX_BRIEF_BYTES)) close();
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
