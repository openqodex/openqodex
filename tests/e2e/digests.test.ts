// 1. The filed JSON shapes leave pages unread or hide planted scalar errors.
// 2. A dependency store loses files between summary pages or consumes line pages.
// 3. The integration receipt must count structural summaries once C3 lands.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, expect, it } from "vitest";
import type { ReviewUnit } from "@openqodex/core";
import "./global-setup.js";
import { demo, readJson, report, reportDir, run, stagedProviderEnv, writeConfig } from "./support.js";
import { removeTempDirs } from "../temp-dirs.mjs";
import { fixDemoSecret } from "../golden/fixture-secret.mjs";

afterAll(removeTempDirs);
const flags = ["review", "--reviewer", "claude", "--skip", "semgrep,osv-scanner", "--no-color"];
function savedBriefs(out: string) {
  return readdirSync(join(out, "briefs")).filter((name) => name.startsWith("finder-")).map((name) => readFileSync(join(out, "briefs", name), "utf8"));
}
function filedJson(lines: number, plants: boolean) {
  const count = Math.floor((lines - 2) / 42);
  const label = (prefix: string, i: number) => `${prefix}-${i}-benchmark-fixture`.padEnd(64, "x");
  const records = Array.from({ length: count }, (_, i) => ({
    id: label("run", i), caseId: label("case", i % (count - 1)), caseIds: [`case-${i % (count - 1)}`],
    splitHash: label("public-split", 0), duration: 100, findDuration: 70, verifyDuration: 30,
    inputTokens: 14000, outputTokens: 2400, cachedTokens: 8000, cost: 0.42,
    verdict: "passed", findings: i === 1 ? [] : [{ caseId: `case-${i % (count - 1)}`, outcome: "passed" }],
    model: label("fixture-model", 0), provider: label("fixture-provider", 0),
    repository: label("public-repository", i), revision: label("public-revision", i),
    baseRevision: label("base-revision", i), promptHash: label("public-prompt", i),
    configHash: label("public-config", i), inputHash: label("public-input", i),
    outputHash: label("public-output", i), environment: label("fixture-environment", 0),
    suite: label("regression-suite", 0), split: label("evaluation-split", 0),
    scenario: label("review-scenario", i), artifact: label("saved-artifact", i),
    startedAt: "2026-10-01T00:00:00Z", endedAt: "2026-10-01T00:01:40Z",
    status: "complete", attempt: 1, seed: 123, exitCode: 0, errors: 0, warnings: 0,
  }));
  if (plants) {
    records[7]!.splitHash = "wrong-split";
    records[19]!.duration = -1;
    delete (records[42] as Partial<(typeof records)[number]>)!.caseIds;
  }
  const rows = JSON.stringify(records, null, 2).split("\n");
  // Compact adjacent property rows to match the filed line counts. Every
  // line contains JSON data, with no whitespace-only padding.
  for (let i = rows.length - 3; rows.length > lines && i > 0; i--) {
    if (!/^    "(?:caseId|outcome|errors|warnings|exitCode|seed|attempt|cost|cachedTokens|outputTokens|inputTokens|verifyDuration|findDuration)":/.test(rows[i]!)) continue;
    rows[i] += " " + rows[i + 1]!.trimStart();
    rows.splice(i + 1, 1);
  }
  expect(rows).toHaveLength(lines);
  expect(rows.every((row) => row.trim().length > 0)).toBe(true);
  const text = rows.join("\n") + "\n";
  expect(JSON.parse(text)).toEqual(records);
  if (lines === 11710) expect(Buffer.byteLength(text)).toBeGreaterThan(500000);
  return { records, text, rows };
}
let jsonStdout = "";
it("reviews 11710 and 9426 JSON lines by structural summary and finds only the three planted value errors", () => {
  const dir = demo("digest-json");
  fixDemoSecret(dir);
  const first = filedJson(11710, true);
  const second = filedJson(9426, false);
  writeFileSync(join(dir, "runs-a.json"), first.text);
  writeFileSync(join(dir, "runs-b.json"), second.text);
  writeConfig(dir, "review:\n  stages: true\n");
  const locations = [
    [first.rows.findIndex((r) => r.includes('"wrong-split"')) + 1, "Wrong split hash"],
    [first.rows.findIndex((r) => r.includes('"duration": -1')) + 1, "Negative duration"],
    [first.rows.findIndex((r) => r.includes(`"id": "${first.records[42]!.id}"`)), "Missing case ids"],
  ] as const;
  const result = run("digest-json", dir, flags, { env: stagedProviderEnv("claude", { OPENQODEX_STANDIN_PLANT: locations.map(([line, title]) => `runs-a.json:${line}:${title}`).join(";") }) });
  expect(result.status, result.stderr).toBe(0);
  const saved = report(dir);
  expect(saved.completion!.status, JSON.stringify(saved.completion!.missing)).toBe("complete");
  expect(saved.completion!.coverage.unread).toEqual([]);
  for (const [, title] of locations) expect(saved.findings.some((f) => f.title === title)).toBe(true);
  expect(saved.findings.filter((f) => f.file_path.startsWith("runs-")).map((f) => f.title).sort()).toEqual(locations.map(([, title]) => title).sort());
  expect(saved.findings.some((f) => f.file_path === "app/server.py")).toBe(true);
  const out = reportDir(dir);
  const units = readJson<ReviewUnit[]>(join(out, "units.json")).filter((u) => u.digest?.kind === "json");
  for (const path of ["runs-a.json", "runs-b.json"]) expect(units.filter((u) => u.files.includes(path)).length).toBeGreaterThan(1);
  for (const unit of units) {
    expect(saved.completion!.coverage.given).toContainEqual(expect.objectContaining({ path: unit.files[0], by: "digest" }));
    const briefs = savedBriefs(out).filter((text) => text.includes(`Unit: ${unit.id}\n`));
    expect(briefs).toHaveLength(2);
    for (const text of briefs) {
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(256 * 1024);
      expect(text).toContain("(structural summary: json)");
      expect(text).toContain(`array length ${unit.files.includes("runs-a.json") ? first.records.length : second.records.length}`);
      expect(text).not.toContain("```diff");
    }
    expect(readFileSync(join(out, "digests", `${unit.id}.md`), "utf8")).toContain("structural summary coverage");
  }
  const firstBriefs = savedBriefs(out).filter((text) => units.some((u) => u.files.includes("runs-a.json") && text.includes(`Unit: ${u.id}\n`))).join("\n");
  expect(firstBriefs).toContain('"wrong-split"');
  expect(firstBriefs).toContain(" = -1");
  expect(firstBriefs).toContain(JSON.stringify(first.records[42]));
  expect(firstBriefs).toMatch(new RegExp(`odd record \\$\\[42\\]@${locations[2][0]}-`));
  expect(readJson<{ delivered: unknown[] }[]>(join(out, "rounds.json")).flatMap((r) => r.delivered)).toEqual([]);
  jsonStdout = result.stdout;
});
// needs C3's receipt line; the session enables it at integration
it("counts structural summaries in C3's receipt", ({ skip }) => {
  if (process.env.OPENQODEX_C3_MERGED) {
    expect(jsonStdout).toContain(" structural summary");
    expect(jsonStdout).toMatch(/Changed ranges:.*[1-9]\d* structural summary/);
  } else skip();
});
it("reviews all 798 dependency-store files through bounded summary pages and still finds a code defect", () => {
  const dir = demo("digest-store");
  fixDemoSecret(dir);
  const paths: string[] = [];
  const targetLines = 349695;
  let total = 0;
  for (let i = 0; i < 798; i++) {
    const path = i === 797 ? ".pnpm-store/v11/files/manifest/package.json" : `.pnpm-store/v11/files/${String(i % 256).padStart(2, "0")}/${String(i).padStart(64, "a")}`;
    paths.push(path);
    const count = i === 0 ? 12356 : i === 797 ? 1 : i === 796 ? targetLines - total - 1 : 423;
    let text: string;
    if (i === 797) text = '{"name":"digest-manifest","version":"7.8.9"}\n';
    else if (i % 4 === 0) text = "module.exports = function () { return 1; };\n".repeat(count);
    else if (i % 4 === 1) text = JSON.stringify({ name: `package-${i}`, version: "1.2.3" }) + "\n" + "\n".repeat(count - 1);
    else if (i % 4 === 2) text = '{"version":3,"sources":[],"mappings":""}\n' + "\n".repeat(count - 1);
    else text = "Copyright fixture. All rights reserved.\n".repeat(count);
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
    total += count;
  }
  expect(total).toBe(targetLines);
  writeFileSync(join(dir, "plant.ts"), "export const duration = -1;\n");
  writeConfig(dir, "review:\n  stages: true\n");
  const result = run("digest-store", dir, flags, { env: stagedProviderEnv("claude", { OPENQODEX_STANDIN_PLANT: "plant.ts:1:Invalid code duration" }) });
  expect(result.status, result.stderr).toBe(0);
  const saved = report(dir);
  expect(saved.completion!.status, JSON.stringify(saved.completion!.missing)).toBe("complete");
  expect(saved.findings.some((f) => f.title === "Invalid code duration")).toBe(true);
  const out = reportDir(dir);
  const units = readJson<ReviewUnit[]>(join(out, "units.json")).filter((u) => u.files.some((path) => path.startsWith(".pnpm-store/")));
  expect(units.every((u) => u.digest?.kind === "store")).toBe(true);
  expect(units.flatMap((u) => u.files).sort()).toEqual(paths.sort());
  for (const path of paths) expect(saved.completion!.coverage.given).toContainEqual(expect.objectContaining({ path, by: "digest" }));
  const briefs = savedBriefs(out);
  for (const unit of units) {
    const own = briefs.filter((text) => text.includes(`Unit: ${unit.id}\n`));
    expect(own).toHaveLength(2);
    for (const text of own) {
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(256 * 1024);
      expect(text).toContain("digest-manifest 7.8.9");
    }
  }
  expect(readJson<{ delivered: { path: string }[] }[]>(join(out, "rounds.json")).flatMap((r) => r.delivered).filter((h) => h.path.startsWith(".pnpm-store/"))).toEqual([]);
});
