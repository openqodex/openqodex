// Ways the combined reviewer check could fail, written before the code:
// 1. The build omits the replacement lens, or a replacement never selects it.
// 2. The reviewer receives the old omission rule instead of honest confidence.
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Report } from "@openqodex/core";
import { baseline, readBrief, readJson, reportDir, root, run } from "./support.js";
import { removeTempDirs, tempDir } from "../temp-dirs.mjs";

afterAll(removeTempDirs);

describe("replacement lens and honest confidence in a CLI review", () => {
  let brief: string;

  beforeAll(() => {
    const dir = baseline();
    const file = join(dir, "app/server.py");
    // Parentheses preserve the value, so this replacement loses no effect.
    writeFileSync(file, readFileSync(file, "utf8").replace("PAGE_SIZE = 20", "PAGE_SIZE = (20)"));
    const args = ["review", "--base", "HEAD", "--skip", "semgrep,osv-scanner", "--no-graph", "--offline", "--no-install", "--no-color"];
    const prepared = run("replacement-confidence-prepare", dir, [...args, "--agent"], { env: { OPENQODEX_REVIEW_DEPTH: "" } });
    expect(prepared.status, prepared.stderr).toBe(0);
    const change = readBrief(dir);
    expect(change.candidates).toEqual([]);

    // Replay an empty answer through the model provider used by the e2e suite.
    const provider = tempDir("oq-e2e-replacement-provider-");
    writeFileSync(join(provider, "claude.cjs"), readFileSync(join(root, "tests/golden/stand-ins/claude.cjs"), "utf8"));
    writeFileSync(join(provider, "claude"), `#!${process.execPath}\nrequire("./claude.cjs");\n`);
    chmodSync(join(provider, "claude"), 0o755);
    writeFileSync(join(provider, "submission.json"), JSON.stringify({ version: 2, change_id: change.changeId, summary: "Preserves the page size.", findings: [], dropped: [] }));
    const result = run("replacement-confidence-review", dir, [...args, "--reviewer", "claude", "--reviewer-web", "off"], {
      env: { PATH: [provider, dirname(process.execPath), process.env.PATH].join(delimiter), CLAUDECODE: undefined, OPENQODEX_REVIEW_DEPTH: "" },
    });
    expect(result.status, result.stderr).toBe(0);
    const out = reportDir(dir);
    const reviewed = readJson<Report>(join(out, "report.json"));
    expect(reviewed.completion?.status).toBe("complete");
    brief = readFileSync(join(out, "brief.md"), "utf8");
  });

  it("does not omit the replacement lens from the reviewer brief", () => {
    expect(readFileSync(join(root, "packages/cli/lenses/replaced-line-drops-behavior.md"), "utf8"))
      .toBe(readFileSync(join(root, "packages/core/lenses/replaced-line-drops-behavior.md"), "utf8"));
    expect(brief).toContain("### replaced-line-drops-behavior");
  });

  it("does not replace honest confidence with the old omission rule", () => {
    expect(brief).toContain("Raise every defect you can show from the code with confidence 0.5 or higher. Set confidence honestly. Findings under 0.7 are shown as possible issues and never counted.");
  });
});
