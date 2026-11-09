// Failure cases: a refused outside read, a refused tool and a single-pass
// refusal discard valid answers. A served outside read must still fail.
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import type { CompletionRecord, GateReceipt, TraceEntry } from "@openqodex/core";
import "./global-setup.js";
import { demo, readJson, report, reportDir, root, run, stagedProviderEnv, toolsHome, writeConfig } from "./support.js";
import { fixDemoSecret } from "../golden/fixture-secret.mjs";
import { removeTempDirs, tempDir } from "../temp-dirs.mjs";

afterAll(removeTempDirs);
function review(label: string, session: string, tool: string, path: string, refused = true, stages = true) {
  const dir = demo(label);
  fixDemoSecret(dir);
  writeConfig(dir, `review:\n  stages: ${stages}\n`);
  const tools = toolsHome;
  const env = stagedProviderEnv("claude", {
    OPENQODEX_STANDIN_TOOL_SESSION: session,
    OPENQODEX_STANDIN_TOOL_NAME: tool,
    OPENQODEX_STANDIN_TOOL_PATH: path,
    OPENQODEX_STANDIN_TOOL_ERROR: refused ? "1" : "0",
  });
  const result = run(label, dir, ["review", "--reviewer", "claude", "--skip", "semgrep,osv-scanner", "--no-color"], { tools, env });
  const out = reportDir(dir);
  const saved = report(dir);
  const id = createHash("sha256").update(realpathSync(dir)).digest("hex");
  const push = readJson<GateReceipt>(join(tools, "receipts", id, `${saved.change_id}.json`));
  return { result, saved, out, push, completion: saved.completion as CompletionRecord, trace: readJson<TraceEntry[]>(join(out, "trace.json")) };
}
function planted(r: ReturnType<typeof review>) {
  const expected = readJson<{ bugs: { id: string; file: string; lines: [number, number] }[] }>(join(root, "examples/demo-repo/expected.json"));
  for (const bug of expected.bugs) expect(r.saved.findings.some((f) => f.file_path === bug.file && f.line_number <= bug.lines[1] && f.line_end >= bug.lines[0]), bug.id).toBe(true);
}
for (const [session, path] of [["verifier:app/config.py", "/dev/null"], ["finder:u1:local", "../openqodex-checkout.json"]]) {
  it(`a refused read outside the snapshot discards the staged review: ${session}`, () => {
    const r = review(`refused-${session}`, session, "Read", path);
    expect(r.result.status, r.result.stderr).toBe(0);
    expect(r.completion.status).toBe("complete");
    expect(r.completion.refused).toEqual([path]);
    expect(r.completion.outside_reads).toEqual([path]);
    expect(r.trace).toContainEqual(expect.objectContaining({ tool: "Read", path, inside: false, ok: false }));
    expect(r.result.stdout).toContain(`These requests were refused by the reviewer's own rules: ${path}`);
    expect(readFileSync(join(r.out, "report.md"), "utf8")).toContain("These requests were refused by the reviewer's own rules:");
    expect(r.completion.reviewer!.sessions!.some((s) => s.role.includes("retry"))).toBe(false);
    expect(r.push.kind).toBe("complete");
    planted(r);
  });
}
it("one refused Bash call discards the whole staged review", () => {
  const r = review("refused-bash", "finder:u1:local", "Bash", "");
  expect(r.result.status, r.result.stderr).toBe(0);
  expect(r.completion.status).toBe("complete");
  expect(r.completion.refused).toEqual(["Bash"]);
  expect(r.result.stdout).toContain("These requests were refused by the reviewer's own rules: Bash");
  expect(r.push.kind).toBe("complete");
  planted(r);
});
it("a read that left the snapshot completes the review", () => {
  const path = join(tempDir("oq-served-outside-"), "outside.txt");
  writeFileSync(path, "outside content");
  const r = review("served-outside", "finder:u1:local", "Read", path, false);
  expect(r.result.status).toBe(2);
  expect(r.completion.status).toBe("incomplete");
  expect(r.completion.missing.join(" ")).toContain(path);
  expect(r.trace).toContainEqual(expect.objectContaining({ path, inside: false, ok: true }));
  expect(r.saved.findings.some((f) => f.file_path === "app/server.py")).toBe(true);
  expect(r.push.kind).toBe("incomplete");
});
it("the single pass drops its answer after a refusal", () => {
  const r = review("refused-single", "primary", "Read", "/dev/null", true, false);
  expect(r.result.status, r.result.stderr).toBe(0);
  expect(r.completion.status).toBe("complete");
  expect(r.completion.refused).toEqual(["/dev/null"]);
  expect(r.push.kind).toBe("complete");
  expect(r.result.stdout).toContain("These requests were refused by the reviewer's own rules: /dev/null");
});
