// The inline suppression comments each built-in scanner obeys, and where it
// obeys them. A change that adds one makes that scanner report nothing on
// the line, so the runner raises the comment itself as a candidate.
//
// Each entry follows the scanner's documentation and its source at the
// pinned version, and was run through the scanner itself for all but rubocop
// and golangci-lint, which need Ruby and Go. Where the two disagree, the
// entry follows what the scanner does. docs/scanners.md lists the sources.
// actionlint, brakeman, osv-scanner, sqllint, kubeconform and cargo-deny
// have no inline marker: actionlint and brakeman read only their settings or
// ignore files, osv-scanner its osv-scanner.toml, cargo-deny only the config
// OpenQodex writes for it, and sqllint and kubeconform have none.

import type { BuiltinScanner } from "@openqodex/core";
import { comments } from "./comments.js";
import { yamlKeys } from "./yaml-keys.js";
import type { Comment, Family } from "./comments.js";

type Marker = {
  // The marker as the scanner writes it. `{kw}` is replaced by the match's
  // `kw` group, which only ever holds one of a fixed set of words, so the name
  // never carries text from the line.
  name: string;
  // Tested on each comment's text from its opener, or on each line for the
  // "line" family. Group `at` is where the marker starts, for its line.
  pattern: RegExp;
  // Only a comment with nothing but blanks before it on its line.
  ownLine?: true;
  // Only a comment that starts before the end of the line holding the Go
  // package clause: golangci-lint reads no comment after it for this marker.
  header?: true;
  // The unit this marker is read in when it differs from its scanner's
  // family: Checkov reads its skip comment in Terraform and its skip
  // annotation as YAML.
  family?: Unit;
};

// "line": the scanner obeys the marker anywhere on the line, in a comment,
// a string or code alike. "yaml-keys": the scanner obeys it as a key of a
// YAML or JSON mapping, such as an object's annotations, in any style
// (yaml-keys.ts): the pattern is tested on each key as the scanner decodes
// it, and a hit counts on the key's line, or on the line of an alias that
// brings the key in. A file the parser cannot read, or one too large, is
// tested line by line instead, so the reading is never narrower than the
// scanner's. A "yaml-keys" pattern must not be anchored to the start: in
// that fallback a unit is a whole line.
type Unit = Family | "line" | "yaml-keys";
type Entry = { family: Unit; markers: Marker[] };

export const SUPPRESSION_MARKERS: Partial<Record<BuiltinScanner, Entry>> = {
  // nosem or nosemgrep in any case, anywhere on the line or on the line
  // before a match. Its documentation asks for a comment; semgrep 1.94.0
  // obeys the text inside a string too, but only after a space. The space is
  // not required here, so a version that drops it is still covered.
  semgrep: { family: "line", markers: [{ name: "nosemgrep", pattern: /(?<at>nosem)/dgi }] },
  // gitleaks:allow anywhere on the lines of a match, case-sensitive (detect/detect.go).
  gitleaks: { family: "line", markers: [{ name: "gitleaks:allow", pattern: /(?<at>gitleaks:allow)/dg }] },
  // A Python comment holding #, blanks, nosec (bandit/core/manager.py, NOSEC_COMMENT).
  // Any word after it, test id or not, still silences the line.
  bandit: { family: "python", markers: [{ name: "# nosec", pattern: /(?<at>#\s*nosec)/dg }] },
  // # noqa in any case anywhere in a comment; # ruff: noqa and # flake8: noqa
  // on their own line exempt the file (crates/ruff_linter/src/noqa.rs). The
  // isort action comments switch off the import-sorting rule: a comment
  // holding `isort: skip` or `isort:skip`, and `# isort: off` with or
  // without `ruff:` (crates/ruff_linter/src/directives.rs). ruff 0.17 also
  // obeys `# ruff: ignore[CODES]` (the end of a line or a line of its own),
  // and `# ruff: disable[CODES]` and `# ruff: file-ignore[CODES]` only on a
  // line of their own (measured with 0.17.5; each needs a bracketed code
  // list and a comment that starts at the `#`).
  ruff: {
    family: "python",
    markers: [
      { name: "# noqa", pattern: /(?<at>#\s*noqa)/dgi },
      { name: "# {kw}: noqa", pattern: /^(?<at>#\s*(?<kw>flake8|ruff)\s*:\s*[nN][oO][qQ][aA])/dg, ownLine: true },
      { name: "# ruff: {kw}", pattern: /^(?<at>#\s*ruff\s*:\s*(?<kw>ignore))\s*\[/dg },
      { name: "# ruff: {kw}", pattern: /^(?<at>#\s*ruff\s*:\s*(?<kw>disable|file-ignore))\s*\[/dg, ownLine: true },
      { name: "# isort: {kw}", pattern: /(?<at>isort: ?(?<kw>skip_file|skip))/dg },
      { name: "# isort: off", pattern: /^(?<at>#\s*(?:ruff:\s*)?isort:\s*off)\s*$/dg },
    ],
  },
  // A comment `# shellcheck` then a blank, with a disable= key, or
  // extended-analysis=false, among its keys (src/ShellCheck/Parser.hs,
  // readAnnotation). shellcheck needs no blank between keys
  // (`source='x'disable=1`), so any `disable=` after the prefix counts: a
  // superset of what it obeys, found in one pass with no nested repetition.
  shellcheck: {
    family: "shell",
    markers: [
      { name: "# shellcheck disable=", pattern: /^(?<at>#[ \t]*shellcheck)[ \t][^\n]*?disable=/dg },
      { name: "# shellcheck extended-analysis=false", pattern: /^(?<at>#[ \t]*shellcheck)[ \t][^\n]*?extended-analysis=["']?false/dg },
    ],
  },
  // A comment line `# hadolint ignore=`, `# hadolint global ignore=` or
  // `# hadolint stage ignore=` with a rule list (src/Hadolint/Pragma.hs).
  hadolint: {
    family: "dockerfile",
    markers: [{ name: "# hadolint {kw}ignore=", pattern: /^(?<at>#[ \t]*hadolint)[ \t]+(?<kw>(?:global|stage)[ \t]+)?ignore[ \t]*=[ \t]*[DLSC0-9]/dg }],
  },
  // golangci-lint: a // comment that reads nolint after its slashes and
  // spaces, then a space, a colon or its end
  // (pkg/result/processors/nolint_filter.go). A comment before the package
  // clause that says "code generated", "do not edit", "autogenerated file"
  // or "generated by: swagger codegen", in any case, makes it skip the whole
  // file (exclusion_generated_file_matcher.go, lax mode, the default). gosec,
  // which it runs: #nosec at the start of a comment line, and
  // //gosec:disable (analyzer.go).
  golangci: {
    family: "go",
    markers: [
      { name: "//nolint", pattern: /^(?<at>\/\/[/ ]*nolint)(?:[ :]|$)/dg },
      { name: "a generated-file comment", pattern: /(?<at>code generated|do not edit|autogenerated file|\* generated by: swagger codegen )/dgi, header: true },
      { name: "#nosec", pattern: /(?:^\/\/[ \t]*|^\/\*\s*|\n[ \t]*)(?<at>#nosec)/dg },
      { name: "//gosec:disable", pattern: /^(?<at>\/\/gosec:disable)(?: |$)/dg },
    ],
  },
  // A Ruby comment holding # rubocop:disable or # rubocop:todo and a cop
  // name or all (lib/rubocop/directive_comment.rb).
  rubocop: {
    family: "ruby",
    markers: [{ name: "# rubocop:{kw}", pattern: /(?<at>#\s*rubocop\s*:\s*(?<kw>disable|todo))\b\s*(?:all|[A-Z]\w+)/dg }],
  },
  // A // or /* */ comment that starts, after blanks, with eslint-disable or
  // oxlint-disable, -line or -next-line, then a blank or its end
  // (crates/oxc_linter/src/disable_directives.rs).
  oxlint: {
    family: "js",
    markers: [{ name: "{kw}", pattern: /^\/[/*]\s*(?<at>(?<kw>(?:eslint|oxlint)-disable(?:-next-line|-line)?))(?=\s|\*\/|$)/dg }],
  },
  // `# zizmor: ignore[` with one blank after the `#` and the colon
  // (IGNORE_EXPR in crates/zizmor/src/finding/location.rs). Anywhere on the
  // line: for the audits that locate a finding by its raw span
  // (unredacted-secrets, obfuscation and four more), zizmor reads each line
  // from its first `#`, so 1.30.1 obeys the marker inside a `run: |` body and
  // a quoted value too. The closing `]` and what follows it are not checked,
  // so this is wider than zizmor, never narrower.
  zizmor: { family: "line", markers: [{ name: "# zizmor: ignore[...]", pattern: /(?<at># zizmor: ignore\[)/dg }] },
  // A `--` or `/* */` comment whose text starts, after blanks, with
  // squawk-ignore or squawk-ignore-file (crates/squawk_linter/src/ignore.rs,
  // ignore_rule_info), or with squawk-disable-assume-in-transaction, which
  // changes what squawk reports for the whole file. Case-sensitive. A bare
  // `squawk-ignore` with no rule silences nothing in 2.66.0; it still counts.
  squawk: {
    family: "sql",
    markers: [
      { name: "-- {kw}", pattern: /^(?:--|\/\*)\s*(?<at>(?<kw>squawk-ignore(?:-file)?))/dg },
      { name: "-- squawk-disable-assume-in-transaction", pattern: /^(?:--|\/\*)\s*(?<at>squawk-disable-assume-in-transaction)/dg },
    ],
  },
  // SQLFluff reads `noqa` at the start of a comment, or after the comment's
  // last `--` (sqlfluff/core/rules/noqa.py, _parse_noqa), lower case only.
  // Which text is a comment depends on the dialect the repo names: `#`
  // starts one in ansi and mysql, not in postgres, and strings differ too.
  // So the marker counts anywhere on the line after `--`, `#` or `/*`, and
  // at the start of a line, for a block comment whose `noqa` is on the line
  // after its opener: wider than SQLFluff in every dialect. A line that
  // starts with `-- sqlfluff` or `--sqlfluff` sets SQLFluff's settings for
  // the file (core/config/fluffconfig.py, process_raw_file_for_config):
  // `ignore:linting`, `exclude_rules`, `rules`, `warnings` or the dialect can
  // hide or downgrade what it reports, so each one counts. Exactly as
  // SQLFluff reads one: `--` and at most one space at the very start of the
  // line, then `sqlfluff:`, then a key and a value parted by a colon
  // (process_inline_config); any other spacing, case, opener or a key with
  // no value is ignored, as checked through the 4.3.0 binary. SQLFluff
  // splits lines as Python's splitlines does: a carriage return, a vertical
  // tab, a form feed, \x1c to \x1e, \x85 and the Unicode line and
  // paragraph separators start a line too.
  sqlfluff: {
    family: "line",
    markers: [
      { name: "-- noqa", pattern: /(?:--|#|\/\*)[ \t]*(?<at>noqa)/dg },
      { name: "-- noqa", pattern: /^[ \t]*(?<at>noqa)/dg },
      // The control characters are Python's line breaks, matched on purpose.
      // oxlint-disable-next-line no-control-regex
      { name: "-- sqlfluff:", pattern: /(?:^|[\r\v\f\x1c-\x1e\x85\u2028\u2029])(?<at>-- ?sqlfluff:)(?=[^\n\r\v\f\x1c-\x1e\x85\u2028\u2029]*:)/dg },
    ],
  },
  // trivy reads every line of a Terraform file (.tf and .tf.json) and of a
  // CloudFormation YAML template as raw text, a string included: a word of
  // the line (split at blanks) that, once its leading #, / and * are cut,
  // starts with trivy: or tfsec: and holds an ignore: section
  // (pkg/iac/ignore/parse.go). trivy 0.75.0 obeys none in Kubernetes YAML or
  // CloudFormation JSON, where this still counts one.
  trivy: {
    family: "line",
    markers: [{ name: "{kw}:ignore", pattern: /(?:^|[ \t])[#/*]*(?<at>(?<kw>trivy|tfsec):[^ \t]*?ignore:[^ \t])/dg }],
  },
  // checkov reads the lines of a Terraform resource and of a CloudFormation
  // resource as raw text, a comment of any style or a string alike, for
  // checkov:skip=, bridgecrew:skip= or cortex:skip=
  // (checkov/common/comment/enum.py, COMMENT_REGEX). It reads a Kubernetes
  // object's annotation keys that hold checkov.io/skip, bridgecrew.io/skip or
  // cortex.io/skip (checkov/kubernetes/kubernetes_utils.py), and a
  // CloudFormation resource's Metadata keys checkov and bridgecrew with a skip
  // list (checkov/cloudformation/context_parser.py), both as keys of YAML or
  // JSON. The Metadata key counts wherever a key is checkov or bridgecrew.
  checkov: {
    family: "line",
    markers: [
      { name: "{kw}:skip=", pattern: /(?<at>(?<kw>checkov|bridgecrew|cortex):skip=)/dg },
      { name: "{kw}.io/skip annotation", pattern: /(?<at>(?<kw>checkov|bridgecrew|cortex)\.io\/skip)/dg, family: "yaml-keys" },
      // In a file the parser cannot read (Terraform), the raw lines: a skip
      // comment there is already counted by the first marker.
      { name: "Metadata {kw} key", pattern: /(?<![\w./-])(?<at>(?<kw>checkov|bridgecrew))(?![\w./-]|:skip=)/dg, family: "yaml-keys" },
    ],
  },
  // tflint: `tflint-ignore: ` or `tflint-ignore-file: ` then a rule list, in
  // an HCL comment (tflint/annotation.go, lineAnnotationPattern and
  // fileAnnotationPattern). tflint obeys the file form only at the very start
  // of a file, and in a .tf.json file only as the start of the root "//"
  // key's value; it counts here anywhere in a comment or at the start of any
  // string.
  tflint: {
    family: "hcl",
    markers: [
      { name: "tflint-ignore{kw}:", pattern: /(?<at>tflint-ignore(?<kw>-file)?: )[^\n*/#]/dg },
      { name: 'tflint-ignore-file: in a JSON "//" value', pattern: /"(?<at>tflint-ignore-file: )[^\n*/#"]/dg, family: "line" },
    ],
  },
  // An object annotation whose key is ignore-check.kube-linter.io/<check> or
  // kube-linter.io/ignore-all (pkg/ignore/ignore.go, read from the object's
  // metadata.annotations as the Kubernetes YAML decoder gives them, aliases
  // and merge keys resolved). Any key holding the text counts, at any depth:
  // wider than kube-linter, never narrower.
  "kube-linter": {
    family: "yaml-keys",
    markers: [
      { name: "ignore-check.kube-linter.io annotation", pattern: /(?<at>ignore-check\.kube-linter\.io\/)/dg },
      { name: "kube-linter.io/ignore-all annotation", pattern: /(?<at>kube-linter\.io\/ignore-all)/dg },
    ],
  },
};

export type MarkerHit = { scanner: BuiltinScanner; line: number; name: string };

// Every suppression marker in `text` that one of `scanners` obeys, with its
// 1-based line, in line order. Each family's comments are found once.
export function findMarkers(file: string, scanners: readonly BuiltinScanner[]): MarkerHit[] {
  // A UTF-8 byte order mark first is no text to the scanners (SQLFluff,
  // Python's tools, the YAML and HCL parsers read past it), so it is no text
  // here either: a marker at the start of the first line still counts. It
  // holds no line end, so every line keeps its number.
  const text = file.charCodeAt(0) === 0xfeff ? file.slice(1) : file;
  const starts = [0];
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  const lineOf = (offset: number): number => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((starts[mid] as number) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  const units = new Map<Unit, Comment[]>();
  // True when the "yaml-keys" units are keys, so a hit counts on the key's
  // line whatever the key's escapes made of its offsets.
  let keyUnits = false;
  const unitsOf = (family: Unit): Comment[] => {
    let found = units.get(family);
    if (found === undefined) {
      if (family === "line") {
        found = starts.map((start) => lineAt(text, start));
      } else if (family === "yaml-keys") {
        const read = yamlKeys(text);
        found = read.units;
        keyUnits = read.keys;
      } else {
        found = comments(text, family);
      }
      units.set(family, found);
    }
    return found;
  };

  // The end of the line holding the first Go `package` clause outside a
  // comment; the whole file when there is none. The comments are in file
  // order, so one pointer walks them beside the package lines.
  let headerEnd: number | null = null;
  const pastHeader = (unit: Comment): boolean => {
    if (headerEnd === null) {
      headerEnd = text.length;
      const spans = unitsOf("go");
      let k = 0;
      for (const m of text.matchAll(/^[ \t]*package\b/gm)) {
        const at = m.index + m[0].length - "package".length;
        while (k < spans.length && (spans[k] as Comment).start + (spans[k] as Comment).text.length <= at) k++;
        const span = spans[k];
        if (span !== undefined && span.start <= at) continue;
        const end = text.indexOf("\n", at);
        headerEnd = end < 0 ? text.length : end;
        break;
      }
    }
    return unit.start >= headerEnd;
  };

  const hits: MarkerHit[] = [];
  const seen = new Set<string>();
  for (const scanner of scanners) {
    const entry = SUPPRESSION_MARKERS[scanner];
    if (entry === undefined) continue;
    for (const marker of entry.markers) {
      const family = marker.family ?? entry.family;
      for (const unit of unitsOf(family)) {
        if (marker.ownLine && text.slice(starts[lineOf(unit.start) - 1], unit.start).trim() !== "") continue;
        if (marker.header && pastHeader(unit)) continue;
        for (const m of unit.text.matchAll(marker.pattern)) {
          const at = m.indices?.groups?.at?.[0] ?? m.index;
          const line = family === "yaml-keys" && keyUnits ? lineOf(unit.start) : lineOf(unit.start + at);
          const name = marker.name.replace("{kw}", (m.groups?.kw ?? "").replace(/\s+/g, " "));
          const key = `${scanner}\0${line}\0${name}`;
          if (seen.has(key)) continue;
          seen.add(key);
          hits.push({ scanner, line, name });
        }
      }
    }
  }
  return hits.sort((a, b) => a.line - b.line);
}

function lineAt(text: string, start: number): Comment {
  const end = text.indexOf("\n", start);
  const line = text.slice(start, end < 0 ? text.length : end);
  return { start, text: line.endsWith("\r") ? line.slice(0, -1) : line };
}
