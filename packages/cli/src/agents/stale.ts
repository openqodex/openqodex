// The files OpenQodex wrote in user scope that this version would write
// differently: exactly what the next `openqodex init` refreshes. Counted by
// init's own planner on a copy of the record, so a file the developer edited
// (which init keeps) is never counted, and neither is anything outside user
// scope: the team section and project-scope files are pinned on purpose.
// Nothing is written. An update never writes these files; it only says how
// many there are and that `init` refreshes them.
import { existsSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { launcherFormatStale, launcherPath, launcherRunner } from "../launcher.js";
import { AGENTS } from "./detect.js";
import { readText } from "./files.js";
import { Guard } from "./guarded-fs.js";
import { claudeHome, codexHome, gooseHome } from "./homes.js";
import { ownedFile, planInstall, type Ctx } from "./plan.js";
import { loadRecord, type InstallRecord } from "./record.js";
import { clineCliData, targetsFor, type Target } from "./targets.js";

const CURSOR_RULE = join(".cursor", "rules", "openqodex.mdc");

function recorded(record: InstallRecord, t: Target): boolean {
  switch (t.kind) {
    case "file":
      return record.files.some((f) => f.path === t.path);
    case "md-section":
      return record.sections.some((s) => s.path === t.path);
    case "hook-json":
      return record.hooks.some((h) => h.path === t.path);
    case "allow-rules":
      return record.allowRules.some((r) => r.path === t.path);
    case "mcp-json":
    case "mcp-toml":
      return record.mcp.some((m) => m.path === t.path);
  }
}

// The stale files, in the order init plans them, and the repositories that
// hold one (a user-scope Cursor rule): `init` refreshes such a rule only when
// it runs in that repository. Empty when there is no install record, or it
// cannot be read.
export type Stale = { paths: string[]; repos: string[] };

export function staleOwned(home: string, oqHome: string): Stale {
  let record: InstallRecord;
  try {
    record = loadRecord(oqHome);
  } catch {
    return { paths: [], repos: [] };
  }
  const launcher = launcherPath(oqHome);
  const runner = launcherRunner(launcher);
  const clineCli = existsSync(clineCliData(home));
  // A user-scope Cursor rule lives in a repository: the record names it.
  const cursorRepos = record.files.filter((f) => f.usesLauncher && f.path.endsWith(`${sep}${CURSOR_RULE}`)).map((f) => dirname(dirname(dirname(f.path))));
  // Each target with the guard init would write it through: the home's own
  // folders for the home's files, and for a repository's rule the guard of
  // that repository, which refuses a link the repository holds.
  const roots = [home, claudeHome(home), codexHome(home), gooseHome(home), oqHome];
  const planned: { target: Target; guard: Guard; repo: string | null }[] = [];
  const homeOnly = new Guard({ repoRoot: null, gitFolders: [], roots });
  for (const agent of AGENTS) {
    for (const target of targetsFor({ agent, scope: "user", home, repoRoot: null, version: __OPENQODEX_VERSION__, runner, launcher, clineCli }).targets) planned.push({ target, guard: homeOnly, repo: null });
  }
  for (const repoRoot of cursorRepos) {
    let guard: Guard;
    try {
      guard = new Guard({ repoRoot, gitFolders: [], roots });
    } catch {
      continue;
    }
    const rule = targetsFor({ agent: "cursor", scope: "user", home, repoRoot, version: __OPENQODEX_VERSION__, runner, launcher, clineCli }).targets.filter((t) => t.kind === "file" && t.path.endsWith(CURSOR_RULE));
    for (const target of rule) planned.push({ target, guard, repo: repoRoot });
  }
  const copy = structuredClone(record);
  const stale: string[] = [];
  const repos: string[] = [];
  const seen = new Set<string>();
  for (const { target: t, guard, repo } of planned) {
    const key = `${t.kind} ${t.path}`;
    if (seen.has(key) || !recorded(record, t)) continue;
    seen.add(key);
    const ctx: Ctx = { record: copy, scope: "user", repoRoot: repo, guard };
    try {
      const action = planInstall(t, ctx);
      if ((action.verb === "update" || action.verb === "replace") && !stale.includes(t.path)) {
        stale.push(t.path);
        if (repo !== null && !repos.includes(repo)) repos.push(repo);
      }
    } catch {
      // a file that cannot be read or a path init refuses: init says why
    }
  }
  try {
    if (ownedFile(record, launcher, readText(launcher)) && launcherFormatStale(oqHome)) stale.push(launcher);
  } catch {
    // unreadable: init says why
  }
  return { paths: stale, repos };
}

// How the stale files are refreshed: one init anywhere for the home's own
// files, or one init in each repository that holds a stale rule, which
// refreshes the home's files too.
export function refreshHow(oqHome: string, stale: Stale): string {
  const runner = launcherRunner(launcherPath(oqHome));
  if (stale.repos.length === 0) return `run ${runner} init to refresh them`;
  if (stale.repos.length === 1) return `run ${runner} init in ${stale.repos[0]} to refresh them`;
  return `run ${runner} init in each of these repositories to refresh them: ${stale.repos.join(", ")}`;
}

// The line after an update; null when nothing is stale.
export function staleLine(home: string, oqHome: string): string | null {
  const stale = staleOwned(home, oqHome);
  const n = stale.paths.length;
  if (n === 0) return null;
  return `${n} ${n === 1 ? "file OpenQodex wrote is" : "files OpenQodex wrote are"} from an older version; ${refreshHow(oqHome, stale)}`;
}
