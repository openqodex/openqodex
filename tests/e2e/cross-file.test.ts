// `openqodex review` with the real Claude Code as the reviewer, on two small
// repositories whose verdict rests on a second file. The cases cost real
// usage, so they run only in the model tier (pnpm gate:model, which sets
// OPENQODEX_MODEL_TESTS=1); anywhere else the group skips with a printed
// reason. In the model tier a reviewer that cannot run fails the case.
//
// Ways it could fail, written before the code:
//  X1. A changed return type (findUser may now return undefined) breaks an
//      unchanged caller in another file, and the review does not raise it,
//      or raises it without citing the caller's file in its evidence.
//  X2. The same change, where the caller already guards against undefined,
//      is raised anyway: the verifier did not read the guard in the other
//      file before confirming.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Report } from "@openqodex/core";
import "./global-setup.js";
import { git, modelTestsOff, readJson, reportDir, requireReviewer, reviewerMissing, run } from "./support.js";
import { tempDir } from "../temp-dirs.mjs";

const USERS_BEFORE = "export type User = { id: string; name: string };\n\nconst users = new Map<string, User>();\n\nexport function findUser(id: string): User {\n  const user = users.get(id);\n  if (!user) throw new Error(`no user ${id}`);\n  return user;\n}\n";
const USERS_AFTER = "export type User = { id: string; name: string };\n\nconst users = new Map<string, User>();\n\nexport function findUser(id: string): User | undefined {\n  return users.get(id);\n}\n";
const CALLER = 'import { findUser } from "./users";\n\nexport function greet(id: string): string {\n  const user = findUser(id);\n  return `Hello ${user.name}`;\n}\n';
const GUARDED = 'import { findUser } from "./users";\n\nexport function greet(id: string): string {\n  const user = findUser(id);\n  if (user === undefined) return "Hello stranger";\n  return `Hello ${user.name}`;\n}\n';

// The base committed, the change to findUser left uncommitted.
function repo(caller: string): string {
  const dir = tempDir("oq-cross-file-");
  const write = (path: string, text: string) => { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), text); };
  write("src/users.ts", USERS_BEFORE);
  write("src/greet.ts", caller);
  git(dir, "init", "-q"); git(dir, "add", "-A"); git(dir, "commit", "-qm", "Baseline");
  write("src/users.ts", USERS_AFTER);
  return dir;
}

function review(label: string, caller: string): Report {
  requireReviewer(reviewerMissing());
  const dir = repo(caller);
  const out = run(label, dir, ["review", "--no-color"], { home: process.env.HOME, timeout: 900_000 });
  expect([0, 1], out.stderr).toContain(out.status);
  const report = readJson<Report>(join(reportDir(dir), "report.json"));
  expect(report.completion?.status, out.stderr).toBe("complete");
  return report;
}

describe.skipIf(modelTestsOff("cross-file evidence with claude"))("cross-file evidence with Claude Code as the reviewer", () => {
  it("X1. raises the caller broken by the changed return type, citing the caller's file", () => {
    const report = review("cross-file-defect", CALLER);
    const raised = [...report.findings, ...report.possible].filter((f) => f.category === "bug");
    expect(raised.some((f) => f.evidence?.some((e) => e.file_path === "src/greet.ts")), JSON.stringify(raised)).toBe(true);
  }, 1_000_000);

  it("X2. does not raise the change when the caller already guards against a missing user", () => {
    const report = review("cross-file-guarded", GUARDED);
    const raised = [...report.findings, ...report.possible].filter((f) => f.category === "bug");
    expect(raised, JSON.stringify(raised)).toEqual([]);
  }, 1_000_000);
});
