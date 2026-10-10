// The decisive scope fixture (plan §4 test 7), reviewed end to end through
// the review core with the server's scoped parts: the change over the
// admitted paths, the materialised snapshot, base reads through the scope
// check and the graph's inventory of the snapshot. Real git, the real
// in-process SQL scanner, a real project-wide scanner (a custom one that
// walks the whole folder it is given, links followed), the real graph and
// the real finalize checks. The reviewer is the one stand-in: a model
// provider that answers from a recorded submission, and makes a stand-in
// tool call through `admitted` while the snapshot exists.
//
// Ways it could fail, written before the code:
//  1. A root canary, an excluded file inside the admitted folder, the old
//     version of a file renamed in from outside, or the target of an
//     unchanged link reaches the snapshot.
//  2. One of them reaches a scanner: a built-in scanner's changed files and
//     candidates, or what a project-wide scanner can read from its folder.
//  3. One of them reaches the graph packet: a caller outside the scope, or
//     a base version read outside it.
//  4. A tool call can read one of them.
//  5. A citation of a refused path, or a finding on one, passes the check.
//  6. One of them reaches the brief or an output: the report in every
//     format, the completion record, the trace, the submission, the
//     display, a progress line.
//  7. The rename from outside and the link left out are not recorded.
//  8. An incremental review wires the wrong change into the core: the
//     brief carries lines reviewed before, or a finding on such a line (in
//     the change, outside the delta) is refused, as if findings anchored on
//     the delta.
import { chmodSync, existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { parseConfig, renderJson, renderMarkdown, renderSarif } from "@openqodex/core";
import type { ReviewerDriver, ReviewerSession, Turn } from "../src/agents/driver.js";
import { runReviewCore } from "../src/review-change.js";
import type { ReviewEvent } from "../src/review-change.js";
import { decideIncremental } from "../src/incremental.js";
import { serverScope } from "../src/scoped.js";
import { snapshotFiles } from "../src/snapshot.js";
import { approve, createToolResolver, resolveCustomArtifact } from "@openqodex/scanners";
import { CANARIES, EXCLUDE, OUTSIDE_PATHS, SCOPES, decisiveFixture, history } from "./scope-fixture.js";
import { removeTempDirs, tempDir } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);
afterEach(() => vi.unstubAllEnvs());

// Every marker and outside path found in `text`.
const leaks = (text: string): string[] => [...CANARIES, ...OUTSIDE_PATHS].filter((c) => text.includes(c));

type Seen = { snapshot: string[]; snapshotText: string; packet: string; tools: Record<string, string>; briefs: string[] };

// The model provider stand-in. First answer: a finding on the root canary
// and every candidate dropped citing it; the check refuses both. Second
// answer: a finding on a changed line of the scope and every candidate
// dropped citing the scope's own line. While the snapshot exists it records
// what it holds and asks the stand-in tool for each outside path.
function standIn(seen: Seen, admit: (path: string) => boolean): ReviewerDriver {
  return {
    name: "claude",
    traced: true,
    detect: async () => ({ ok: true, version: "9.9.9", bin: "/stand-in/claude" }),
    start({ snapshotDir }): ReviewerSession {
      return {
        pid: 1,
        async send(text: string): Promise<Turn> {
          seen.briefs.push(text);
          if (seen.briefs.length === 1) {
            seen.snapshot = snapshotFiles(snapshotDir);
            seen.snapshotText = seen.snapshot.filter((p) => !p.startsWith(".openqodex-review/")).map((p) => readFileSync(join(snapshotDir, p), "utf8")).join("\n");
            seen.packet = seen.snapshot.filter((p) => p.startsWith(".openqodex-review/")).map((p) => `${p}\n${readFileSync(join(snapshotDir, p), "utf8")}`).join("\n");
            // A tool call as the brain makes it: the path is asked of
            // admitted first, then read from the snapshot alone.
            for (const path of [...OUTSIDE_PATHS, "services/api/link-out", "services/api/../../canary.txt"]) {
              if (!admit(path)) seen.tools[path] = "refused: outside the review's scopes";
              else {
                const full = join(snapshotDir, path);
                seen.tools[path] = existsSync(full) && lstatSync(full).isFile() ? readFileSync(full, "utf8") : "no such file";
              }
            }
          }
          const brief = seen.briefs[0]!;
          const id = /`change_id`: `([0-9a-f]{12})`/.exec(brief)?.[1] ?? "missing";
          const candidates = [...new Set([...brief.matchAll(/^- (c\d+) \[/gm)].map((m) => m[1]))];
          const first = seen.briefs.length === 1;
          const at = first ? { file_path: "canary.txt", line_number: 1 } : { file_path: "services/api/db/q.sql", line_number: 1 };
          const finding = {
            severity: "minor",
            category: "bug",
            confidence: 0.9,
            ...(first ? { file_path: "canary.txt", line_number: 1 } : { file_path: "services/api/handler.ts", line_number: 4 }),
            title: "The label is cut without saying so",
            problem: "A long label is cut to 64 characters.",
            consequence: "Two long names can get the same label.",
            fix: "Return the whole label, or say it was cut.",
          };
          const dropped = candidates.map((c) => ({ candidate: c, reason: "The function is internal and never exposed.", ...at }));
          const finalText = JSON.stringify({ version: 2, change_id: id, summary: "Cuts long labels in the handler.", findings: [finding], dropped });
          return { finalText, calls: [], usage: { turns: seen.briefs.length, input_tokens: 1, output_tokens: 1, cost_usd: null }, sessionId: "s", failure: null };
        },
        async close() {},
      };
    },
  };
}

// A project-wide scanner: lists and reads every file it can reach from the
// folder it is given, links followed, into a log outside the snapshot.
async function walker(clone: string, log: string): Promise<string> {
  const bin = tempDir("oq-scoped-bin-");
  const path = join(bin, "walk");
  writeFileSync(path, `#!/bin/sh\n{ find -L "$1" -type f 2>/dev/null | sort; find -L "$1" -type f -exec cat {} + 2>/dev/null; } > '${log}'\nprintf '%s' '{"version":"2.1.0","runs":[{"tool":{"driver":{"name":"walk"}},"results":[]}]}'\n`);
  chmodSync(path, 0o755);
  vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
  const yaml = `review:\n  paths:\n    exclude: ${JSON.stringify(EXCLUDE)}\nscanners:\n  custom:\n    - { source: "https://github.com/a/walk", name: walk, run: "walk {repo}", install: path, target: repo, format: sarif }\n`;
  const entry = parseConfig(yaml).config.custom[0]!;
  await approve(clone, entry, await resolveCustomArtifact(entry));
  return yaml;
}

describe("a scoped server review of the decisive fixture", () => {
  it("1 to 7. nothing outside the admitted files reaches the snapshot, the scanners, the packet, the tools, the citations or the outputs", async () => {
    vi.stubEnv("OPENQODEX_HOME", tempDir("oq-scoped-home-"));
    const f = decisiveFixture();
    const log = join(tempDir("oq-scoped-log-"), "walk.log");
    const config = parseConfig(await walker(f.dir, log)).config;
    const decision = await decideIncremental({ clonePath: f.dir, mergeBaseSha: f.base, headSha: f.head });
    if (!decision.ok) throw new Error(decision.reason);
    const work = tempDir("oq-scoped-work-");
    const server = serverScope({ clonePath: f.dir, workDir: work, scopes: SCOPES, exclude: config.exclude, decision });
    const seen: Seen = { snapshot: [], snapshotText: "", packet: "", tools: {}, briefs: [] };
    const events: ReviewEvent[] = [];
    const result = await runReviewCore(
      { repoRoot: f.dir, config, scope: {}, target: f.head, noGraph: false, reviewer: "auto", web: false, timeoutMs: 120_000, runtimeVersion: "0.0.0-test" },
      {
        drivers: [standIn(seen, server.admit)],
        snapshots: server.snapshots,
        resolveTool: createToolResolver({ allowInstall: false, installBudgetMs: null }),
        resolveTarget: async () => ({ headSha: f.head, baseRef: "main", baseSource: "the pull request", baseSha: f.base, mergeBase: f.base, notes: [], release: async () => {} }),
        instructions: () => ({ text: "", hash: null }),
        onEvent: (e) => events.push(e),
        now: Date.now,
        scoped: server.scoped,
      },
    );
    if (result.ended !== "reviewed") throw new Error(`the review ended ${result.ended}: ${JSON.stringify(result)}`);

    // 1. The snapshot: the admitted regular files and the packet, no more.
    expect(seen.snapshot.filter((p) => !p.startsWith(".openqodex-review/"))).toEqual(["services/api/db/q.sql", "services/api/handler.ts", "services/api/run.sh", "services/api/same.ts", "services/api/util.ts"]);
    expect(leaks(seen.snapshotText)).toEqual([]);
    expect(readdirSync(work)).toEqual([]);

    // 2. The scanners: the built-in one's candidates, and all a
    // project-wide one could read.
    const scan = events.find((e): e is Extract<ReviewEvent, { type: "scan" }> => e.type === "scan")!.scan;
    expect(scan.candidates.map((c) => c.filePath)).toEqual(["services/api/db/q.sql"]);
    expect(scan.scanners.find((s) => s.scanner === "custom:walk")?.status).toBe("ran");
    const walked = readFileSync(log, "utf8");
    expect(walked).toContain("services/api/handler.ts");
    expect(walked).not.toContain("link-out");
    expect(leaks(walked)).toEqual([]);

    // 3. The packet was written, from the admitted files alone.
    expect(seen.packet).toContain("impact.json");
    expect(leaks(seen.packet)).toEqual([]);

    // 4. The tools.
    for (const path of OUTSIDE_PATHS) expect(seen.tools[path], path).toBe("refused: outside the review's scopes");
    expect(seen.tools["services/api/../../canary.txt"]).toBe("refused: outside the review's scopes");
    expect(seen.tools["services/api/link-out"]).toBe("no such file");

    // 5. The first answer was refused for its finding and its citations,
    // and the second passed.
    expect(seen.briefs).toHaveLength(2);
    expect(seen.briefs[1]).toMatch(/canary\.txt is not a file in the code under review/);
    expect(seen.briefs[1]).toMatch(/the file is not in this change/);
    expect(result.completion.status).toBe("complete");
    expect(result.report.findings.map((x) => `${x.file_path}:${x.line_number}`)).toEqual(["services/api/handler.ts:4"]);
    expect(result.report.dropped.map((d) => d.cited?.file_path)).toEqual(["services/api/db/q.sql"]);

    // 6. The brief and every output.
    const outputs = {
      brief: seen.briefs[0]!,
      markdown: renderMarkdown(result.report),
      json: renderJson(result.report),
      sarif: renderSarif(result.report),
      completion: JSON.stringify(result.completion),
      trace: JSON.stringify(result.trace),
      submission: JSON.stringify(result.submission),
      display: JSON.stringify(result.display),
      lines: events.filter((e) => e.type === "progress" || e.type === "warning").map((e) => (e as { line: string }).line).join("\n"),
    };
    for (const [name, text] of Object.entries(outputs)) expect(leaks(text), name).toEqual([]);

    // 7. What the review could not hold is recorded. A move is told from the
    // object ids alone, since telling a move with edits would read the
    // outside file: util.ts, moved with a line removed, is a new file.
    expect(server.notes()).toEqual([
      "services/api/same.ts was renamed in from a path outside the review's scopes: it is reviewed as a new file, and its earlier version is not read",
      "services/api/link-out is a link, which the snapshot does not hold",
    ]);
  });

  it("8. a delta review briefs only what changed since, and checks findings on the whole change", async () => {
    vi.stubEnv("OPENQODEX_HOME", tempDir("oq-scoped-home-"));
    const h = history();
    const decision = await decideIncremental({ clonePath: h.dir, mergeBaseSha: h.base, headSha: h.head, previousReviewedSha: h.previous });
    if (!decision.ok) throw new Error(decision.reason);
    expect(decision.scope.kind).toBe("delta");
    const server = serverScope({ clonePath: h.dir, workDir: tempDir("oq-scoped-work-"), exclude: [], decision });
    const briefs: string[] = [];
    // Answers once: a finding on line 5 of s/a.ts, changed before the
    // previous review, so in the change and outside the delta.
    const reviewer: ReviewerDriver = {
      name: "claude",
      traced: true,
      detect: async () => ({ ok: true, version: "9.9.9", bin: "/stand-in/claude" }),
      start: (): ReviewerSession => ({
        pid: 1,
        async send(text: string): Promise<Turn> {
          briefs.push(text);
          const id = /`change_id`: `([0-9a-f]{12})`/.exec(briefs[0]!)?.[1] ?? "missing";
          const finding = { severity: "minor", category: "bug", confidence: 0.9, file_path: "s/a.ts", line_number: 5, title: "The line reads oddly", problem: "The line says it changed.", consequence: "A reader may be misled.", fix: "Say what the line holds." };
          return { finalText: JSON.stringify({ version: 2, change_id: id, summary: "Edits lines.", findings: [finding], dropped: [] }), calls: [], usage: { turns: 1, input_tokens: 1, output_tokens: 1, cost_usd: null }, sessionId: "s", failure: null };
        },
        async close() {},
      }),
    };
    const result = await runReviewCore(
      { repoRoot: h.dir, config: parseConfig("").config, scope: {}, target: h.head, noGraph: false, reviewer: "auto", web: false, timeoutMs: 120_000, runtimeVersion: "0.0.0-test" },
      {
        drivers: [reviewer],
        snapshots: server.snapshots,
        resolveTool: createToolResolver({ allowInstall: false, installBudgetMs: null }),
        resolveTarget: async () => ({ headSha: h.head, baseRef: "main", baseSource: "the pull request", baseSha: h.base, mergeBase: h.base, notes: [], release: async () => {} }),
        instructions: () => ({ text: "", hash: null }),
        onEvent: () => {},
        now: Date.now,
        scoped: server.scoped,
      },
    );
    if (result.ended !== "reviewed") throw new Error(`the review ended ${result.ended}`);
    expect(briefs).toHaveLength(1);
    expect(briefs[0]).toContain("+changed since the previous review");
    expect(briefs[0]).toContain("+changed since too");
    expect(briefs[0]).not.toContain("+changed before the previous review");
    expect(briefs[0]).not.toContain("s/c.ts");
    expect(result.completion.status).toBe("complete");
    expect(result.report.findings.map((x) => `${x.file_path}:${x.line_number}`)).toEqual(["s/a.ts:5"]);
    expect(result.change.files.map((x) => x.path).sort()).toEqual(["s/a.ts", "s/b.ts", "s/c.ts"]);
  });
});
