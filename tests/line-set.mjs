// Real interval coverage from the line numbers a test names.
import { LineSet } from "../packages/core/dist/index.js";

/** @param {Iterable<number>} numbers */
export function makeLineSet(numbers = []) {
  const lines = new LineSet();
  for (const n of numbers) lines.add(n);
  return lines;
}
