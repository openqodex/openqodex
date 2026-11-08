// Holds every version in docs/scanners.md to packages/scanners/toolchain.json
// (issue 187): the scanner table, the download table, the suppression table,
// each scanner's own section with its "- Version:" line and its links, and any
// "<tool> x.y.z" in prose. scripts/docs-facts.mjs runs it.
//
// A version is three numbers joined by dots. Each one must be a pin of a tool:
//  - the tool named right before it ("hadolint 2.15.1"), else
//  - the tool the table row is about (the first cell that names one), else
//  - the tool whose "## <name>" section holds the line.
// A tool's pins are its version, the gem versions installed with it and the
// Kubernetes version of its schemas. A version with none of these scopes, or
// one that is not a pin of its tool, is a problem, unless the line holds one
// of the phrases in NOT_PINS, versions the page names on purpose.

// Versions the page names that toolchain.json does not pin, each with why.
export const NOT_PINS = [
  // The trivy release OpenQodex refuses to pin, named in its Pin line.
  "trivy 0.69.4",
  // Part of the tflint binary, not a separate download.
  "terraform ruleset 0.15.0",
  // gosec's own source: a linter inside golangci-lint, with a version of its own.
  "securego/gosec/blob/v2.29.0",
];

// A tag such as v8.21.2 or oxlint_v1.86.0 in a link counts; a fourth number does not.
const VERSION = /(?<![\d.])\d+\.\d+\.\d+(?!\.?\d)/g;
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// `tools`: the "tools" object of toolchain.json. `names`: each tool's other
// names on the page, by toolchain key (golangci is golangci-lint there).
export function pinsOf(tools, names = {}) {
  const pins = new Map();
  for (const [key, tool] of Object.entries(tools)) {
    const set = new Set([tool.version]);
    for (const gem of tool.gems ?? []) set.add(gem.split(":")[1]);
    if (tool.schemas?.kubernetes) set.add(tool.schemas.kubernetes);
    for (const name of [key, ...(names[key] ? [names[key]] : [])]) pins.set(name.toLowerCase(), set);
  }
  return pins;
}

// Returns one problem per stale or unexplained version, as "line N: ...".
export function scannerPageVersionProblems(text, pins) {
  const problems = [];
  // Longest names first, so "golangci-lint" wins over "golangci".
  const names = [...pins.keys()].sort((a, b) => b.length - a.length);
  const before = new RegExp(`(?<![\\w-])(${names.map(escape).join("|")})\\s+$`, "i");
  let section = null;
  for (const [i, line] of text.split("\n").entries()) {
    const heading = /^## (.+?)\s*$/.exec(line);
    if (heading) {
      section = pins.has(heading[1].toLowerCase()) ? heading[1].toLowerCase() : null;
      continue;
    }
    // A table row is about the first cell that names a tool.
    const cells = line.startsWith("|") ? line.split("|").map((c) => c.trim().replace(/^`|`$/g, "").toLowerCase()) : [];
    const row = cells.find((c) => pins.has(c)) ?? null;
    for (const m of line.matchAll(VERSION)) {
      const v = m[0];
      if (NOT_PINS.some((phrase) => phrase.includes(v) && line.includes(phrase))) continue;
      const named = before.exec(line.slice(0, m.index))?.[1]?.toLowerCase() ?? null;
      const tool = named ?? row ?? section;
      if (tool === null) {
        problems.push(`line ${i + 1}: names version ${v} outside any tool's section or row; name the tool before it`);
        continue;
      }
      const set = pins.get(tool);
      if (!set.has(v)) problems.push(`line ${i + 1}: names ${tool} at ${v}; toolchain.json pins ${[...set].join(", ")}`);
    }
  }
  return problems;
}
