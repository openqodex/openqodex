// The growth checks of the suppression readers (src/suppression.test.ts,
// failure 16 of its list): generated input takes time that grows faster than
// its size. Checked by the ratio of two sizes through the shared growth check
// (packages/graph/src/test-timing.ts: CPU time, a 50 ms floor, the median of
// three readings when the first reaches the bound), which runs on the full
// tier only. Before it, these tests divided by a 20 ms floor with no second
// reading, and a loaded runner failed them on unchanged input (issues 275
// and 296: 8.01 and 8.27 against the bound of 8).
// They live here and not beside the readers because a test under src is
// compiled with the package and cannot import another package's source.
import { it } from "vitest";
import type { BuiltinScanner } from "@openqodex/core";
import { findMarkers } from "../src/suppression.js";
import { expectLinearRepeated, growthTests, repeatedCpuMs } from "../../graph/src/test-timing.js";

const MB = 1024 * 1024;
const flat = (made: string) => Buffer.from(made, "utf8").toString("utf8");

// A heredoc's end is looked up by a hash of each line's text (EPBVIVKP and
// ELXSADHD share one). Lines that all share one hash cost each lookup no
// rescan: a file of them with a heredoc on every other line (172,000 lines
// that share the word's hash at 3.94 MB) grows linearly.
growthTests("a heredoc ends only on a line that is its word", () => {
  it("stays linear on a file of lines that all share the word's hash", async () => {
    const at = (size: number) => {
      const text = flat("cat <<EPBVIVKP\nELXSADHD\n".repeat(Math.ceil(size / 24)));
      return repeatedCpuMs(() => findMarkers(text, ["shellcheck"]));
    };
    await expectLinearRepeated("a file of lines that share the heredoc word's hash, at 1 MB and at 3.94 MB", at(MB), at(4 * MB - 64 * 1024));
  }, 180_000);
});

growthTests("linear time on generated input, per reader family (16)", () => {
  // Two sizes about four times apart. The larger stays under 4 MB: past
  // MAX_KEY_BYTES the YAML key reader reads raw lines instead, and its
  // parser would go unmeasured.
  const SMALL = MB;
  const LARGE = 4 * MB - 64 * 1024;
  // `unit` repeated to about `size`; `(k) => string` gives each repeat its own text.
  const filler = (size: number) => (unit: string | ((k: number) => string)) => {
    const parts: string[] = [];
    let length = 0;
    for (let k = 0; length < size; k++) {
      const part = typeof unit === "string" ? unit : unit(k);
      parts.push(part);
      length += part.length;
    }
    return parts.join("");
  };
  type Fill = ReturnType<typeof filler>;
  // The CPU time of the reader on `made`, `repeats` times over, the fastest
  // of three runs after one that is not counted (repeatedCpuMs). The text is
  // copied flat first, as a file read from disk is.
  const timed = (scanner: BuiltinScanner, made: string) => {
    const text = flat(made);
    return repeatedCpuMs(() => findMarkers(text, [scanner]));
  };
  const cases: [BuiltinScanner, string, (fill: Fill) => string][] = [
    ["semgrep", "one very long line", (fill) => fill("x nose ")],
    ["bandit", "many unclosed openers of each kind", (fill) => fill((k) => [`a = '''${k}\n`, `b = """${k}\n`, `c = f'''{${k}\n`, `d = f"{e:${k}\n`, `g = '${k}\n`][k % 5] as string)],
    ["bandit", "one very long line", (fill) => `x = ${fill("'a' + f\"{b}\" + ")}1  # nosec\n`],
    ["bandit", "deep nesting", (fill) => `x = f"${fill("{a:")}"\n`],
    ["shellcheck", "many unclosed openers of each kind", (fill) => fill((k) => [`echo '${k}\n`, `echo "${k}\n`, `echo $'${k}\n`, `x=$(echo ${k}\n`, `y=\`echo ${k}\n`][k % 5] as string)],
    ["shellcheck", "many distinct heredoc words", (fill) => fill((k) => `cat <<E${k}\n`)],
    ["shellcheck", "one very long line", (fill) => `cat <<${fill('""')}\nEOF\n`],
    ["shellcheck", "one very long line of heredocs", (fill) => `cat ${fill('<<"a" ')}\n`],
    ["shellcheck", "deep nesting", (fill) => `x="${fill("$(\"")}"\n`],
    ["shellcheck", "a $( ) left open in every heredoc body (18)", (fill) => fill("cat <<E\n$(echo\nE\n")],
    ["shellcheck", "backticks left open in every heredoc body (18)", (fill) => fill("cat <<E\n`echo\nE\n")],
    ["kube-linter", "one very long flow map of near-miss keys", (fill) => `a: {${fill(", ignore-check.kube-linter.io/x y")}}\n`],
    ["kube-linter", "many lines of dashes before a near-miss key", (fill) => fill("- - - - kube-linter.io/ignore-all x\n")],
    ["hadolint", "many distinct heredoc words", (fill) => `FROM a\n${fill((k) => `RUN <<E${k}\n`)}`],
    ["hadolint", "one very long line", (fill) => `FROM a\nRUN ${fill("<<a ")}\n`],
    ["hadolint", "deep nesting", (fill) => `FROM a\n${fill("RUN a \\\n")}`],
    ["rubocop", "many unclosed openers of each kind", (fill) => fill((k) => [`a = "${k}\n`, `b = '${k}\n`, `c = %q(${k}\n`, `=begin ${k}\n`, `d = "#{${k}\n`][k % 5] as string)],
    ["rubocop", "many distinct heredoc words", (fill) => fill((k) => `x = <<~E${k}\n`)],
    ["rubocop", "one very long line", (fill) => `x = ${fill('"a" + ')}1 # rubocop:disable Lint/Foo\n`],
    ["rubocop", "deep nesting", (fill) => `x = ${fill('"#{')}\n`],
    ["oxlint", "many unclosed openers of each kind", (fill) => fill((k) => [`a = \`${k}\n`, `/* ${k}\n`, `b = "${k}\n`, `c = /${k}\n`, `d = \`\${${k}\n`][k % 5] as string)],
    ["oxlint", "one very long line", (fill) => `x = ${fill("a / b / ")}1; // eslint-disable-line\n`],
    ["oxlint", "deep nesting", (fill) => `x = ${fill("`${")}\n`],
    ["golangci", "many unclosed openers of each kind", (fill) => fill((k) => [`a := \`${k}\n`, `/* ${k}\n`, `b := "${k}\n`][k % 3] as string)],
    ["golangci", "one very long line", (fill) => `x := ${fill('"a" + ')}1 //nolint\n`],
    ["golangci", "deep nesting and package lines in comments", (fill) => fill("/*\npackage x\n*/\n")],
    ["tflint", "many unclosed openers of each kind (24)", (fill) => fill((k) => [`a = "${k}\n`, `/* ${k}\n`, `b = "\${${k}\n`, `c = <<E${k}\n`, `d = "%{${k}\n`][k % 5] as string)],
    ["tflint", "many distinct heredoc words (24)", (fill) => fill((k) => `x = <<E${k}\n`)],
    ["tflint", "one very long line (24)", (fill) => `x = ${fill('"a" + ')}1 # tflint-ignore: all\n`],
    ["tflint", "deep nesting (24)", (fill) => `x = ${fill('"${')}\n`],
  ];
  for (const [scanner, what, make] of cases) {
    it(`${scanner}: ${what}`, async () => {
      // About four times the input: a linear reader takes about four times
      // as long on any machine, one that rescans sixteen; the bound is the
      // middle of the two. Measured here, every family took 2.8 to 4.2 times
      // as long, and a linear one 5.2 times while other tests loaded the
      // machine.
      await expectLinearRepeated(`${scanner}: ${what}, at 1 MB and at ${(LARGE / MB).toFixed(2)} MB`, timed(scanner, make(filler(SMALL))), timed(scanner, make(filler(LARGE))));
    }, 180_000);
  }
});
