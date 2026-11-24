// The reviewer is the project's choice now: review.reviewers and
// review.reviewer_web in the project's config file, shared by the whole
// team. The user config, <openqodex home>/config.yaml, held four reviewer
// keys up to 0.23.0:
//   reviewer: auto | claude | codex | cursor
//   reviewer_web: on | off
//   reviewer_model: <model id>       (Codex only)
//   reviewer_effort: low | ... | xhigh   (Codex only)
// Three of them are not read for a review any more. A personal
// `reviewer_web: off` still turns the web tools off, for now: an opt-out
// is never dropped without a word (personalWebOff). They stay known keys of
// the user config (user-config.ts), so a file that still holds them never
// pauses automatic updates; a review prints one warning that names them and
// the exact lines to add to the project's file instead.
import { CONFIG_FILE, CONFIG_MAX_BYTES, LEGACY_CONFIG_FILE, REVIEWER_EFFORTS, readRepoFile, reviewerModelProblem, shownValue } from "@openqodex/core";
import { isMap, parseDocument } from "yaml";
import { openqodexHomeDir } from "../launcher.js";
import { readUserConfig, unknownKeysWarning } from "../user-config.js";
import type { UserConfig } from "../user-config.js";

// The retired keys, in the order the warning names them.
export const RETIRED_REVIEWER_KEYS = ["reviewer", "reviewer_web", "reviewer_model", "reviewer_effort"] as const;

const set = (value: unknown): boolean => value !== undefined && value !== null;
const off = (value: unknown): boolean => value === "off" || value === false;

// The project file the advice is for: the one a review reads (the folder
// file, else the root file of before 0.2.0), with its text, else the folder
// file to create. `block` is the review block it already has, if any.
export type ProjectFile = { file: string; block: "review" | "pr_review" | null; has: { reviewers: boolean; reviewer_web: boolean } };

export function projectFile(repoRoot: string | null): ProjectFile {
  const none: ProjectFile = { file: CONFIG_FILE, block: null, has: { reviewers: false, reviewer_web: false } };
  if (repoRoot === null) return none;
  for (const file of [CONFIG_FILE, LEGACY_CONFIG_FILE]) {
    let text: string | null;
    try { text = readRepoFile(repoRoot, file, CONFIG_MAX_BYTES); }
    catch { text = null; }
    if (text === null) continue;
    const doc = parseDocument(text);
    if (doc.errors.length > 0 || !isMap(doc.contents)) return { ...none, file };
    const block = doc.has("review") ? "review" : doc.has("pr_review") ? "pr_review" : null;
    return { file, block, has: { reviewers: block !== null && doc.hasIn([block, "reviewers"]), reviewer_web: block !== null && doc.hasIn([block, "reviewer_web"]) } };
  }
  return none;
}

// The lines of the project's file that keep what the retired keys did: the
// reviewer they chose with the model and effort, which reached Codex only,
// and `reviewer_web: off`. `reviewer: auto` needs no list: a project with
// none keeps the auto order. A value that was not valid there is not
// carried over, and a key the file already has is not repeated. A model is
// quoted, so a pasted `"123"` stays a string.
function projectLines(v: UserConfig["values"], project: ProjectFile): string[] {
  const reviewer = typeof v.reviewer === "string" ? v.reviewer : "auto";
  const model = typeof v.reviewer_model === "string" && reviewerModelProblem("codex", v.reviewer_model) === null ? v.reviewer_model : null;
  const effort = typeof v.reviewer_effort === "string" && REVIEWER_EFFORTS.codex.includes(v.reviewer_effort) ? v.reviewer_effort : null;
  const tool = reviewer === "claude" || reviewer === "codex" ? reviewer : null;
  const lines: string[] = [];
  if (tool !== null && !project.has.reviewers) {
    lines.push("reviewers:", `  - tool: ${tool}`);
    if (tool === "codex" && model !== null) lines.push(`    model: ${JSON.stringify(model)}`);
    if (tool === "codex" && effort !== null) lines.push(`    effort: ${effort}`);
  }
  if (off(v.reviewer_web) && !project.has.reviewer_web) lines.push("reviewer_web: off");
  return lines;
}

// Whether the retired personal `reviewer_web: off` is set. It keeps the web
// tools off when the project's file sets no review.reviewer_web (or sets
// on) and the command line does not say on: an opt-out made before the
// move is not dropped on upgrade.
export function personalWebOff(home: string = openqodexHomeDir()): boolean {
  const config = readUserConfig(home);
  return config.error === null && off(config.values.reviewer_web);
}

// The one warning for a user config that still holds a retired key, or null.
export function retiredReviewerWarning(config: UserConfig, project: ProjectFile = projectFile(null)): string | null {
  const present = RETIRED_REVIEWER_KEYS.filter((k) => set(config.values[k]));
  if (present.length === 0) return null;
  const named = present.map((k) => `${k}: ${shownValue(config.values[k])}`).join(", ");
  const lines = projectLines(config.values, project);
  const out = [`${config.path} sets ${named}. openqodex no longer reads ${present.length === 1 ? "it" : "them"} there: each project chooses its reviewer in its own config file, which the whole team shares.`];
  if (lines.length > 0) {
    if (project.block === null) out.push(`To keep this choice, add these lines to the project's ${project.file}:`, ...["review:", ...lines.map((l) => `  ${l}`)].map((l) => `  ${l}`));
    else out.push(`To keep this choice, add these lines inside the ${project.block}: block of the project's ${project.file}:`, ...lines.map((l) => `    ${l}`));
  } else if (project.has.reviewers || project.has.reviewer_web) out.push(`The project's ${project.file} already sets its own, and a review uses that.`);
  if (config.values.reviewer === "auto" || (!set(config.values.reviewer) && (set(config.values.reviewer_model) || set(config.values.reviewer_effort)))) {
    out.push("reviewer: auto needs no line: a project with no review.reviewers keeps the auto order (the agent you run the review from, then Claude Code, then Codex). A list is optional; `openqodex guide config` says how to write one with a model and effort.");
  }
  out.push(`Then delete ${present.join(", ")} from ${config.path}.`);
  if (off(config.values.reviewer_web)) out.push(`Your reviewer_web: off still keeps the reviewer's web tools off for now, unless --reviewer-web on is given; a later release stops reading it here, so move it into the project's ${project.file}.`);
  return out.join("\n");
}

// What a review prints about the user config, one warning each: a file
// that cannot be used, keys this version does not know, and the retired
// reviewer keys. None of them stops the review: the file holds nothing a
// review reads.
export function userConfigNotes(home: string = openqodexHomeDir(), repoRoot: string | null = null): string[] {
  const config = readUserConfig(home);
  if (config.error !== null) return [`${config.error}; automatic updates are off until it is fixed`];
  return [unknownKeysWarning(config), retiredReviewerWarning(config, projectFile(repoRoot))].filter((w): w is string => w !== null);
}
