// Prints a markdown table of line, branch, function and statement coverage,
// overall and per package, from coverage/coverage-summary.json (written by
// pnpm test:coverage). Usage: node scripts/coverage-summary.mjs [summary.json]
import { readFileSync } from "node:fs";
import { relative } from "node:path";

const path = process.argv[2] ?? "coverage/coverage-summary.json";
const summary = JSON.parse(readFileSync(path, "utf8"));
const root = process.cwd();
const KEYS = ["lines", "branches", "functions", "statements"];

// The group is the package for packages/<name>/src, else benchmark.
const groupOf = (name) => {
  const parts = relative(root, name).split("/");
  return parts[0] === "packages" ? parts[1] : parts[0];
};
const empty = () => Object.fromEntries(KEYS.map((key) => [key, { covered: 0, total: 0 }]));
const groups = new Map();
for (const [name, counts] of Object.entries(summary)) {
  if (name === "total") continue;
  const group = groups.get(groupOf(name)) ?? { files: 0, ...empty() };
  group.files += 1;
  for (const key of KEYS) {
    group[key].covered += counts[key].covered;
    group[key].total += counts[key].total;
  }
  groups.set(groupOf(name), group);
}

const pct = ({ covered, total }) => (total === 0 ? "n/a" : `${((100 * covered) / total).toFixed(2)}`);
const row = (name, files, counts) => `| ${name} | ${files} | ${KEYS.map((key) => pct(counts[key])).join(" | ")} |`;
const lines = [
  "| Scope | Files | Lines % | Branches % | Functions % | Statements % |",
  "| --- | --- | --- | --- | --- | --- |",
  row("overall", Object.keys(summary).length - 1, summary.total),
  ...[...groups.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([name, group]) => row(name, group.files, group)),
];
console.log(lines.join("\n"));
