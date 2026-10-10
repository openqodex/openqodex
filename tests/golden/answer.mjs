// Freezes the stand-ins' fixed answer, stand-ins/submission.json: one finding
// per scanner candidate of the golden run, in candidate order, none dropped.
// Run by hand with `pnpm golden:answer` when the demo's candidates change
// (a new scanner version, a new planted bug), then record again. record and
// check never run it: the stand-ins replay the frozen file and never look at
// the candidates of the run they answer.
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bin, checked, here, prepare, SKIPPED } from "./record.mjs";

export function answerFor(scan, changeId) {
  return {
    version: 2,
    change_id: changeId,
    summary: "Reviewed the fixed planted change.",
    findings: scan.candidates.map((c, i) => ({
      severity: c.reviewSeverity,
      category: "bug",
      confidence: 1,
      file_path: c.filePath,
      line_number: c.lineStart,
      line_end: c.lineEnd,
      title: `Planted problem number ${i + 1}`,
      problem: "This changed line introduces an unsafe operation.",
      consequence: "The affected behavior can fail when this path runs.",
      fix: "Correct the flagged operation before using this change.",
      source: c.token,
      candidate: c.id,
    })),
    dropped: [],
  };
}

export const answerText = (scan, changeId) => `${JSON.stringify(answerFor(scan, changeId), null, 2)}\n`;

async function freeze() {
  const prepared = await prepare();
  try {
    const out = join(prepared.work, "scan");
    await checked(process.execPath, [bin, "scan", "--skip", SKIPPED, "--report-dir", out, "--format", "json", "--no-color"], prepared.demo, prepared.env);
    const scan = JSON.parse(readFileSync(join(out, "scan.json"), "utf8"));
    const report = JSON.parse(readFileSync(join(out, "report.json"), "utf8"));
    writeFileSync(join(here, "stand-ins/submission.json"), answerText(scan, report.change_id));
    console.log(`golden: answer frozen, ${scan.candidates.length} candidates raised, change ${report.change_id}`);
  } finally {
    rmSync(prepared.work, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await freeze(); }
  catch (error) { console.error(error.message); process.exitCode = 2; }
}
