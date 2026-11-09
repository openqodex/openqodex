// Ways the built CLI could fail, written before this check:
// 1. The shipped catalog omits the lens, or the CLI never puts it in the
//    brief a scripted reviewer receives for a C line losing its null check.
// 2. A scripted answer cannot complete the real review and save its report.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { expect, it } from "vitest";
import { ADAPTERS } from "@openqodex/scanners";

it("does not omit the replacement lens from a built CLI review of a lost C null check", () => {
  const root = resolve(import.meta.dirname, "../../..");
  // Keep the acceptance receipt and fixture under the assigned ignored output
  // folder so the session can inspect the real CLI's saved brief and report.
  const results = join(root, "benchmark/results/w6-h2b-cli");
  mkdirSync(results, { recursive: true });
  const fixture = mkdtempSync(join(results, "case-"));
  const dir = join(fixture, "repo");
  const provider = join(fixture, "provider");
  const home = join(fixture, "home");
  for (const folder of [dir, provider, home]) mkdirSync(folder);
  const git = (...args: string[]) => {
    const result = spawnSync("git", ["-c", "user.name=Test", "-c", "user.email=test@openqodex.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
    expect(result.status, result.stderr).toBe(0);
  };
  git("init", "-q", "-b", "main");
  mkdirSync(join(dir, "app"));
  // The existing scripted provider reads this unchanged file in its snapshot.
  writeFileSync(join(dir, "app/server.py"), "pass\n");
  writeFileSync(join(dir, "value.c"), "int value(int *ptr) {\n  return ptr ? *ptr : 0;\n}\n");
  git("add", "-A");
  git("commit", "-qm", "Base");
  writeFileSync(join(dir, "value.c"), "int value(int *ptr) {\n  return *ptr;\n}\n");
  const out = join(fixture, "report");
  const env = { ...process.env, OPENQODEX_HOME: home, OPENQODEX_AUTO_UPDATE: "0", OPENQODEX_OFFLINE: "1", PATH: [provider, process.env.PATH].join(delimiter), CLAUDECODE: "" };
  const cli = (...args: string[]) => spawnSync(process.execPath, [join(root, "packages/cli/dist/bin.js"), "review", "--base", "HEAD", "--skip", ADAPTERS.map((a) => a.source).join(","), "--no-graph", "--offline", ...args], { cwd: dir, encoding: "utf8", timeout: 60_000, env });
  const prepared = cli("--agent");
  expect(prepared.status, prepared.stderr).toBe(0);
  const latest = JSON.parse(readFileSync(join(dir, ".openqodex/latest.json"), "utf8"));
  const manifest = JSON.parse(readFileSync(join(dir, latest.dir, "manifest.json"), "utf8"));
  writeFileSync(join(provider, "submission.json"), JSON.stringify({ version: 2, change_id: manifest.change_id, summary: "Reviewed the C replacement.", findings: [], dropped: [] }));
  writeFileSync(join(provider, "claude.cjs"), readFileSync(join(root, "tests/golden/stand-ins/claude.cjs"), "utf8"));
  writeFileSync(join(provider, "claude"), `#!${process.execPath}\nimport "./claude.cjs";\n`);
  chmodSync(join(provider, "claude"), 0o755);
  const reviewed = cli("--reviewer", "claude", "--reviewer-web", "off", "--report-dir", out);
  writeFileSync(join(out, "cli-stdout.txt"), reviewed.stdout);
  writeFileSync(join(out, "cli-stderr.txt"), reviewed.stderr);
  expect(reviewed.status, reviewed.stderr).toBe(0);
  expect(readFileSync(join(out, "brief.md"), "utf8")).toContain("### replaced-line-drops-behavior");
  const report = JSON.parse(readFileSync(join(out, "report.json"), "utf8"));
  expect(report.completion.status).toBe("complete");
  process.stdout.write(`Built CLI C replacement: exit 0, brief names replaced-line-drops-behavior, scripted review complete. Receipt: ${out}\n`);
});
