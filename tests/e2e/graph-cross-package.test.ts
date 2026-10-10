// The code graph across workspace packages, on this repository itself
// (T3 audit: `safeGit` showed no caller while grep found them in
// packages/cli/src). One failure this file guards against: a change to a
// function of one workspace package lists none of its callers in another
// package (packages/cli/src and packages/review/src here), because the
// import names the package (`@openqodex/core`) rather than a path. The
// callers must be listed as likely, with the reason: the package's entry is
// its built dist file, and no tsconfig paths, project reference or source
// condition maps it to source.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { git, root, run } from "./support.js";
import { removeTempDirs, tempDir } from "../temp-dirs.mjs";

afterAll(removeTempDirs);

describe("callers across workspace packages", () => {
  it("lists the callers in packages/cli/src and packages/review/src of a changed function of packages/core, as likely with the reason", () => {
    const dir = join(tempDir("oq-graph-self-"), "repo");
    git(root, "clone", "-q", "--no-hardlinks", root, dir);
    // This file checks which callers the graph lists, not how fast it builds.
    // A fresh clone has no kept facts, so the review parses all of this
    // repository; on a busy runner that takes longer than the default 10
    // second budget, and the brief then holds a partial graph that misses
    // callers. The clone's config gives the graph room to finish, committed
    // so the change stays one edit to safe-git.ts.
    const config = join(dir, ".openqodex.yaml");
    const yaml = readFileSync(config, "utf8");
    expect(yaml).not.toMatch(/^graph:/m);
    writeFileSync(config, `${yaml}graph:\n  budget_ms: 120000\n`);
    git(dir, "commit", "-q", "-am", "Give the graph room to finish");
    const file = join(dir, "packages/core/src/safe-git.ts");
    const text = readFileSync(file, "utf8");
    const at = text.indexOf("export async function safeGit(");
    expect(at).toBeGreaterThan(-1);
    // A one-line edit inside the function.
    const open = text.indexOf("{", at) + 1;
    writeFileSync(file, `${text.slice(0, open)}\n  // edited for the cross-package graph check${text.slice(open)}`);
    const r = run("graph-cross-package", dir, ["review", "--agent", "--only", "gitleaks", "--no-install", "--offline"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("## What this change reaches");
    expect(r.stdout).not.toContain("The graph is partial");
    const callers = r.stdout.split("\n").filter((l) => /^- packages\/(?:cli|review)\/src\/\S+:\d+ in `[^`]+` calls `safeGit` \(1 hop, likely: /.test(l));
    expect(callers.length).toBeGreaterThanOrEqual(5);
    for (const line of callers) expect(line).toContain("no tsconfig paths, project reference or active source condition maps @openqodex/core to its source");
  });
});
