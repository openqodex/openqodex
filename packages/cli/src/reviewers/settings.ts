// The reviewer is the project's choice now: review.reviewers and
// review.reviewer_web in .openqodex/config.yaml, shared by the whole team.
// The user config, <openqodex home>/config.yaml, held four reviewer keys up
// to 0.23.0:
//   reviewer: auto | claude | codex | cursor
//   reviewer_web: on | off
//   reviewer_model: <model id>       (Codex only)
//   reviewer_effort: low | ... | xhigh   (Codex only)
// None of them is read for a review any more. They stay known keys of the
// user config (user-config.ts), so a file that still holds them never pauses
// automatic updates; a review prints one warning that names them and the
// exact lines to add to the project's file instead.
import { REVIEWER_EFFORTS, reviewerModelProblem, shownValue } from "@openqodex/core";
import { openqodexHomeDir } from "../launcher.js";
import { readUserConfig, unknownKeysWarning } from "../user-config.js";
import type { UserConfig } from "../user-config.js";

// The retired keys, in the order the warning names them.
export const RETIRED_REVIEWER_KEYS = ["reviewer", "reviewer_web", "reviewer_model", "reviewer_effort"] as const;

const set = (value: unknown): boolean => value !== undefined && value !== null;
const off = (value: unknown): boolean => value === "off" || value === false;

// The lines of .openqodex/config.yaml that keep what the retired keys did:
// the reviewer they chose, and the model and effort, which reached Codex
// only (so a model or effort under `reviewer: auto` names Codex). A value
// that was not valid there is not carried over.
function projectLines(v: UserConfig["values"]): string[] {
  const reviewer = typeof v.reviewer === "string" ? v.reviewer : "auto";
  const model = typeof v.reviewer_model === "string" && reviewerModelProblem("codex", v.reviewer_model) === null ? v.reviewer_model : null;
  const effort = typeof v.reviewer_effort === "string" && REVIEWER_EFFORTS.codex.includes(v.reviewer_effort) ? v.reviewer_effort : null;
  const tool = reviewer === "claude" || reviewer === "codex" ? reviewer : model !== null || effort !== null ? "codex" : null;
  const lines: string[] = [];
  if (tool !== null) {
    lines.push("  reviewers:", `    - tool: ${tool}`);
    if (tool === "codex" && model !== null) lines.push(`      model: ${model}`);
    if (tool === "codex" && effort !== null) lines.push(`      effort: ${effort}`);
  }
  if (off(v.reviewer_web)) lines.push("  reviewer_web: off");
  return lines.length === 0 ? [] : ["review:", ...lines];
}

// The one warning for a user config that still holds a retired key, or null.
export function retiredReviewerWarning(config: UserConfig): string | null {
  const present = RETIRED_REVIEWER_KEYS.filter((k) => set(config.values[k]));
  if (present.length === 0) return null;
  const named = present.map((k) => `${k}: ${shownValue(config.values[k])}`).join(", ");
  const lines = projectLines(config.values);
  const out = [`${config.path} sets ${named}. openqodex no longer reads ${present.length === 1 ? "it" : "them"} there: each project chooses its reviewer in .openqodex/config.yaml, which the whole team shares.`];
  if (lines.length > 0) out.push("To keep this choice, add these lines to the project's .openqodex/config.yaml (into its review block, if it has one):", ...lines.map((l) => `  ${l}`));
  out.push(`Then delete ${present.join(", ")} from ${config.path}.`);
  if (off(config.values.reviewer_web)) out.push("Until the project's file says reviewer_web: off, the reviewer keeps its web tools: your reviewer_web: off is not honoured any more.");
  return out.join("\n");
}

// What a review prints about the user config, one warning each: a file
// that cannot be used, keys this version does not know, and the retired
// reviewer keys. None of them stops the review: the file holds nothing a
// review reads.
export function userConfigNotes(home: string = openqodexHomeDir()): string[] {
  const config = readUserConfig(home);
  if (config.error !== null) return [`${config.error}; automatic updates are off until it is fixed`];
  return [unknownKeysWarning(config), retiredReviewerWarning(config)].filter((w): w is string => w !== null);
}
