// The reviewers a project lists in .openqodex/config.yaml, under
// review.reviewers, tried top to bottom, and the values each tool takes.
// The same checks serve the file and the --reviewer and --reviewer-effort
// flags, so a value is refused the same way wherever it was written.
//
//   claude  model: an alias (fable, opus, sonnet, haiku, best, default, with
//           a suffix such as sonnet[1m]) or a full model id, as Claude
//           Code's --model takes it; effort: low, medium, high, xhigh, max
//   codex   model: a Codex model id (gpt-5.5, o3), as -m takes it; effort:
//           low, medium, high, xhigh. `minimal` is left out: OpenAI refuses
//           web search at that effort.
//
// No value may start with `-`, so none can read as a flag on the agent's
// command line.

// The tools a list may name.
export const LISTED_REVIEWERS = ["claude", "codex"] as const;
export type ListedReviewer = (typeof LISTED_REVIEWERS)[number];

// One entry of the list. `model` and `effort` left out: the tool's own default.
export type ReviewerEntry = { tool: string; model?: string; effort?: string };

export const REVIEWER_EFFORTS: Record<ListedReviewer, readonly string[]> = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["low", "medium", "high", "xhigh"],
};

// The first release that reads review.reviewers. `init` writes it as
// min_version, so an older openqodex stops and names it instead of
// ignoring the list. Until that release is cut it holds the next minor
// version; scripts/sync-version.mjs writes the version changesets chose in
// place of a value marked `release: next`.
export const REVIEWERS_SINCE = "0.24.0";

// A Codex model id: letters, digits and `.`, `-`, `_`, `:`, `/`, never
// starting with `-`.
const CODEX_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
// A Claude model: an alias or a full id, also a Bedrock or Vertex one
// (`us.anthropic.claude-sonnet-4-5-20250929-v1:0`, `claude-sonnet-4-5@20250929`),
// with an optional bracketed suffix such as `[1m]`.
const CLAUDE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}(\[[A-Za-z0-9]{1,16}\])?$/;

// A value safe to print on one line: a line break or other control
// character is escaped, and a value that is not a string, number or boolean
// is named by its kind, never converted.
export function shownValue(value: unknown): string {
  // oxlint-disable-next-line no-control-regex
  if (typeof value === "string") return value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return String(value);
  return Array.isArray(value) ? "a list" : typeof value === "object" ? "a mapping" : typeof value;
}

const listed = (tool: string): tool is ListedReviewer => (LISTED_REVIEWERS as readonly string[]).includes(tool);

// Null when `value` is a model `tool` can be given, else why not.
export function reviewerModelProblem(tool: string, value: unknown): string | null {
  if (!listed(tool)) return `${tool} takes no model`;
  const ok = typeof value === "string" && (tool === "claude" ? CLAUDE_MODEL : CODEX_MODEL).test(value);
  if (ok) return null;
  return tool === "claude" ? `must be a Claude model such as opus, sonnet[1m] or claude-sonnet-5-5, not ${shownValue(value)}` : `must be a Codex model id such as gpt-5.5, not ${shownValue(value)}`;
}

// Null when `value` is a reasoning effort `tool` can be given, else why not.
export function reviewerEffortProblem(tool: string, value: unknown): string | null {
  if (!listed(tool)) return `${tool} takes no effort`;
  const efforts = REVIEWER_EFFORTS[tool];
  return typeof value === "string" && efforts.includes(value) ? null : `must be one of ${efforts.join(", ")} for ${tool}, not ${shownValue(value)}`;
}

// One entry as a person reads it: `claude, model opus, effort high`.
export function entryLabel(entry: ReviewerEntry): string {
  return [entry.tool, ...(entry.model !== undefined ? [`model ${entry.model}`] : []), ...(entry.effort !== undefined ? [`effort ${entry.effort}`] : [])].join(", ");
}
