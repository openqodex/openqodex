// A model provider fixture, shared by driver and model tests. It translates
// fixed submissions using the actual brief and snapshot, without replacing
// the review engine, scanners, filesystem or process driver.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SubmissionV2 } from "@openqodex/core";
import type { Speaker } from "../src/conversation.js";

export function stagedAnswer(brief: string, fixed: string, read: (file: string, line: number) => string): string {
  if (!/^# OpenQodex review brief: (find|verify) pass/.test(brief)) return fixed;
  let value: SubmissionV2;
  try { value = JSON.parse(fixed) as SubmissionV2; } catch { return fixed; }
  if (value.version !== 2 || !Array.isArray(value.findings) || !Array.isArray(value.dropped)) return fixed;
  // Extra keys must reach the real round storage and its redaction check.
  const extra = Object.fromEntries(Object.entries(value).filter(([key]) => !["version", "change_id", "summary", "findings", "dropped"].includes(key)));
  const hunks = [...brief.matchAll(/^### (h\d+) (.+) (\d+)-(\d+)(?: \([^\n]*\))*$/gm)].map((m) => ({ id: m[1]!, file: m[2]!, start: Number(m[3]), end: Number(m[4]) }));
  if (brief.startsWith("# OpenQodex review brief: find")) {
    return JSON.stringify({ ...extra, version: "find-1", change_id: value.change_id, unit: /^Unit: (u\d+)$/m.exec(brief)?.[1], examined: hunks.map((h) => h.id), analysis: hunks.map((h) => ({ hunk: h.id, changed: "The operation changed.", could_break: "The changed behavior can fail." })), candidates: value.findings.filter((f) => hunks.some((h) => h.file === f.file_path && f.line_number >= h.start && f.line_number <= h.end)).map((f) => ({ ...f, claim: `${f.problem} ${f.consequence}`, lens: f.source?.startsWith("lens:") ? f.source.slice(5) : null, evidence: [{ file_path: f.file_path, line_number: f.line_number, quote: read(f.file_path, f.line_number) }] })) });
  }
  const candidates = [...brief.matchAll(/^### ([ck]\d+) \((finder|scanner)\)\n([\s\S]*?)(?=^### |^## |$(?![\s\S]))/gm)].map((m) => {
    const location = /^- Location: (.+):(\d+)(?:-\d+)?$/m.exec(m[3]!);
    return { id: m[1]!, kind: m[2]!, file: location?.[1] ?? "", line: Number(location?.[2]), title: /^- Title: (.*)$/m.exec(m[3]!)?.[1] };
  });
  const verdicts = candidates.flatMap((c) => {
    const f = value.findings.find((f) => c.kind === "scanner" ? f.candidate === c.id : f.file_path === c.file && f.line_number === c.line && f.title === c.title);
    const dropped = value.dropped.find((d) => d.candidate === c.id);
    // An intentionally undisposed scanner still fails the real check.
    if (c.kind === "scanner" && !f && !dropped) return [];
    const duplicate = f && c.kind === "finder" ? candidates.find((other) => other.kind === "scanner" && other.id === f.candidate) : null;
    return [{ id: c.id, verdict: f ? "confirmed" : "refuted", reason: dropped?.reason ?? "The cited operation confirms the claim.", duplicate_of: duplicate?.id ?? null, severity: f?.severity ?? "minor", category: f?.category ?? "bug", confidence: f?.confidence ?? 0.9, file_path: f?.file_path ?? dropped?.file_path ?? c.file, line_number: f?.line_number ?? dropped?.line_number ?? c.line, ...(f?.line_end ? { line_end: f.line_end } : {}), title: f?.title ?? "Refuted claim", problem: f?.problem ?? "", consequence: f?.consequence ?? "", fix: f?.fix ?? "", suggested_change: f?.suggested_change ?? null, tier: "finding" }];
  });
  return JSON.stringify({ ...extra, version: "verify-1", change_id: value.change_id, verdicts });
}

export function stagedFake<T extends Speaker>(session: T, snapshotDir: string): T {
  let brief: string | null = null;
  const send = session.send.bind(session);
  session.send = async (text) => {
    brief ??= text;
    const turn = await send(text);
    return { ...turn, finalText: stagedAnswer(brief, turn.finalText, (file, line) => readFileSync(join(snapshotDir, file), "utf8").split("\n")[line - 1] ?? "") };
  };
  return session;
}
