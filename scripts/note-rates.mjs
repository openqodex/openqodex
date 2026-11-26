// How often library reviews end each way, per week, from a review sweep: a
// JSONL file with one review per line, each with a `steps` list, as a host
// such as qodeclaw exports it. Each `library_review` step's resultExcerpt
// is a line of key=value pairs: status, reason (free text, last but for
// source), and, from the release that added them, reasonCode, the
// incomplete cause and the neighbourhood's partial cause. A step without a
// reasonCode gets one read from its reason, by the same rules the library
// uses (packages/review/src/outcome.ts).
//
// It prints, for each ISO week of the steps' createdAt, the share of steps
// with each status, each reason code or incomplete cause, each partial
// cause and each note kind, and flags any share above 20%. A complete status
// is never flagged: it is the share a host wants high.
//
// Usage: node scripts/note-rates.mjs <sweep.jsonl>
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const FLAG_ABOVE = 0.2;

// The keys a step's excerpt may hold, in either spelling a host writes. A
// value runs to the next known key, so a reason may hold spaces and "=".
const KEYS = ["status", "scope", "findings", "dispositions", "calls", "failed", "refused", "tools_served", "rounds", "files_opened", "files_not_opened", "cost", "clone_ms", "review_ms", "reason", "source", "reasonCode", "reason_code", "cause", "incomplete_cause", "partial_cause", "neighbourhood_cause", "notes"];
const KEY = new RegExp(`(?:^|\\s)(${KEYS.join("|")})=`, "g");

// An excerpt's key=value pairs.
export function parseExcerpt(text) {
  const out = {};
  const marks = [...String(text ?? "").matchAll(KEY)];
  for (const [i, m] of marks.entries()) {
    const start = m.index + m[0].length;
    const end = i + 1 < marks.length ? marks[i + 1].index : text.length;
    out[m[1]] = text.slice(start, end).trim();
  }
  return out;
}

// The reason codes a reason's text shows, in the library's order: the first
// that matches is the code.
const CODES = [
  ["nothing_to_review", /^nothing to review/],
  ["merge_base_unproven", /not an ancestor|merge base/],
  ["missing_objects", /missing (?:git )?objects|partial clone/],
  ["reviewer_unavailable", /no reviewer is available|reviewer is not available/],
  ["secret_in_change", /secret the scanners found/],
  ["brief_too_big", /MAX_BRIEF_BYTES/],
  ["boundary_breach", /read outside the snapshot/],
  ["budget_refused", /budget refused/],
  ["deadline_timeout", /timed out|time ran out|did not finish in time/],
  ["reviewer_failed", /model call failed/],
  ["range_not_examined", /changed ranges? (?:was|were) not examined/],
];
export function codeOf(reason) {
  for (const [code, pattern] of CODES) if (pattern.test(reason)) return code;
  return "other";
}

// The kinds of note a step's reason and notes carry, each counted once.
const NOTES = [
  ["packet_byte_cap", /symbols cut at the packet byte cap/],
  ["neighbourhood_time_cap", /Time cap reached/],
  ["brief_too_big", /MAX_BRIEF_BYTES/],
  ["range_not_examined", /changed ranges? (?:was|were) not examined/],
  ["unit_not_examined", /unit u\d+ was not (?:examined|started)/],
  ["timed_out", /timed out|time ran out|did not finish in time/],
  ["model_call_failed", /model call failed/],
  ["budget_refused", /budget refused/],
  ["nothing_to_review", /nothing to review/],
];
export function notesOf(text) {
  return NOTES.filter(([, pattern]) => pattern.test(text)).map(([kind]) => kind);
}

// The ISO week of a time (ms since the epoch or an ISO string): 2026-W48.
export function isoWeek(at) {
  const d = new Date(typeof at === "number" ? at : Date.parse(at));
  const day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  day.setUTCDate(day.getUTCDate() + 4 - (day.getUTCDay() || 7));
  const year = day.getUTCFullYear();
  const week = Math.ceil(((day - Date.UTC(year, 0, 1)) / 86_400_000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

// One record per library_review step in the sweep's text.
export function stepsOf(jsonl) {
  const out = [];
  for (const line of jsonl.split("\n")) {
    if (line.trim() === "") continue;
    for (const step of JSON.parse(line).steps ?? []) {
      if (step.name !== "library_review") continue;
      const e = parseExcerpt(step.resultExcerpt);
      const reason = e.reason ?? "";
      const status = e.status ?? "unknown";
      const given = e.reasonCode ?? e.reason_code ?? e.cause ?? e.incomplete_cause;
      // Before the nothing_to_review status, a review with nothing to review
      // ended complete with a reason; its code is still read from that reason.
      const code = given ?? (reason ? codeOf(reason) : null);
      out.push({ week: isoWeek(step.createdAt), status, code, partial: e.partial_cause ?? e.neighbourhood_cause ?? null, notes: notesOf(`${reason}\n${e.notes ?? ""}`) });
    }
  }
  return out;
}

// Per week: the step count and the count of each value in each group.
export function rates(records) {
  const weeks = new Map();
  for (const r of records) {
    let w = weeks.get(r.week);
    if (!w) weeks.set(r.week, (w = { total: 0, status: {}, code: {}, partial: {}, note: {} }));
    w.total++;
    const add = (group, value) => { if (value) w[group][value] = (w[group][value] ?? 0) + 1; };
    add("status", r.status);
    add("code", r.code);
    add("partial", r.partial);
    for (const kind of r.notes) add("note", kind);
  }
  return new Map([...weeks.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

const CLEAN = new Set(["complete", "complete_blocking"]);
const LABELS = { status: "status", code: "reason code", partial: "partial cause", note: "note" };

// The printed table: one line per week, group and value, with its share.
export function format(weeks) {
  const lines = [];
  for (const [week, w] of weeks) {
    lines.push(`${week}: ${w.total} library reviews`);
    for (const group of ["status", "code", "partial", "note"]) {
      for (const [value, count] of Object.entries(w[group]).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
        const share = count / w.total;
        const flag = share > FLAG_ABOVE && !(group === "status" && CLEAN.has(value)) ? "  FLAG: above 20%" : "";
        lines.push(`  ${LABELS[group]} ${value}: ${count} (${(share * 100).toFixed(1)}%)${flag}`);
      }
    }
  }
  return lines.join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const path = process.argv[2];
  if (!path) {
    console.error("usage: node scripts/note-rates.mjs <sweep.jsonl>");
    process.exit(2);
  }
  console.log(format(rates(stepsOf(readFileSync(path, "utf8")))));
}
