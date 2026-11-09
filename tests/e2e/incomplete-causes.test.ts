// Failure case: a deleted binary hunk cannot be read and leaves coverage incomplete.
import { readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import "./global-setup.js";
import { baseline, git, report, reportDir, run, stagedProviderEnv, writeConfig } from "./support.js";
import { removeTempDirs } from "../temp-dirs.mjs";

afterAll(removeTempDirs);

describe("binary deletion coverage", () => {
  for (const stages of [true, false]) {
    // The single-pass case is green on step2-batch and gives the route an owner.
    it(stages ? "a deleted binary file keeps the staged review incomplete" : "the single pass stops listing a deleted binary file", () => {
      const dir = baseline();
      const image = join(dir, "logo.png");
      writeFileSync(image, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=", "base64"));
      git(dir, "add", "logo.png");
      git(dir, "commit", "-qm", "Add baseline image");
      unlinkSync(image);
      writeConfig(dir, `review:\n  stages: ${stages}\n`);
      const env = stagedProviderEnv();
      const submissionPath = join(env.PATH!.split(delimiter)[0]!, "submission.json");
      const submission = JSON.parse(readFileSync(submissionPath, "utf8"));
      submission.findings = [];
      submission.dropped = [];
      writeFileSync(submissionPath, JSON.stringify(submission));
      const result = run(`binary-deletion-${stages}`, dir, ["review", "--reviewer", "claude", "--skip", "semgrep,osv-scanner", "--no-color"], { env });
      const completion = report(dir).completion!;
      expect(completion.status, JSON.stringify(completion.missing)).toBe("complete");
      expect(completion.coverage.hunks).toBe(1);
      expect(completion.coverage.covered).toBe(completion.coverage.hunks);
      expect(result.status, result.stderr).toBe(0);
      const out = reportDir(dir);
      if (stages) {
        const briefs = readdirSync(join(out, "briefs")).filter((name) => name.startsWith("finder-"));
        expect(briefs.length).toBeGreaterThan(0);
        for (const name of briefs) {
          expect(readFileSync(join(out, "briefs", name), "utf8")).toContain("The file is binary and was deleted. There are no lines to read; the deletion is the change.");
        }
      } else {
        expect(readFileSync(join(out, "brief.md"), "utf8")).toContain("logo.png was deleted");
      }
    });
  }
});
