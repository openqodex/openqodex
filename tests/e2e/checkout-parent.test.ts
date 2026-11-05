// A reviewer that drops `tree/` from a path (issue 239), end to end: the built
// CLI on the demo change with the real scanners. The model provider is the one
// stand-in: the golden run's Claude Code with one more tool call in its stream.
// As in the timings case, the two scanners that read live data are skipped.
//
// Ways it could fail, written before the code:
//  1. A refused read in the review's own checkout folder voids the review.
//  2. It is not shown in report.md, or not recorded in report.json.
//  3. The same read when it succeeded completes the review.
//  4. A refused read of a sibling of that folder completes the review.
import { chmodSync, cpSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Report } from "@openqodex/core";
import "./global-setup.js";
import { demo, readJson, reportDir, root, run } from "./support.js";
import { removeTempDirs, tempDir } from "../temp-dirs.mjs";

afterAll(removeTempDirs);

const INIT = 'emit({ type: "system", subtype: "init", session_id, tools: ["Read", "Grep", "Glob"], mcp_servers: [] });';

// The stand-in, with a read of `target` (code over the snapshot's `dirname`) just after init.
function provider(target: string, isError: boolean): string {
  const folder = tempDir("oq-e2e-parent-");
  const source = readFileSync(join(root, "tests/golden/stand-ins/claude.cjs"), "utf8");
  expect(source).toContain(INIT);
  const attempt = [
    INIT,
    `const attempt = join(${target}, "app/server.py");`,
    'emit({ type: "assistant", session_id, message: { content: [{ type: "tool_use", id: "attempt", name: "Read", input: { file_path: attempt } }] } });',
    `emit({ type: "user", session_id, message: { content: [{ type: "tool_result", tool_use_id: "attempt", is_error: ${isError}, content: "x" }] } });`,
  ].join("\n");
  writeFileSync(join(folder, "claude"), `#!${process.execPath}\n${source.replace(INIT, attempt)}`);
  chmodSync(join(folder, "claude"), 0o755);
  cpSync(join(root, "tests/golden/stand-ins/submission.json"), join(folder, "submission.json"));
  return folder;
}

function review(name: string, target: string, isError: boolean) {
  const dir = demo(name);
  const path = [provider(target, isError), dirname(process.execPath), process.env.PATH].join(delimiter);
  const result = run(name, dir, ["review", "--reviewer", "claude", "--skip", "semgrep,osv-scanner", "--no-color"], { env: { PATH: path, CLAUDECODE: undefined } });
  const folder = reportDir(dir);
  return { result, folder, report: readJson<Report>(join(folder, "report.json")) };
}

const PARENT = "dirname(snapshot)";

describe("a reviewer that addresses a path above tree/", () => {
  it("1, 2. a refused read in the checkout folder leaves the review complete, with a warning", () => {
    const { result, folder, report } = review("parent-refused", PARENT, true);
    expect(report.completion?.missing).toEqual([]);
    expect(report.completion?.status).toBe("complete");
    expect(result.stderr).not.toContain("outside the snapshot");
    expect(report.completion?.outside_reads).toEqual([]);
    const warned = report.completion as { refused_checkout_reads?: string[] };
    expect(warned.refused_checkout_reads).toEqual([expect.stringMatching(/app\/server\.py$/)]);
    expect(readFileSync(join(folder, "report.md"), "utf8")).toContain("Warning: refused reads beside the snapshot");
  }, 600_000);

  it("3. the same read when it succeeded makes the review incomplete", () => {
    const { result, report } = review("parent-succeeded", PARENT, false);
    expect(result.status).toBe(2);
    expect(report.completion?.outside_reads).toEqual([expect.stringMatching(/app\/server\.py$/)]);
  }, 600_000);

  it("4. a refused read of a sibling of the checkout folder makes the review incomplete", () => {
    const { result, report } = review("parent-sibling", 'join(dirname(dirname(snapshot)), "work-other")', true);
    expect(result.status).toBe(2);
    expect(report.completion?.outside_reads).toEqual([expect.stringMatching(/work-other\/app\/server\.py$/)]);
  }, 600_000);
});
