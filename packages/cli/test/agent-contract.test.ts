// The user-scope agent files are what an update leaves in place: init
// writes them, and only the next init refreshes them. So they hold no
// procedure and name no version, and they change only with a new
// agentContract, the number that keeps the background update from crossing
// the change (src/contract.ts).
//
// Ways it could fail, written before the code:
//  1. A user-scope file names a version, a review command or who reviews,
//     so after an update it contradicts the procedure `guide skill` prints.
//  2. A user-scope file, hook or permission rule changes under the same
//     agentContract (a template edit, such as templates/instructions-section.md),
//     so the background update crosses a change only `init` brings to the
//     files already written.
//  3. The copy checked in for a contract is rewritten in place instead of a
//     new contract being added with its own copy.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AGENTS } from "../src/agents/detect.js";
import { targetsFor } from "../src/agents/targets.js";
import { runningContract } from "../src/contract.js";

const COPIES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "agent-contract");
const LAUNCHER = "/home/dev/.openqodex/bin/openqodex";
const VERSION = "9.9.9";

// The sha256 of each checked-in copy (copyHash). A copy's files are never
// changed: a new contract adds a folder and a line here. The one exception
// is an agent new in the running contract, whose files are added to its
// copy, since no machine holds them yet (Goose, added under contract 3).
const COPIES: Record<number, string> = {
  1: "6baaa371d9d814b0ca225ff82705403d607f4d0f02c137834050b8d7c2566ecc",
  2: "f34091e753bd8c0a0dce42cd5f7312d7e5609497e9dc941aff72048f4fce87a3",
  3: "ed9e38f9c3f0be5bdfc1d5f3b049776a8eaf5820899e737238911889644dcb45",
};

// Every file, hook and rule a user-scope init writes for every agent, for a
// fixed launcher, by a name that says which.
function rendered(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const agent of AGENTS) {
    for (const t of targetsFor({ agent, scope: "user", home: "/home/dev", repoRoot: "/home/dev/repo", version: VERSION, runner: LAUNCHER, launcher: LAUNCHER, clineCli: true }).targets) {
      if (t.kind === "file") out[`${agent}-${basename(t.path)}`] = t.content;
      else if (t.kind === "md-section") out[`${agent}-section.md`] = `${t.section}\n`;
      else if (t.kind === "hook-json") out[`${agent}-hook.json`] = `${JSON.stringify(t.group, null, 2)}\n`;
      else if (t.kind === "mcp-json") out[`${agent}-mcp.json`] = `${JSON.stringify(t.entry, null, 2)}\n`;
      else if (t.kind === "mcp-toml") out[`${agent}-mcp.toml`] = `${t.block}\n`;
      else out[`${agent}-allow-rules.json`] = `${JSON.stringify(t.rules, null, 2)}\n`;
    }
  }
  return out;
}

function copy(n: number): Record<string, string> {
  const dir = join(COPIES_DIR, String(n));
  return Object.fromEntries(readdirSync(dir).map((f) => [f, readFileSync(join(dir, f), "utf8")]));
}

function copyHash(files: Record<string, string>): string {
  const h = createHash("sha256");
  for (const name of Object.keys(files).sort()) h.update(`${name}\0${files[name]}\0`);
  return h.digest("hex");
}

describe("the user-scope agent files", () => {
  it("name no version, no review command and no reviewer, only the launcher's guide (failure 1)", () => {
    for (const [name, text] of Object.entries(rendered())) {
      if (name.endsWith("allow-rules.json")) continue;
      expect(text, name).not.toContain(VERSION);
      expect(text, name).not.toMatch(/npx -y openqodex@/);
      expect(text, name).not.toMatch(/openqodex (review|scan|trust|report)\b/);
      expect(text, name).not.toMatch(/subagent|reviewer process|who reviews/i);
    }
    for (const name of ["claude-code-SKILL.md", "cursor-openqodex.mdc", "cline-openqodex.md", "goose-SKILL.md"]) expect(rendered()[name], name).toContain(`${LAUNCHER} guide skill`);
  });

  it("are the copy checked in for the running agentContract: changing one needs a new contract and a new copy (failure 2)", () => {
    const n = runningContract().agent;
    expect(Object.keys(COPIES).map(Number), `add test/fixtures/agent-contract/${n}/ and its hash for agentContract ${n}`).toContain(n);
    expect(rendered()).toEqual(copy(n));
  });

  it("each checked-in copy is pinned by its hash, so none is rewritten under its number (failure 3)", () => {
    const dirs = readdirSync(COPIES_DIR).map(Number).sort((a, b) => a - b);
    expect(dirs).toEqual(Object.keys(COPIES).map(Number).sort((a, b) => a - b));
    for (const n of dirs) expect(copyHash(copy(n)), `copy ${n}`).toBe(COPIES[n]);
  });
});
