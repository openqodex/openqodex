// Failures guarded:
// 1. Adjacent, overlapping or nested ranges leave duplicate lines or gaps.
// 2. Membership and overlap include a gap or lose an endpoint.
// 3. Intersection loses partial overlaps or mutates its inputs.
// 4. Iteration is unordered and empty sets expose a minimum.
// 5. A 500,001-line run takes one entry per line.
import { describe, expect, it } from "vitest";
import { LineSet } from "./line-set.js";

describe("LineSet", () => {
  it("merges adjacent, overlapping and nested ranges without double counting", () => {
    const lines = new LineSet();
    lines.addRange(8, 10);
    lines.addRange(2, 4);
    lines.addRange(3, 9);
    lines.addRange(4, 5);
    lines.add(1);
    lines.add(12);
    lines.add(11);
    expect(lines.ranges()).toEqual([[1, 12]]);
    expect(lines.size).toBe(12);
  });

  it("keeps membership and overlaps exact at endpoints and gaps", () => {
    const lines = new LineSet();
    lines.addRange(2, 4);
    lines.addRange(8, 10);
    expect([1, 2, 4, 5, 7, 8, 10, 11].map((n) => lines.has(n))).toEqual([false, true, true, false, false, true, true, false]);
    expect([[1, 1], [1, 2], [4, 4], [5, 7], [7, 8], [10, 12], [11, 20]].map(([a, b]) => lines.overlaps(a, b))).toEqual([false, true, true, false, true, true, false]);
  });

  it("intersects partial ranges without mutating either input", () => {
    const left = new LineSet();
    left.addRange(2, 6);
    left.addRange(10, 15);
    const right = new LineSet();
    right.addRange(4, 11);
    right.addRange(14, 18);
    expect(left.intersect(right).ranges()).toEqual([[4, 6], [10, 11], [14, 15]]);
    expect(left.ranges()).toEqual([[2, 6], [10, 15]]);
    expect(right.ranges()).toEqual([[4, 11], [14, 18]]);
    expect(left.intersect(new LineSet()).size).toBe(0);
  });

  it("iterates numbers in order and handles an empty set", () => {
    const lines = new LineSet();
    expect(lines.min()).toBeUndefined();
    expect([...lines]).toEqual([]);
    expect(lines.overlaps(1, 10)).toBe(false);
    lines.addRange(8, 9);
    lines.addRange(2, 3);
    expect(lines.min()).toBe(2);
    expect([...lines]).toEqual([2, 3, 8, 9]);
    const ranges = lines.ranges();
    ranges[0][0] = 1;
    expect(lines.min()).toBe(2);
  });

  it("stores 500,001 contiguous lines in one interval", () => {
    const lines = new LineSet();
    lines.addRange(1, 500_001);
    expect(lines.size).toBe(500_001);
    expect(lines.ranges().length).toBe(1);
    expect(lines.has(500_001)).toBe(true);
  });
});
