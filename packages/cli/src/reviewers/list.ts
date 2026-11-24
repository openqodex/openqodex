// The project's reviewer list (review.reviewers in .openqodex/config.yaml)
// as the commands use it: the one-run override from the command line, the
// list `init` writes when the file has none, and whether each entry can
// start on this machine (doctor, init).
import { OpenQodexError, REVIEWERS_SINCE, entryLabel, reviewerEffortProblem, reviewerModelProblem } from "@openqodex/core";
import type { ReviewerEntry } from "@openqodex/core";
import { REVIEWER_NAMES, entryCanStart, hostAgent, readinessCache } from "@openqodex/review";
import type { ReviewerDriver } from "@openqodex/review";
import { isMap, parseDocument } from "yaml";
import type { Document, Pair } from "yaml";
import { asMapping } from "../user-config.js";

// What reviews this run. `--reviewer <tool>:<model>`, or a tool with
// --reviewer-effort, replaces the project's list for this run with that
// one entry, and nothing falls back from it. `--reviewer auto` and a tool
// named alone keep their old meaning: the first reviewer that can start, as
// `auto` orders them, with its own default model. With no flag, the
// project's list, else `auto`. The model is cut at the first `:` only, so
// a Bedrock id (`...-v1:0`) stays whole.
export function reviewerChoice(flag: string | undefined, effort: string | undefined, listed: readonly ReviewerEntry[] | undefined): string | ReviewerEntry[] {
  if (flag === undefined || flag === "auto") {
    if (effort !== undefined) throw new OpenQodexError(`--reviewer-effort goes with --reviewer <tool> or --reviewer <tool>:<model>, which says whose effort it is${flag === "auto" ? ", not auto" : ""}`);
    return flag ?? (listed !== undefined && listed.length > 0 ? [...listed] : "auto");
  }
  const at = flag.indexOf(":");
  const tool = at < 0 ? flag : flag.slice(0, at);
  const model = at < 0 ? undefined : flag.slice(at + 1);
  if (!(REVIEWER_NAMES as readonly string[]).includes(tool)) throw new OpenQodexError(`--reviewer must be auto, one of ${REVIEWER_NAMES.join(", ")}, or <tool>:<model> such as claude:opus, not ${flag}`);
  if (model === undefined && effort === undefined) return tool;
  const modelBad = model === undefined ? null : reviewerModelProblem(tool, model);
  if (modelBad !== null) throw new OpenQodexError(`--reviewer ${flag}: the model ${modelBad}`);
  const effortBad = effort === undefined ? null : reviewerEffortProblem(tool, effort);
  if (effortBad !== null) throw new OpenQodexError(`--reviewer-effort ${effortBad}`);
  return [{ tool, ...(model !== undefined ? { model } : {}), ...(effort !== undefined ? { effort } : {}) }];
}

// The list `init` writes when the project has none: the agent running init
// first, then the other one when it can start here. Claude Code reviews with
// opus at high effort; Codex with the first model its login lists (left
// out when that list cannot be read) at high effort. Nothing when neither
// agent runs init nor can start: the project then reviews with `auto`.
export async function defaultReviewerList(drivers: readonly ReviewerDriver[], repoRoot: string): Promise<{ entries: ReviewerEntry[]; ready: boolean[] }> {
  const host = hostAgent();
  const order = (["claude", "codex"] as const).slice().sort((a, b) => Number(b === host) - Number(a === host));
  const entries: ReviewerEntry[] = [];
  const ready: boolean[] = [];
  for (const tool of order) {
    const driver = drivers.find((d) => d.name === tool);
    if (driver === undefined) continue;
    const d = await driver.detect(repoRoot);
    if (!d.ok && tool !== host) continue;
    if (tool === "claude") entries.push({ tool, model: "opus", effort: "high" });
    else {
      const top = d.ok && driver.models ? ((await driver.models(d.bin))?.top ?? null) : null;
      // A slug the config would refuse is left out: Codex's own default then.
      entries.push({ tool, ...(top !== null && reviewerModelProblem("codex", top) === null ? { model: top } : {}), effort: "high" });
    }
    ready.push(d.ok);
  }
  return { entries, ready };
}

const newer = (a: string, b: string): boolean => {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
};

// `before` with review.reviewers set to `entries`, and min_version set to
// REVIEWERS_SINCE right after `version` when the file has none, so an older
// openqodex stops and names the version it needs instead of ignoring the
// list. Null when the file already has review.reviewers (even an empty
// list): that is the team's choice and stays. Every other key, value and
// comment of the file is kept; a min_version already there is never
// changed. `oldMin` names a min_version older than REVIEWERS_SINCE.
//
// `running` is this openqodex. A build older than REVIEWERS_SINCE (one made
// before the release that sets it, by scripts/sync-version.mjs) writes no
// min_version: it would refuse the file it just wrote.
export function insertReviewerList(before: string, entries: readonly ReviewerEntry[], running: string = __OPENQODEX_VERSION__): { text: string; oldMin: string | null } | null {
  const parsed = parseDocument(before);
  if (parsed.errors.length > 0) return null;
  const doc = parsed as unknown as Document;
  const block = doc.has("pr_review") && !doc.has("review") ? "pr_review" : "review";
  if (doc.hasIn([block, "reviewers"])) return null;
  // A file of comments only keeps them.
  asMapping(doc);
  if (!isMap(doc.contents)) return null;
  try {
    doc.setIn([block, "reviewers"], doc.createNode(entries.map((e) => ({ ...e }))));
  } catch {
    // The block is not a mapping (`review: x`): the parser names that, and
    // nothing is written.
    return null;
  }
  const min = doc.get("min_version");
  let oldMin: string | null = null;
  if (newer(REVIEWERS_SINCE, running)) {
    // Not released yet: see above.
  } else if (min === undefined || min === null) {
    // `min_version:` with no value is set in place, never written twice.
    if (doc.has("min_version")) doc.set("min_version", REVIEWERS_SINCE);
    else {
      const items = doc.contents.items as Pair[];
      const at = items.findIndex((p) => (p.key as { value?: unknown } | null)?.value === "version");
      items.splice(at < 0 ? 0 : at + 1, 0, doc.createPair("min_version", REVIEWERS_SINCE));
    }
  } else if (newer(REVIEWERS_SINCE, String(min))) oldMin = String(min);
  return { text: doc.toString(), oldMin };
}

// Each entry of a project's list, and whether it can start on this
// machine, with the reason when it cannot, and whether its model was
// confirmed. Nothing is started. Every entry shares one readiness cache, so
// each tool is checked once, however long the list.
export async function listReadiness(entries: readonly ReviewerEntry[], drivers: readonly ReviewerDriver[], repoRoot: string): Promise<{ entry: ReviewerEntry; label: string; version: string | null; line: string }[]> {
  const cache = readinessCache();
  const found = await Promise.all(entries.map((e) => entryCanStart(e, drivers, repoRoot, cache)));
  return entries.map((entry, i) => {
    const f = found[i]!;
    return { entry, label: entryLabel(entry), version: f.ok ? f.version : null, line: f.ok ? `can start here (${f.driver.name} ${f.version})${f.modelChecked ? "" : `; whether model ${entry.model} serves this login shows only when a review starts`}` : `cannot start here: ${f.reason}` };
  });
}
