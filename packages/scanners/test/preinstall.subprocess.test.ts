// Strict preinstall of every scanner into a clean install root, as a server
// image build does it. It downloads every pinned scanner from its release
// (about 1 GB) and runs each one on its check case through the real binary,
// so it runs only with OPENQODEX_PREINSTALL_FULL=1: the release workflow's
// check after each publish sets it (tests/e2e/preinstall-full.test.ts), and
// the pull request gate skips it. The strict check's failures and the
// server's resolver on a preinstalled root are checked on every gate, in
// server-roots.subprocess.test.ts.
//
// The failure this guards, written before the code: preinstall reports
// success while a scanner is not installed at its pinned version, lacks
// its runtime, or does not report its check case's finding; or a tool or a
// download cache lands outside the install root named (in the OpenQodex
// home).
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { BuiltinScanner } from "@openqodex/core";
import { checkCase, loadToolchain, preinstallScanners } from "@openqodex/scanners";
import type { PreinstallResult } from "@openqodex/scanners";
import { removeTempDirs, tempDir } from "../../../tests/temp-dirs.mjs";

const savedHome = process.env.OPENQODEX_HOME;
afterAll(() => {
  if (savedHome === undefined) delete process.env.OPENQODEX_HOME;
  else process.env.OPENQODEX_HOME = savedHome;
});
afterAll(removeTempDirs);

const full = process.env.OPENQODEX_PREINSTALL_FULL === "1";
if (!full) process.stdout.write("clean-root preinstall: skipped, it downloads every scanner (about 1 GB); OPENQODEX_PREINSTALL_FULL=1 runs it\n");

describe.skipIf(!full)("strict preinstall into a clean install root (OPENQODEX_PREINSTALL_FULL=1)", () => {
  it("installs every scanner at its pinned version into the root alone, and each reports its check case", async () => {
    const table = loadToolchain();
    // An empty OpenQodex home that nothing may touch: the install root is named.
    const home = tempDir("oq-preinstall-home-");
    process.env.OPENQODEX_HOME = home;
    const root = join(tempDir("oq-preinstall-"), "tools");
    const result: PreinstallResult = await preinstallScanners({ installRoot: root, require: "all" });
    process.stdout.write(`preinstall: ${result.tools.filter((t) => t.ok).length} ready; missing: ${result.missing.join("; ") || "none"}\n`);

    expect(result.ok).toBe(result.missing.length === 0);
    // Only a runtime this machine lacks may be missing; under CI none.
    for (const line of result.missing) expect(line).toMatch(/^(golangci|cargo-deny|brakeman|rubocop): needs (Go|Cargo \(Rust\)|Ruby [0-9.]+ or newer)$/);
    if (process.env.CI) expect(result.missing).toEqual([]);
    for (const tool of result.tools.filter((t) => t.ok && t.version !== "built in")) {
      const c = checkCase(tool.scanner as BuiltinScanner)!;
      expect(tool.version).toBe(table.tools[tool.scanner]!.version);
      expect(tool.detail, tool.scanner).toBe(c.rule === null ? "ran its check case" : `reported ${c.rule} on ${c.anchor}`);
    }
    // The root holds tools and nothing else: no download cache, no lock.
    expect(readdirSync(root).filter((name) => !(name in table.tools) && name !== "uv-python")).toEqual([]);
    expect(readdirSync(home)).toEqual([]);
  }, 1_800_000);
});
