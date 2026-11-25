import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { Report } from "@openqodex/core";
import "./global-setup.js";
import { demo, offline, report, root, run, toolsHome, writeConfig } from "./support.js";
import { removeTempDirs } from "../temp-dirs.mjs";

afterAll(removeTempDirs);

// A custom scanner on the demo repo's workflow file, guarding the trust step:
// nothing runs before the approval, and a changed entry needs a new one. Trust
// is per repository in the shared tools folder, so each fresh demo repo starts
// untrusted; --only keeps each scan to the custom entry.
// The program is actionlint at the pinned version the shared tools folder
// already holds (global-setup's `doctor --install`), taken from PATH with
// `install: path`. A release download from GitHub here made the case fail
// whenever github.com stalled (issue 300); the release download itself is
// owned by packages/scanners/test/toolchain.test.ts and custom-flow.test.ts.
const pinned = (JSON.parse(readFileSync(join(root, "packages/scanners/toolchain.json"), "utf8")) as { tools: { actionlint: { version: string } } }).tools.actionlint.version;
const actionlintBin = join(toolsHome, "tools", "actionlint", pinned, "bin");
const withActionlint = { PATH: `${actionlintBin}${delimiter}${process.env.PATH ?? ""}` };
const command = "actionlint -no-color -format '{{json .}}' {target}";
const yaml = (runLine: string) => `scanners:\n  custom:\n    - source: https://github.com/rhysd/actionlint\n      install: path\n      run: ${JSON.stringify(runLine)}\n      format: json-map\n      map: { items: ".", file: filepath, line: line, rule: kind, message: message }\n      paths: [".github/workflows/*.yml"]\n`;
// Offline with no install, the shared folder may not hold the program.
const missing = (): boolean => {
  if (!offline() || existsSync(join(actionlintBin, "actionlint"))) return false;
  process.stdout.write(`custom scanner: skipped because OPENQODEX_E2E_OFFLINE=1 and ${actionlintBin} holds no actionlint\n`);
  return true;
};
const row = (r: Report) => r.scanners.find((s) => s.scanner === "custom:actionlint");
const customFindings = (r: Report) => r.findings.filter((f) => f.source?.startsWith("custom:actionlint:")).map((f) => f.source);

describe.skipIf(missing())("custom scanner", () => {
  let dir: string;
  const scan = (label: string) => { const r = run(label, dir, ["scan", "--only", "custom:actionlint", "--format", "json"], { env: withActionlint }); if (r.status !== 0) throw new Error(`scan exited ${r.status}: ${r.stderr}`); return report(dir); };
  beforeAll(() => { dir = demo("custom"); writeConfig(dir, yaml(command)); }, 300_000);

  it("never runs before the developer approves it", () => {
    const r = scan("custom-untrusted");
    expect(row(r)?.status).toBe("untrusted");
    expect(customFindings(r)).toEqual([]);
  });
  it("runs after trust --yes and reports its finding as custom:actionlint", () => {
    expect(run("custom-trust", dir, ["trust", "--yes"], { env: withActionlint }).status).toBe(0);
    const r = scan("custom-trusted");
    expect(row(r)?.status).toBe("ran");
    expect(customFindings(r)).toContain("custom:actionlint:expression");
  });
  it("stops running when its run line changes after approval", () => {
    writeConfig(dir, yaml(`${command} -verbose`));
    const r = scan("custom-changed");
    expect(row(r)?.status).toBe("untrusted");
    expect(customFindings(r)).toEqual([]);
  });
});
