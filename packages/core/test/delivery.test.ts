// Failures guarded:
// 1. A 5 MB line is refused, loses bytes, or has labels without byte offsets.
// 2. Unicode bytes are split inside a code point.
import { expect, it } from "vitest";
import { deliveryRow } from "../src/delivery.js";

it("7m carries a 5 MB line in contiguous labelled byte fragments", () => {
  const text = "x".repeat(5 * 1024 * 1024);
  const rows = deliveryRow("big.txt", 7, text, "7\t");
  let next = 1;
  for (const row of rows) {
    const label = /^big.txt: line 7, bytes ([\d,]+) to ([\d,]+) of ([\d,]+)\t(.*)$/.exec(row);
    expect(label, row.slice(0, 100)).not.toBeNull();
    const [from, to, total] = label!.slice(1, 4).map((n) => Number(n.replaceAll(",", "")));
    expect(from).toBe(next);
    expect(total).toBe(5 * 1024 * 1024);
    expect(Buffer.byteLength(label![4]!)).toBe(to! - from! + 1);
    next = to! + 1;
  }
  expect(next).toBe(5 * 1024 * 1024 + 1);
  expect(rows[0]!.slice(0, rows[0]!.indexOf("\t"))).toBe("big.txt: line 7, bytes 1 to 2,000 of 5,242,880");
});
it("keeps Unicode intact while labelling UTF-8 byte offsets", () => {
  const text = "a😀é".repeat(2000);
  const rows = deliveryRow("u.txt", 1, text, "1\t");
  expect(rows.map((r) => r.split("\t").slice(1).join("\t")).join("")).toBe(text);
  expect(rows.at(-1)).toContain("of 14,000\t");
});
it.each(["a".repeat(2000), "é".repeat(2000)])("R2.5 uses bytes at the exact fragment boundary", (text) => {
  const rows = deliveryRow("u.txt", 1, text, "1\t");
  expect(rows).toHaveLength(Buffer.byteLength(text) / 2000);
});
it("R2.4 labels every Unicode fragment with its own byte length", () => {
  const text = "x".repeat(1999) + "😀" + "é".repeat(3000);
  let next = 1;
  for (const row of deliveryRow("u.txt", 1, text, "1\t")) {
    const m = /bytes ([\d,]+) to ([\d,]+) of ([\d,]+)\t(.*)/.exec(row)!;
    const [from, to, total] = m.slice(1, 4).map((n) => Number(n.replaceAll(",", "")));
    expect(from).toBe(next);
    expect(to! - from! + 1).toBe(Buffer.byteLength(m[4]!));
    expect(total).toBe(Buffer.byteLength(text));
    next = to! + 1;
  }
  expect(next).toBe(Buffer.byteLength(text) + 1);
});
