// The repo folder `.openqodex/`: its two team files (config.yaml and
// custom-instructions.md, meant to be committed) and its .gitignore. Created
// by init and by the first scan or review in a repo; an existing file is
// never touched. Init records what it created, and uninstall removes a file
// only while it is unchanged and not committed.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_CONFIG_YAML,
  FOLDER_CONFIG,
  INSTRUCTIONS_FILE,
  STATE_DIR,
  STATE_GITIGNORE,
  ensureRepoFiles,
  listRepoDir,
  readRepoFile,
  repoStat,
  safeGitEnv,
  type RepoFiles,
} from "@openqodex/core";
import { assetPath } from "../assets.js";
import { sha256 } from "./files.js";
import { isTracked } from "./git.js";
import type { Guard } from "./guarded-fs.js";
import { ownedFile, type Action } from "./plan.js";
import type { InstallRecord } from "./record.js";

export function instructionsTemplate(): string {
  return readFileSync(assetPath("templates", "repo", "custom-instructions.md"), "utf8");
}

export function createRepoFiles(repoRoot: string): RepoFiles {
  return ensureRepoFiles(repoRoot, { config: DEFAULT_CONFIG_YAML, instructions: instructionsTemplate() });
}

export const INSTRUCTIONS_LINE =
  "Write in .openqodex/custom-instructions.md what a reviewer of this repo must know: conventions, what never to flag, what always to check. It adds to the files the owners chose in review.instructions_files.";

// A scan or review run by hand where the repo had no settings file: the file
// it creates is what opts the repo in to agent reviews (the global note and
// the push hooks look for it).
export const OPT_IN_LINE = `The new ${STATE_DIR}/${FOLDER_CONFIG} opts this repo in: agents now review here before a push. Run openqodex init here to set it up for your team.`;

export const ROOT_CONFIG_NOTE =
  "This repo has .openqodex.yaml at its root; it is still read. To move it into the folder: git mv .openqodex.yaml .openqodex/config.yaml";

// Whether git ignores this repo-relative path: true, false, or null when git
// could not answer. `git check-ignore` exits 0 for an ignored path, 1 for one
// it does not ignore (a tracked file included), anything else on an error.
function ignoredByGit(repoRoot: string, path: string): boolean | null {
  const r = spawnSync("git", ["check-ignore", "-q", "--", path], { cwd: repoRoot, env: safeGitEnv(), stdio: "ignore", timeout: 15_000 });
  return r.status === 0 ? true : r.status === 1 ? false : null;
}

// The advice for files the developer may share: commit the ones git can
// stage, say so for the ones the repo ignores, and nothing for a path git
// could not answer about.
export function commitLines(repoRoot: string, paths: string[]): string[] {
  const commit: string[] = [];
  const lines: string[] = [];
  for (const p of paths) {
    const ignored = ignoredByGit(repoRoot, p);
    if (ignored === false) commit.push(p);
    else if (ignored === true) lines.push(`${p} is ignored by git in this repo (a .gitignore or exclude rule), so it is not shared with your team.`);
  }
  const them = commit.length > 1 ? "them" : "it";
  const named = commit.length > 1 ? `${commit.slice(0, -1).join(", ")} and ${commit[commit.length - 1]}` : commit.join("");
  return [...(commit.length > 0 ? [`Commit ${named} so your team shares ${them}.`] : []), ...lines];
}

// What a scan or review tells the developer about files it just created.
export function repoFilesLines(repoRoot: string, files: RepoFiles): string[] {
  if (files.created.length === 0) return [];
  return [
    `Created ${files.created.join(" and ")}.`,
    ...commitLines(repoRoot, files.created),
    ...(files.created.some((p) => p.endsWith(INSTRUCTIONS_FILE)) ? [INSTRUCTIONS_LINE] : []),
    ...(files.rootConfig ? [ROOT_CONFIG_NOTE] : []),
    ...(files.created.includes(`${STATE_DIR}/${FOLDER_CONFIG}`) ? [OPT_IN_LINE] : []),
  ];
}

type RepoFile = { path: string; label: string; text: string };

// What the folder's .gitignore held on Day 0: the whole folder ignored itself.
const DAY0_GITIGNORE = "*\n";

function repoFiles(repoRoot: string): { files: RepoFile[]; gitignore: RepoFile; rootConfig: boolean } {
  const dir = join(repoRoot, STATE_DIR);
  const rootConfig = repoStat(repoRoot, ".openqodex.yaml") !== null;
  const files: RepoFile[] = [];
  if (!rootConfig) files.push({ path: join(dir, FOLDER_CONFIG), label: "the team's OpenQodex config, to commit", text: DEFAULT_CONFIG_YAML });
  files.push({ path: join(dir, INSTRUCTIONS_FILE), label: "what a reviewer of this repo must know, to commit", text: instructionsTemplate() });
  return { files, gitignore: { path: join(dir, ".gitignore"), label: "keeps the review reports out of git", text: STATE_GITIGNORE }, rootConfig };
}

// Creates the file only when nothing is there (an exclusive open, never a
// replacing rename), and records it as ours only when that create succeeded:
// a first scan running at the same moment keeps its own file.
function createOwned(guard: Guard, record: InstallRecord, f: RepoFile): void {
  if (!guard.write(f.path, f.text, { exclusive: true })) return;
  record.files = record.files.filter((r) => r.path !== f.path);
  record.files.push({ path: f.path, sha256: sha256(f.text), usesLauncher: false });
}

export function planRepoFiles(repoRoot: string, record: InstallRecord, guard: Guard): { actions: Action[]; rootConfig: boolean } {
  const { files, gitignore, rootConfig } = repoFiles(repoRoot);
  const actions: Action[] = [];
  // The .gitignore first, so the reports never show in git status.
  const all = [gitignore, ...files];
  for (const f of all) {
    const before = readRepoFile(repoRoot, f.path);
    // The Day 0 folder ignored itself with "*": rewritten once, recorded as a
    // migration with the original bytes, so uninstall puts them back.
    if (f === gitignore && before === DAY0_GITIGNORE) {
      actions.push({
        verb: "update",
        path: f.path,
        note: `${f.label}, in place of the old "*"`,
        guard: { path: f.path, before },
        apply: () => {
          guard.write(f.path, f.text, { keepMode: true });
          record.migrations = record.migrations.filter((m) => m.path !== f.path);
          record.migrations.push({ path: f.path, original: before, sha256: sha256(f.text) });
        },
      });
      continue;
    }
    if (before !== null) {
      actions.push({ verb: "skip", path: f.path, note: f === gitignore ? "already there" : "already there; never changed by openqodex" });
      continue;
    }
    actions.push({ verb: "create", path: f.path, note: f.label, guard: { path: f.path, before }, apply: () => createOwned(guard, record, f) });
  }
  return { actions, rootConfig };
}

// Removes what init created there while it is unchanged and not committed;
// the .gitignore and the folder go only when nothing else is left in it.
export async function planRepoFilesRemoval(repoRoot: string, record: InstallRecord, guard: Guard): Promise<Action[]> {
  const dir = join(repoRoot, STATE_DIR);
  const { files, gitignore } = repoFiles(repoRoot);
  const actions: Action[] = [];
  const removing = new Set<string>();
  const forget = (path: string): void => {
    record.files = record.files.filter((r) => r.path !== path);
  };
  const consider = async (f: RepoFile): Promise<void> => {
    if (!record.files.some((r) => r.path === f.path)) return;
    const before = readRepoFile(repoRoot, f.path);
    if (before === null) return forget(f.path);
    if (!ownedFile(record, f.path, before)) {
      forget(f.path);
      actions.push({ verb: "keep", path: f.path, note: "edited after init; left in place" });
      return;
    }
    if (await isTracked(repoRoot, f.path)) {
      forget(f.path);
      actions.push({ verb: "keep", path: f.path, note: "committed to the repo; left in place" });
      return;
    }
    removing.add(f.path);
    actions.push({
      verb: "remove",
      path: f.path,
      note: f.label,
      guard: { path: f.path, before },
      apply: () => {
        guard.remove(f.path);
        forget(f.path);
      },
    });
  };
  for (const f of files) await consider(f);
  // A migrated Day 0 .gitignore gets its original bytes back while it is
  // still what init wrote.
  const migration = record.migrations.find((m) => m.path === gitignore.path);
  if (migration) {
    record.migrations = record.migrations.filter((m) => m !== migration);
    const now = readRepoFile(repoRoot, gitignore.path);
    if (now !== null && sha256(now) === migration.sha256) {
      actions.push({
        verb: "restore",
        path: gitignore.path,
        note: "the .gitignore as it was before init",
        guard: { path: gitignore.path, before: now },
        apply: () => {
          guard.write(gitignore.path, migration.original, { keepMode: true });
        },
      });
    }
    return actions;
  }
  const others = listRepoDir(repoRoot, dir).filter((n) => !removing.has(join(dir, n)) && join(dir, n) !== gitignore.path);
  if (others.length === 0) {
    await consider(gitignore);
    const last = actions[actions.length - 1];
    if (last?.path === gitignore.path && last.verb === "remove") {
      const inner = last.apply!;
      last.apply = () => {
        inner();
        try {
          guard.removeEmptyFolder(dir);
        } catch {
          // something else is there now; it is not ours
        }
      };
    }
  } else if (record.files.some((r) => r.path === gitignore.path)) {
    // The reports are still there and need it; it stops being ours.
    forget(gitignore.path);
  }
  return actions;
}

// The first scan or review in a repo creates the two team files and says so
// on stderr, one line each.
export function announceRepoFiles(repoRoot: string): void {
  for (const line of repoFilesLines(repoRoot, createRepoFiles(repoRoot))) process.stderr.write(`openqodex: ${line}\n`);
}
