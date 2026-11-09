// Failure list, written before implementation:
// 1. One of the five Git read commands with arguments is denied.
// 2. Shell operators, substitutions, redirections or other commands are allowed.
// 3. Newlines, comments, expansions or malformed quoting evade command parsing.
// 4. A Git argument writes output or enables an external diff helper.
// 5. Malformed JSON, missing commands or the wrong hook event or tool pass.
// 6. Decoded help or web flags launch a viewer or browser.
// 7. Diff, show or log inherits an external diff, text conversion or filter.
// 8. Signature flags or pretty formats run a configured signature program.
// 9. Safety flags become paths after --, or literal arguments change on rewrite.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { controlEnv } from "../lib/claude-control.mjs";

const gate = fileURLToPath(new URL("../lib/control-gate.mjs", import.meta.url));
const input = (command) => ({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } });
function hookOutput(stdin, options = {}) {
  const result = spawnSync(process.execPath, [gate], { input: stdin, encoding: "utf8", ...options });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout.trim().split("\n")).toHaveLength(1);
  const output = JSON.parse(result.stdout).hookSpecificOutput;
  expect(output.hookEventName).toBe("PreToolUse");
  expect(output.permissionDecisionReason).toMatch(/^[^\r\n]+$/);
  return output;
}
const decision = (stdin) => hookOutput(stdin).permissionDecision;

for (const command of ["git diff --stat -- 'src/a b.ts'", "git status --short", "git log -5 --oneline", 'git show HEAD -- "src/a b.ts"', "git rev-parse --show-toplevel"]) it(`allows ${command}`, () => {
  expect(decision(JSON.stringify(input(command)))).toBe("allow");
});
for (const command of ["git diff; id", "git diff && id", "git diff | id", "git diff $(id)", "git diff `id`", "cat x", "ls", "git push", "git diff > f", "git diff & id", "git diff < f", "git diff\nid", "git diff\rstatus", "git diff # comment", "git diff *.ts", "git diff {a,b}", "git diff (id)", "git diff 'unfinished", 'git diff "unfinished', "git diff\\", "git -c alias.diff=push diff", "git diff --output=f", "git log --output f", "git show --ext-diff", "git diff --textconv"]) it(`denies ${JSON.stringify(command)} with a reason`, () => {
  expect(decision(JSON.stringify(input(command)))).toBe("deny");
});
for (const [name, stdin] of [["malformed JSON", "{"], ["null input", "null"], ["a missing command", JSON.stringify(input(undefined))], ["a non-string command", JSON.stringify(input(["git", "diff"]))], ["the wrong tool", JSON.stringify({ ...input("git diff"), tool_name: "Read" })], ["the wrong event", JSON.stringify({ ...input("git diff"), hook_event_name: "PostToolUse" })]]) it(`denies ${name} with a reason`, () => {
  expect(decision(stdin)).toBe("deny");
});

for (const subcommand of ["diff", "status", "log", "show", "rev-parse"]) {
  for (const flag of ["--help", "-h", "--web", "'--he'lp", "--he\\lp", "--help --web"]) it(`denies decoded ${flag} for git ${subcommand}`, () => {
    expect(decision(JSON.stringify(input(`git ${subcommand} ${flag}`)))).toBe("deny");
  });
  for (const flag of ["--ext-diff", "--textconv", "'--ext-'diff", "--text\\conv"]) it(`denies decoded ${flag} for git ${subcommand}`, () => {
    expect(decision(JSON.stringify(input(`git ${subcommand} ${flag}`)))).toBe("deny");
  });
}
for (const flag of ["--show-signature", "'--show-'signature", "--format=%GG", "--format '%G?'", "--pretty=tformat:%GK", "--pretty 'format:%GS'"]) it(`denies signature execution through ${flag}`, () => {
  expect(decision(JSON.stringify(input(`git log ${flag}`)))).toBe("deny");
});

const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
function withRepo(check) {
  const root = fileURLToPath(new URL("../results/", import.meta.url));
  mkdirSync(root, { recursive: true });
  const cwd = mkdtempSync(join(root, "control-gate-"));
  const env = controlEnv({ PATH: process.env.PATH });
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd, env, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout;
  };
  try {
    git("init", "-q");
    writeFileSync(join(cwd, ".gitattributes"), "sample.txt diff=unsafe filter=unsafe\n");
    writeFileSync(join(cwd, "sample.txt"), "before\n");
    git("add", ".");
    git("-c", "user.name=Gate test", "-c", "user.email=gate@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "Base");
    writeFileSync(join(cwd, "sample.txt"), "after\n");
    writeFileSync(join(cwd, "helper.mjs"), 'import { writeFileSync } from "node:fs"; writeFileSync(new URL("./called", import.meta.url), "called"); process.exit(1);\n');
    check({ cwd, env, git, helper: `${quote(process.execPath)} ${quote(join(cwd, "helper.mjs"))}` });
  } finally { rmSync(cwd, { recursive: true, force: true }); }
}
for (const key of ["diff.external", "diff.unsafe.command", "diff.unsafe.textconv", "filter.unsafe.clean", "filter.unsafe.process", "filter.unsafe.smudge"]) {
  for (const command of ["git diff", "git show HEAD", "git log -p -1"]) it(`prevents ${key} execution through ${command}`, () => {
    withRepo(({ cwd, env, git, helper }) => {
      git("config", key, helper);
      const output = hookOutput(JSON.stringify(input(command)), { cwd, env });
      expect(output.permissionDecision).toBe("allow");
      const rewritten = output.updatedInput?.command;
      expect(rewritten).toContain("--no-ext-diff");
      expect(rewritten).toContain("--no-textconv");
      if (key.startsWith("filter.")) expect(rewritten).toContain(`${key}=`);
      const result = spawnSync(rewritten, { cwd, env, shell: true, encoding: "utf8" });
      expect(existsSync(join(cwd, "called"))).toBe(false);
      expect(result.status, result.stderr).toBe(0);
    });
  });
}
it("inserts safety flags before paths and preserves decoded literal arguments", () => {
  withRepo(({ cwd, env }) => {
    writeFileSync(join(cwd, "a b'c.txt"), "kept\n");
    const command = `git diff --no-index -- /dev/null ${quote("a b'c.txt")}`;
    const output = hookOutput(JSON.stringify(input(command)), { cwd, env });
    const result = spawnSync(output.updatedInput?.command, { cwd, env, shell: true, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout).toContain("+kept");
  });
});
