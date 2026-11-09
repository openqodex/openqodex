// Model provider stand-in, using the stream test's stdin and stream-json shape.
const { mkdtempSync, renameSync, rmSync, cpSync, existsSync, readFileSync, realpathSync, writeFileSync } = require("node:fs");
const { dirname, join } = require("node:path");
const { createInterface } = require("node:readline");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("2.1.289 (Claude Code)"); process.exit(0); }
if (args[0] === "auth") { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
const folder = dirname(__filename);
const snapshot = realpathSync(process.cwd());
writeFileSync(join(folder, "snapshot-path"), snapshot);
// A copy of the snapshot as the reviewer is given it, after the run took its
// hash: the harness checks that hash and records it normalised. A correction
// round starts the provider again and keeps the first copy.
const copy = join(folder, "snapshot");
if (!existsSync(copy)) {
  const pending = mkdtempSync(join(folder, "snapshot-pending-"));
  try {
    cpSync(snapshot, pending, { recursive: true, filter: (path) => path !== join(snapshot, ".git") });
    try { renameSync(pending, copy); }
    catch (error) { if (!["EEXIST", "ENOTEMPTY"].includes(error.code)) throw error; }
  } finally { rmSync(pending, { recursive: true, force: true }); }
}
// Answers are derived from the brief's ids and frozen planted locations.
// The quotes come from the snapshot at those locations, never live scanners.
const frozen = JSON.parse(readFileSync(join(folder, "submission.json"), "utf8"));
let initialBrief = null;
let answerRound = 0;
function answerForPrompt(prompt) {
  initialBrief ??= prompt.split("## Your answer so far")[0];
  const brief = initialBrief;
  const first = brief.split("\n")[0];
  const kind = /verif/i.test(first) ? "verify" : /find/i.test(first) ? "find" : "single";
  answerRound++;
  const change_id = /`change_id`:\s*`([0-9a-f]+)`/.exec(brief)?.[1] ?? /["`]?change_id["`]?\s*[:=]\s*["`]?([0-9a-f]{12,64})/.exec(brief)?.[1] ?? frozen.change_id;
  if (kind === "single") return JSON.stringify({ ...frozen, change_id });
  const hunks = [...brief.matchAll(/^###\s+(h\d+)\s+(.+?)\s+(\d+)-(\d+)/gm)].map((m) => ({ id: m[1], file: m[2], start: Number(m[3]), end: Number(m[4]) }));
  if (kind === "find") {
    const unit = /\b(u\d+)\b/.exec(first)?.[1] ?? /(?:unit|review unit)[`"\s:*]+(u\d+)/i.exec(brief)?.[1];
    if (!unit) throw new Error("find brief has no unit id");
    const pass = /\b(local|contracts)\b/.exec(first)?.[1] ?? /(?:pass)[`"\s:*]+(local|contracts)/i.exec(brief)?.[1];
    if (!pass) throw new Error("find brief has no pass");
    if (process.env.OPENQODEX_STANDIN_FAIL_FINDER === `${unit}:${pass}`) throw new Error("selected finder fails in both sessions");
    const candidates = [];
    const seen = new Set();
    const list = existsSync(join(folder, "find-answers.json")) ? Object.values(JSON.parse(readFileSync(join(folder, "find-answers.json"), "utf8"))).flat() : frozen.findings;
    for (const f of list) {
      const hunk = hunks.find((h) => h.file === f.file_path && f.line_number >= h.start && f.line_number <= h.end)
        ?? hunks.find((h) => h.file === f.file_path && Math.min(Math.abs(h.start - f.line_number), Math.abs(h.end - f.line_number)) <= 2);
      if (!hunk) continue;
      // A deleted line can move the planted location beside its anchor.
      const anchor = Math.max(hunk.start, Math.min(hunk.end, f.line_number));
      const key = `${f.file_path}:${f.line_number}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const quote = readFileSync(join(snapshot, f.file_path), "utf8").split("\n")[f.line_number - 1];
      if (!quote?.trim()) continue;
      candidates.push({ severity: f.severity, category: f.category, confidence: 0.8, file_path: f.file_path, line_number: anchor, line_end: Math.max(anchor, f.line_end ?? f.line_number), title: f.title, claim: f.problem, evidence: [{ file_path: f.file_path, line_number: f.line_number, quote }] });
    }
    return JSON.stringify({ version: "find-1", change_id, unit, examined: hunks.map((h) => h.id), analysis: hunks.map((h) => ({ hunk: h.id, changed: "The planted operation changes here.", could_break: "Unsafe inputs can affect this operation." })), candidates });
  }
  const candidates = new Map();
  for (const m of brief.matchAll(/^### ([ck]\d+) \((finder|scanner)\)\n([\s\S]*?)(?=^### |^## )/gm)) {
    const location = /^- Location: (.+):(\d+)(?:-(\d+))?$/m.exec(m[3]);
    if (location) candidates.set(m[1], { id: m[1], file_path: location[1], line_number: Number(location[2]), line_end: Number(location[3] ?? location[2]), title: /^- Title: (.*)$/m.exec(m[3])?.[1], category: /^- Category: (.*)$/m.exec(m[3])?.[1] });
  }
  if (!candidates.size) throw new Error("verify brief has no candidate ids");
  const unresolved = process.env.OPENQODEX_STANDIN_UNRESOLVED_SCANNER === "1" && answerRound === 1;
  const verdicts = [...candidates].map(([id, c]) => {
    const details = c.candidate ?? c;
    const file_path = details.file_path ?? details.filePath;
    const line_number = details.line_number ?? details.lineStart;
    const templates = existsSync(join(folder, "find-answers.json")) ? Object.values(JSON.parse(readFileSync(join(folder, "find-answers.json"), "utf8"))).flat() : frozen.findings;
    const template = templates.find((f) => details.title && f.title === details.title) ?? templates.find((f) => f.file_path === file_path && f.line_number === line_number) ?? frozen.findings[0];
    return { id, verdict: unresolved && id.startsWith("c") ? "unresolved" : "confirmed", reason: "The planted operation is unsafe on this changed line.", severity: template.severity, category: details.category ?? template.category, confidence: 1, file_path, line_number, line_end: details.line_end ?? line_number, title: template.title, problem: template.problem, consequence: template.consequence, fix: template.fix, tier: "finding" };
  });
  for (const v of verdicts) {
    if (!v.id.startsWith("k")) continue;
    const scanner = verdicts.find((s) => s.id.startsWith("c") && s.file_path === v.file_path && s.line_number === v.line_number);
    if (scanner) v.duplicate_of = scanner.id;
  }
  return JSON.stringify({ version: "verify-1", change_id, verdicts });
}

const emit = (event) => console.log(JSON.stringify(event));
const session_id = `golden-claude-session-${process.pid}`;
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  const inputContent = message.message?.content ?? message.content ?? "";
  const prompt = typeof inputContent === "string" ? inputContent : inputContent.map((c) => c.text ?? "").join("\n");
  const answer = answerForPrompt(prompt);
  const path = join(snapshot, "app/server.py");
  const content = readFileSync(path, "utf8");
  emit({ type: "system", subtype: "init", session_id, tools: ["Read", "Grep", "Glob"], mcp_servers: [] });
  emit({ type: "assistant", session_id, message: { content: [{ type: "tool_use", id: "golden-read", name: "Read", input: { file_path: path } }] } });
  emit({ type: "user", session_id, message: { content: [{ type: "tool_result", tool_use_id: "golden-read", content }] }, tool_use_result: { type: "text", file: { filePath: path, content, startLine: 1, numLines: content.split("\n").length, totalLines: content.split("\n").length } } });
  const brief = initialBrief;
  const first = brief.split("\n")[0];
  const selected = /verif/i.test(first) ? `verifier:${/^## The file\n\n(.+)$/m.exec(brief)?.[1]}`
    : /find/i.test(first) ? `finder:${/^Unit: (u\d+)$/m.exec(brief)?.[1]}:${/^Pass: (local|contracts)$/m.exec(brief)?.[1]}` : "primary";
  if (answerRound === 1 && process.env.OPENQODEX_STANDIN_TOOL_SESSION === selected) {
    const name = process.env.OPENQODEX_STANDIN_TOOL_NAME;
    const extraPath = process.env.OPENQODEX_STANDIN_TOOL_PATH;
    const is_error = process.env.OPENQODEX_STANDIN_TOOL_ERROR === "1";
    const input = name === "Bash" ? { command: "pwd" } : { file_path: extraPath };
    emit({ type: "assistant", session_id, message: { content: [{ type: "tool_use", id: "extra-call", name, input }] } });
    emit({ type: "user", session_id, message: { content: [{ type: "tool_result", tool_use_id: "extra-call", content: is_error ? "Permission denied" : "outside content", ...(is_error ? { is_error: true } : {}) }] } });
  }
  emit({ type: "result", subtype: "success", is_error: false, session_id, result: answer, num_turns: 1, total_cost_usd: 0.01, usage: { input_tokens: 1000, output_tokens: 500, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } });
});
