// 1. A large code file keeps one finder pair and leaves its last lines unseen.
// 2. Repetitive hand-written code loses unsampled defects to a summary.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { hunkRows } from "../../packages/core/src/index.js";
import type { Change, ReviewUnit } from "@openqodex/core";
import "./global-setup.js";
import { demo, readJson, report, reportDir, run, stagedProviderEnv, writeConfig } from "./support.js";
import { removeTempDirs } from "../temp-dirs.mjs";
import { fixDemoSecret } from "../golden/fixture-secret.mjs";

afterAll(removeTempDirs);

for (const repetitive of [false, true]) {
  it(repetitive ? "reviews repetitive hand-written code in parts and finds an unsampled defect" : "reviews every part of 9000 lines with fresh finder pairs", () => {
    const dir = demo(`big-code-${repetitive}`);
    fixDemoSecret(dir);
    const path = "big.ts";
    const rows = Array.from({ length: 9000 }, (_, i) => repetitive ? `const n${i + 1} = unsafe(${i + 1});` : `export const distinct${i + 1} = ${i + 1};`);
    writeFileSync(join(dir, path), rows.join("\n") + "\n");
    writeConfig(dir, "review:\n  stages: true\n");
    const inspect = run(`big-parts-${repetitive}-measure`, dir, ["review", "--reviewer", "claude", "--skip", "semgrep,osv-scanner", "--no-color"], { env: stagedProviderEnv() });
    expect(inspect.status, inspect.stderr).toBe(0);
    const units = readJson<ReviewUnit[]>(join(reportDir(dir), "units.json"));
    const parts = units.flatMap((u) => u.hunks).filter((h) => h.path === path);
    expect(parts.length).toBeGreaterThanOrEqual(3);
    const boundary = parts[1]!.start;
    rows[boundary - 2] = "if (value < 0) {".padEnd(rows[boundary - 2]!.length);
    rows[boundary - 1] = "  unsafe(value); }".padEnd(rows[boundary - 1]!.length);
    writeFileSync(join(dir, path), rows.join("\n") + "\n");
    // The boundary defect spans the last line of part 1 and the first of part 2,
    // so no part's brief holds both halves: a finder raises it only after it
    // reads the other half with its tool, and the verifier confirms it only
    // after its own read. Both reads are asserted below.
    const plants = [[`${40}`, "First part defect"], [`${8900}`, "Last part defect"], [`${boundary - 1}-${boundary}`, "Boundary defect"]] as const;
    const result = run(`big-parts-${repetitive}`, dir, ["review", "--reviewer", "claude", "--skip", "semgrep,osv-scanner", "--no-color"], { env: stagedProviderEnv("claude", { OPENQODEX_STANDIN_PLANT: plants.map(([lines, title]) => `${path}:${lines}:${title}`).join(";") }) });
    expect(result.status, result.stderr).toBe(0);
    const saved = report(dir);
    expect(saved.completion!.status, JSON.stringify(saved.completion!.missing)).toBe("complete");
    for (const [, title] of plants) expect(saved.findings.some((f) => f.title === title)).toBe(true);
    const out = reportDir(dir);
    const refs = readJson<ReviewUnit[]>(join(out, "units.json")).flatMap((u) => u.hunks).filter((h) => h.path === path);
    const change = { files: [], diffs: [{ path, text: "@@ -0,0 +1,9000 @@\n" + rows.map((r) => `+${r}`).join("\n") + "\n" }], deletionPoints: new Map() } as Change;
    for (const h of refs) {
      const rendered = hunkRows(change, h);
      expect(rendered.length).toBeLessThanOrEqual(4000);
      expect(Buffer.byteLength(rendered.join("\n"))).toBeLessThanOrEqual(120 * 1024);
      expect(saved.completion!.coverage.given).toContainEqual(expect.objectContaining({ path, start: h.start, end: h.end, by: "brief" }));
    }
    const sessions = saved.completion!.contract === "openqodex-review-2" ? saved.completion!.reviewer!.sessions! : [];
    for (const unit of units.filter((u) => u.files.includes(path))) expect(sessions.filter((s) => s.unit === unit.id)).toHaveLength(2);
    const briefs = readdirSync(join(out, "briefs")).filter((name) => name.startsWith("finder-")).map((name) => readFileSync(join(out, "briefs", name), "utf8"));
    for (const h of refs) {
      const own = briefs.filter((text) => text.includes(`### ${h.id} ${path} ${h.start}-${h.end}`));
      expect(own).toHaveLength(2);
      for (const text of own) {
        expect(text).toContain(`+${rows[h.start - 1]}`);
        if (h.end < rows.length) expect(text).not.toContain(`+${rows[h.end]}\n`);
        expect(text).not.toContain("structural summary");
      }
    }
    // Every finder whose part holds one half of the boundary defect reads the
    // other half (both parts, both passes), and the verifier reads it again.
    const straddling = readJson<import("@openqodex/core").TraceEntry[]>(join(out, "trace.json")).filter((t) => t.tool === "Read" && t.path === path && t.range && t.range[0] < boundary && t.range[1] >= boundary);
    // Local sessions for both boundary units receive one half. Contracts
    // sessions receive the same briefs, so all four must read across the edge.
    const boundaryUnits = units.filter((u) => u.hunks.some((h) => h.path === path && h.start <= boundary && h.end >= boundary - 1));
    expect(boundaryUnits).toHaveLength(2);
    const expectedFinders = boundaryUnits.flatMap((u) => ["local", "contracts"].map((pass) => `finder:${u.id}:${pass}`));
    expect(straddling.filter((t) => t.session?.startsWith("finder")).map((t) => t.session).sort()).toEqual(expectedFinders.sort());
    expect(straddling.filter((t) => t.session?.startsWith("verifier")).length).toBeGreaterThanOrEqual(1);
    // The two other plants sit inside their parts, so no finder reads for them
    // (the stand-in verifier still reads near a part edge, as a real one may).
    const elsewhere = readJson<import("@openqodex/core").TraceEntry[]>(join(out, "trace.json")).filter((t) => t.tool === "Read" && t.path === path && t.session?.startsWith("finder") && t.range && (t.range[1] < boundary - 1 || t.range[0] > boundary));
    expect(elsewhere, JSON.stringify(elsewhere)).toEqual([]);
    expect(readJson<{ delivered: { path: string }[] }[]>(join(out, "rounds.json")).flatMap((r) => r.delivered).filter((h) => h.path === path)).toEqual([]);
  });
}
