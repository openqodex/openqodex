// Changed line numbers stored as sorted, disjoint, inclusive intervals.
// Adjacent intervals merge, so storage follows runs rather than line count.
export interface LineSet extends Iterable<number> {
  readonly size: number;
  min(): number | undefined;
  ranges(): [number, number][];
  has(n: number): boolean;
  overlaps(a: number, b: number): boolean;
  add(n: number): this;
  addRange(a: number, b: number): this;
  intersect(other: LineSet): LineSet;
}

// Keep the public contract structural across separately bundled packages.
export const LineSet: { new(): LineSet } = class implements LineSet {
  private intervals: [number, number][] = [];
  private count = 0;

  get size(): number {
    return this.count;
  }

  min(): number | undefined {
    return this.intervals[0]?.[0];
  }

  ranges(): [number, number][] {
    return this.intervals.map(([a, b]) => [a, b]);
  }

  has(n: number): boolean {
    return Number.isInteger(n) && this.overlaps(n, n);
  }

  overlaps(a: number, b: number): boolean {
    if (!(a <= b)) return false;
    let lo = 0;
    let hi = this.intervals.length;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (this.intervals[mid]![1] < a) lo = mid + 1;
      else hi = mid;
    }
    return lo < this.intervals.length && this.intervals[lo]![0] <= b;
  }

  add(n: number): this {
    return this.addRange(n, n);
  }

  addRange(a: number, b: number): this {
    if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b)) throw new RangeError("Line endpoints must be safe integers");
    if (a > b) return this;
    let lo = 0;
    let hi = this.intervals.length;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (this.intervals[mid]![1] < a - 1) lo = mid + 1;
      else hi = mid;
    }
    let end = lo;
    while (end < this.intervals.length && this.intervals[end]![0] <= b + 1) {
      const [start, last] = this.intervals[end]!;
      a = Math.min(a, start);
      b = Math.max(b, last);
      this.count -= last - start + 1;
      end++;
    }
    this.intervals.splice(lo, end - lo, [a, b]);
    this.count += b - a + 1;
    return this;
  }

  intersect(other: LineSet): LineSet {
    const out = new LineSet();
    const right = other.ranges();
    let i = 0;
    let j = 0;
    while (i < this.intervals.length && j < right.length) {
      const [a, b] = this.intervals[i]!;
      const [c, d] = right[j]!;
      if (a <= d && c <= b) out.addRange(Math.max(a, c), Math.min(b, d));
      if (b < d) i++;
      else j++;
    }
    return out;
  }

  *[Symbol.iterator](): IterableIterator<number> {
    for (const [a, b] of this.intervals) {
      for (let n = a; n <= b; n++) yield n;
    }
  }
};
