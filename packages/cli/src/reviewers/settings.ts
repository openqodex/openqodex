// The reviewer keys of the user config, <openqodex home>/config.yaml, read
// through the one reader every command uses (user-config.ts):
//   reviewer: auto | claude | codex | cursor   which agent reviews (the
//                                              --reviewer flag wins)
//   reviewer_web: on | off                     whether the reviewer gets its
//                                              agent's web tools
//   reviewer_model: <model id>                 the Codex reviewer's model
//                                              (--reviewer-model wins)
//   reviewer_effort: low | medium | high | xhigh   the Codex reviewer's
//                                              reasoning effort
//                                              (--reviewer-effort wins)
// The model and the effort reach Codex only: one value cannot name a model
// of both agents, and `auto` picks either. Claude Code takes its model from
// ANTHROPIC_MODEL, which its reviewer already gets.
// A file that cannot be used, or a value openqodex does not know, stops the
// review with the file named, rather than reviewing with a setting the
// developer did not choose. A key it does not know is named, with the known
// key nearest to it, in a warning.
import { OpenQodexError } from "@openqodex/core";
import { openqodexHomeDir } from "../launcher.js";
import { readUserConfig, unknownKeysWarning } from "../user-config.js";
import { REVIEWER_NAMES } from "@openqodex/review";

// The one place the default lives. On (owner's decision, 2026-10-04): the
// reviewer can look up a library or an advisory while it reviews. A reviewer
// that reads private code and untrusted text and can open web addresses can
// be talked into sending the code out, so `reviewer_web: off` removes the web
// tools (docs/security.md).
export const DEFAULT_REVIEWER_WEB: "on" | "off" = "on";

// The reasoning efforts the Codex reviewer takes (Codex's
// model_reasoning_effort). `minimal` is left out: OpenAI refuses web search
// at that effort.
export const REVIEWER_EFFORTS = ["low", "medium", "high", "xhigh"] as const;

// A model id as Codex names one (`gpt-5.5`, `o3`): letters, digits and
// `.`, `-`, `_`, `:`, `/`, never starting with `-`, so it cannot read as a flag.
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

// Null when `value` is a model id the reviewer can be given, else why not.
export function modelProblem(value: unknown): string | null {
  return typeof value === "string" && MODEL_ID.test(value) ? null : `must be a model id such as gpt-5.5, not ${String(value)}`;
}

// Null when `value` is a reasoning effort the reviewer can be given, else why not.
export function effortProblem(value: unknown): string | null {
  return typeof value === "string" && (REVIEWER_EFFORTS as readonly string[]).includes(value) ? null : `must be one of ${REVIEWER_EFFORTS.join(", ")}, not ${String(value)}`;
}

// `warnings`: lines for the command to print, one per problem it can go on with.
// `model` and `effort`: null leaves Codex's own default.
export type ReviewerSettings = { reviewer: string; web: boolean; model: string | null; effort: string | null; warnings: string[] };

export function readReviewerSettings(home: string = openqodexHomeDir()): ReviewerSettings {
  const config = readUserConfig(home);
  if (config.error !== null) throw new OpenQodexError(`${config.error}; fix it or remove it`);
  const reviewer = config.values.reviewer ?? "auto";
  if (typeof reviewer !== "string" || !["auto", ...REVIEWER_NAMES].includes(reviewer)) {
    throw new OpenQodexError(`${config.path}: reviewer must be auto or one of ${REVIEWER_NAMES.join(", ")}, not ${String(reviewer)}`);
  }
  const web = config.values.reviewer_web ?? DEFAULT_REVIEWER_WEB;
  if (web !== "on" && web !== "off" && web !== true && web !== false) {
    throw new OpenQodexError(`${config.path}: reviewer_web must be on or off, not ${String(web)}`);
  }
  const model = config.values.reviewer_model ?? null;
  const modelBad = model === null ? null : modelProblem(model);
  if (modelBad !== null) throw new OpenQodexError(`${config.path}: reviewer_model ${modelBad}`);
  const effort = config.values.reviewer_effort ?? null;
  const effortBad = effort === null ? null : effortProblem(effort);
  if (effortBad !== null) throw new OpenQodexError(`${config.path}: reviewer_effort ${effortBad}`);
  const unknown = unknownKeysWarning(config);
  return { reviewer, web: web === "on" || web === true, model: model as string | null, effort: effort as string | null, warnings: unknown === null ? [] : [unknown] };
}
