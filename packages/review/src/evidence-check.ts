import { z } from "zod";
import { FIELD_SENTENCE_LIMITS, FINDER_CONFIDENCE_FLOOR, proseErrors, scannerTerms } from "@openqodex/core";
import type { Change, EvidenceCitation, FindAnswer, FindCandidate, ReviewUnit, ScanResult, VerifyAnswer, VerifyBatch } from "@openqodex/core";

type SnapshotText = (path: string) => string | null;
const normal = (text: string) => text.replace(/\s+/g, " ").trim();
const line = z.number().int().min(1);
const severity = z.enum(["critical", "major", "minor", "nitpick", "info"]);
const category = z.enum(["bug", "security", "performance", "maintainability", "style"]);
const citation = z.object({ file_path: z.string().min(1), line_number: line, quote: z.string().min(1), removed: z.literal(true).optional() });
const candidate = z.object({ severity, category, confidence: z.number().min(FINDER_CONFIDENCE_FLOOR).max(1), file_path: z.string().min(1), line_number: line, line_end: line.optional(), title: z.string().min(1), claim: z.string().min(1), evidence: z.array(citation).min(1).max(3), lens: z.string().nullable().optional() });
const findSchema = z.object({ version: z.literal("find-1"), change_id: z.string(), unit: z.string(), examined: z.array(z.string()), analysis: z.array(z.object({ hunk: z.string(), changed: z.string().min(1), could_break: z.string().min(1) })), candidates: z.array(candidate) });
const verdict = z.object({ id: z.string().min(1), verdict: z.enum(["confirmed", "refuted", "unresolved"]), reason: z.string().min(1), duplicate_of: z.string().nullable().optional(), severity, category, confidence: z.number().min(0).max(1), file_path: z.string().min(1), line_number: line, line_end: line.optional(), title: z.string(), problem: z.string(), consequence: z.string(), fix: z.string(), suggested_change: z.string().nullable().optional(), tier: z.enum(["finding", "observation"]) });
const verifySchema = z.object({ version: z.literal("verify-1"), change_id: z.string(), verdicts: z.array(verdict) });
const sameChange = (id: string, change: Change) => id === change.id || id === change.shortId;
const shapeErrors = (error: z.ZodError) => error.issues.map((e) => `${e.path.join(".")}: ${e.message}`.replace(/\s*\n\s*/g, " "));

export function checkEvidence(c: EvidenceCitation, snapshotText: SnapshotText, change: Change): string | null {
  const at = `${c.file_path}:${c.line_number}${c.removed ? " (removed)" : ""}`.replace(/[\r\n]/g, " ");
  const quote = normal(c.quote);
  if (quote === "") return `evidence ${at}: the quote is empty`;
  if (c.removed) {
    const diff = change.diffs?.find((d) => d.path === c.file_path || change.files.some((f) => f.path === d.path && f.oldPath === c.file_path));
    let oldLine = 0;
    const removed: string[] = [];
    for (const row of diff?.text.split("\n") ?? []) {
      const header = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(row);
      if (header) { oldLine = Number(header[1]); continue; }
      if (oldLine === 0) continue;
      if (row.startsWith("-")) {
        if (Math.abs(oldLine - c.line_number) <= 2) removed.push(row.slice(1));
        oldLine++;
      } else if (row.startsWith(" ")) oldLine++;
      else if (!row.startsWith("+") && !row.startsWith("\\")) oldLine = 0;
    }
    return normal(removed.join(" ")).includes(quote) ? null : `evidence ${at}: the quote is not in the removed lines of this file's diff`;
  }
  const text = snapshotText(c.file_path);
  if (text === null) return `evidence ${at}: the file is not a text file in the snapshot`;
  const lines = text.split("\n");
  const lineCount = lines.length - (lines.at(-1) === "" ? 1 : 0);
  if (c.line_number > lineCount) return `evidence ${at}: the cited line is past the end of the file`;
  const matches = normal(lines.slice(Math.max(0, c.line_number - 3), c.line_number + 2).join(" ")).includes(quote);
  return matches ? null : `evidence ${at}: the quote is not within two lines of the cited line`;
}

export type RejectedEvidence = { candidate: FindCandidate; errors: string[] };
export function checkFindAnswer(value: unknown, unit: ReviewUnit, change: Change, snapshotText: SnapshotText, lenses: readonly string[] = []): { answer: FindAnswer; errors: string[]; answerErrors: string[]; rejected: RejectedEvidence[]; parsed: boolean } {
  const parsed = findSchema.safeParse(value);
  if (!parsed.success) return { answer: { version: "find-1", change_id: change.id, unit: unit.id, examined: [], analysis: [], candidates: [] }, errors: shapeErrors(parsed.error), answerErrors: shapeErrors(parsed.error), rejected: [], parsed: false };
  const answer = parsed.data;
  const errors: string[] = [];
  if (!sameChange(answer.change_id, change)) errors.push(`change_id: use ${change.shortId}`);
  if (answer.unit !== unit.id) errors.push(`unit: use ${unit.id}`);
  for (const h of unit.hunks) {
    if (!answer.examined.includes(h.id)) errors.push(`hunk ${h.id} of ${h.path} was not examined`);
    if (!answer.analysis.some((a) => a.hunk === h.id)) errors.push(`analysis: hunk ${h.id} of ${h.path} needs its analysis`);
  }
  for (const id of [...answer.examined, ...answer.analysis.map((a) => a.hunk)]) if (!unit.hunks.some((h) => h.id === id)) errors.push(`hunk ${id} is not in unit ${unit.id}`);
  const rejected: RejectedEvidence[] = [];
  answer.candidates.forEach((c, i) => {
    if (c.lens && !lenses.includes(c.lens)) c.lens = null;
    const candidateErrors = proseErrors(`candidates[${i}].claim`, c.claim, null, FIELD_SENTENCE_LIMITS.problem);
    if (!change.files.some((f) => f.path === c.file_path && f.status === "deleted") && snapshotText(c.file_path) === null) candidateErrors.push(`candidates[${i}].file_path: ${c.file_path} is not a text file in the snapshot`);
    if (c.line_end !== undefined && c.line_end < c.line_number) candidateErrors.push(`candidates[${i}].line_end: it is before line_number`);
    for (const e of c.evidence) {
      const error = checkEvidence(e, snapshotText, change);
      if (error) candidateErrors.push(`candidates[${i}]: ${error}`);
    }
    if (candidateErrors.length) rejected.push({ candidate: c, errors: candidateErrors });
  });
  return { answer, errors: [...errors, ...rejected.flatMap((r) => r.errors)], answerErrors: errors, rejected, parsed: true };
}

// This repeats finalize.ts's private citesChange rule, including its
// 200-line bound. Finalize remains the judge of the assembled submission.
function citesChange(path: string, start: number, end: number, change: Change, lineCount: (path: string) => number | null): string | null {
  if (!change.files.some((f) => f.path === path)) return "the file is not in this change; cite a changed line, or a line next to a deletion";
  if (!change.coverage.get(path)?.has(start) && !(change.deletionPoints.get(path) ?? []).some((p) => p.anchors.includes(start))) return `line ${start} of ${path} is not a line this change added or modified; start the range on a changed line, or a line next to a deletion`;
  const count = lineCount(path);
  if (count !== null && end > count) return `line ${end} of ${path} does not exist; it has ${count} lines`;
  const span = end - start + 1;
  if (span > 200) return `the range spans ${span} lines; the limit is 200, so cite the lines that show the problem`;
  return null;
}

export function checkVerifyAnswer(value: unknown, batch: VerifyBatch, change: Change, snapshotText: SnapshotText, lineCount: (path: string) => number | null, scan?: ScanResult): { answer: VerifyAnswer; errors: string[] } {
  const parsed = verifySchema.safeParse(value);
  if (!parsed.success) return { answer: { version: "verify-1", change_id: change.id, verdicts: [] }, errors: shapeErrors(parsed.error) };
  const answer = parsed.data;
  const errors: string[] = [];
  if (!sameChange(answer.change_id, change)) errors.push(`change_id: use ${change.shortId}`);
  const ids = new Set(batch.candidates.map((c) => c.id));
  const banned = scannerTerms(scan ?? { candidates: batch.candidates.flatMap((c) => c.kind === "scanner" ? [c.candidate] : []), scanners: [] } as unknown as ScanResult);
  for (const c of batch.candidates) {
    const n = answer.verdicts.filter((v) => v.id === c.id).length;
    if (n !== 1) errors.push(`candidate ${c.id}: needs exactly one verdict, got ${n}`);
  }
  for (const v of answer.verdicts) {
    const at = `candidate ${v.id}`;
    if (!ids.has(v.id)) errors.push(`${at}: is not in this batch`);
    if (v.duplicate_of && (!ids.has(v.duplicate_of) || v.duplicate_of === v.id)) errors.push(`${at}.duplicate_of: name another id in this batch`);
    const c = batch.candidates.find((c) => c.id === v.id);
    if (c?.kind === "scanner" && v.verdict === "unresolved") errors.push(`${at}: a scanner candidate is confirmed or refuted`);
    if (c?.kind === "scanner" && v.verdict === "refuted") errors.push(...proseErrors(`${at}.reason`, v.reason, null, 2));
    if (v.line_end !== undefined && v.line_end < v.line_number) errors.push(`${at}.line_end: it is before line_number`);
    if (v.duplicate_of) {
      const target = answer.verdicts.find((item) => item.id === v.duplicate_of);
      if (v.verdict !== "confirmed" || target?.verdict !== "confirmed") errors.push(`${at}.duplicate_of: both candidates must be confirmed`);
      if (c?.kind === "scanner" && batch.candidates.find((item) => item.id === v.duplicate_of)?.kind === "finder") errors.push(`${at}.duplicate_of: a scanner candidate survives; mark the finder candidate as the duplicate`);
    }
    if (v.verdict === "confirmed") {
      for (const field of ["title", "problem", "consequence", "fix"] as const) {
        if (v[field].trim() === "") errors.push(`${at}.${field}: must not be empty`);
        errors.push(...proseErrors(`${at}.${field}`, v[field], banned, field === "title" ? null : FIELD_SENTENCE_LIMITS[field]));
      }
      if (!change.files.some((f) => f.path === v.file_path && f.status === "deleted") && snapshotText(v.file_path) === null) errors.push(`${at}: ${v.file_path} is not a text file in the snapshot`);
      const wrong = citesChange(v.file_path, v.line_number, v.line_end ?? v.line_number, change, lineCount);
      if (wrong) errors.push(`${at}: ${wrong}`);
      if (c?.kind === "finder") for (const e of c.candidate.evidence) {
        const error = checkEvidence(e, snapshotText, change);
        if (error) errors.push(`${at}: ${error}`);
      }
    }
  }
  // A duplicate cycle has no target that can carry the combined provenance.
  const links = new Map(answer.verdicts.filter((v) => v.duplicate_of).map((v) => [v.id, v.duplicate_of!]));
  for (const id of links.keys()) {
    const seen = new Set<string>();
    let next: string | undefined = id;
    while (next && links.has(next)) {
      if (seen.has(next)) { errors.push(`candidate ${id}.duplicate_of: duplicate links form a cycle`); break; }
      seen.add(next);
      next = links.get(next);
    }
  }
  return { answer, errors };
}
