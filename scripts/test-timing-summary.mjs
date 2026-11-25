// Prints a markdown summary of one unit run from vitest's JSON report:
// files, cases, wall time, summed file time, the ten slowest files and the
// summed time per package. Every timing comparison uses this one computation.
// Usage: node scripts/test-timing-summary.mjs <report.json>
import { readFileSync } from "node:fs";
import { relative } from "node:path";

const path = process.argv[2];
if (!path) {
  console.error("usage: node scripts/test-timing-summary.mjs <report.json>");
  process.exit(2);
}
const report = JSON.parse(readFileSync(path, "utf8"));
const root = process.cwd();

// A file's time is its end minus its start, as vitest recorded them.
const files = report.testResults.map((file) => ({
  name: relative(root, file.name),
  seconds: (file.endTime - file.startTime) / 1000,
  status: file.status,
}));
const ends = report.testResults.map((file) => file.endTime);
const wall = ends.length > 0 ? (Math.max(...ends) - report.startTime) / 1000 : 0;
const summed = files.reduce((total, file) => total + file.seconds, 0);

// The group is the package for packages/<name>/, else the top folder.
const groupOf = (name) => {
  const parts = name.split("/");
  return parts[0] === "packages" ? parts[1] : parts[0];
};
const groups = new Map();
for (const file of files) {
  const group = groups.get(groupOf(file.name)) ?? { files: 0, seconds: 0 };
  group.files += 1;
  group.seconds += file.seconds;
  groups.set(groupOf(file.name), group);
}

const s = (seconds) => seconds.toFixed(1);
const lines = [
  "| Measure | Value |",
  "| --- | --- |",
  `| Files | ${files.length} |`,
  `| Cases | ${report.numTotalTests} |`,
  `| Passed | ${report.numPassedTests} |`,
  `| Failed | ${report.numFailedTests} |`,
  `| Skipped or todo | ${report.numPendingTests + report.numTodoTests} |`,
  `| Wall time (s) | ${s(wall)} |`,
  `| Summed file time (s) | ${s(summed)} |`,
  "",
  "| Slowest files | Seconds |",
  "| --- | --- |",
  ...[...files]
    .sort((a, b) => b.seconds - a.seconds)
    .slice(0, 10)
    .map((file) => `| ${file.name} | ${s(file.seconds)} |`),
  "",
  "| Package | Files | Summed seconds |",
  "| --- | --- | --- |",
  ...[...groups.entries()]
    .sort((a, b) => b[1].seconds - a[1].seconds)
    .map(([name, group]) => `| ${name} | ${group.files} | ${s(group.seconds)} |`),
];
const failed = files.filter((file) => file.status === "failed");
if (failed.length > 0) lines.push("", "Failed files:", ...failed.map((file) => `- ${file.name}`));
console.log(lines.join("\n"));
