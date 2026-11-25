// Failure cases: a real scanner failure leaks the checkout root, the
// redaction removes the file and failure detail along with the root, or it
// rewrites a path outside the checkout that starts with the root's text.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { parseConfig } from "@openqodex/core";
import { repoFacts } from "../src/detect.js";
import { runRuff } from "../src/adapters/ruff.js";
import { runScanners } from "../src/run.js";
import { removeTempDirs, tempDir } from "../../../tests/temp-dirs.mjs";
import { installedOnly } from "./subprocess-support.js";

afterAll(removeTempDirs);

// A Python file whose Ruff settings extend `extend`, which does not exist.
async function ruffFailure(extend: string) {
  const parent = tempDir("oq-reason-paths-");
  const root = join(parent, "repo");
  mkdirSync(root);
  writeFileSync(join(root, "main.py"), "import os\n");
  writeFileSync(join(root, "ruff.toml"), `extend = ${JSON.stringify(extend.replaceAll("<parent>", parent))}\n`);
  const resolution = await installedOnly()("ruff");
  if (!resolution.ok) throw new Error(`ruff is not installed: ${resolution.reason}`);
  const raw = await runRuff({ repoDir: root, changedPaths: ["main.py"], tool: resolution.tool, facts: repoFacts(root) });
  const { scan } = await runScanners({ repoDir: root, changedPaths: ["main.py"], config: parseConfig("").config, resolveTool: async () => resolution, only: ["ruff"] });
  return { parent, root, raw: raw.error ?? "", summary: scan.scanners[0] };
}

it("redacts the checkout root in a real Ruff configuration failure", async () => {
  const { root, raw, summary } = await ruffFailure("missing.toml");
  expect(raw).toContain(root);
  expect(summary?.status).toBe("failed");
  expect(summary?.reason).toContain("<checkout>");
  expect(summary?.reason).toContain("missing.toml");
  expect(summary?.reason).not.toContain(root);
});

it("keeps a path outside the checkout that starts with the checkout's own path", async () => {
  const { parent, raw, summary } = await ruffFailure("<parent>/repo-other/missing.toml");
  const outside = join(parent, "repo-other", "missing.toml");
  expect(raw).toContain(outside);
  expect(summary?.status).toBe("failed");
  expect(summary?.reason).toContain(outside);
  // ruff 0.17 also names the checkout's own ruff.toml, which is redacted;
  // the outside path must not be redacted as if it were inside.
  expect(summary?.reason).not.toContain("<checkout>-other");
});
