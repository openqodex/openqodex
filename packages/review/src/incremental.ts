// Incremental review, and the proofs it rests on, made in the host's clone.
//
// The merge base is the host's comparison base: the library proves it is a
// commit the clone holds and an ancestor of the head, and records it as the
// host's (ancestry alone cannot prove that a commit is the merge base). A
// proof that fails ends the review as incomplete with the proof's reason.
//
// The previously reviewed commit is proved the same way. When it is an
// ancestor of the head, the review's obligation (the brief, the scan, the
// coverage) is what changed since it, inside the change: a line the delta
// `previous..head` changed that the change from the merge base also holds.
// So what a merge of the base branch brought in is never a target. Findings
// are still anchored and checked on the whole change. In every other case
// the review is explicitly full, with the reason: the host asked, no
// previous commit, history unknown (a cut history or a commit the clone does
// not hold), diverged (a rewritten branch), not a commit, or a git failure.
import { readFileSync } from "node:fs";
import { OpenQodexError, SERVER_GIT_ENV, getAdmittedTreeChange, safeGit } from "@openqodex/core";
import type { Change, DeletionPoint } from "@openqodex/core";
import type { Admit } from "./scopes.js";

// What the review covers, and why: `result.scope`.
export type ReviewScope = { kind: "delta" | "full"; reason: string };

export type IncrementalDecision =
  // The merge base or the head failed a proof: the review is incomplete.
  | { ok: false; reason: string }
  | { ok: true; scope: ReviewScope; previousReviewedSha: string | null; mergeBase: { sha: string; suppliedBy: "host" } };

const FULL_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

// Every git call on the clone ignores replacement refs (SERVER_GIT_ENV), so
// a ref in the clone cannot forge an ancestry proof.
const cloneGit = (clonePath: string, args: string[]) => safeGit(clonePath, args, undefined, { ...SERVER_GIT_ENV });
const short = (sha: string) => sha.slice(0, 12);
// More shallow commits than this are not each checked: the history is then
// taken as unknown, which never narrows a review.
const MAX_SHALLOW_CHECKS = 100;

type Proof = { ok: true } | { ok: false; key: "not a commit" | "missing commit" | "history unknown" | "diverged" | "git failed"; detail: string };

const gitFailed = (r: { code: number; stderr: string }): Proof => ({ ok: false, key: "git failed", detail: r.stderr.trim().split("\n")[0] || `exit ${r.code}` });

// `sha` names a commit the clone holds: a full id that `<sha>^{commit}`
// resolves to itself. A tag, a tree or a blob is not a commit.
async function proveCommit(clonePath: string, name: string, sha: string): Promise<Proof> {
  if (typeof sha !== "string" || !FULL_ID.test(sha)) return { ok: false, key: "not a commit", detail: `${name} ${JSON.stringify(String(sha).slice(0, 80))} is not a full commit id` };
  const peeled = await cloneGit(clonePath, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${sha}^{commit}`]);
  if (peeled.code === 0 && peeled.stdout.toString("utf8").trim() === sha) return { ok: true };
  const type = await cloneGit(clonePath, ["cat-file", "-t", sha]);
  if (type.code === 0) return { ok: false, key: "not a commit", detail: `${name} ${short(sha)} is a ${type.stdout.toString("utf8").trim()}` };
  if (/not a valid object name|could not get object info|unable to read|missing/i.test(type.stderr)) return { ok: false, key: "missing commit", detail: `${name} ${short(sha)} is not in the clone` };
  return gitFailed(type);
}

// The shallow commits of the clone (where its history is cut), null when
// it is not shallow, or "unreadable" when it is shallow but the list of
// them cannot be read.
async function shallowCommits(clonePath: string): Promise<string[] | null | "unreadable" | Proof> {
  const r = await cloneGit(clonePath, ["rev-parse", "--is-shallow-repository"]);
  if (r.code !== 0) return gitFailed(r);
  if (r.stdout.toString("utf8").trim() !== "true") return null;
  const listed = await cloneGit(clonePath, ["rev-parse", "--path-format=absolute", "--git-path", "shallow"]);
  if (listed.code !== 0) return gitFailed(listed);
  try {
    return readFileSync(listed.stdout.toString("utf8").trim(), "utf8").split("\n").filter((l) => FULL_ID.test(l));
  } catch {
    return "unreadable";
  }
}

// `ancestor` is an ancestor of `head`. A negative answer is "diverged" only
// when the clone holds the head's whole history; when a cut of a shallow
// clone is reachable from the head (or the cuts cannot all be checked), it
// is "history unknown".
async function proveAncestor(clonePath: string, ancestor: string, head: string): Promise<Proof> {
  const r = await cloneGit(clonePath, ["merge-base", "--is-ancestor", ancestor, head]);
  if (r.code === 0) return { ok: true };
  if (r.code !== 1) return gitFailed(r);
  const unknown: Proof = { ok: false, key: "history unknown", detail: "" };
  const shallow = await shallowCommits(clonePath);
  if (shallow === "unreadable") return unknown;
  if (shallow !== null && !Array.isArray(shallow)) return shallow;
  if (shallow !== null) {
    if (shallow.length > MAX_SHALLOW_CHECKS) return unknown;
    for (const s of shallow) {
      const cut = await cloneGit(clonePath, ["merge-base", "--is-ancestor", s, head]);
      if (cut.code === 0) return unknown;
      if (cut.code !== 1) return gitFailed(cut);
    }
  }
  return { ok: false, key: "diverged", detail: "" };
}

// The proofs and the decision, before anything is scanned. The merge base
// and the head must pass (else `ok: false`, the review is incomplete); the
// previous commit only decides between a delta and a full review.
export async function decideIncremental(args: { clonePath: string; mergeBaseSha: string; headSha: string; previousReviewedSha?: string; fullReviewRequested?: boolean }): Promise<IncrementalDecision> {
  const { clonePath, mergeBaseSha, headSha } = args;
  try {
    for (const [name, sha] of [["the merge base", mergeBaseSha], ["the head", headSha]] as const) {
      if (typeof sha !== "string" || !FULL_ID.test(sha)) return { ok: false, reason: `not a commit: ${name} ${JSON.stringify(String(sha).slice(0, 80))} is not a full commit id` };
    }
    const repo = await cloneGit(clonePath, ["rev-parse", "--git-dir"]);
    if (repo.code !== 0) return { ok: false, reason: `git failed: ${repo.stderr.trim().split("\n")[0] || `exit ${repo.code}`}` };
    for (const [name, sha] of [["the merge base", mergeBaseSha], ["the head", headSha]] as const) {
      const p = await proveCommit(clonePath, name, sha);
      if (!p.ok) return { ok: false, reason: p.key === "missing commit" ? `missing commit: ${p.detail}; fetch it before the review (git fetch origin ${sha})` : `${p.key}: ${p.detail}` };
    }
    const base = await proveAncestor(clonePath, mergeBaseSha, headSha);
    if (!base.ok) {
      const reason =
        base.key === "history unknown"
          ? `history unknown: the clone's history is cut (a shallow clone), so it cannot show that the merge base ${short(mergeBaseSha)} is an ancestor of the head ${short(headSha)}; fetch the history between them (git fetch --deepen, or --unshallow) before the review`
          : base.key === "diverged"
            ? `diverged: the merge base ${short(mergeBaseSha)} is not an ancestor of the head ${short(headSha)}; pass the merge base of the pull request, not the target branch's tip`
            : `${base.key}: ${base.detail}`;
      return { ok: false, reason };
    }
    const mergeBase = { sha: mergeBaseSha, suppliedBy: "host" as const };
    const full = (reason: string): IncrementalDecision => ({ ok: true, scope: { kind: "full", reason }, previousReviewedSha: null, mergeBase });
    if (args.fullReviewRequested) return full("requested: the host asked for a full review");
    const previous = args.previousReviewedSha;
    if (previous === undefined) return full("no previous review: the whole change is reviewed");
    const all = "the whole change is reviewed";
    const isCommit = await proveCommit(clonePath, "the previously reviewed commit", previous);
    if (!isCommit.ok) {
      if (isCommit.key === "missing commit") {
        return full(`history unknown: the previously reviewed commit ${short(previous)} is not in the clone (a force push removes it from the branch); fetch it (git fetch origin ${previous}) to review only what changed since; ${all}`);
      }
      return full(`${isCommit.key}: ${isCommit.detail}; ${all}`);
    }
    const since = await proveAncestor(clonePath, previous, headSha);
    if (!since.ok) {
      if (since.key === "history unknown") {
        return full(`history unknown: the clone's history is cut (a shallow clone), so it cannot show that the previously reviewed commit ${short(previous)} is an ancestor of the head ${short(headSha)}; fetch the history between them (git fetch --deepen, or --unshallow) to review only what changed since; ${all}`);
      }
      if (since.key === "diverged") return full(`diverged: the previously reviewed commit ${short(previous)} is not an ancestor of the head ${short(headSha)} (the branch was rewritten); ${all}`);
      return full(`${since.key}: ${since.detail}; ${all}`);
    }
    return { ok: true, scope: { kind: "delta", reason: `delta: only what changed since the previously reviewed commit ${short(previous)} is reviewed; findings are anchored on the whole change` }, previousReviewedSha: previous, mergeBase };
  } catch (error) {
    if (error instanceof OpenQodexError) return { ok: false, reason: `git failed: ${error.message.split("\n")[0]}` };
    throw error;
  }
}

// The whole change over the admitted paths (what findings anchor on), and
// the review's obligation: for a delta, what changed since the previously
// reviewed commit inside it; for a full review, the whole change itself.
// `renamedIn`: files renamed in from a path the admission refuses, each a
// new file of the change.
export async function reviewChanges(args: {
  clonePath: string;
  baseRef: string;
  mergeBaseSha: string;
  headSha: string;
  admit: Admit;
  exclude: string[];
  decision: Extract<IncrementalDecision, { ok: true }>;
  // Where the change source makes its temporary folders.
  tempRoot?: string;
}): Promise<{ full: Change; obligation: Change; renamedIn: string[] }> {
  const { clonePath, admit, exclude } = args;
  const temp = args.tempRoot !== undefined ? { tempRoot: args.tempRoot } : {};
  const { change: full, renamedIn } = await getAdmittedTreeChange({ repoRoot: clonePath, baseRef: args.baseRef, baseSha: args.mergeBaseSha, headSha: args.headSha, exclude, admit, ...temp });
  const previous = args.decision.previousReviewedSha;
  if (args.decision.scope.kind === "full" || previous === null) return { full, obligation: full, renamedIn };
  const { change: since } = await getAdmittedTreeChange({ repoRoot: clonePath, baseRef: "the previously reviewed commit", baseSha: previous, headSha: args.headSha, exclude, admit, ...temp });
  return { full, obligation: deltaChange(full, since), renamedIn };
}

// A hunk of a file's diff text: its header line's new-side range.
type Hunk = { start: number; count: number; lines: string[] };

// One file's diff text cut to the hunks `keep` accepts, its header lines
// kept; the '+' and '-' lines of what is kept, counted.
function keptHunks(text: string, keep: (h: Hunk) => boolean): { text: string; additions: number; deletions: number; hunks: number } {
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  const head: string[] = [];
  const hunks: Hunk[] = [];
  for (const line of lines) {
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (m) hunks.push({ start: Number(m[1]), count: m[2] === undefined ? 1 : Number(m[2]), lines: [line] });
    else if (hunks.length === 0) head.push(line);
    else hunks[hunks.length - 1]!.lines.push(line);
  }
  if (hunks.length === 0) return { text, additions: 0, deletions: 0, hunks: 0 };
  const kept = hunks.filter(keep);
  let additions = 0;
  let deletions = 0;
  for (const h of kept) {
    for (const l of h.lines.slice(1)) {
      if (l.startsWith("+")) additions++;
      else if (l.startsWith("-")) deletions++;
    }
  }
  return { text: `${[...head, ...kept.flatMap((h) => h.lines)].join("\n")}\n`, additions, deletions, hunks: kept.length };
}

// The whole change cut to what `since` (previous..head over the same
// admitted paths) also changed. Line numbers are the head's in both, so a
// line is kept when both changed it; a deletion when both removed lines at
// the same place. A file the change deletes is kept when `since` deletes it
// too; a binary file, or one too large for coverage, when `since` changed
// it. The brief's diff keeps the whole change's hunks that hold a kept line
// or deletion, so the reviewer reads the change against the merge base, and
// its counts are the lines those hunks add and remove. The id is the whole
// change's: the brief and the check name the same change.
export function deltaChange(full: Change, since: Change): Change {
  const sinceFiles = new Map(since.files.map((f) => [f.path, f]));
  // Files previous..head changed but could not cover (past the coverage
  // limit, as a large merge of the base branch makes it happen).
  const sinceUncovered = new Set(since.uncovered ?? []);
  const coverage = new Map<string, Set<number>>();
  const deletionPoints = new Map<string, DeletionPoint[]>();
  const files = full.files.filter((f) => {
    const s = sinceFiles.get(f.path);
    if (!s) return false;
    if (f.status === "deleted") {
      if (s.status !== "deleted") return false;
      deletionPoints.set(f.path, full.deletionPoints.get(f.path) ?? []);
      return true;
    }
    const was = full.coverage.get(f.path);
    if (f.binary || was === undefined) return true;
    // What changed since cannot be told for this file: its whole-change
    // lines stay the obligation, never an empty one.
    if (sinceUncovered.has(f.path)) {
      coverage.set(f.path, was);
      const points = full.deletionPoints.get(f.path) ?? [];
      if (points.length > 0) deletionPoints.set(f.path, points);
      return true;
    }
    const now = since.coverage.get(f.path) ?? new Set<number>();
    const lines = new Set([...was].filter((n) => now.has(n)));
    const at = new Set((since.deletionPoints.get(f.path) ?? []).map((p) => p.after));
    const points = (full.deletionPoints.get(f.path) ?? []).filter((p) => at.has(p.after));
    if (lines.size === 0 && points.length === 0) return false;
    coverage.set(f.path, lines);
    if (points.length > 0) deletionPoints.set(f.path, points);
    return true;
  });
  const kept = new Set(files.map((f) => f.path));
  let additions = 0;
  let deletions = 0;
  const diffs: { path: string; text: string }[] = [];
  for (const d of full.diffs ?? []) {
    if (!kept.has(d.path)) continue;
    const lines = coverage.get(d.path) ?? new Set<number>();
    const points = deletionPoints.get(d.path) ?? [];
    const cut = keptHunks(d.text, (h) => {
      const last = h.start + Math.max(h.count, 1) - 1;
      for (let n = h.start; n <= last; n++) if (lines.has(n)) return true;
      return points.some((p) => p.after >= h.start - 1 && p.after <= last);
    });
    additions += cut.additions;
    deletions += cut.deletions;
    diffs.push({ path: d.path, text: cut.text });
  }
  // A kept file with no diff text (left out of the brief, or binary): its
  // kept lines and deletions are what it adds and removes here.
  for (const f of files) {
    if (diffs.some((d) => d.path === f.path)) continue;
    additions += coverage.get(f.path)?.size ?? 0;
    deletions += (deletionPoints.get(f.path) ?? []).reduce((n, p) => n + p.lines, 0);
  }
  return {
    ...full,
    files,
    changedPaths: files.filter((f) => f.status !== "deleted").map((f) => f.path),
    coverage,
    deletionPoints,
    diff: diffs.map((d) => d.text).join(""),
    diffs,
    notReviewed: full.notReviewed.filter((p) => kept.has(p)),
    uncovered: (full.uncovered ?? []).filter((p) => kept.has(p)),
    stats: { files: files.length, additions, deletions },
  };
}
