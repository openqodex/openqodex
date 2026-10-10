// The reviewer keys of the user config, <openqodex home>/config.yaml, read
// through the one reader every command uses (user-config.ts):
//   reviewer: auto | claude | codex | cursor   which agent reviews (the
//                                              --reviewer flag wins)
//   reviewer_web: on | off                     whether the reviewer gets its
//                                              agent's web tools
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

// `warnings`: lines for the command to print, one per problem it can go on with.
export type ReviewerSettings = { reviewer: string; web: boolean; warnings: string[] };

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
  const unknown = unknownKeysWarning(config);
  return { reviewer, web: web === "on" || web === true, warnings: unknown === null ? [] : [unknown] };
}
