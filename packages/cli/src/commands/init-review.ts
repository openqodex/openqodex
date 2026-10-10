// The review `init` ends with, after the install boundary is released: of
// the change when the repository has one; else one question (the whole
// repository, a pull request, a branch, not now); without a terminal, the
// three commands instead of the question. It runs in this process and
// never throws: init's exit code is about the install. It ends with one
// line, "First review: <how it ended>".
//
// init has just started the downloads of the scanners this repo calls for.
// The review joins them, as any review joins a download in progress, for up
// to FIRST_REVIEW_INSTALL_WAIT_MS, then names the ones still downloading;
// it resolves only the scanners its own change calls for.
import { isAbsolute, relative, resolve } from "node:path";
import { getChange, loadConfig } from "@openqodex/core";
import { parseFlags } from "../flags.js";
import { DEFAULT_TIMEOUT_SECONDS, runReview } from "../review-run.js";
import type { ReviewEnd, ReviewOptions } from "../review-run.js";
import type { ReviewerDriver } from "@openqodex/review";

export type Choice = { kind: "all" } | { kind: "target"; target: string } | null;

// How long the first review waits for a scanner still downloading. A
// review's usual 45 seconds left semgrep, osv-scanner and hadolint out of the
// demo's first run on an Apple Silicon Mac (measured 2026-10-07): the first
// review had the fewest scanners of any. Two minutes covers the big downloads on an
// ordinary line and still bounds the wait; the review itself takes one to three.
export const FIRST_REVIEW_INSTALL_WAIT_MS = 120_000;

// How the first review ended: it ran to a complete report (finished), ran
// and was not complete (incomplete), was not run (skipped, with the reason),
// or found no reviewer that could start (unavailable).
export type FirstReview = "finished" | "incomplete" | "skipped" | "unavailable";

function out(line = ""): void {
  process.stdout.write(`${line}\n`);
}

export function firstReviewLine(ended: FirstReview, why?: string): void {
  out(`First review: ${ended}${why !== undefined ? ` (${why})` : ""}.`);
}

async function askWhat(): Promise<Choice> {
  const prompts = await import("@clack/prompts");
  const what = await prompts.select({
    message: "There is no change to review here. What should OpenQodex review?",
    options: [
      { value: "all", label: "The whole repository" },
      { value: "pr", label: "A pull request" },
      { value: "branch", label: "A branch" },
      { value: "none", label: "Not now" },
    ],
  });
  if (prompts.isCancel(what) || what === "none") return null;
  if (what === "all") return { kind: "all" };
  const answer = await prompts.text({ message: what === "pr" ? "Pull request number or link" : "Branch name" });
  if (prompts.isCancel(answer) || answer.trim() === "") return null;
  const target = answer.trim();
  return { kind: "target", target: what === "pr" && /^\d+$/.test(target) ? `#${target}` : target };
}

export async function reviewAfterInit(o: {
  repoRoot: string;
  // The command the developer types: the launcher, or the pinned npx form.
  runner: string;
  // A terminal to ask in, and no --yes.
  interactive: boolean;
  // The files init wrote in this run, by absolute path, each with its text
  // from before init wrote it (null when init created it). The review takes
  // them as they were, so a developer's own earlier edit to CLAUDE.md is
  // reviewed and the section init added to it is not.
  initFiles?: Map<string, string | null>;
  // Tests pass a model provider stand-in.
  drivers?: ReviewerDriver[];
  ask?: () => Promise<Choice>;
  // FIRST_REVIEW_INSTALL_WAIT_MS unless a test asks for less.
  installWaitMs?: number;
}): Promise<FirstReview> {
  const ended = await firstReview(o);
  firstReviewLine(ended.ended, ended.why);
  return ended.ended;
}

async function firstReview(o: Parameters<typeof reviewAfterInit>[0]): Promise<{ ended: FirstReview; why?: string }> {
  try {
    const { global } = parseFlags(["--cwd", o.repoRoot], {});
    const installBudgetMs = o.installWaitMs ?? FIRST_REVIEW_INSTALL_WAIT_MS;
    const review = async (extra: Partial<ReviewOptions>): Promise<{ ended: FirstReview; why?: string }> => {
      const end: ReviewEnd = { ended: "nothing", installing: [] };
      await runReview({ flags: global, scope: {}, noGraph: false, timeoutMs: DEFAULT_TIMEOUT_SECONDS * 1000, drivers: o.drivers, end, installBudgetMs, ...extra });
      if (end.installing.length > 0) out(`Still downloading: ${end.installing.join(", ")}. The next review includes them once they finish.`);
      return end.ended === "nothing" ? { ended: "skipped", why: "nothing to review" } : { ended: end.ended, why: end.why };
    };
    const { config } = loadConfig(o.repoRoot, undefined, { runtimeVersion: __OPENQODEX_VERSION__ });
    const overlay = [...(o.initFiles ?? new Map<string, string | null>())]
      .map(([path, content]) => ({ path: relative(resolve(o.repoRoot), resolve(path)), content }))
      .filter((f) => f.path !== "" && !f.path.startsWith("..") && !isAbsolute(f.path));
    const change = await getChange({ repoRoot: o.repoRoot, scope: {}, exclude: config.exclude, defaultBase: config.defaultBase, overlay });
    if (change.files.length > 0) {
      out();
      out("Reviewing your change now. This takes one to three minutes.");
      return await review({ overlay });
    }
    if (!o.interactive) {
      out();
      out("No change to review here. To review something else, run one of these:");
      out(`  ${o.runner} review --all          the whole repository`);
      out(`  ${o.runner} review '#<number>'    a pull request`);
      out(`  ${o.runner} review <branch>       a branch`);
      return { ended: "skipped", why: "no change to review" };
    }
    const choice = await (o.ask ?? askWhat)();
    if (choice === null) return { ended: "skipped", why: "not now" };
    return await review(choice.kind === "all" ? { all: true } : { target: choice.target });
  } catch (error) {
    process.stderr.write(`openqodex: the review after init did not run: ${error instanceof Error ? error.message : String(error)}\n`);
    return { ended: "incomplete", why: "the review stopped with an error, shown above" };
  }
}
