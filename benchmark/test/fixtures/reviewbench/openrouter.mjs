#!/usr/bin/env node
// Model API stand-in for the ReviewBench entrypoint's model configuration:
// an OpenAI-compatible Responses API on 127.0.0.1, for its tests and its
// container smoke run. It answers through the scripted model
// (benchmark/lib/scripted-model.mjs): a finder raises one finding on the
// first added line of its brief's first hunk, titled with the model the
// request named; a verifier confirms it; other candidates are dropped.
//
//   node openrouter.mjs <dir> [reject]
// writes its port to <dir>/port and one line per request to
// <dir>/requests.jsonl: { path, authorization, model }. With `reject` every
// call is answered HTTP 401 with the bearer key quoted in the error, as a
// provider may quote it.
import { appendFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { createScriptedReviewer } from "../../../lib/scripted-model.mjs";

const [dir, mode = ""] = process.argv.slice(2);
const raised = [];

// The first added line of the brief's first hunk with text, as a finding.
function firstAdded(brief, model) {
  const hunk = /^### h\d+ (.+?) \d+-\d+[^\n]*\n([\s\S]*?)(?=^### |^## |$(?![\s\S]))/m.exec(brief);
  if (!hunk) return null;
  let next = 0;
  for (const row of hunk[2].split("\n")) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row);
    if (header) next = Number(header[1]);
    else if (next && row.startsWith("+") && row.slice(1).trim() !== "") {
      return { severity: "major", category: "bug", confidence: 1, file_path: hunk[1], line_number: next, title: `Stand-in finding with model ${model}`, problem: "The stand-in flags the first added line.", consequence: "Nothing: no model read it.", fix: "None needed." };
    } else if (next && /^[+ ]/.test(row)) next++;
  }
  return null;
}

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    const request = JSON.parse(body || "{}");
    const authorization = req.headers.authorization ?? null;
    appendFileSync(join(dir, "requests.jsonl"), `${JSON.stringify({ path: req.url, authorization, model: request.model ?? null })}\n`);
    const send = (status, doc) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(doc));
    };
    if (mode === "reject") return send(401, { error: { code: 401, message: `Invalid credentials: ${String(authorization).replace(/^Bearer /, "")}` } });
    const brief = (request.input ?? []).find((i) => i.role === "user" && typeof i.content === "string")?.content ?? "";
    const found = firstAdded(brief, request.model);
    if (found && !raised.some((f) => f.file_path === found.file_path && f.line_number === found.line_number)) raised.push(found);
    const script = { version: 1, model: request.model, served: request.model, prices: { input: 0, cachedInput: 0, output: 0 }, summary: "The stand-in's answer.", findings: raised, dropReason: "The stand-in drops every scanner candidate.", reply: null };
    try {
      const answer = await createScriptedReviewer(script).complete({ messages: [{ role: "user", text: brief }], tools: [], maxOutputTokens: request.max_output_tokens ?? 32000 });
      send(200, { id: "resp_standin", object: "response", status: "completed", model: request.model, output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: answer.message.text }] }], usage: { input_tokens: answer.usage.inputTokens, output_tokens: answer.usage.outputTokens } });
    } catch (error) {
      send(500, { error: { message: `stand-in: ${error.message}` } });
    }
  });
});
server.listen(0, "127.0.0.1", () => writeFileSync(join(dir, "port"), String(server.address().port)));
