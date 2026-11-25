#!/usr/bin/env node
// Model provider stand-in for the ReviewBench entrypoint's tests and its
// container smoke run: it answers on Claude Code's stream-json shape, as
// tests/golden/stand-ins/claude.cjs does, but for any change, not the demo's.
// A finder raises one candidate on the first added line of its unit's first
// hunk that has text, quoting the brief's diff row; a verifier confirms every
// candidate it is given, scanner candidates included. The title names the
// user the stand-in ran as and the model it was asked for (ANTHROPIC_MODEL),
// so a run shows both.
// A file STANDIN_MODE beside the stand-in (a file, since the reviewer's
// environment is an allowlist) changes it: "silent" raises nothing,
// "unexamined" answers without examining any hunk, so the review ends
// incomplete, and "crash" exits before it answers.
const { existsSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const { createInterface } = require("node:readline");

const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("2.1.331 (Claude Code)"); process.exit(0); }
if (args[0] === "auth") { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
const modeFile = join(__dirname, "STANDIN_MODE");
const mode = existsSync(modeFile) ? readFileSync(modeFile, "utf8").trim() : "";
if (mode === "crash") { console.error("stand-in: crash mode"); process.exit(1); }
const silent = mode === "silent";
const uid = typeof process.getuid === "function" ? process.getuid() : "unknown";
const model = process.env.ANTHROPIC_MODEL ?? "none";

function findAnswer(brief, change_id) {
  const first = brief.split("\n")[0];
  const unit = /^Unit: (u\d+)$/m.exec(brief)?.[1];
  if (!unit) throw new Error("find brief has no unit id");
  const hunks = [...brief.matchAll(/^### (h\d+) (.+?) (\d+)-(\d+)[^\n]*\n([\s\S]*?)(?=^### |^## |$(?![\s\S]))/gm)];
  const digests = [...brief.matchAll(/^### (d\d+) (.+?) \(structural summary: (?:json|store)\)/gm)];
  const candidates = [];
  for (const h of silent ? [] : hunks.slice(0, 1)) {
    let next = 0;
    for (const row of h[5].split("\n")) {
      const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row);
      if (header) { next = Number(header[1]); continue; }
      if (!next) continue;
      if (row.startsWith("+") && row.slice(1).trim() !== "") {
        candidates.push({ severity: "major", category: "bug", confidence: 0.9, file_path: h[2], line_number: next, line_end: next, title: `Stand-in finding, reviewed as uid ${uid} with model ${model}`, claim: "The stand-in flags the first added line of the unit.", evidence: [{ file_path: h[2], line_number: next, quote: row.slice(1) }] });
        break;
      }
      if (row.startsWith("+") || row.startsWith(" ")) next++;
    }
  }
  const ids = mode === "unexamined" ? [] : [...hunks.map((h) => h[1]), ...digests.map((d) => d[1])];
  if (!/find/i.test(first)) throw new Error("not a find brief");
  return { version: "find-1", change_id, unit, examined: ids, analysis: ids.map((hunk) => ({ hunk, changed: "The stand-in read this hunk.", could_break: "The stand-in does not judge code." })), candidates };
}

function verifyAnswer(brief, change_id) {
  const verdicts = [];
  for (const m of brief.matchAll(/^### ([ck]\d+) \((?:finder|scanner)\)\n([\s\S]*?)(?=^### |^## )/gm)) {
    const location = /^- Location: (.+):(\d+)(?:-(\d+))?$/m.exec(m[2]);
    if (!location) continue;
    const line_number = Number(location[2]);
    verdicts.push({ id: m[1], verdict: "confirmed", reason: "The stand-in confirms every candidate.", severity: "major", category: /^- Category: (.*)$/m.exec(m[2])?.[1] ?? "bug", confidence: 1, file_path: location[1], line_number, line_end: Number(location[3] ?? location[2]), title: /^- Title: (.*)$/m.exec(m[2])?.[1] ?? "Stand-in finding", problem: "The stand-in raised this line.", consequence: "Nothing: no model read it.", fix: "None needed.", tier: "finding" });
  }
  if (verdicts.length === 0) throw new Error("verify brief has no candidate ids");
  return { version: "verify-1", change_id, verdicts };
}

let brief = null;
const session_id = `reviewbench-standin-${process.pid}`;
const emit = (event) => console.log(JSON.stringify(event));
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  const content = message.message?.content ?? message.content ?? "";
  const prompt = typeof content === "string" ? content : content.map((c) => c.text ?? "").join("\n");
  brief ??= prompt.split("## Your answer so far")[0];
  const change_id = /`change_id`:\s*`([0-9a-f]+)`/.exec(brief)?.[1] ?? /"change_id":\s*"([0-9a-f]{12,64})"/.exec(brief)?.[1];
  emit({ type: "system", subtype: "init", session_id, tools: ["Read", "Grep", "Glob"], mcp_servers: [] });
  const answer = /verif/i.test(brief.split("\n")[0]) ? verifyAnswer(brief, change_id) : findAnswer(brief, change_id);
  emit({ type: "result", subtype: "success", is_error: false, session_id, result: JSON.stringify(answer), num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1000, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } });
});
