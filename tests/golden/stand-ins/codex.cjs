// Model provider stand-in, using the stream test's complete stdin and JSON events.
const { cpSync, existsSync, readFileSync, realpathSync, writeFileSync } = require("node:fs");
const { dirname, join } = require("node:path");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("codex-cli 0.160.0"); process.exit(0); }
if (args[0] === "login") { console.log("Logged in using ChatGPT"); process.exit(0); }
// The provider binary also answers the driver's preflight command. Only the
// inside file and completion marker are returned. This scripted provider is
// not a test of the real Codex operating system sandbox.
if (args[0] === "sandbox") {
  const sh = args.lastIndexOf("sh");
  process.stdout.write(readFileSync(args[sh + 1], "utf8"));
  console.log(args[sh + 4]);
  process.exit(0);
}
const folder = dirname(__filename);
const snapshot = realpathSync(process.cwd());
writeFileSync(join(folder, "snapshot-path"), snapshot);
// A copy of the snapshot as the reviewer is given it, after the run took its
// hash: the harness checks that hash and records it normalised. A correction
// round starts the provider again and keeps the first copy.
const copy = join(folder, "snapshot");
if (!existsSync(copy)) cpSync(snapshot, copy, { recursive: true, filter: (path) => path !== join(snapshot, ".git") });
const answer = readFileSync(join(folder, "submission.json"), "utf8").trim();
process.stdin.resume();
process.stdin.on("end", () => {
  const emit = (event) => console.log(JSON.stringify(event));
  emit({ type: "thread.started", thread_id: "golden-codex-session" });
  emit({ type: "turn.started" });
  emit({ type: "item.completed", item: { id: "golden-read", type: "command_execution", command: "/bin/cat app/server.py", aggregated_output: readFileSync(join(snapshot, "app/server.py"), "utf8"), exit_code: 0, status: "completed" } });
  emit({ type: "item.completed", item: { id: "golden-answer", type: "agent_message", text: answer } });
  emit({ type: "turn.completed", usage: { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 500 } });
});
