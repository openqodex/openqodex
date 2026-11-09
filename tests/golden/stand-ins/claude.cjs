// Model provider stand-in, using the stream test's stdin and stream-json shape.
// OPENQODEX_STANDIN_PLANT is a semicolon-separated list of path:first[-last]:title.
// A finder needs every planted line in its received rows. With exactly one
// half of a two-line plant within 50 lines of its part's edge, it Reads three
// lines centred on the second half and combines that result with brief/page
// rows before raising a candidate. A part with neither half never Reads it.
// A ranged plant is confirmed only after the verifier's own Read returns
// every line of the range.
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
const received = new Map();
const readReceived = new Map();
const plants = (process.env.OPENQODEX_STANDIN_PLANT ?? "").split(";").filter(Boolean).map((entry) => {
  const match = /^(.+):(\d+)(?:-(\d+))?:(.+)$/.exec(entry);
  if (!match) throw new Error("invalid OPENQODEX_STANDIN_PLANT entry");
  return { file_path: match[1], line_number: Number(match[2]), line_end: Number(match[3] ?? match[2]), title: match[4], severity: "major", category: "bug", problem: "The planted operation accepts an invalid value.", consequence: "A caller gets incorrect output.", fix: "Validate the value before using it." };
});
function hasPlant(rows, plant) {
  for (let line = plant.line_number; line <= plant.line_end; line++) if (!rows.get(plant.file_path)?.has(line)) return false;
  return true;
}
function remember(prompt) {
  const put = (path, line, text) => {
    if (!received.has(path)) received.set(path, new Map());
    received.get(path).set(line, text);
  };
  for (const m of prompt.matchAll(/^### h\d+ (.+?) \d+-\d+[^\n]*\n([\s\S]*?)(?=^### |^## |$(?![\s\S]))/gm)) {
    let next = 0;
    for (const row of m[2].split("\n")) {
      const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(row);
      if (header) { next = Number(header[1]) + Number(header[2] === "0"); continue; }
      if (next && /^[ +]/.test(row)) { put(m[1], next++, row.slice(1)); }
    }
  }
  for (const m of prompt.matchAll(/^### d\d+ (.+?) \(structural summary: json\)\n([\s\S]*?)(?=^### |^## |$(?![\s\S]))/gm)) {
    for (const plant of plants.filter((p) => p.file_path === m[1])) {
      for (const row of m[2].split("\n")) {
        const odd = /^odd record \$.*?@(\d+)-(\d+): (.+)$/.exec(row);
        if (odd && Number(odd[1]) === plant.line_number) {
          const rows = readFileSync(join(snapshot, plant.file_path), "utf8").split("\n");
          // The odd-record entry must contain the actual record. Its opening
          // line is not a scalar, so a scalar listing cannot trigger this plant.
          const record = rows.slice(Number(odd[1]) - 1, Number(odd[2])).join("\n").replace(/,\s*$/, "");
          try {
            if (JSON.stringify(JSON.parse(odd[3])) === JSON.stringify(JSON.parse(record))) put(plant.file_path, plant.line_number, rows[plant.line_number - 1]);
          } catch { /* A shortened odd record cannot trigger a full-record plant. */ }
        }
        const scalar = /^\$.*?@(\d+) = (.+)$/.exec(row);
        if (!scalar || Number(scalar[1]) !== plant.line_number) continue;
        // A plant fires only after its value appears in received digest text.
        // Disk supplies the literal evidence, never the decision to find it.
        const quote = readFileSync(join(snapshot, plant.file_path), "utf8").split("\n")[plant.line_number - 1];
        if (quote?.includes(scalar[2])) put(plant.file_path, plant.line_number, quote);
      }
    }
  }
  let path = null;
  for (const row of prompt.split("\n")) {
    const header = /^(.+) lines \d+ to \d+ \(with context \d+ to \d+\):$/.exec(row);
    if (header) { path = header[1]; continue; }
    const line = /^(\d+)\t(.*)$/.exec(row);
    if (path && line) {
      if (!line[2].startsWith("(not shown: a context line over ")) put(path, Number(line[1]), line[2]);
    }
    else path = null;
  }
}
function answerForPrompt(prompt) {
  remember(prompt);
  initialBrief ??= prompt.split("## Your answer so far")[0];
  const brief = initialBrief;
  const first = brief.split("\n")[0];
  const kind = /verif/i.test(first) ? "verify" : /find/i.test(first) ? "find" : "single";
  const change_id = /`change_id`:\s*`([0-9a-f]+)`/.exec(brief)?.[1] ?? /["`]?change_id["`]?\s*[:=]\s*["`]?([0-9a-f]{12,64})/.exec(brief)?.[1] ?? frozen.change_id;
  if (kind === "single") return JSON.stringify({ ...frozen, change_id });
  const hunks = [...brief.matchAll(/^###\s+(h\d+)\s+(.+?)\s+(\d+)-(\d+)/gm)].map((m) => ({ id: m[1], file: m[2], start: Number(m[3]), end: Number(m[4]) }));
  const digests = [...brief.matchAll(/^###\s+(d\d+)\s+(.+?) \(structural summary: (json|store)\)/gm)].map((m) => ({ id: m[1], file: m[2] }));
  if (kind === "find") {
    const unit = /\b(u\d+)\b/.exec(first)?.[1] ?? /(?:unit|review unit)[`"\s:*]+(u\d+)/i.exec(brief)?.[1];
    if (!unit) throw new Error("find brief has no unit id");
    const pass = /\b(local|contracts)\b/.exec(first)?.[1] ?? /(?:pass)[`"\s:*]+(local|contracts)/i.exec(brief)?.[1];
    if (!pass) throw new Error("find brief has no pass");
    if (process.env.OPENQODEX_STANDIN_FAIL_FINDER === `${unit}:${pass}`) throw new Error("selected finder fails in both sessions");
    const candidates = [];
    const seen = new Set();
    const list = existsSync(join(folder, "find-answers.json")) ? Object.values(JSON.parse(readFileSync(join(folder, "find-answers.json"), "utf8"))).flat() : frozen.findings;
    for (const f of [...list, ...plants]) {
      if (plants.includes(f) && !hasPlant(received, f)) continue;
      const hunk = hunks.find((h) => h.file === f.file_path && f.line_number >= h.start && f.line_number <= h.end)
        ?? hunks.find((h) => h.file === f.file_path && Math.min(Math.abs(h.start - f.line_number), Math.abs(h.end - f.line_number)) <= 2);
      const digest = digests.find((d) => d.file === f.file_path);
      if (!hunk && !digest) continue;
      // A deleted line can move the planted location beside its anchor.
      const anchor = hunk ? Math.max(hunk.start, Math.min(hunk.end, f.line_number)) : f.line_number;
      const key = `${f.file_path}:${f.line_number}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const quote = plants.includes(f) ? received.get(f.file_path).get(f.line_number) : readFileSync(join(snapshot, f.file_path), "utf8").split("\n")[f.line_number - 1];
      if (!quote?.trim()) continue;
      candidates.push({ severity: f.severity, category: f.category, confidence: 0.8, file_path: f.file_path, line_number: anchor, line_end: Math.max(anchor, f.line_end ?? f.line_number), title: f.title, claim: f.problem, evidence: [{ file_path: f.file_path, line_number: f.line_number, quote }] });
    }
    return JSON.stringify({ version: "find-1", change_id, unit, examined: [...hunks, ...digests].map((h) => h.id), analysis: [...hunks, ...digests].map((h) => ({ hunk: h.id, changed: "The planted operation changes here.", could_break: "Unsafe inputs can affect this operation." })), candidates });
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
    const template = [...templates, ...plants].find((f) => details.title && f.title === details.title) ?? [...templates, ...plants].find((f) => f.file_path === file_path && f.line_number === line_number) ?? frozen.findings[0];
    const unreadPlant = plants.includes(template) && template.line_end > template.line_number && !hasPlant(readReceived, template);
    return { id, verdict: unreadPlant ? (id.startsWith("c") ? "refuted" : "unresolved") : unresolved && id.startsWith("c") ? "unresolved" : "confirmed", reason: "The planted operation is unsafe on this changed line.", severity: template.severity, category: details.category ?? template.category, confidence: 1, file_path, line_number, line_end: details.line_end ?? line_number, title: template.title, problem: template.problem, consequence: template.consequence, fix: template.fix, tier: "finding" };
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
  initialBrief ??= prompt.split("## Your answer so far")[0];
  remember(prompt);
  // Counted here, before the tool calls below, so the first-round switches see round 1.
  answerRound++;
  const path = join(snapshot, "app/server.py");
  const content = readFileSync(path, "utf8");
  emit({ type: "system", subtype: "init", session_id, tools: ["Read", "Grep", "Glob"], mcp_servers: [] });
  emit({ type: "assistant", session_id, message: { content: [{ type: "tool_use", id: "golden-read", name: "Read", input: { file_path: path } }] } });
  emit({ type: "user", session_id, message: { content: [{ type: "tool_result", tool_use_id: "golden-read", content }] }, tool_use_result: { type: "text", file: { filePath: path, content, startLine: 1, numLines: content.split("\n").length, totalLines: content.split("\n").length } } });
  const brief = initialBrief;
  if (brief.startsWith("# OpenQodex review brief: find")) {
    const parts = [...brief.matchAll(/^### h\d+ (.+?) (\d+)-(\d+)/gm)];
    for (const plant of plants) {
      if (plant.line_end !== plant.line_number + 1) continue;
      const halves = [plant.line_number, plant.line_end].filter((line) => received.get(plant.file_path)?.has(line));
      if (halves.length !== 1 || !parts.some((m) => m[1] === plant.file_path && halves[0] >= Number(m[2]) && halves[0] <= Number(m[3]) && Math.min(halves[0] - Number(m[2]), Number(m[3]) - halves[0]) <= 50)) continue;
      const full = join(snapshot, plant.file_path);
      const from = plant.line_number;
      const rows = readFileSync(full, "utf8").replace(/\n$/, "").split("\n");
      const read = rows.slice(from - 1, from + 2);
      const content = read.join("\n");
      emit({ type: "assistant", session_id, message: { content: [{ type: "tool_use", id: "boundary-read", name: "Read", input: { file_path: full, offset: from, limit: 3 } }] } });
      emit({ type: "user", session_id, message: { content: [{ type: "tool_result", tool_use_id: "boundary-read", content }] }, tool_use_result: { type: "text", file: { filePath: full, content, startLine: from, numLines: read.length, totalLines: rows.length } } });
      if (!readReceived.has(plant.file_path)) readReceived.set(plant.file_path, new Map());
      if (!received.has(plant.file_path)) received.set(plant.file_path, new Map());
      read.forEach((row, i) => {
        readReceived.get(plant.file_path).set(from + i, row);
        received.get(plant.file_path).set(from + i, row);
      });
    }
  }
  if (brief.startsWith("# OpenQodex review brief: verify")) {
    const parts = [...brief.matchAll(/^### h\d+ (.+?) (\d+)-(\d+)/gm)];
    for (const plant of plants) if (brief.includes(`- Title: ${plant.title}\n`) && parts.some((m) => m[1] === plant.file_path && Math.min(Math.abs(Number(m[2]) - plant.line_number), Math.abs(Number(m[3]) - plant.line_number)) <= 50)) {
      const full = join(snapshot, plant.file_path);
      const from = Math.max(1, plant.line_number - 1);
      const rows = readFileSync(full, "utf8").replace(/\n$/, "").split("\n");
      const read = rows.slice(from - 1, plant.line_end + 1);
      const content = read.join("\n");
      if (!readReceived.has(plant.file_path)) readReceived.set(plant.file_path, new Map());
      read.forEach((row, i) => readReceived.get(plant.file_path).set(from + i, row));
      emit({ type: "assistant", session_id, message: { content: [{ type: "tool_use", id: "boundary-read", name: "Read", input: { file_path: full, offset: from, limit: plant.line_end - from + 2 } }] } });
      emit({ type: "user", session_id, message: { content: [{ type: "tool_result", tool_use_id: "boundary-read", content }] }, tool_use_result: { type: "text", file: { filePath: full, content, startLine: from, numLines: read.length, totalLines: rows.length } } });
    }
  }
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
  const answer = answerForPrompt(prompt);
  emit({ type: "result", subtype: "success", is_error: false, session_id, result: answer, num_turns: 1, total_cost_usd: 0.01, usage: { input_tokens: 1000, output_tokens: 500, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } });
});
