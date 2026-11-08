// Failure cases: benchmark/test/calibration-failures.md.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { canonicalJson } from "./suites.mjs";

const equal = (a, b) => canonicalJson(a) === canonicalJson(b);
const need = (ok, message) => { if (!ok) throw new Error(`calibration: ${message}`); };
export const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function checkedBytes(bytes, pin) {
  need(hash(bytes) === pin.sha256, `${pin.path} differs from its source pin`);
  return bytes;
}

export function compareLabels(verdicts, published, classes) {
  const index = (rows, kind) => {
    const map = new Map();
    for (const row of rows) {
      need(typeof row.id === "string" && classes.includes(row.label), `${kind}: malformed label`);
      need(!map.has(row.id), `${kind}: duplicate label ${row.id}`);
      map.set(row.id, row.label);
    }
    return map;
  };
  const ours = index(verdicts, "adapter");
  const theirs = index(published, "vendor");
  for (const id of ours.keys()) need(theirs.has(id), `missing vendor label for ${id}`);
  for (const id of theirs.keys()) need(ours.has(id), `extra vendor label for ${id}`);
  const counts = { total: ours.size, agree: 0, disagree: 0, byClass: Object.fromEntries(classes.map((c) => [c, { total: 0, agree: 0, disagree: 0 }])) };
  for (const [id, expected] of theirs) {
    const verdict = ours.get(id) === expected ? "agree" : "disagree";
    counts[verdict]++; counts.byClass[expected][verdict]++; counts.byClass[expected].total++;
  }
  return counts;
}

export const agreementOf = (counts) => Object.fromEntries(Object.entries(counts.byClass).map(([name, c]) => [name, c.total === 0 ? null : c.agree / c.total]));
export const agreementPercentages = (agreement) => Object.fromEntries(Object.entries(agreement).map(([name, value]) => [name, Number((value * 100).toFixed(2))]));

function validateAgreement(record) {
  const counts = record.counts;
  const classes = Object.keys(counts?.byClass ?? {}).sort();
  need(equal(classes, record.board.name === "greptile" ? ["caught", "missed"] : ["negative", "positive"]), "agreement must give both published classes");
  let total = 0; let agree = 0; let disagree = 0;
  for (const [name, c] of Object.entries(counts.byClass)) {
    need([c.total, c.agree, c.disagree].every((n) => Number.isInteger(n) && n >= 0) && c.total === c.agree + c.disagree, `invalid counts for ${name}`);
    need(c.total > 0, `empty class ${name}`);
    total += c.total; agree += c.agree; disagree += c.disagree;
  }
  need(counts.total === total && counts.agree === agree && counts.disagree === disagree, "aggregate counts differ from class counts");
  need(equal(record.agreement, agreementOf(counts)), "agreement differs from saved counts");
}

// Completion means agreement was computed for both classes. The comparison
// applies its acceptance bar separately, after checking the record's pins.
export function finalizeCalibration(record) {
  if (record.judgeFailures?.items) record.excluded = { count: record.judgeFailures.items, reason: "Judge items exhausted invalid-answer retries; their affected reviews and published labels were excluded from agreement. See judgeFailures for stages, attempts and per-class label counts." };
  try { validateAgreement(record); } catch (error) { record.status = "failed"; record.failure = error.message; return 1; }
  record.status = "complete";
  return 0;
}

// The comparison checks the ruling's board, person and date before passing
// its percentages here. A ruling never bypasses record integrity checks.
export function validateCalibration(record, { build, board, agreementRuling }) {
  need(!Object.hasOwn(record, "form"), "form calibration cannot be used in a comparison");
  need(record.status !== "failed", "failed calibration has no agreement on both published classes");
  if (record.judgeFailures?.items) need(record.status === "complete" && record.excluded?.count === record.judgeFailures.items && Number.isInteger(record.excluded.count) && record.excluded.count > 0 && typeof record.excluded.reason === "string" && record.excluded.reason.trim().length > 0, "judge failures must have a matching excluded item count and reason");
  need(equal(record.build, build), "build differs from the comparison build");
  need(equal(record.board, board) && record.judgeModel === board.judgeModel && record.promptHash === board.promptHash, "board, prompt or judge differs from the comparison board");
  need(record.version === 1 && typeof record.vendor === "string" && record.vendor.length > 0 && typeof record.labelUnit === "string" && record.labelUnit.length > 0 && Number.isFinite(record.costUsd) && record.costUsd >= 0, "missing vendor, label unit or cost");
  validateAgreement(record);
  need(Object.values(record.agreement).every((v) => v >= 0.9) || (agreementRuling !== undefined && equal(agreementRuling, agreementPercentages(record.agreement))), "agreement must be at least 90 percent on each class without a matching calibration ruling");
  return record;
}

// The label unit is a golden comment, identified by PR and its frozen index.
// No unmatched pair is invented from the winner-only published evaluations.
export function martianLabels(data, evaluations, vendor) {
  const out = [];
  for (const [url, entry] of Object.entries(data)) {
    const ev = evaluations[url]?.[vendor];
    need(ev && !ev.skipped && ev.errors_count === 0, `${url}: missing or failed vendor evaluation`);
    const rows = [
      ...(ev.true_positives ?? []).map((g) => ({ id: g.golden_comment, label: "positive" })),
      ...(ev.false_negatives ?? []).map((g) => ({ id: g.golden_comment, label: "negative" })),
    ];
    const truth = entry.golden_comments.map((g) => ({ id: g.comment, label: "positive" }));
    compareLabels(truth, rows, ["positive", "negative"]);
    const labels = new Map(rows.map((r) => [r.id, r.label]));
    entry.golden_comments.forEach((g, i) => out.push({ id: `${url}#g${i + 1}`, label: labels.get(g.comment) }));
  }
  return out;
}

export function costOfUsage(usage, model) {
  need(usage?.responses > 0 && usage.missing === 0, "judge usage is missing, cost cannot be reported");
  const price = JSON.parse(readFileSync(new URL("../outside/prices.json", import.meta.url))).models[model];
  need(price, `no price for ${model}`);
  return ((usage.inputTokens - usage.cachedTokens) * price.input + usage.cachedTokens * price.cachedInput + usage.outputTokens * price.output) / 1_000_000;
}
