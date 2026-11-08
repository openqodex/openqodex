// The suppression marker table and the comment tokenizers, on file text.
// Each case was checked against the scanner itself: bandit 1.9.4, ruff
// 0.8.4, semgrep 1.94.0, gitleaks 8.21.2, shellcheck 0.10.0, hadolint
// 2.15.1 and oxlint 1.71.0 were run on the same lines, and the cases for
// rubocop 1.69.2 and golangci-lint 2.12.2 follow their source, since this
// Mac has no usable Ruby or Go.
//
// Failure list, written before the code:
//   1. A marker the scanner obeys only in a comment is reported when it sits
//      in a one-line string of the same language.
//   2. The same, in a string that spans lines: a Python triple-quoted
//      string, a JavaScript template literal, a Go raw string, a shell or
//      Dockerfile heredoc, a Ruby heredoc or %-literal.
//   3. A marker in a real comment is missed: a whole-line comment, one after
//      code, a block comment, or one after a string or a regular expression
//      that holds a quote or a comment opener.
//   4. A marker semgrep or gitleaks obeys anywhere on a line is missed
//      because it sits in a string.
//   5. A marker is matched more loosely or more strictly than its scanner
//      matches it (case, spacing, its place in the comment).
//   6. The line is wrong for a marker inside a block comment that spans
//      lines, or in a file with CRLF line ends.
//   7. A scanner with no inline marker (actionlint, brakeman, osv-scanner,
//      sqllint) reports one.
//   8. The name a candidate prints holds text from the line beyond the
//      marker, such as a secret.
// Added after the security check of the first version, so the detector is
// never narrower than the scanner:
//   9. A form the scanner obeys is not matched: semgrep's marker without the
//      space before it, ruff's isort action comments, shellcheck's
//      extended-analysis=false, golangci-lint's generated-file header.
//  10. A comment the scanner reads is taken for a string: a shellcheck
//      directive inside "$( )", backticks or a heredoc's $( ); a comment in a
//      Python 3.12 f-string field; a JavaScript or Ruby regular expression
//      taken for a division, which then opens a string.
// Added after the code review of the second version:
//  11. A hostile line makes a pattern or a reader take more than linear time
//      and hang the run on a small file.
//  12. shellcheck keys written with no blank between them are not read:
//      `source='/dev/null'disable=SC2086`.
//  13. A heredoc's end word is read short (`<<EOF.JSON` as EOF), so the end
//      line is never found and the rest of the file is taken for its body.
//  14. A Dockerfile heredoc opens where BuildKit opens none (`ENV X=<<EOF`),
//      and swallows a later `# hadolint ignore=`.
//  15. A string, heredoc, template, raw string or block comment left open
//      at the end of the file hides every marker after its opener.
// Added after the second code review:
//  16. Generated input takes time that grows faster than its size:
//      thousands of distinct heredoc words left open, a heredoc word made of
//      100,000 quote pairs, many unclosed openers of each kind, one very
//      long line, deep nesting. Many openers left open are checked here by
//      the characters the searches for their closers cover, which no load
//      changes (issue 296); the rest by the ratio of two sizes in
//      test/suppression-growth.test.ts on the full tier.
//  17. A construct read wrongly hides a later real comment: an f-string
//      field whose format spec is never closed; in Ruby, `x /y` read as a
//      regular expression; in JavaScript, `} / 2` read as one.
// Added after the third code review:
//  18. A $( ) left open in each of many heredoc bodies makes each nested
//      read run to the end of the file and the next level read it again:
//      exponential work.
//  19. A shell heredoc end word is read other than the way shellcheck reads
//      it, so the body runs on and an apostrophe in it swallows a later
//      directive: `<<"E\"OF"` ends at `E\"OF`, `<<E"O"F` at `E"O"F`, and
//      an end line may carry trailing blanks.
// Added with the infrastructure scanners (trivy 0.75.0, checkov 3.3.22 and
// tflint 0.64.0 were run on the same lines):
//  20. tflint: `tflint-ignore:` in an HCL string, a heredoc body or a
//      template's string is reported; or a `#`, `//` or `/* */` comment that
//      holds it is missed, also after a string that holds a quote, a `#`, a
//      `//` or a `${ }` with nested strings and braces, and inside a `${ }`.
//  21. An HCL heredoc is read other than the way HCL reads it: its closing
//      word indented (both `<<` and `<<-`), a `<<WORD` not followed by the
//      line end, `$${` taken for a template.
//  22. trivy and checkov read their markers on the raw line, a string
//      included; one is missed there, or in the forms they take (`tfsec:`,
//      `trivy:exp:...:ignore:`, `bridgecrew:skip=`).
//  23. checkov's Kubernetes annotation key and CloudFormation Metadata key
//      are missed as a YAML or JSON key (block, flow, JSON, an alias), or
//      counted in a YAML comment or a quoted value; a marker of one family
//      is read in another's units.
//  24. The HCL reader takes more than linear time on hostile input.

import { describe, expect, it } from "vitest";
import type { BuiltinScanner } from "@openqodex/core";
import { closerSearchSpan } from "./comments.js";
import { SUPPRESSION_MARKERS, findMarkers } from "./suppression.js";

const lines = (scanner: BuiltinScanner, text: string): number[] =>
  findMarkers(text, [scanner]).map((m) => m.line);

const src = (...rows: string[]): string => `${rows.join("\n")}\n`;

describe("bandit, # nosec in Python comments", () => {
  it("finds it in a comment after code and in a later comment on the line, never in a string (1, 3, 5)", () => {
    const text = src(
      'subprocess.call("ls", shell=True)  # nosec',
      'subprocess.call("ls", shell=True); s = "# nosec"',
      'subprocess.call("ls", shell=True)  #nosec B602',
      'subprocess.call("ls", shell=True)  # foo # nosec',
      'subprocess.call("ls", shell=True)  # NOSEC',
      "s = '# nosec'  # plain",
    );
    expect(lines("bandit", text)).toEqual([1, 3, 4]);
  });

  it("ignores it inside a triple-quoted string, and finds a comment after the string closes (2, 3)", () => {
    const text = src(
      's = """',
      "# nosec",
      '"""; x = 1  # nosec',
      "t = '''a # nosec",
      "'''",
      "u = f'{x}#nosec'",
      'v = "a \\" # nosec"',
    );
    expect(lines("bandit", text)).toEqual([3]);
  });
});

describe("ruff, # noqa in Python comments", () => {
  it("finds # noqa in any case anywhere in a comment, and # ruff: noqa only on its own line (1, 5)", () => {
    const text = src(
      "import os, sys  # noqa",
      'import json, re; t = "# noqa"',
      "import csv, io  # foo # NOQA",
      "# ruff: noqa: F401",
      "x = 1  # ruff: noqa",
      "  # flake8: noqa",
      "# ruff noqa",
    );
    const found = findMarkers(text, ["ruff"]);
    expect(found.map((m) => [m.line, m.name])).toEqual([
      [1, "# noqa"],
      [3, "# noqa"],
      [4, "# ruff: noqa"],
      [6, "# flake8: noqa"],
    ]);
  });
});

describe("semgrep and gitleaks obey their marker anywhere on the line", () => {
  it("semgrep: nosem in any case, in a comment or a string, with or without a space before it (4, 5, 9)", () => {
    // semgrep 1.94.0 itself needs the space; its documentation only asks for
    // a comment, so `#nosemgrep` and a tab are flagged too (over-flagged).
    const text = src(
      "eval(x)  # nosemgrep",
      "eval(x)  #nosemgrep",
      'eval(x); s = " nosemgrep"',
      "eval(x)  # NOSEM",
      "eval(x)  #\tnosemgrep",
      "eval(x) //nosemgrep: rule.id",
      "plain line",
    );
    expect(lines("semgrep", text)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("gitleaks: gitleaks:allow, case-sensitive, in a comment or a string (4, 5)", () => {
    const text = src('A = "x"  # gitleaks:allow', 'B = "x gitleaks:allow"', 'C = "x"  # GITLEAKS:ALLOW');
    expect(lines("gitleaks", text)).toEqual([1, 2]);
  });
});

describe("shellcheck, # shellcheck disable= in shell comments", () => {
  it("finds the directive with or without a space and after another key, never in a string, a heredoc or a word (1, 2, 5)", () => {
    const text = src(
      "echo start",
      "# shellcheck disable=SC2086",
      'echo "# shellcheck disable=SC2086"; echo $B',
      "cat <<EOF",
      "# shellcheck disable=SC2086",
      "EOF",
      "echo x#shellcheck disable=SC2086",
      "# shellcheck source=/dev/null disable=SC2086",
      "#shellcheck disable=SC2086",
      "# shellcheck enable=require-variable-braces",
      "cat <<-'END' | tr a b",
      "\t# shellcheck disable=SC2086",
      "\tEND",
      "echo '# shellcheck disable=SC2086",
      "# shellcheck disable=SC2086'",
      "echo ${#arr[@]} $# # shellcheck disable=SC2086",
    );
    expect(lines("shellcheck", text)).toEqual([2, 8, 9, 16]);
  });
});

describe("hadolint, # hadolint ignore= on a Dockerfile comment line", () => {
  it("finds ignore, global ignore and stage ignore pragmas, never in an instruction or a heredoc (1, 2, 5)", () => {
    const text = src(
      "FROM debian:12",
      "# hadolint ignore=DL3008",
      'RUN echo "# hadolint ignore=DL3008"',
      "   #   hadolint   ignore=DL3008",
      "#hadolint ignore=DL3008,SC2086",
      "# hadolint global ignore=DL3008",
      "# hadolint stage ignore=DL3006",
      "RUN <<EOF",
      "# hadolint ignore=DL3008",
      "EOF",
      "# hadolint shell=bash",
      "RUN true # hadolint ignore=DL3008",
    );
    expect(lines("hadolint", text)).toEqual([2, 4, 5, 6, 7]);
  });
});

describe("oxlint, eslint-disable and oxlint-disable at the start of a JavaScript comment", () => {
  it("finds line and block directives, never in a string, a template or later in a comment (1, 2, 3, 5)", () => {
    const text = src(
      "function f() {",
      "  debugger; // eslint-disable-line",
      '  debugger; const s = "// eslint-disable-line";',
      "  // eslint-disable-next-line",
      "  const t = `",
      "// eslint-disable-next-line",
      "`; debugger;",
      "  /* oxlint-disable-next-line */",
      "  debugger; /*eslint-disable-line*/",
      '  const r = /"/; debugger; // eslint-disable-line',
      "  debugger; // foo eslint-disable-line",
      "  const u = `${'`'}`; // oxlint-disable-line no-debugger",
      "  const w = `a ${ { b: `// eslint-disable` }.b } c`; // eslint-disable-line",
      "  const q = a / b; // eslint-disable-line",
      "}",
      "/* eslint-disable */",
      "/** eslint-disable */",
    );
    expect(findMarkers(text, ["oxlint"]).map((m) => [m.line, m.name])).toEqual([
      [2, "eslint-disable-line"],
      [4, "eslint-disable-next-line"],
      [8, "oxlint-disable-next-line"],
      [9, "eslint-disable-line"],
      [10, "eslint-disable-line"],
      [12, "oxlint-disable-line"],
      [13, "eslint-disable-line"],
      [14, "eslint-disable-line"],
      [16, "eslint-disable"],
    ]);
  });

  it("puts a directive inside a block comment that spans lines on its own line (6)", () => {
    const text = src("/*", "  eslint-disable no-console", "*/", "/* note", "eslint-disable */");
    expect(lines("oxlint", text)).toEqual([2]);
  });
});

describe("golangci-lint, //nolint, #nosec and //gosec:disable in Go comments", () => {
  it("finds //nolint as golangci-lint parses it, never in a block comment or a string (1, 5)", () => {
    const text = src(
      "x := f() //nolint",
      "x := f() // nolint:errcheck",
      "x := f() /// nolint",
      'x := "//nolint"',
      "x := f() /* nolint */",
      "x := f() //nolintfoo",
      "x := f() //nolint:gosec,errcheck // reason",
    );
    expect(lines("golangci", text)).toEqual([1, 2, 3, 7]);
  });

  it("finds gosec's #nosec at the start of a comment line and //gosec:disable, never in a raw string (1, 2, 5, 6)", () => {
    const text = src(
      "pw := \"x\" // #nosec G101",
      "pw := \"x\" //#nosec",
      "pw := \"x\" // see #nosec",
      "q := `",
      "// #nosec",
      "`",
      "/*",
      "  #nosec G204",
      "*/",
      "c := '\\'' //gosec:disable G101",
      "c := 1 //gosec:disabled",
    );
    expect(findMarkers(text, ["golangci"]).map((m) => [m.line, m.name])).toEqual([
      [1, "#nosec"],
      [2, "#nosec"],
      [8, "#nosec"],
      [10, "//gosec:disable"],
    ]);
  });
});

describe("rubocop, # rubocop:disable and # rubocop:todo in Ruby comments", () => {
  it("finds the directive in a comment and an =begin block, never in strings, heredocs or %-literals (1, 2, 3, 5)", () => {
    const text = src(
      "x = eval(y) # rubocop:disable Security/Eval",
      'x = "# rubocop:disable Security/Eval"',
      "x = 1 # rubocop:todo Lint/UselessAssignment",
      "# rubocop : disable all",
      "s = <<~SQL",
      "  # rubocop:disable Security/Eval",
      "SQL",
      "t = %q(# rubocop:disable all (nested))",
      'u = "#{a + "b"} # rubocop:disable all"',
      "=begin",
      "# rubocop:disable all",
      "=end",
      "# rubocop:enable all",
      "# rubocop:disable lower/case",
      "v = a ? 1 : 2 # rubocop:disable Style/Ternary",
    );
    expect(findMarkers(text, ["rubocop"]).map((m) => [m.line, m.name])).toEqual([
      [1, "# rubocop:disable"],
      [3, "# rubocop:todo"],
      [4, "# rubocop:disable"],
      [11, "# rubocop:disable"],
      [15, "# rubocop:disable"],
    ]);
  });
});

describe("never narrower than the scanner", () => {
  it("ruff: the isort action comments that switch off import sorting (9)", () => {
    const text = src(
      "# isort: skip_file",
      "import b, a  # isort:skip",
      "# ruff: isort: off",
      "# isort: split",
      "x = 'isort: skip'",
    );
    expect(findMarkers(text, ["ruff"]).map((m) => [m.line, m.name])).toEqual([
      [1, "# isort: skip_file"],
      [2, "# isort: skip"],
      [3, "# isort: off"],
    ]);
  });

  it("bandit and ruff: a comment inside a Python 3.12 f-string field, never a # in a format spec (10)", () => {
    const text = src(
      'x = f"{', "    a  # nosec", '}" + "y"  # nosec',
      'y = f"{v:#x}"  # nosec',
      'z = f"{d:{w}}" "# nosec"',
      "t = f'''{a!r} # nosec'''",
      'u = rf"""{', "    b  # nosec", '}"""',
    );
    expect(lines("bandit", text)).toEqual([2, 3, 4, 8]);
  });

  it("shellcheck: extended-analysis=false, and directives inside \"$( )\", backticks and a heredoc's $( ) (9, 10)", () => {
    const text = src(
      "echo start",
      'x="$(',
      "# shellcheck disable=SC2086",
      "echo $A",
      ')"',
      "y=`",
      "# shellcheck disable=SC2086",
      "echo $C`",
      "cat <<EOF",
      "$(",
      "# shellcheck disable=SC2086",
      "echo $E",
      ")",
      "# shellcheck disable=SC2086",
      "EOF",
      "cat <<'EOF'",
      "$(",
      "# shellcheck disable=SC2086",
      ")",
      "EOF",
      "# shellcheck extended-analysis=false",
      'z="a $(echo "# shellcheck disable=SC2086") b"',
    );
    expect(findMarkers(text, ["shellcheck"]).map((m) => [m.line, m.name])).toEqual([
      [3, "# shellcheck disable="],
      [7, "# shellcheck disable="],
      [11, "# shellcheck disable="],
      [21, "# shellcheck extended-analysis=false"],
    ]);
  });

  it("golangci-lint: a generated-file comment before the package clause, in any case (9)", () => {
    const header = src("// Code generated by protoc-gen-go. DO NOT EDIT.", "", "package api", "", "// do not edit below", "var x = 1");
    expect(findMarkers(header, ["golangci"]).map((m) => [m.line, m.name])).toEqual([[1, "a generated-file comment"]]);
    const block = src("/*", " * Autogenerated file, keep out.", " */", "package api // Do Not Edit");
    expect(lines("golangci", block)).toEqual([2, 4]);
  });

  it("oxlint: a regular expression after if (...) or a postfix ++ is never taken for a string (10)", () => {
    const text = src(
      "#!/usr/bin/env node",
      "if (a) /'/.test(b); // eslint-disable-line",
      "while (x) /\"/.exec(y); // eslint-disable-line",
      "n = a++ / b; // eslint-disable-line",
      "m = (a) / 2; // eslint-disable-line",
    );
    expect(lines("oxlint", text)).toEqual([2, 3, 4, 5]);
  });

  it("rubocop: a regular expression argument after a method name is never taken for a string (10)", () => {
    const text = src(
      "parts = line.split /'/ # rubocop:disable Style/RegexpLiteral",
      "half = total / 2 # rubocop:disable Lint/Foo",
      "rest = 1",
      "# rubocop:todo Lint/Bar",
    );
    expect(lines("rubocop", text)).toEqual([1, 2, 4]);
  });
});

describe("keys and heredoc words read as the scanners read them", () => {
  it("shellcheck: keys with no blank between them (12)", () => {
    // shellcheck 0.10.0 obeys this disable (checked against the binary).
    const text = src("echo start", "# shellcheck source='/dev/null'disable=SC2086", "echo $A", "# shellcheck disable=2086source=/dev/null", "echo $B");
    expect(lines("shellcheck", text)).toEqual([2, 4]);
  });

  it("shell: the whole end word of a heredoc, quoted, escaped or with a dot (13)", () => {
    // shellcheck 0.10.0 ends each of these heredocs at the line shown.
    const text = src(
      "cat <<EOF.JSON",
      "# shellcheck disable=SC2086",
      "EOF.JSON",
      "# shellcheck disable=SC2086",
      'cat <<"X Y"',
      "# shellcheck disable=SC2086",
      "X Y",
      "# shellcheck disable=SC2086",
      "cat <<-\\END",
      "\t# shellcheck disable=SC2086",
      "\tEND",
      "# shellcheck disable=SC2086",
    );
    expect(lines("shellcheck", text)).toEqual([4, 8, 12]);
  });

  it("shell: the end word and end line as shellcheck reads them (19)", () => {
    // shellcheck 0.10.0 ends each heredoc at the line shown and obeys the
    // directive after it (checked against the binary).
    for (const [opener, end] of [
      ['cat <<"E\\"OF"', 'E\\"OF'],
      ["cat <<'E\\\"OF'", 'E\\"OF'],
      ['cat <<E"O"F', 'E"O"F'],
      ["cat <<EOF", "EOF  "],
    ] as const) {
      const text = src("echo start", opener, "it's here", end, "# shellcheck disable=SC2086", "echo $A", "echo 'done'");
      expect(lines("shellcheck", text), opener).toEqual([5]);
    }
  });

  it("Dockerfile: a heredoc opens only in RUN, COPY and ADD, at the start of a word (14)", () => {
    // hadolint 2.15.1 obeys line 3 (checked against the binary).
    const text = src(
      "FROM debian:12",
      "ENV MARKER=<<EOF",
      "# hadolint ignore=DL3008",
      "RUN cat<<EOF",
      "# hadolint ignore=DL3009",
      "COPY <<EOF /etc/x",
      "# hadolint ignore=DL3010",
      "EOF",
      "run echo <<'END' \\",
      "  && true",
      "# hadolint ignore=DL3011",
      "END",
      "# hadolint ignore=DL3012",
    );
    expect(lines("hadolint", text)).toEqual([3, 5, 13]);
  });
});

describe("an opener left open at the end of the file hides nothing after it (15)", () => {
  it("python: a triple-quoted string and a triple-quoted f-string", () => {
    expect(lines("bandit", src("x = '''", "y = 1  # nosec"))).toEqual([2]);
    expect(lines("bandit", src('x = f"""{a}', "y = 1  # nosec"))).toEqual([2]);
  });

  it("shell: a heredoc, a single-quoted and a double-quoted string, a $( )", () => {
    for (const opener of ["cat <<EOF", "echo 'abc", 'echo "abc', "x=$(echo"]) {
      expect(lines("shellcheck", src("echo start", opener, "# shellcheck disable=SC2086", "echo $A")), opener).toEqual([3]);
    }
  });

  it("Dockerfile: a heredoc", () => {
    expect(lines("hadolint", src("FROM debian:12", "RUN <<EOF", "# hadolint ignore=DL3008", "RUN true"))).toEqual([3]);
  });

  it("ruby: a heredoc, a double-quoted string, a %-literal and an =begin block", () => {
    for (const opener of ["s = <<~SQL", 's = "abc #{x}', "t = %q(abc", "=begin"]) {
      expect(lines("rubocop", src(opener, "x = 1 # rubocop:disable Lint/Foo")), opener).toEqual([2]);
    }
  });

  it("javascript: a template literal and a block comment", () => {
    for (const opener of ["const t = `abc ${x}", "/* note"]) {
      expect(lines("oxlint", src(opener, "debugger; // eslint-disable-line")), opener).toEqual([2]);
    }
  });

  it("go: a raw string and a block comment", () => {
    for (const opener of ["q := `abc", "/* note"]) {
      expect(lines("golangci", src(opener, "x := f() //nolint")), opener).toEqual([2]);
    }
  });
});

describe("a construct read wrongly hides no later comment (17)", () => {
  it("python: an f-string field whose format spec is never closed", () => {
    expect(lines("bandit", src('x = f"{a:>10"', "y = 1  # nosec"))).toEqual([2]);
    expect(lines("bandit", src('x = f"""{a:', "y = 1  # nosec"))).toEqual([2]);
  });

  it("ruby: a local variable, a blank and a slash, read as a regular expression", () => {
    expect(lines("rubocop", src("half = total /2 # rubocop:disable Lint/Foo"))).toEqual([1]);
  });

  it("javascript: a division after a closing brace, read as a regular expression", () => {
    expect(lines("oxlint", src("x = {a: 1}.a } / 2; // eslint-disable-line"))).toEqual([1]);
  });
});

describe("linear time on hostile input (11)", () => {
  // Each input is large enough that a pattern or reader with quadratic or
  // exponential work takes minutes; a linear one takes milliseconds.
  const N = 100_000;
  const fast = (scanner: BuiltinScanner, text: string) => {
    const started = performance.now();
    findMarkers(text, [scanner]);
    return performance.now() - started;
  };
  const cases: [BuiltinScanner, string, string][] = [
    ["shellcheck", "a directive with many keys, then a bad one", `# shellcheck ${"source='x' ".repeat(2000)}! disable=SC2086\n`],
    ["shellcheck", "a directive with many keys and no disable", `# shellcheck ${"source='x' ".repeat(N / 10)}!\n# shellcheck ${"extended-analysis=".repeat(N / 10)}\n`],
    ["shellcheck", "openers left open", `echo start\n${"'\"`$(<<EOF\n".repeat(N / 10)}`],
    ["shellcheck", "deep $( )", `x=${"$(".repeat(N)}\n`],
    ["semgrep", "a long line", `${"nose".repeat(N)}\n`],
    ["gitleaks", "a long line", `${"gitleaks:allo".repeat(N / 4)}\n`],
    ["bandit", "blanks after #", `#${" ".repeat(N)}x\n${"# ".repeat(N)}\n`],
    ["ruff", "blanks after # and isort", `#${" ".repeat(N)}x\n${"isort: ".repeat(N / 4)}\n`],
    ["bandit", "openers left open", `${"'''\"\"\"f'''{".repeat(N / 10)}\n`],
    ["bandit", "deep f-string fields", `x = f"${"{a:".repeat(N)}\n`],
    ["hadolint", "heredocs left open", `FROM a\n${"RUN <<EOF\n".repeat(N / 10)}`],
    ["hadolint", "blanks after #", `#${" ".repeat(N)}hadolint\n`],
    ["oxlint", "openers left open", `${"`/*(".repeat(N / 4)}\n`],
    ["oxlint", "blanks after //", `//${" ".repeat(N)}x\n`],
    ["golangci", "openers left open and package lines in comments", `${"/*\npackage x\n*/\n".repeat(N / 10)}${"`".repeat(N / 10)}\n`],
    ["golangci", "blanks before #nosec", `/*\n${" ".repeat(N)}x\n*/\n`],
    ["rubocop", "openers left open", `${'=begin\n"#{%q(<<~A\n'.repeat(N / 10)}`],
    ["rubocop", "blanks in a directive", `#${" ".repeat(N)}rubocop${" ".repeat(N)}:x\n`],
    ["tflint", "openers left open (24)", `${'"${/*<<E\n'.repeat(N / 10)}`],
    ["tflint", "deep templates (24)", `x = ${'"${'.repeat(N)}\n`],
    ["trivy", "a long word and many short ones (24)", `${"#".repeat(N)}trivy:${"a".repeat(N)}\n${" trivy:".repeat(N / 7)}\n`],
    ["checkov", "many near markers (24)", `${"checkov:skip".repeat(N / 12)}\n${"checkov.io/ski".repeat(N / 14)}\n`],
  ];
  for (const [scanner, what, text] of cases) {
    it(`${scanner}: ${what}`, () => {
      expect(fast(scanner, text)).toBeLessThan(1000);
    });
  }
});

// A heredoc's end is looked up by a hash of each line's text. Two words
// with one 32-bit hash (EPBVIVKP and ELXSADHD share 0x63c4d43c): a body line
// that only shares the hash must not end the heredoc, or a comment-shaped
// line of its body would count as a marker.
describe("a heredoc ends only on a line that is its word", () => {
  it("passes over a body line whose text shares the word's hash", () => {
    const text = src("x = <<~EPBVIVKP", "  ELXSADHD", "  # rubocop:disable all", "  EPBVIVKP", "y = 1 # rubocop:disable Lint/Foo");
    expect(findMarkers(text, ["rubocop"]).map((m) => m.line)).toEqual([5]);
  });

  // However many lines share the word's hash before its real end, the
  // heredoc ends there, as the scanner ends it. Read as left open, its body
  // would be read as code: the quote in "it's" would open a string that runs
  // past the end and hides the real comment after it.
  it("ends at the real end after any number of lines that share its hash, and hides no marker after it", () => {
    const text = src("cat <<EPBVIVKP", ...Array(200).fill("ELXSADHD"), "it's", "EPBVIVKP", "echo $1 # shellcheck disable=SC2086", "echo 'x'");
    expect(findMarkers(text, ["shellcheck"]).map((m) => m.line)).toEqual([204]);
  });
});

describe("tflint, tflint-ignore in HCL comments (20, 21)", () => {
  it("finds it in #, // and /* */ comments and in a template's comment, never in a string or a heredoc body", () => {
    const text = src(
      "# tflint-ignore: terraform_unused_declarations",
      'variable "a" { # tflint-ignore: all',
      '  description = "tflint-ignore: all"',
      "}",
      "/* tflint-ignore: terraform_unused_declarations */",
      "// tflint-ignore: all",
      "locals {",
      "  doc = <<EOT",
      "# tflint-ignore: all",
      "  EOT",
      '  x = "a \\" # tflint-ignore: all"',
      '  y = "${lookup(m, "k # x", "}")}" # tflint-ignore: all',
      '  z = "${ # tflint-ignore: all',
      '  }"',
      "}",
      "# tflint-ignore-file: terraform_unused_declarations",
      "# tflint-ignore:all",
    );
    const found = findMarkers(text, ["tflint"]);
    expect(found.map((m) => [m.line, m.name])).toEqual([
      [1, "tflint-ignore:"],
      [2, "tflint-ignore:"],
      [5, "tflint-ignore:"],
      [6, "tflint-ignore:"],
      [12, "tflint-ignore:"],
      [13, "tflint-ignore:"],
      [16, "tflint-ignore-file:"],
    ]);
  });

  it("reads heredocs as HCL does: an indented closing word for both forms, a <<WORD with text after it opens none, $${ is text", () => {
    const text = src(
      "locals {",
      "  a = <<-EOT",
      "    # tflint-ignore: all",
      "    ${var.x} # tflint-ignore: all",
      "    EOT",
      "  b = 1 # tflint-ignore: all",
      "  c = <<EOT ",
      "# tflint-ignore: all",
      '  d = "$${ # tflint-ignore: all }"',
      '  e = "%%{ # tflint-ignore: all }"',
      "}",
    );
    expect(lines("tflint", text)).toEqual([6, 8]);
  });

  it("finds the file form as the start of a .tf.json string, as tflint reads the root \"//\" key", () => {
    const text = src('{', '  "//": "tflint-ignore-file: terraform_unused_declarations",', '  "variable": {"a": {}}', "}");
    expect(findMarkers(text, ["tflint"]).map((m) => [m.line, m.name])).toEqual([[2, 'tflint-ignore-file: in a JSON "//" value']]);
  });
});

describe("trivy and checkov read their markers on the raw line (22)", () => {
  it("trivy: trivy:ignore and tfsec:ignore as a word of the line after #, / or *, a string included", () => {
    const text = src(
      "#trivy:ignore:AWS-0107",
      'resource "x" "y" { # tfsec:ignore:aws-ec2-no-public-ingress-sgr',
      '  description = "see trivy:ignore:* here"',
      "  //trivy:exp:2030-01-01:ignore:AWS-0107",
      '  name = "trivy:ignore:x"',
      '  note = "trivy: ignore:x"',
      "  x = 1 /* trivy:ignore:AWS-0107 */",
      "}",
    );
    expect(findMarkers(text, ["trivy"]).map((m) => [m.line, m.name])).toEqual([
      [1, "trivy:ignore"],
      [2, "tfsec:ignore"],
      [3, "trivy:ignore"],
      [4, "trivy:ignore"],
      [7, "trivy:ignore"],
    ]);
  });

  it("checkov: checkov:skip=, bridgecrew:skip= and cortex:skip= anywhere on the line, a string included", () => {
    const text = src(
      'resource "aws_security_group" "c" {',
      "  # checkov:skip=CKV_AWS_24:reason",
      '  description = "x checkov:skip=CKV_AWS_24:in a string"',
      "  # bridgecrew:skip=CKV_AWS_23",
      "  # cortex:skip=CKV_AWS_23",
      "  # checkov:skip CKV_AWS_24",
      "}",
    );
    expect(findMarkers(text, ["checkov"]).map((m) => [m.line, m.name])).toEqual([
      [2, "checkov:skip="],
      [3, "checkov:skip="],
      [4, "bridgecrew:skip="],
      [5, "cortex:skip="],
      // Terraform is not YAML: the Metadata key is looked for on its raw
      // lines, wider than checkov.
      [6, "Metadata checkov key"],
    ]);
  });
});

describe("checkov's YAML keys, a family of their own in one entry (23)", () => {
  it("a Kubernetes skip annotation counts as a YAML key, never in a comment or a quoted value; the skip comment counts on the line", () => {
    const text = src(
      "apiVersion: v1",
      "kind: Pod",
      "metadata:",
      "  annotations:",
      "    checkov.io/skip1: CKV_K8S_16=reason",
      '    "bridgecrew.io/skip2": CKV_K8S_20',
      '    note: "checkov.io/skip3: CKV_K8S_16"',
      "  # checkov.io/skip4: CKV_K8S_16",
      "  # checkov:skip=CKV_K8S_16",
    );
    expect(findMarkers(text, ["checkov"]).map((m) => [m.line, m.name])).toEqual([
      [5, "checkov.io/skip annotation"],
      [6, "bridgecrew.io/skip annotation"],
      [9, "checkov:skip="],
    ]);
  });

  it("a CloudFormation Metadata checkov or bridgecrew key counts as a YAML key, in block or flow form, never in a value", () => {
    const text = src(
      "Resources:",
      "  SgA:",
      "    Type: AWS::EC2::SecurityGroup",
      "    Metadata:",
      "      checkov:",
      "        skip:",
      "          - id: CKV_AWS_24",
      "      bridgecrew: {skip: [{id: CKV_AWS_23}]}",
      "    Properties:",
      '      GroupDescription: "checkov: not a key"',
      "      Tags: checkov",
    );
    expect(findMarkers(text, ["checkov"]).map((m) => [m.line, m.name])).toEqual([
      [5, "Metadata checkov key"],
      [8, "Metadata bridgecrew key"],
    ]);
  });

  it("the annotation key in flow style, in JSON and through an alias, as checkov's YAML loader reads them", () => {
    const flow = src("apiVersion: v1", "kind: Pod", 'metadata: {name: a, annotations: {"checkov.io/skip1": "CKV_K8S_16=x"}}');
    expect(findMarkers(flow, ["checkov"]).map((m) => [m.line, m.name])).toEqual([[3, "checkov.io/skip annotation"]]);
    const json = src("{", '  "apiVersion": "v1", "kind": "Pod",', '  "metadata": {"annotations": {"cortex.io/skip1": "CKV_K8S_16"}}', "}");
    expect(findMarkers(json, ["checkov"]).map((m) => [m.line, m.name])).toEqual([[3, "cortex.io/skip annotation"]]);
    const alias = src("x-common: &skips", "  checkov.io/skip1: CKV_K8S_16", "---", "apiVersion: v1", "kind: Pod", "metadata:", "  annotations: *skips");
    expect(findMarkers(alias, ["checkov"]).map((m) => m.line)).toEqual([2]);
    const anchored = src("apiVersion: v1", "kind: Pod", "x-common: &skips", "  checkov.io/skip1: CKV_K8S_16", "metadata:", "  annotations: *skips");
    expect(findMarkers(anchored, ["checkov"]).map((m) => m.line)).toEqual([4, 6]);
  });

  it("the CloudFormation Metadata key in a JSON template", () => {
    const text = src('{"Resources": {"A": {', '  "Type": "AWS::S3::Bucket",', '  "Metadata": {"checkov": {"skip": [{"id": "CKV_AWS_18"}]}}', "}}}");
    expect(findMarkers(text, ["checkov"]).map((m) => [m.line, m.name])).toEqual([[3, "Metadata checkov key"]]);
  });
});

describe("trivy's marker in each file form it reads (22)", () => {
  it("counts it in a YAML comment, a YAML value and a JSON string, as on any line", () => {
    const yaml = src("Resources:", "  # trivy:ignore:AWS-0107", "  Sg:", "    Type: AWS::EC2::SecurityGroup", '    Properties: {GroupDescription: "x tfsec:ignore:aws-ec2-x"}');
    expect(findMarkers(yaml, ["trivy"]).map((m) => [m.line, m.name])).toEqual([
      [2, "trivy:ignore"],
      [5, "tfsec:ignore"],
    ]);
    const json = src('{"Resources": {"Sg": {"Type": "AWS::EC2::SecurityGroup",', '  "Properties": {"GroupDescription": "see trivy:ignore:*"}}}}');
    expect(findMarkers(json, ["trivy"]).map((m) => m.line)).toEqual([2]);
  });
});

// kube-linter 0.8.3 skips an object whose metadata.annotations hold the key
// ignore-check.kube-linter.io/<check> or kube-linter.io/ignore-all
// (pkg/ignore/ignore.go); checked with the binary: the annotation silences
// privileged-container, the same text in a YAML comment does not.
describe("kube-linter, its ignore annotations as YAML keys", () => {
  it("finds the annotation keys at a key position, quoted or in a flow map, never in a comment, a quoted value, a plain value or a block scalar (1, 2, 5)", () => {
    const text = src(
      "apiVersion: apps/v1",
      "kind: Deployment",
      "metadata:",
      "  name: web",
      "  annotations:",
      '    ignore-check.kube-linter.io/privileged-container: "needs the host"',
      '    kube-linter.io/ignore-all: "true"',
      '    "ignore-check.kube-linter.io/run-as-non-root": x',
      '    note: "ignore-check.kube-linter.io/latest-tag: x"',
      "    # ignore-check.kube-linter.io/latest-tag: x",
      "    other: ignore-check.kube-linter.io/latest-tag",
      '  labels: {app: web, kube-linter.io/ignore-all: "true"}',
      "data:",
      "  script: |",
      "    ignore-check.kube-linter.io/host-network: x",
      "list:",
      "  - kube-linter.io/ignore-all",
      "  - ignore-check.kube-linter.io/host-pid: x",
    );
    expect(findMarkers(text, ["kube-linter"]).map((m) => [m.line, m.name])).toEqual([
      [6, "ignore-check.kube-linter.io annotation"],
      [7, "kube-linter.io/ignore-all annotation"],
      [8, "ignore-check.kube-linter.io annotation"],
      [12, "kube-linter.io/ignore-all annotation"],
      [18, "ignore-check.kube-linter.io annotation"],
    ]);
  });
});

describe("lines and names", () => {
  it("counts lines in a file with CRLF line ends (6)", () => {
    const text = "import os\r\nx = 1  # noqa\r\ny = 2 # nosec\r\n";
    expect(findMarkers(text, ["ruff", "bandit"]).map((m) => [m.scanner, m.line])).toEqual([
      ["ruff", 2],
      ["bandit", 3],
    ]);
  });

  it("a scanner with no inline marker reports none (7)", () => {
    const text = src("# nosec # noqa nosemgrep gitleaks:allow", "-- nosemgrep");
    for (const scanner of ["actionlint", "brakeman", "osv-scanner", "sqllint", "kubeconform", "cargo-deny"] as const) {
      expect(findMarkers(text, [scanner]), scanner).toEqual([]);
    }
  });

  it("names the marker only, never the rest of the line (8)", () => {
    const key = `sk_live_${"a1b2c3d4".repeat(3)}`;
    const text = src(`KEY = "${key}"  # gitleaks:allow nosemgrep # nosec ${key} # noqa: ${key}`);
    const found = findMarkers(text, ["gitleaks", "semgrep", "bandit", "ruff"]);
    expect(found.map((m) => [m.scanner, m.name])).toEqual([
      ["gitleaks", "gitleaks:allow"],
      ["semgrep", "nosemgrep"],
      ["bandit", "# nosec"],
      ["ruff", "# noqa"],
    ]);
    for (const m of found) expect(m.name).not.toContain(key);
  });
});

// zizmor, squawk and SQLFluff. Each case was run through the scanner at its
// pinned version: zizmor 1.30.1, squawk 2.66.0, sqlfluff 4.3.0.
// Failure list, written before the code:
//  Z1. A zizmor marker zizmor obeys is missed: it reads `# zizmor:
//      ignore[...]` from the first `#` of each line of a finding's span, so
//      for its line-read audits (unredacted-secrets, obfuscation and others)
//      the marker counts inside a `run: |` body and a quoted value too.
//  Z2. A form zizmor rejects is raised: no blank after the `#` or the colon.
//  S1. A squawk marker inside a string is raised: '...' with '' for a
//      quote, E'...' with backslash escapes, a $$ or $tag$ body, a "quoted
//      identifier". squawk's lexer reads each of them as one token.
//  S2. A real comment is missed after a string that holds a comment opener
//      or a backslash: in a plain string a backslash is a character, so
//      'a\' ends there and what follows is code.
//  S3. Block comments nest in Postgres: a `--` inside `/* /* */ */` is part
//      of the comment, and a comment after the outer close is real.
//  S4. `$1` (a parameter) or `a$b$` (an identifier) is taken for a dollar
//      quote and swallows a later comment.
//  S5. A marker squawk reads is missed: `--squawk-ignore` with no blank, a
//      `/* */` comment, `squawk-ignore-file`, a trailing `-- note`, and
//      `squawk-disable-assume-in-transaction`, which changes what squawk
//      reports for the whole file; or one it rejects is raised: text before
//      the marker, upper case.
//  S6. An opener left open at the end of the file (a string, a dollar quote,
//      a quoted identifier, a block comment) hides every marker after it.
//  S7. Many unclosed openers, many distinct dollar tags or deep block
//      comments take more than linear time.
//  F1. A SQLFluff marker is missed. SQLFluff reads `noqa` at the start of a
//      comment or after its last `--`, in `--`, `/* */` and, in dialects such
//      as ansi and mysql, `#` comments; which strings and comments exist
//      depends on the repo's dialect, so the marker counts anywhere on the
//      line.
//  F2. A form SQLFluff rejects is raised: text between the opener and
//      `noqa`, upper case.
describe("zizmor, # zizmor: ignore[...] anywhere on the line", () => {
  it("finds it in a comment, a block scalar body and a quoted value, as zizmor obeys it there (Z1)", () => {
    const text = src(
      "on: push",
      "jobs:",
      "  a:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: echo ${{ github.event.issue.title }} # zizmor: ignore[template-injection]",
      "      - run: |",
      "          echo ${{ fromJSON(secrets.CREDS).password }} # zizmor: ignore[unredacted-secrets]",
      "      - run: 'echo ${{ fromJSON(secrets.CREDS).password }} # zizmor: ignore[unredacted-secrets] done'",
      "      - run: echo hi # why # zizmor: ignore[template-injection]",
    );
    expect(findMarkers(text, ["zizmor"]).map((m) => [m.line, m.name])).toEqual([
      [6, "# zizmor: ignore[...]"],
      [8, "# zizmor: ignore[...]"],
      [9, "# zizmor: ignore[...]"],
      [10, "# zizmor: ignore[...]"],
    ]);
  });

  it("raises nothing for the forms zizmor rejects (Z2)", () => {
    const text = src(
      "      - run: echo a # zizmor:ignore[template-injection]",
      "      - run: echo b #zizmor: ignore[template-injection]",
      "      - run: echo c #  zizmor: ignore[template-injection]",
      "      - run: echo d # zizmor: ignore template-injection",
    );
    expect(findMarkers(text, ["zizmor"])).toEqual([]);
  });
});

describe("squawk, -- squawk-ignore at the start of a SQL comment", () => {
  const IGNORE = "squawk-ignore require-concurrent-index-creation";
  const at = (text: string) => findMarkers(text, ["squawk"]).map((m) => [m.line, m.name]);

  it("finds the forms squawk obeys and none it rejects (S5)", () => {
    const text = src(
      `-- ${IGNORE}`,
      `CREATE INDEX idx ON t (c); -- ${IGNORE}`,
      `--${IGNORE}`,
      `/* ${IGNORE} */`,
      `-- ${IGNORE} -- why`,
      "-- squawk-ignore-file require-concurrent-index-creation",
      "-- squawk-disable-assume-in-transaction",
      "/*",
      `  ${IGNORE}`,
      "*/",
      `-- note ${IGNORE}`,
      `-- SQUAWK-IGNORE require-concurrent-index-creation`,
    );
    expect(at(text)).toEqual([
      [1, "-- squawk-ignore"],
      [2, "-- squawk-ignore"],
      [3, "-- squawk-ignore"],
      [4, "-- squawk-ignore"],
      [5, "-- squawk-ignore"],
      [6, "-- squawk-ignore-file"],
      [7, "-- squawk-disable-assume-in-transaction"],
      [9, "-- squawk-ignore"],
    ]);
  });

  it("never in a string, an escape string, a dollar quote or a quoted identifier (S1)", () => {
    const text = src(
      `SELECT '-- ${IGNORE}';`,
      `SELECT 'it''s -- ${IGNORE}';`,
      `SELECT E'it\\'s -- ${IGNORE}';`,
      "SELECT $$",
      `-- ${IGNORE}`,
      "$$;",
      "SELECT $fn$ x $f$",
      `-- ${IGNORE}`,
      "$fn$;",
      'SELECT "a',
      `-- ${IGNORE}`,
      '";',
      `SELECT x FROM t; -- ${IGNORE}`,
    );
    expect(at(text)).toEqual([[13, "-- squawk-ignore"]]);
  });

  it("reads a comment after a plain string that ends in a backslash or holds a comment opener (S2)", () => {
    const text = src(`SELECT 'a\\' -- ${IGNORE}`, `SELECT '/*', '--' -- ${IGNORE}`, `SELECT e'a\\\\' -- ${IGNORE}`);
    expect(at(text).map(([line]) => line)).toEqual([1, 2, 3]);
  });

  it("reads nested block comments as one comment (S3)", () => {
    const text = src("/* a /* b */", `-- ${IGNORE}`, `*/ SELECT 1; -- ${IGNORE}`, `/* a /* b */ c */ -- ${IGNORE}`);
    expect(at(text).map(([line]) => line)).toEqual([3, 4]);
  });

  it("never takes a parameter or an identifier with $ for a dollar quote (S4)", () => {
    const text = src(`SELECT $1 -- ${IGNORE}`, `SELECT a$b$ -- ${IGNORE}`, `SELECT a$$ -- ${IGNORE}`);
    expect(at(text).map(([line]) => line)).toEqual([1, 2, 3]);
  });

  it("reads an opener left open at the end of the file as code (S6)", () => {
    for (const opener of ["'", "E'", "$$", "$x$", '"', "/*"]) {
      expect(at(src(`SELECT ${opener}`, `-- ${IGNORE}`)), opener).toEqual([[2, "-- squawk-ignore"]]);
    }
  });

  it("counts lines in a file with CRLF line ends", () => {
    expect(at(`SELECT 1;\r\n-- ${IGNORE}\r\n`)).toEqual([[2, "-- squawk-ignore"]]);
  });
});

describe("SQLFluff, noqa anywhere on the line", () => {
  const at = (text: string) => findMarkers(text, ["sqlfluff"]).map((m) => m.line);

  it("finds the forms SQLFluff obeys in every dialect (F1)", () => {
    const q = "SELECT id FROM users WHERE x = NULL;";
    const text = src(
      `${q} -- noqa`,
      `${q} -- noqa: CV05`,
      `${q} --noqa`,
      `${q} /* noqa */`,
      `${q} -- why -- noqa: CV05`,
      "-- noqa: disable=CV05",
      "/* noqa: enable=all */",
      `${q} # noqa`,
      "/*",
      "noqa: disable=all */",
    );
    expect(at(text)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 10]);
  });

  it("raises nothing for the forms SQLFluff rejects (F2)", () => {
    expect(at(src("SELECT 1; -- this noqa", "SELECT 1; -- NOQA", "SELECT 1; -- no qa"))).toEqual([]);
  });

  // F3. An inline setting is missed, or one SQLFluff ignores is raised. A
  // line that starts with `-- sqlfluff:` or `--sqlfluff:`, then a key and a
  // value parted by a colon, sets SQLFluff's settings for the file
  // (core/config/fluffconfig.py, process_raw_file_for_config and
  // process_inline_config). Lines are split as Python's splitlines splits
  // them. Each form below was run through SQLFluff 4.3.0 on a `= NULL`
  // comparison: the first group hid or downgraded CV05, the second did not.
  it("finds an inline setting exactly where SQLFluff obeys one (F3)", () => {
    const obeyed = [
      "-- sqlfluff:ignore:linting",
      "--sqlfluff:exclude_rules:CV05",
      "-- sqlfluff: exclude_rules : CV05",
      "-- sqlfluff:warnings:CV05",
      "SELECT 1;\r-- sqlfluff:exclude_rules:CV05",
      "SELECT 1; -- sqlfluff:exclude_rules:CV05",
      "SELECT 1;\v-- sqlfluff:exclude_rules:CV05",
    ];
    const ignored = [
      "-- SQLFLUFF:exclude_rules:CV05",
      "-- sqlfluff :exclude_rules:CV05",
      "--  sqlfluff:exclude_rules:CV05",
      "--\tsqlfluff:exclude_rules:CV05",
      "SELECT 1; -- sqlfluff:exclude_rules:CV05",
      "/* sqlfluff:exclude_rules:CV05 */",
      "  -- sqlfluff:exclude_rules:CV05",
      "-- sqlfluff:ignore",
    ];
    for (const line of obeyed) expect(findMarkers(src(line), ["sqlfluff"]).map((m) => m.name), line).toEqual(["-- sqlfluff:"]);
    for (const line of ignored) expect(findMarkers(src(line), ["sqlfluff"]), line).toEqual([]);
  });
});

// A UTF-8 byte order mark at the start of a file is read by the scanners as
// no text at all (SQLFluff, Python's tools, the YAML and HCL parsers), so a
// marker on the first line counts as if it were not there. One marker per
// reader family, on the first line after a mark.
describe("a byte order mark hides no marker on the first line", () => {
  const BOM = "﻿";
  const cases: [BuiltinScanner, string][] = [
    ["sqlfluff", "-- sqlfluff:ignore:linting\nSELECT 1;\n"],
    ["semgrep", "x = 1  # nosemgrep\n"],
    ["ruff", "# ruff: noqa\nimport os\n"],
    ["shellcheck", "# shellcheck disable=SC2086\necho $1\n"],
    ["hadolint", "# hadolint ignore=DL3007\nFROM python:latest\n"],
    ["golangci", "//nolint:all\npackage main\n"],
    ["rubocop", "# rubocop:disable all\nx = 1\n"],
    ["oxlint", "// oxlint-disable\nvar x = 1;\n"],
    ["squawk", "-- squawk-ignore-file\nCREATE INDEX i ON t (c);\n"],
    ["tflint", "# tflint-ignore: terraform_unused_declarations\nvariable \"x\" {}\n"],
    ["kube-linter", "metadata:\n  annotations:\n    kube-linter.io/ignore-all: \"x\"\n"],
  ];
  for (const [scanner, text] of cases) {
    it(`${scanner} on a file that starts with a byte order mark`, () => {
      const plain = findMarkers(text, [scanner]).map((m) => [m.line, m.name]);
      expect(plain.length, "the marker is found without the mark").toBeGreaterThan(0);
      expect(findMarkers(`${BOM}${text}`, [scanner]).map((m) => [m.line, m.name])).toEqual(plain);
    });
  }
});

describe("linear time on hostile SQL (S7)", () => {
  const MB = 1024 * 1024;
  const fill = (unit: (k: number) => string) => {
    const parts: string[] = [];
    let size = 0;
    for (let k = 0; size < MB; k++) {
      const part = unit(k);
      parts.push(part);
      size += part.length;
    }
    return parts.join("");
  };
  const cases: [string, string][] = [
    ["many unclosed openers of each kind", fill((k) => [`a = '${k}\n`, `b = E'${k}\n`, `c = "${k}\n`, `/* ${k}\n`, `d = $$${k}\n`][k % 5] as string)],
    ["many distinct dollar tags left open", fill((k) => `SELECT $t${k}$ x\n`)],
    ["many dollar tags, each closed by a later one", fill((k) => `$a${k}$ $a${k + 1}$\n`)],
    ["deep nesting of block comments", fill(() => "/* ")],
    ["one very long line", `SELECT ${fill(() => "'a' || $$b$$ || ")}1; -- squawk-ignore x\n`],
  ];
  for (const [what, text] of cases) {
    it(`squawk: ${what}`, () => {
      const started = performance.now();
      findMarkers(text, ["squawk"]);
      expect(performance.now() - started).toBeLessThan(1000);
    });
  }
});

// A search for a closer that reaches the end of the file is not made again
// from a later opener of its kind (comments.ts, the second rule). Without
// that rule each opener left open searches the rest of the file, and the
// characters searched grow with the square of the file: at 64 KB these
// inputs then cover 150 to 1,200 times the file, and at 256 KB 2,100 to
// 4,600 times. With it they cover 1 to 2.4 times the file at any size. The
// count is of characters, not time, so a busy machine cannot move it
// (issue 296: the timing ratio failed on a loaded runner). Each input leaves
// open, many times over, the openers of its language that have no closer
// after them; a quote opened again only closes the one before.
describe("many openers left open: each kind is searched to the end of the file once (16)", () => {
  const SIZE = 64 * 1024;
  const fill = (unit: (k: number) => string): string => {
    const parts: string[] = [];
    let length = 0;
    for (let k = 0; length < SIZE; k++) {
      const part = unit(k);
      parts.push(part);
      length += part.length;
    }
    return parts.join("");
  };
  const cases: [BuiltinScanner, (k: number) => string][] = [
    ["bandit", (k) => [`a = '''${k}\n`, `b = """${k}\n`, `c = f'''{${k}\n`, `d = f"{e:${k}\n`, `g = '${k}\n`][k % 5] as string],
    ["rubocop", (k) => [`c = %q(${k}\n`, `=begin ${k}\n`, `a = "${k}\n`, `b = '${k}\n`, `d = "#{${k}\n`][k % 5] as string],
    ["golangci", (k) => [`a := \`${k}\n`, `/* ${k}\n`, `b := "${k}\n`][k % 3] as string],
    ["tflint", (k) => [`a = "${k}\n`, `/* ${k}\n`, `b = "\${${k}\n`, `c = <<E${k}\n`, `d = "%{${k}\n`][k % 5] as string],
  ];
  for (const [scanner, unit] of cases) {
    it(`${scanner}: the searches cover at most four times the file`, () => {
      const family = SUPPRESSION_MARKERS[scanner]?.family;
      if (family === undefined || family === "line" || family === "yaml-keys") throw new Error(`${scanner} has no comment reader`);
      const text = fill(unit);
      expect(closerSearchSpan(text, family) / text.length).toBeLessThan(4);
    });
  }
});
