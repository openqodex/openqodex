// The contract a release keeps with what is already on a machine, declared
// in its package.json and so in the registry's metadata for that version:
//
//   "openqodex": { "agentContract": 1, "configFormat": 1 }
//
// agentContract: bumped when the procedure the user-scope agent files or
// the Claude Code permission rules depend on changes (the commands an agent
// runs, what the files must say). test/agent-contract.test.ts holds every
// user-scope file to the copy checked in for this number, so changing one
// without a bump fails. A change that a file an older init wrote still works
// with beside the new binary is checked in there as a revision of the same
// number instead, with no bump.
// configFormat: bumped when a key of the repo or user config changes
// meaning in a way an existing file cannot keep (CONFIG_CHANGES in the core
// package handles renames and removals without a bump).
//
// The background update installs only a release with the same two numbers
// as the running one. A release with other numbers is announced and waits
// for a foreground `openqodex update`, after which `openqodex init`
// refreshes the agent files. Releases before this field existed declare
// none; their workers never read it.
import { readFileSync } from "node:fs";
import { assetPath } from "./assets.js";

export type Contract = { agent: number; config: number };

function positive(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

// The contract a package manifest (a package.json, or one version of the
// registry's metadata) declares; null when it declares none or one that
// does not parse.
export function contractOf(manifest: unknown): Contract | null {
  if (typeof manifest !== "object" || manifest === null) return null;
  const block = (manifest as { openqodex?: unknown }).openqodex;
  if (typeof block !== "object" || block === null) return null;
  const agent = positive((block as { agentContract?: unknown }).agentContract);
  const config = positive((block as { configFormat?: unknown }).configFormat);
  return agent === null || config === null ? null : { agent, config };
}

export function sameContract(a: Contract | null, b: Contract | null): boolean {
  return a === null || b === null ? a === b : a.agent === b.agent && a.config === b.config;
}

export function contractText(c: Contract | null): string {
  return c === null ? "none" : `agent ${c.agent}, config ${c.config}`;
}

let running: Contract | null = null;

// The contract of the running package, from its own package.json.
export function runningContract(): Contract {
  if (running === null) {
    const c = contractOf(JSON.parse(readFileSync(assetPath("package.json"), "utf8")));
    if (c === null) throw new Error(`${assetPath("package.json")} declares no openqodex contract`);
    running = c;
  }
  return running;
}
