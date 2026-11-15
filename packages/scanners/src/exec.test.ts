// The process helper every scanner goes through. Real processes only: the
// child is this machine's own node binary.
//
// Failure list, written before the tests:
//   1. scannerEnv passes a variable outside the allowlist (a token, a cloud
//      credential) to the scanner.
//   2. scannerEnv drops an allowed variable: PATH, HOME, an LC_ variable or
//      a proxy setting in either case.
//   3. `extra` is ignored, or loses to the developer's own value.
//   4. execTool rejects when the binary is missing instead of resolving
//      with failure "not_found".
//   5. A non-zero exit is reported as a failure instead of an exit code
//      with the output kept.
//   6. A process that runs past its timeout is not stopped, or is not
//      reported as "timeout".
//   7. Output past the cap is not reported as "overflow".
//   8. Arguments go through a shell, so a ";" or "$(...)" in one runs.
//  10. A child that ignores SIGTERM keeps execTool pending past its deadline.
//  11. A whole-repo file list is passed to one process, which fails with
//      E2BIG and loses every finding; or the chunks drop, repeat or reorder
//      a file when their results are merged.

import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ARG_BUDGET_BYTES, execTool, runInChunks, scannerEnv, stderrTail } from "./exec.js";

const NODE = process.execPath;
const opts = (over: Partial<{ timeoutMs: number; maxBytes: number; env: Record<string, string> }> = {}) => ({
  cwd: os.tmpdir(),
  timeoutMs: 10_000,
  maxBytes: 1024 * 1024,
  ...over,
});

const saved = { ...process.env };
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
});

describe("scannerEnv", () => {
  it("passes only the allowlist (1, 2)", () => {
    process.env.OPENQODEX_TEST_TOKEN = "do-not-pass";
    process.env.AWS_SECRET_ACCESS_KEY = "do-not-pass";
    process.env.LC_ALL = "en_US.UTF-8";
    process.env.https_proxy = "http://proxy.local:3128";
    process.env.NO_PROXY = "localhost";
    const env = scannerEnv();
    expect(env.OPENQODEX_TEST_TOKEN).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.PATH).toBe(process.env.PATH);
    expect(env.HOME).toBe(process.env.HOME);
    expect(env.LC_ALL).toBe("en_US.UTF-8");
    expect(env.https_proxy).toBe("http://proxy.local:3128");
    expect(env.NO_PROXY).toBe("localhost");
    const allowed = /^(PATH|HOME|TMPDIR|LANG|LC_.*|HTTPS?_PROXY|NO_PROXY|https?_proxy|no_proxy)$/;
    for (const key of Object.keys(env)) expect(key).toMatch(allowed);
  });

  it("adds extra and lets it win (3)", () => {
    const env = scannerEnv({ GEM_HOME: "/tools/gems", HOME: "/elsewhere" });
    expect(env.GEM_HOME).toBe("/tools/gems");
    expect(env.HOME).toBe("/elsewhere");
  });
});

describe("execTool", () => {
  it("resolves not_found for a missing binary (4)", async () => {
    const r = await execTool(path.join(os.tmpdir(), "openqodex-no-such-binary"), [], opts());
    expect(r.failure).toBe("not_found");
    expect(r.exitCode).toBeNull();
  });

  it("keeps the output and the code of a non-zero exit (5)", async () => {
    const r = await execTool(NODE, ["-e", "process.stdout.write('out'); process.exit(3)"], opts());
    expect(r).toMatchObject({ stdout: "out", exitCode: 3, failure: null });
  });

  it("stops a process at its timeout (6)", async () => {
    const r = await execTool(NODE, ["-e", "setTimeout(() => {}, 60000)"], opts({ timeoutMs: 300 }));
    expect(r.failure).toBe("timeout");
    expect(r.exitCode).toBeNull();
  });

  it("reports output past the cap as overflow (7)", async () => {
    const r = await execTool(NODE, ["-e", "process.stdout.write('x'.repeat(10000))"], opts({ maxBytes: 100 }));
    expect(r.failure).toBe("overflow");
  });

  it("never uses a shell, and gives the child only the small environment (8, 1)", async () => {
    process.env.OPENQODEX_TEST_TOKEN = "do-not-pass";
    const r = await execTool(
      NODE,
      ["-e", "console.log(JSON.stringify({ argv: process.argv.slice(1), env: process.env }))", "a; echo hi", "$(id)"],
      opts({ env: { EXTRA_ONE: "1" } }),
    );
    const out = JSON.parse(r.stdout) as { argv: string[]; env: Record<string, string> };
    expect(out.argv).toEqual(["a; echo hi", "$(id)"]);
    expect(out.env.OPENQODEX_TEST_TOKEN).toBeUndefined();
    expect(out.env.EXTRA_ONE).toBe("1");
  });

  it("stops a child that ignores SIGTERM at the deadline (10)", async () => {
    const started = Date.now();
    const r = await execTool(
      NODE,
      ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
      opts({ timeoutMs: 300 }),
    );
    expect(r.failure).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 10_000);

});

describe("runInChunks", () => {
  it("splits 20,000 file names into processes under the argument budget and merges every name back in order", async () => {
    const files = Array.from({ length: 20_000 }, (_, i) => `src/module-${String(i).padStart(5, "0")}/index.ts`);
    const sizes: number[] = [];
    const merged = await runInChunks("echo", files, 60_000, async (chunk, left) => {
      sizes.push(chunk.reduce((n, f) => n + Buffer.byteLength(f) + 1, 0));
      const r = await execTool(NODE, ["-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", "--", ...chunk], opts({ timeoutMs: left, maxBytes: 4 * 1024 * 1024 }));
      expect(r.failure).toBeNull();
      return JSON.parse(r.stdout) as string[];
    });
    expect(sizes.length).toBeGreaterThan(1);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(ARG_BUDGET_BYTES);
    expect(merged).toEqual(files);
  });
});

// Failure case: a failed tree chunk erases the findings of completed chunks.
it("keeps completed chunks when a tree chunk times out", async () => {
  const files = ["a".repeat(ARG_BUDGET_BYTES), "b"];
  const partial: string[] = [];
  await expect(runInChunks("tree", files, 60_000, async (chunk) => {
    if (chunk[0] === "b") throw new Error("tree timed out");
    return ["advisory"];
  }, partial)).rejects.toThrow("tree timed out");
  expect(partial).toEqual(["advisory"]);
});

describe("stderrTail", () => {
  const tail = (stderr: string) => stderrTail({ stdout: "", stderr, exitCode: 2, failure: null });
  it("keeps short stderr whole", () => {
    expect(tail("  ruff failed: bad config \n")).toBe("ruff failed: bad config");
  });
  it("drops the part word a 300-character cut lands in", () => {
    const end = " Cause: Failed to read <file>";
    const path = "/private/var/folders/" + "x".repeat(300 - end.length) + "/missing.toml";
    const out = tail(`extends ${path}${end}`);
    expect(out).toBe(end.trim());
  });
  it("keeps the first word when the cut falls on a space", () => {
    const words = "a ".repeat(400) + "end";
    expect(tail(words).startsWith("a ")).toBe(true);
    expect(tail(words).endsWith("end")).toBe(true);
  });
});
