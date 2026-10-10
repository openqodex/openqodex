// Model provider stand-in, using the stream test's stdin and stream-json shape.
const { cpSync, existsSync, readFileSync, realpathSync, writeFileSync } = require("node:fs");
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
if (!existsSync(copy)) cpSync(snapshot, copy, { recursive: true, filter: (path) => path !== join(snapshot, ".git") });
const answer = readFileSync(join(folder, "submission.json"), "utf8").trim();
const emit = (event) => console.log(JSON.stringify(event));
const session_id = "golden-claude-session";
createInterface({ input: process.stdin }).on("line", () => {
  const path = join(snapshot, "app/server.py");
  const content = readFileSync(path, "utf8");
  emit({ type: "system", subtype: "init", session_id, tools: ["Read", "Grep", "Glob"], mcp_servers: [] });
  emit({ type: "assistant", session_id, message: { content: [{ type: "tool_use", id: "golden-read", name: "Read", input: { file_path: path } }] } });
  emit({ type: "user", session_id, message: { content: [{ type: "tool_result", tool_use_id: "golden-read", content }] }, tool_use_result: { type: "text", file: { filePath: path, content, startLine: 1, numLines: content.split("\n").length, totalLines: content.split("\n").length } } });
  emit({ type: "result", subtype: "success", is_error: false, session_id, result: answer, num_turns: 1, total_cost_usd: 0.01, usage: { input_tokens: 1000, output_tokens: 500, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } });
});
