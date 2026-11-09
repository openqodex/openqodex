// A shared byte policy for briefs and pages. Sources read only one fragment;
// offsets describe the redacted source line. A line of DELIVERY_ROW_BYTES or
// fewer travels whole; a longer line is cut into fragments of at most that.
export const DELIVERY_ROW_BYTES = 2000;
// `fragments`: each fragment's end and text size, when one pass already
// measured them, so a cutter can size parts without reading the line again.
export type ByteLine = { bytes: number; read(from: number, length: number): Buffer; fragments?: { ends: readonly number[]; sizes: readonly number[] } };
export type LineFragment = { from: number; to: number; total: number; text: string };

export function textByteLine(text: string): ByteLine {
  // Encode once, so overlapping fragment reads never restart a character walk.
  const bytes = Buffer.from(text, "utf8");
  return { bytes: bytes.length, read: (from, length) => bytes.subarray(from, from + length) };
}

// Each byte from `from` to `to` is read once: bytes past a cut carry over.
export function* lineFragments(source: ByteLine, from = 1, to = source.bytes): Generator<LineFragment> {
  let carry: Buffer = Buffer.alloc(0);
  for (let at = from; at <= to;) {
    const want = Math.min(DELIVERY_ROW_BYTES + 4, to - at + 1);
    const more = want > carry.length ? source.read(at - 1 + carry.length, want - carry.length) : Buffer.alloc(0);
    const bytes = carry.length ? Buffer.concat([carry, more]) : more;
    if (!bytes.length) throw new Error("the line ended before its byte range");
    let length = Math.min(DELIVERY_ROW_BYTES, bytes.length);
    // A continuation byte belongs to the next fragment's code point.
    while (length > 0 && length < bytes.length && (bytes[length]! & 0xc0) === 0x80) length--;
    if (!length) length = Math.min(DELIVERY_ROW_BYTES, bytes.length);
    const text = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(bytes.subarray(0, length));
    yield { from: at, to: at + length - 1, total: source.bytes, text };
    carry = Buffer.from(bytes.subarray(length));
    at += length;
  }
}

// Fragment bounds and text sizes for cutting parts. A measured line answers
// without a read; any other line is read once through lineFragments.
export function* fragmentSizes(source: ByteLine, from = 1, to = source.bytes): Generator<{ from: number; to: number; size: number }> {
  const known = source.fragments;
  let at = from;
  if (known) {
    let low = 0;
    let high = known.ends.length;
    while (low < high) { const mid = (low + high) >>> 1; if (known.ends[mid]! < from) low = mid + 1; else high = mid; }
    if ((low === 0 ? 1 : known.ends[low - 1]! + 1) === from) {
      for (let i = low; i < known.ends.length && known.ends[i]! <= to; i++) {
        yield { from: at, to: known.ends[i]!, size: known.sizes[i]! };
        at = known.ends[i]! + 1;
      }
    }
  }
  if (at <= to) for (const f of lineFragments(source, at, to)) yield { from: f.from, to: f.to, size: Buffer.byteLength(f.text) };
}

// The one label of a fragment, for briefs, pages, records and reports.
// A removed line names the old path and its old line number.
export function fragmentLabel(path: string, line: number, from: number, to: number, total: number, side: "new" | "old" = "new"): string {
  const number = (n: number) => n.toLocaleString("en-US");
  return `${lineHeading(path, line, side)}, bytes ${number(from)} to ${number(to)} of ${number(total)}`;
}

// The path and line a fragment label starts with, for page headings too.
export function lineHeading(path: string, line: number, side: "new" | "old" = "new"): string {
  return `${path}: ${side === "old" ? "old line" : "line"} ${line}`;
}

// A hunk's fragment label. A removed fragment names the old path and its old
// line; with no old line on record it takes the new-side form, never "old line".
export function hunkFragmentLabel(ref: { path: string; start: number; deletion?: unknown; old?: readonly [number, number] | null; fragment: { from: number; to: number }; lineBytes?: number }, oldPath = ref.path): string {
  const old = ref.deletion ? ref.old?.[0] : undefined;
  return old === undefined
    ? fragmentLabel(ref.path, ref.start, ref.fragment.from, ref.fragment.to, ref.lineBytes ?? 0)
    : fragmentLabel(oldPath, old, ref.fragment.from, ref.fragment.to, ref.lineBytes ?? 0, "old");
}

// Kept for bounded callers that need rendered rows together. Streaming
// consumers iterate lineFragments and stop at their page or part budget.
export function deliveryRow(path: string, line: number, text: string, prefix: string, old = false, mark = ""): string[] {
  if (Buffer.byteLength(text) <= DELIVERY_ROW_BYTES) return [`${prefix}${text}`];
  return Array.from(lineFragments(textByteLine(text)), (f) => `${mark}${fragmentLabel(path, line, f.from, f.to, f.total, old ? "old" : "new")}\t${f.text}`);
}
