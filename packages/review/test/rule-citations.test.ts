// Failure cases, written before the code: a confirmed break of a written
// rule in a supplied instruction file is shown as an observation, or as a
// finding without its citation (file, heading, quote, source); a rule quoted
// across a line break, or with the brief's quote marks, is dropped as if it
// were invented; an invented quote, a heading the file does not have, or a
// file the review did not supply is counted, or dropped with no recorded
// reason; a quote that sits under another heading than the one cited is
// counted as a rule of the cited heading; a docs or style item with no rule becomes a finding; a rule finding
// changes the cap of 12 observations; the report files leave the citation
// out; the verifier's brief does not ask for the citation or for a stated
// exception to be checked. The model provider is the only fake.
import { afterAll, expect, it } from "vitest";
import { buildVerifyBrief, completionRecord, readCoverage, renderJson, renderReview } from "@openqodex/core";
import type { FindAnswer, InstructionFile, VerifyAnswer, VerifyBatch, VerifyVerdict } from "@openqodex/core";
import { runStagedReview } from "../src/stages.js";
import type { StagedArgs } from "../src/stages.js";
import { modelSession } from "../src/model-loop.js";
import type { ModelReviewer } from "../src/reviewer.js";
import { candidate, cleanupFixtures, fixture, reply, verdict } from "./staged-fixture.js";

afterAll(cleanupFixtures);

const SOURCE = "b".repeat(40);
const AGENTS: InstructionFile = {
  path: "AGENTS.md",
  text: "# Team rules\n\n## Data access\n\n- Every tenant-scoped query goes through the permission\n  gate, except in tests.\n- Log with the request id.\n",
  source: SOURCE,
};
const RULE = { file: "AGENTS.md", heading: "Data access", quote: "Every tenant-scoped query goes through the permission gate" };

type Answer = (answer: FindAnswer | VerifyAnswer) => FindAnswer | VerifyAnswer;
function setup(answer: Answer, instructionFiles: InstructionFile[] = [AGENTS]) {
  const f = fixture(["a.txt"]);
  const briefs: string[] = [];
  const model: ModelReviewer = { kind: "model", model: "fixture", maxOutputTokens: 4096, async complete(request) {
    const text = request.messages.find((m) => m.role === "user")!.text;
    const brief = text.startsWith("# OpenQodex review brief: verify pass") ? { batch: batches.get(text)! } : JSON.parse(text.split("\nPrevious answer:")[0]!) as { unit?: import("@openqodex/core").ReviewUnit; batch?: VerifyBatch; pass?: string };
    const first: FindAnswer | VerifyAnswer = brief.unit
      ? { version: "find-1", change_id: f.change.id, unit: brief.unit.id, examined: brief.unit.hunks.map((h) => h.id), analysis: brief.unit.hunks.map((h) => ({ hunk: h.id, changed: "The operation changed.", could_break: "Inputs can be unsafe." })), candidates: brief.pass === "local" ? [candidate("a.txt")] : [] }
      : { version: "verify-1", change_id: f.change.id, verdicts: brief.batch!.candidates.map((c) => verdict(c)) };
    return reply(answer(first));
  } };
  const batches = new Map<string, VerifyBatch>();
  const shared: import("../src/usage.js").CallRecord[] = [];
  const budgetState = { pending: Promise.resolve(), refused: false };
  const args: StagedArgs = {
    snapshotDir: f.dir, change: f.change, scan: f.scan, config: f.config, manifest: f.manifest, secrets: [], deadline: Date.now() + 60_000, now: () => Date.now(), traced: true, model: true, say: () => {}, instructionFiles,
    findBrief: (unit, pass) => ({ text: JSON.stringify({ unit, pass }), diffFiles: new Set(unit.files), carried: unit.hunks }),
    // The verifier reads the real brief, so the test sees what it is told.
    verifyBrief: (batch) => {
      const brief = buildVerifyBrief({ change: f.change, scan: f.scan, lenses: [], config: f.config, secrets: [], instructionFiles }, batch);
      batches.set(brief.text, batch);
      briefs.push(brief.text);
      return brief;
    },
    openSession: (role) => {
      const session = modelSession({ reviewer: model, role, shared, budgetState, box: { snapshotDir: f.dir, change: f.change, secrets: [], graph: null, graphNote: null }, now: () => Date.now(), budget: { deadlineMs: 60_000, authorize: async () => true } });
      return { send: (text) => session.send(text), attempts: session.attempts, get sentRounds() { return session.sentRounds; }, kill: () => session.kill(), close: () => session.close() };
    },
  };
  return { ...f, args, briefs };
}

// Every verdict of the verifier's answer, changed by `change`.
const verdicts = (change: (v: VerifyVerdict) => void): Answer => (answer) => {
  if (answer.version === "verify-1") answer.verdicts.forEach(change);
  return answer;
};

it.each([
  ["copied as one line", RULE.quote],
  ["copied across the file's line break", "Every tenant-scoped query goes through the permission\n  gate"],
  ["copied with the brief's quote marks", "Every tenant-scoped query goes through the permission\n> gate"],
])("keeps a confirmed rule break as a finding with its citation, the quote %s", async (_label, quote) => {
  const f = setup(verdicts((v) => { v.category = "security"; v.rule = { ...RULE, quote }; }));
  const r = await runStagedReview(f.args);
  expect(r.missing).toEqual([]);
  expect(r.report.observations).toEqual([]);
  expect(r.report.findings).toHaveLength(1);
  expect(r.report.findings[0]).toMatchObject({ category: "security", rule: { file: "AGENTS.md", heading: "Data access", source: SOURCE } });
  expect(r.report.findings[0]!.rule!.quote.replace(/\s+/g, " ")).toBe(RULE.quote);
});

it.each([
  ["an invented quote", { ...RULE, quote: "Every query is cached for an hour" }, "dropped: its rule quote is not in AGENTS.md"],
  ["a heading the file does not have", { ...RULE, heading: "Caching" }, "dropped: its rule heading is not in AGENTS.md"],
  ["a file the review did not supply", { ...RULE, file: "CONTRIBUTING.md" }, "dropped: its rule cites CONTRIBUTING.md, which is not an instruction file of this review"],
])("drops a rule finding with %s and records why", async (_label, rule, reason) => {
  const f = setup(verdicts((v) => { v.rule = rule; }));
  const r = await runStagedReview(f.args);
  expect(r.missing).toEqual([]);
  expect(r.report.findings).toEqual([]);
  expect(r.report.possible).toEqual([]);
  expect(r.report.observations).toEqual([]);
  expect(r.report.low_confidence).toEqual([expect.objectContaining({ title: "Unsafe operation", file_path: "a.txt", reason })]);
});

// Two sections: a quote from one must not be reported as a rule of the other.
const SECTIONS: InstructionFile = {
  path: "AGENTS.md",
  text: "# Team rules\n\n## Production access\n\n- Never query the production database from a laptop.\n\n## Test exceptions\n\n```sh\n# Production access\n```\n\n- Tests may skip the permission gate when they use the\n  fixture tenant.\n",
  source: SOURCE,
};
const EXCEPTION = "Tests may skip the permission gate when they use the fixture tenant";

it.each([
  ["its own heading", { file: "AGENTS.md", heading: "Production access", quote: "Never query the production database from a laptop" }],
  ["its own heading, copied across the file's line break", { file: "AGENTS.md", heading: "Test exceptions", quote: "Tests may skip the permission gate when they use the\n  fixture tenant" }],
])("keeps a rule whose quote sits under %s", async (_label, rule) => {
  const f = setup(verdicts((v) => { v.rule = rule; }), [SECTIONS]);
  const r = await runStagedReview(f.args);
  expect(r.report.low_confidence).toEqual([]);
  expect(r.report.findings).toEqual([expect.objectContaining({ rule: expect.objectContaining({ heading: rule.heading }) })]);
});

it("drops a rule whose quote sits only under another heading than the one cited, and records why", async () => {
  const f = setup(verdicts((v) => { v.rule = { file: "AGENTS.md", heading: "Production access", quote: EXCEPTION }; }), [SECTIONS]);
  const r = await runStagedReview(f.args);
  expect(r.report.findings).toEqual([]);
  expect(r.report.possible).toEqual([]);
  expect(r.report.low_confidence).toEqual([expect.objectContaining({ title: "Unsafe operation", reason: "dropped: its rule quote is not under its heading in AGENTS.md" })]);
});

it("keeps a docs or style item with no rule an observation", async () => {
  const f = setup(verdicts((v) => { v.category = "style"; v.severity = "nitpick"; v.tier = "observation"; }));
  const r = await runStagedReview(f.args);
  expect(r.report.findings).toEqual([]);
  expect(r.report.observations).toEqual([expect.objectContaining({ title: "Unsafe operation", category: "style" })]);
  expect(r.report.observations![0]).not.toHaveProperty("rule");
});

it("shows a rule finding beside thirteen observations, which keep their cap of 12", async () => {
  const f = setup((answer) => {
    if (answer.version === "find-1" && answer.candidates.length) answer.candidates = [...Array.from({ length: 13 }, (_, i) => candidate("a.txt", `Observation ${i}`)), candidate("a.txt", "Ungated query")];
    if (answer.version === "verify-1") for (const v of answer.verdicts) {
      if (v.title === "Ungated query") v.rule = RULE;
      else { v.tier = "observation"; v.category = "style"; }
    }
    return answer;
  });
  const r = await runStagedReview(f.args);
  expect(r.missing).toEqual([]);
  expect(r.report.findings.map((x) => x.title)).toEqual(["Ungated query"]);
  expect(r.report.observations).toHaveLength(12);
  expect(r.report.observations_omitted).toBe(1);
});

it("prints the citation in report.md and keeps it in report.json", async () => {
  const f = setup(verdicts((v) => { v.rule = RULE; }));
  const r = await runStagedReview(f.args);
  r.report.completion = completionRecord({ change: f.change, reviewer: { driver: "model", version: "fixture", pid: null, started_at: "now", ended_at: "now", duration_ms: 0, rounds: 1, usage: r.sessions[0]!.usage, sessions: r.sessions }, snapshot: { tree: null, before: "same", after: "same" }, candidates: { total: r.required, disposed: r.disposed }, coverage: readCoverage({ change: f.change, trace: [], obligations: r.obligations, briefCarried: r.briefCarried, delivered: r.delivered }), trace: [], submissionErrors: [], wholeRepo: false, missing: r.missing });
  // Markdown escapes the ">" so it never starts a quote block.
  expect(renderReview(r.report, { format: "markdown" })).toContain('- **Rule:** AGENTS.md \\> Data access: "Every tenant-scoped query goes through the permission gate"');
  expect(renderReview(r.report, { format: "terminal" })).toContain('Rule: AGENTS.md > Data access: "Every tenant-scoped query goes through the permission gate"');
  expect(JSON.parse(renderJson(r.report)).findings[0].rule).toEqual({ ...RULE, source: SOURCE });
});

it("asks the verifier for the citation and for a stated exception to be checked only when instruction files are supplied", async () => {
  const withRules = setup((answer) => answer);
  await runStagedReview(withRules.args);
  const brief = withRules.briefs[0]!;
  expect(brief).toContain("- `rule`: only for a broken written rule of a convention file above");
  expect(brief).toContain('When the file states an exception that covers this code, such as "except in tests", check it before you confirm.');
  expect(brief).toContain("Set it to `finding` for defects and broken written rules.");
  const none = setup((answer) => answer, []);
  await runStagedReview(none.args);
  expect(none.briefs[0]).not.toContain("- `rule`:");
  expect(none.briefs[0]).toContain("Set `tier` to `observation` for style, naming, docs, clarity, conventions and test coverage items. Set it to `finding` for defects.");
});
