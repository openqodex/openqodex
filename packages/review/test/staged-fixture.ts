import { makeLineSet } from "../../../tests/line-set.mjs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG, configHash } from "@openqodex/core";
import type { Candidate, Change, FindCandidate, RunManifest, ScanResult, VerifyCandidate, VerifyVerdict } from "@openqodex/core";
import type { ModelResponse } from "../src/reviewer.js";
import { tmpdir } from "node:os";
const dirs: string[] = [];
// These fixtures start no process, so their cleanup only removes files.
export function cleanupFixtures() { dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })); }

export function fixture(files = ["a.txt", "b.txt"]) {
  const dir = mkdtempSync(join(tmpdir(), "oq-stages-"));
  dirs.push(dir);
  for (const file of files) writeFileSync(join(dir, file), "unsafe operation\nsafe operation\n");
  const change: Change = { repoRoot: dir, baseRef: "main", baseSha: "base", id: "a".repeat(64), shortId: "a".repeat(12), files: files.map((path) => ({ path, status: "modified", oldPath: null, binary: false })), changedPaths: files, coverage: new Map(files.map((f) => [f, makeLineSet([1])])), deletionPoints: new Map(), diff: "", diffs: files.map((path) => ({ path, text: "@@ -1 +1 @@\n-old operation\n+unsafe operation\n" + " ".repeat(31 * 1024) })), notReviewed: [], stats: { files: files.length, additions: files.length, deletions: files.length } };
  const scan: ScanResult = { candidates: [], scanners: [], secretFingerprints: [] };
  const config = { ...structuredClone(DEFAULT_CONFIG), stages: true };
  const manifest: RunManifest = { version: 3, change_id: change.id, config_hash: configHash(config), created_at: new Date().toISOString(), lenses: [], instructions_hash: null, runtime_version: "test" };
  return { dir, change, scan, config, manifest };
}
export function scanner(file: string, id = "c1"): Candidate {
  return { id, token: "sqllint:test", source: "sqllint", ruleId: "test", filePath: file, lineStart: 1, lineEnd: 1, severity: "high", reviewSeverity: "major", message: "Unsafe operation", reference: null };
}
export function candidate(file: string, title = "Unsafe operation"): FindCandidate {
  return { severity: "major", category: "bug", confidence: 0.8, file_path: file, line_number: 1, title, claim: "The operation accepts unsafe input.", evidence: [{ file_path: file, line_number: 1, quote: "unsafe operation" }] };
}
export function verdict(c: VerifyCandidate, outcome: VerifyVerdict["verdict"] = "confirmed"): VerifyVerdict {
  return { id: c.id, verdict: outcome, reason: "The changed operation accepts unsafe input.", severity: "major", category: c.kind === "finder" ? c.candidate.category : "security", confidence: 0.9, file_path: c.kind === "finder" ? c.candidate.file_path : c.candidate.filePath, line_number: 1, title: c.kind === "finder" ? c.candidate.title : "Unsafe scanner operation", problem: "The changed operation accepts unsafe input.", consequence: "A caller can cause incorrect output.", fix: "Validate the input before using it.", tier: "finding" };
}
export const reply = (answer: unknown): ModelResponse => ({ message: { text: JSON.stringify(answer), toolCalls: [] }, usage: { model: "fixture", inputTokens: 10, outputTokens: 5, costUsd: 0.01 } });
