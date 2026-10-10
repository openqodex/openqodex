// Real git repositories for the scoped and incremental review tests, made in
// temp folders the calling test file removes (tests/temp-dirs.mjs).
//
// The decisive scope fixture (plan §4 test 7), scope "services/api" with
// review.paths.exclude "**/generated/**":
//   canary.txt                        a root file outside the scope, changed
//   root-caller.ts                    a root file that calls into the scope
//   db/root.sql                       a root SQL function a scanner would flag
//   services/api/generated/client.sql an excluded file inside the scope, changed
//   legacy/util.ts -> services/api/util.ts
//                                     a rename whose old path is outside, with
//                                     one old-only line removed
//   legacy/same.ts -> services/api/same.ts
//                                     a move from outside of the same bytes
//   services/api/link-out             an unchanged link to the root canary
//   services/api/handler.ts           a changed file inside the scope
//   services/api/db/q.sql             an added SQL function inside the scope
//   services/api/run.sh               an unchanged executable inside the scope
// Every text that must never reach the review carries a CANARY marker.
import { spawnSync } from "node:child_process";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tempDir } from "../../../tests/temp-dirs.mjs";

export function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-c", "user.name=T", "-c", "user.email=t@openqodex.invalid", "-c", "commit.gpgsign=false", "-c", "protocol.file.allow=always", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

export function write(dir: string, path: string, text: string | Buffer): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
}

export const SQL = "CREATE OR REPLACE FUNCTION public.admin_get_hygiene()\nRETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT 1 $$;\n";

// Every marker that must not reach the snapshot, the scanners, the graph
// packet, the tools, the citations or the outputs.
export const CANARIES = ["ROOT-CANARY-7f3a", "ROOT-CALLER-CANARY-2b81", "ROOT-SQL-CANARY-5d0c", "EXCLUDED-CANARY-91be", "OLD-ONLY-CANARY-4c2d"];
// Paths that must not be named there either.
// (The base version of handler.ts imports "../../legacy/util": that line is
// the admitted file's own, so the old path is named with its extension.)
export const OUTSIDE_PATHS = ["canary.txt", "root-caller.ts", "db/root.sql", "services/api/generated/client.sql", "legacy/util.ts"];

export const SCOPES = ["services/api"];
export const EXCLUDE = ["**/generated/**"];

const UTIL_BASE = [
  "export function normalize(name: string): string {",
  "  return name.trim().toLowerCase();",
  "}",
  "",
  "export function label(name: string): string {",
  "  return `user:${normalize(name)}`;",
  "}",
  "",
  "// OLD-ONLY-CANARY-4c2d: this line is removed by the move",
  "export function width(name: string): number {",
  "  return normalize(name).length;",
  "}",
  "",
].join("\n");

const HANDLER_BASE = [
  'import { label } from "./util";',
  "",
  "export function handle(name: string): string {",
  "  return label(name);",
  "}",
  "",
].join("\n");

export type Fixture = { dir: string; base: string; head: string };

export function decisiveFixture(): Fixture {
  const dir = tempDir("oq-scope-repo-");
  git(dir, "init", "-q", "-b", "main");
  write(dir, "canary.txt", "ROOT-CANARY-7f3a base\n");
  write(dir, "root-caller.ts", 'import { handle } from "./services/api/handler";\n\n// ROOT-CALLER-CANARY-2b81\nexport function rootCaller(): string {\n  return handle("root");\n}\n');
  write(dir, "legacy/util.ts", UTIL_BASE);
  write(dir, "services/api/handler.ts", HANDLER_BASE.replace('"./util"', '"../../legacy/util"'));
  write(dir, "services/api/generated/client.sql", "-- EXCLUDED-CANARY-91be base\n");
  write(dir, "services/api/run.sh", "#!/bin/sh\necho run\n");
  write(dir, "legacy/same.ts", "export const same = 1;\n");
  symlinkSync("../../canary.txt", join(dir, "services/api/link-out"));
  git(dir, "add", "-A");
  git(dir, "update-index", "--chmod=+x", "services/api/run.sh");
  git(dir, "commit", "-qm", "base");
  const base = git(dir, "rev-parse", "HEAD");
  git(dir, "checkout", "-q", "-b", "feature");
  write(dir, "canary.txt", "ROOT-CANARY-7f3a changed\n");
  write(dir, "db/root.sql", `-- ROOT-SQL-CANARY-5d0c\n${SQL}`);
  write(dir, "services/api/generated/client.sql", `-- EXCLUDED-CANARY-91be head\n${SQL}`);
  git(dir, "mv", "legacy/util.ts", "services/api/util.ts");
  git(dir, "mv", "legacy/same.ts", "services/api/same.ts");
  write(dir, "services/api/util.ts", UTIL_BASE.replace("// OLD-ONLY-CANARY-4c2d: this line is removed by the move\n", ""));
  write(dir, "services/api/handler.ts", HANDLER_BASE.replace("  return label(name);", "  const out = label(name);\n  return out.length > 64 ? out.slice(0, 64) : out;"));
  write(dir, "services/api/db/q.sql", SQL);
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "head");
  return { dir, base, head: git(dir, "rev-parse", "HEAD") };
}

// The incremental history. main: B. feature: P1 (a.ts line 5, adds c.ts),
// then P2 (a.ts line 25, b.ts line 3); the previously reviewed commit is P1.
export const lines = (n: number, edit: Record<number, string> = {}) => Array.from({ length: n }, (_, i) => edit[i + 1] ?? `line ${i + 1}`).join("\n") + "\n";
export const commit = (dir: string, message: string) => {
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", message);
  return git(dir, "rev-parse", "HEAD");
};

export function history() {
  const dir = tempDir("oq-inc-");
  git(dir, "init", "-q", "-b", "main");
  write(dir, "s/a.ts", lines(40));
  write(dir, "s/b.ts", lines(10));
  const base = commit(dir, "B");
  git(dir, "checkout", "-q", "-b", "feature");
  write(dir, "s/a.ts", lines(40, { 5: "changed before the previous review" }));
  write(dir, "s/c.ts", "export const c = 1;\n");
  const previous = commit(dir, "P1");
  write(dir, "s/a.ts", lines(40, { 5: "changed before the previous review", 25: "changed since the previous review" }));
  write(dir, "s/b.ts", lines(10, { 3: "changed since too" }));
  const head = commit(dir, "P2");
  return { dir, base, previous, head };
}
