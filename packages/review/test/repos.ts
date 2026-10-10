// Real git repositories for the reviewChange tests, made in temp folders the
// calling test file removes (tests/temp-dirs.mjs).
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
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

function write(dir: string, path: string, text: string): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
}

export const SQL = "CREATE OR REPLACE FUNCTION public.admin_get_hygiene()\nRETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT 1 $$;\n";

// A base commit with a sum and its caller, and a head commit that turns the
// sum into a difference and adds an SQL function (one built-in scanner
// candidate). With `big`, the head also adds a file of about 170 KB and one
// of about 40 KB: the brief carries diffs up to 200 KB, so the second file's
// diff is left out and its changed lines must be read.
export function changeRepo(opts: { big?: boolean } = {}): { dir: string; base: string; head: string } {
  const dir = tempDir("oq-rc-repo-");
  git(dir, "init", "-q", "-b", "main");
  write(dir, "src/math.ts", "export function add(a: number, b: number): number {\n  return a + b;\n}\n");
  write(dir, "src/use.ts", 'import { add } from "./math";\n\nexport function total(xs: number[]): number {\n  return xs.reduce((s, x) => add(s, x), 0);\n}\n');
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "Base");
  const base = git(dir, "rev-parse", "HEAD");
  git(dir, "checkout", "-q", "-b", "feature");
  write(dir, "src/math.ts", "export function add(a: number, b: number): number {\n  return a - b;\n}\n");
  write(dir, "db/x.sql", SQL);
  if (opts.big) {
    write(dir, "a/big.txt", Array.from({ length: 5000 }, (_, i) => `big line ${String(i + 1).padStart(24, "0")}`).join("\n") + "\n");
    write(dir, "b/second.txt", Array.from({ length: 1000 }, (_, i) => `second line ${String(i + 1).padStart(27, "0")}`).join("\n") + "\n");
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "Change");
  const head = git(dir, "rev-parse", "HEAD");
  return { dir, base, head };
}
