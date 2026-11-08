// The growth checks of the YAML key reader (src/yaml-keys.test.ts, failure
// 7 of its list): input that grows with its size takes more than linear
// time. Checked by the ratio of two sizes through the shared growth check
// (packages/graph/src/test-timing.ts: CPU time, a 50 ms floor, the median of
// three readings when the first reaches the bound), which runs on the full
// tier only. Before it, this test took one reading of each size, and a
// loaded macOS runner failed it on unchanged input (issue 215: 1417 ms for
// 1 MB, 12667 ms for 3.94 MB, 8.94 against the bound of 8).
// It lives here and not beside the reader because a test under src is
// compiled with the package and cannot import another package's source.
import { expect, it } from "vitest";
import { MAX_KEY_BYTES, yamlKeys } from "../src/yaml-keys.js";
import { expectLinearRepeated, growthTests, repeatedCpuMs } from "../../graph/src/test-timing.js";

const MB = 1024 * 1024;
const LARGE = 4 * MB - 64 * 1024;
// The reader's CPU time on `made`, flat as a file read from disk is.
const timed = (made: string) => {
  const text = Buffer.from(made, "utf8").toString("utf8");
  return repeatedCpuMs(() => yamlKeys(text));
};
const lines = (size: number, line: (i: number) => string) => {
  const out: string[] = [];
  let length = 0;
  for (let i = 0; length < size; i++) {
    const l = line(i);
    out.push(l);
    length += l.length + 1;
  }
  return out.join("\n");
};
const growing: [string, (size: number) => string][] = [
  ["one long line", (size) => `k: ${"a ".repeat(Math.ceil(size / 2))}\n`],
  ["many keys", (size) => lines(size, (i) => `k${i}: v`)],
];

// A linear reader takes about four times as long for about four times the
// input, one that rescans sixteen; the bound is the middle of the two. The
// larger size stays under MAX_KEY_BYTES, past which the raw lines are read
// instead and the parser goes unmeasured. The loose bound fails only a gross
// slowdown: a Linux runner took 2.7 s of wall time for "many keys" at
// 1.1 MB, and the macOS runner 12.7 s of CPU time at 3.94 MB, so it is
// 32 s at 3.94 MB (8 s at 1 MB, as before).
growthTests("YAML key reading on hostile input (7)", () => {
  for (const [what, make] of growing) {
    it(`${what}, at 1 MB and four times that`, async () => {
      expect(MAX_KEY_BYTES).toBeGreaterThan(LARGE);
      await expectLinearRepeated(`${what}, at 1 MB and at 3.94 MB`, timed(make(MB)), timed(make(LARGE)), { looseBoundMs: 32_000 });
    }, 300_000);
  }
});
