// Model provider only. The CLI, git, snapshots and checks are real.
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("2.1.289 (Claude Code)"); process.exit(0); }
if (args[0] === "auth") { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const brief = JSON.parse(line).message.content;
  const id = /`change_id`: `([0-9a-f]{12})`/.exec(brief)[1];
  // The staged briefs get the same empty answer in their own shape: every
  // hunk examined with no candidate, every candidate refuted.
  const answer = () => {
    if (brief.startsWith("# OpenQodex review brief: find pass")) {
      const hunks = [...brief.matchAll(/^### (h\d+) (.+) (\d+)-(\d+)(?: \([^\n]*\))*$/gm)].map((m) => m[1]);
      return { version: "find-1", change_id: id, unit: /^Unit: (u\d+)$/m.exec(brief)[1], examined: hunks, analysis: hunks.map((hunk) => ({ hunk, changed: "The page size changed.", could_break: "A caller that depends on the old page size.", checked: "The callers of page_size.", conclusion: "No defect." })), candidates: [] };
    }
    if (brief.startsWith("# OpenQodex review brief: verify pass")) {
      const verdicts = [...brief.matchAll(/^### ([ck]\d+) \((finder|scanner)\)\n([\s\S]*?)(?=^### |^## |$(?![\s\S]))/gm)].map((m) => {
        const location = /^- Location: (.+):(\d+)(?:-\d+)?$/m.exec(m[3]);
        return { id: m[1], verdict: "refuted", reason: "The cited line shows no defect.", duplicate_of: null, severity: "minor", category: "bug", confidence: 1, file_path: location[1], line_number: Number(location[2]), title: "No defect", problem: "The cited line shows no defect.", consequence: "None.", fix: "None.", tier: "finding" };
      });
      return { version: "verify-1", change_id: id, verdicts };
    }
    return { version: 2, change_id: id, summary: "Changes the page size.", findings: [], dropped: [] };
  };
  console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "conventions", tools: ["Read", "Grep", "Glob"], mcp_servers: [] }));
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: "conventions", result: JSON.stringify(answer()), num_turns: 1 }));
});
