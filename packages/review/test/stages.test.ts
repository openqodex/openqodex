// 6. A code deletion beside store digests loses its brief credit.
// 5. Thousands of unsplit hunks abandon a verifiable candidate.
// 1. Part sessions receive other parts; verifier briefs grow to a whole file.
// 2. Wide neighbouring parts overflow a single-candidate verifier brief.
// 4. Cited deletions overflow, fixed blocks throw, renders grow per part and examined loses ids.
// 3. Two candidates lose their own parts instead of splitting a full batch.
// Round 1 failures: one bad quote discards good candidates, an oversized hunk
// blocks completion, unknown lenses fail assembly, neighbours split batches,
// invalid duplicates hide scanners, idle verifiers accumulate, one bad item
// discards a batch, and concurrent completion changes candidate ids.
// Failure cases: invalid evidence reaches verification, refutations become
// findings, scanners stay unresolved, failed sessions erase other findings,
// same-line defects collapse, retry call ids collide, stop leaves sessions
// open, verifier abandon reasons lose either attempt, and finders use the verifier's reserved time.
// Round 2 failures: a missing file or inverted range discards a good answer,
// a line tie splits duplicate candidates, and refutation prose waits for assembly.
import { makeLineSet } from "../../../tests/line-set.mjs";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { buildFindBrief, buildVerifyBrief, completionRecord, readCoverage } from "@openqodex/core";
import type { FindAnswer, ReviewUnit, VerifyAnswer, VerifyBatch } from "@openqodex/core";
import { runStagedReview } from "../src/stages.js";
import { TIMED_OUT } from "../src/agents/driver.js";
import type { StagedArgs } from "../src/stages.js";
import { modelSession } from "../src/model-loop.js";
import type { ModelSession } from "../src/model-loop.js";
import type { ModelRequest, ModelReviewer } from "../src/reviewer.js";
import { hunkRefs, obligations, MAX_BRIEF_BYTES, unitsOf } from "../src/units.js";
import { cleanupFixtures, candidate, fixture, reply, scanner, verdict } from "./staged-fixture.js";

afterAll(cleanupFixtures);
type Answerer = (answer: FindAnswer | VerifyAnswer, request: ModelRequest, brief: { unit?: ReviewUnit; batch?: VerifyBatch; pass?: string }) => unknown | Promise<unknown>;
function setup(answerer?: Answerer, files?: string[]) {
  const f = fixture(files);
  const requests: ModelRequest[] = [];
  const realBriefs = new Map<string, { unit?: ReviewUnit; batch?: VerifyBatch; pass?: string }>();
  const shared: import("../src/usage.js").CallRecord[] = [];
  const budgetState = { pending: Promise.resolve(), refused: false };
  const opened: ModelSession[] = [];
  let stopped = false;
  let allow = true;
  let clock = Date.now();
  const closed = new Set<number>();
  const budgets: import("../src/reviewer.js").AuthorizeRequest[] = [];
  const model: ModelReviewer = { kind: "model", model: "fixture", maxOutputTokens: 4096, async complete(request) {
    requests.push(structuredClone(request));
    const briefText = request.messages.find((m) => m.role === "user")!.text;
    const brief = (realBriefs.get(briefText) ?? JSON.parse(briefText.split("\nPrevious answer:")[0]!)) as { unit?: ReviewUnit; batch?: VerifyBatch; pass?: string };
    const answer: FindAnswer | VerifyAnswer = brief.unit
      ? { version: "find-1", change_id: f.change.id, unit: brief.unit.id, examined: brief.unit.hunks.map((h) => h.id), analysis: brief.unit.hunks.map((h) => ({ hunk: h.id, changed: "The operation changed.", could_break: "Inputs can be unsafe." })), candidates: brief.pass === "local" ? [candidate(brief.unit.files[0]!)] : [] }
      : { version: "verify-1", change_id: f.change.id, verdicts: brief.batch!.candidates.map((c) => verdict(c)) };
    return reply(answerer ? await answerer(answer, request, brief) : answer);
  } };
  const args: StagedArgs = {
    snapshotDir: f.dir, change: f.change, scan: f.scan, config: f.config, manifest: f.manifest, secrets: [], deadline: clock + 60_000, now: () => clock, traced: true, model: true, say: () => {}, stopped: () => stopped,
    findBrief: (unit, pass) => ({ text: JSON.stringify({ unit, pass }), diffFiles: new Set(unit.files), carried: unit.hunks }),
    verifyBrief: (batch) => ({ text: JSON.stringify({ batch }) }),
    openSession: (role) => {
      const session = modelSession({ reviewer: model, role, shared, budgetState, box: { snapshotDir: f.dir, change: f.change, secrets: [], graph: null, graphNote: null }, now: () => clock, budget: { deadlineMs: 60_000, authorize: async (call) => { budgets.push(call); await new Promise((resolve) => setTimeout(resolve, 0)); return allow; } } });
      const id = opened.push(session);
      return { send: (text) => session.send(text), attempts: session.attempts, get sentRounds() { return session.sentRounds; }, kill: () => session.kill(), close: async () => { closed.add(id); await session.close(); } };
    },
  };
  return { ...f, args, requests, realBriefs, opened, budgets, closed, refuse: () => { allow = false; }, advance: (ms: number) => { clock += ms; }, stop: () => { stopped = true; opened.forEach((s) => s.kill()); } };
}
function completion(r: Awaited<ReturnType<typeof runStagedReview>>, f: ReturnType<typeof setup>) {
  return completionRecord({ change: f.change, reviewer: { driver: "model", version: "fixture", pid: null, started_at: "now", ended_at: "now", duration_ms: 0, rounds: r.sessions.reduce((n, s) => n + s.rounds, 0), usage: r.sessions[0]!.usage, sessions: r.sessions }, snapshot: { tree: null, before: "same", after: "same" }, candidates: { total: r.required, disposed: r.disposed }, coverage: readCoverage({ change: f.change, trace: [], obligations: r.obligations, briefCarried: r.briefCarried, delivered: r.delivered }), trace: [], submissionErrors: [], wholeRepo: false, missing: r.missing });
}
it("credits a code deletion's brief beside an oversized store root", async () => {
  const store = ".pnpm-store/v11/files/fixture";
  const f = setup((answer, _request, brief) => {
    if (answer.version === "find-1") {
      const ids = brief.unit!.digest ? ["d1"] : brief.unit!.hunks.map((h) => h.id);
      answer.examined = ids;
      answer.analysis = ids.map((hunk) => ({ hunk, changed: "The operation changed.", could_break: "Inputs can be unsafe." }));
      answer.candidates = [];
    }
    return answer;
  }, ["Dockerfile"]);
  const code = "FROM python:latest\n\nRUN apt-get update && apt-get install curl\n\nWORKDIR /app\nADD requirements.txt .\nRUN pip install -r requirements.txt\nCOPY app ./app\n\nEXPOSE 5000\nCMD python\n";
  writeFileSync(join(f.dir, "Dockerfile"), code);
  mkdirSync(join(f.dir, ".pnpm-store/v11/files"), { recursive: true });
  writeFileSync(join(f.dir, store), "module.exports = 1;\n".repeat(5000));
  f.change.files.push({ path: store, status: "added", oldPath: null, binary: false });
  f.change.changedPaths.push(store);
  f.change.coverage = new Map([["Dockerfile", makeLineSet([1, 3, 5, 6, 7])], [store, makeLineSet(Array.from({ length: 5000 }, (_, i) => i + 1))]]);
  f.change.deletionPoints.set("Dockerfile", [{ after: 9, lines: 1, anchors: [9, 10] }]);
  // The retained patch is the control for the diff-cap fix on C4.2.
  f.change.diffs = [{ path: "Dockerfile", text: "@@ -9,3 +9,2 @@\n \n-USER app\n EXPOSE 5000\n" }];
  f.args.findBrief = (unit, pass) => {
    const brief = buildFindBrief({ ...f, lenses: [], secrets: [] }, unit, pass);
    f.realBriefs.set(brief.text, { unit, pass });
    return brief;
  };
  let units: ReviewUnit[] = [];
  f.args.onUnits = (value) => { units = value; };
  const r = await runStagedReview(f.args);
  expect(units.some((u) => u.digest?.kind === "store")).toBe(true);
  expect(units.some((u) => !u.digest && u.files.includes("Dockerfile"))).toBe(true);
  expect(r.sessions.filter((s) => s.role.startsWith("finder:"))).toHaveLength(units.length * 2);
  const coverage = readCoverage({ change: f.change, obligations: r.obligations, briefCarried: r.briefCarried, digestCarried: r.digestCarried, delivered: r.delivered, trace: [] });
  expect(coverage.given).toContainEqual(expect.objectContaining({ path: "Dockerfile", start: 9, end: 10, by: "brief" }));
  expect(coverage.unread).toEqual([]);
  expect(r.missing).toEqual([]);
});
it("sends an invented quote back and never verifies the rejected candidate", async () => {
  const f = setup((answer, request) => {
    if (answer.version === "find-1" && answer.candidates.length) {
      if (request.purpose === "find") answer.candidates[0]!.evidence[0]!.quote = "invented quote";
      else answer.candidates = [];
    }
    return answer;
  });
  const r = await runStagedReview(f.args);
  expect(r.rounds.some((round) => round.errors.some((e) => e.includes("quote")))).toBe(true);
  expect(r.submission.findings).toEqual([]);
  expect(f.requests.some((r) => r.purpose === "verify")).toBe(false);
});
it("keeps refuted finder candidates out of findings", async () => {
  const f = setup((answer) => { if (answer.version === "verify-1") answer.verdicts.forEach((v) => { v.verdict = "refuted"; }); return answer; });
  const r = await runStagedReview(f.args);
  expect(r.report.findings).toEqual([]);
  expect(r.submission.findings).toEqual([]);
  expect(r.missing).toEqual([]);
});
it("corrects an unresolved scanner and accepts its second answer", async () => {
  const f = setup((answer, request) => { if (answer.version === "verify-1" && request.purpose === "verify") answer.verdicts.filter((v) => v.id === "c1").forEach((v) => { v.verdict = "unresolved"; }); return answer; });
  f.scan.candidates.push(scanner("a.txt"));
  const r = await runStagedReview(f.args);
  expect(r.rounds.some((round) => round.errors.some((e) => e.includes("a scanner candidate is confirmed or refuted")))).toBe(true);
  expect(r.report.findings.some((f) => f.candidate === "c1")).toBe(true);
  expect(r.disposed).toBe(1);
});
it("retries a failed finder once and keeps other units' checked findings", async () => {
  const f = setup((answer, request) => { if (request.callId.startsWith("finder:u1:local")) throw new Error("provider failed"); return answer; });
  const r = await runStagedReview(f.args);
  expect(r.sessions.filter((s) => s.role.startsWith("finder:u1:local"))).toHaveLength(2);
  expect(r.missing).toContain("hunk h1 of a.txt:1-1 was not examined by the local pass");
  expect(completion(r, f).status).toBe("incomplete");
  expect(r.report.findings.some((f) => f.file_path === "b.txt")).toBe(true);
});
it("leaves failed verifier scanners not reviewed and preserves other findings", async () => {
  const f = setup((answer, _request, brief) => { if (brief.batch?.file === "a.txt") throw new Error("provider failed"); return answer; });
  f.scan.candidates.push(scanner("a.txt"));
  const r = await runStagedReview(f.args);
  expect(r.report.not_reviewed.map((c) => c.id)).toEqual(["c1"]);
  expect(r.report.low_confidence).toContainEqual(expect.objectContaining({ file_path: "a.txt", reason: "not verified" }));
  expect(completion(r, f).status).toBe("incomplete");
  expect(r.report.findings.some((f) => f.file_path === "b.txt")).toBe(true);
});
it("a verifier that cannot start loses both attempt failures in its abandon reason", async () => {
  const f = setup(undefined, ["a.txt"]);
  const open = f.args.openSession;
  f.args.openSession = (role) => {
    if (role.startsWith("verifier:")) throw new Error(role.endsWith(":retry1") ? "second start failed" : "first start failed");
    return open(role);
  };
  const r = await runStagedReview(f.args);
  expect(r.missing.join(" ")).toContain("the verifier session failed twice (attempt 1: first start failed; attempt 2: second start failed)");
});
it("a verifier that fails after starting loses both attempt failures in its abandon reason", async () => {
  const f = setup((_answer, request) => {
    if (request.callId.startsWith("verifier:")) throw new Error(request.callId.startsWith("verifier:1:retry1-") ? "second call failed" : "first call failed");
    return _answer;
  }, ["a.txt"]);
  const r = await runStagedReview(f.args);
  expect(r.missing.join(" ")).toContain("the verifier session failed twice (attempt 1: the model call failed: first call failed; attempt 2: the model call failed: second call failed)");
});
it("delivers two distinct same-line candidates to the same verifier", async () => {
  const f = setup((answer) => { if (answer.version === "find-1" && answer.candidates.length) answer.candidates.push(candidate(answer.candidates[0]!.file_path, "A different defect")); return answer; });
  await runStagedReview(f.args);
  const briefs = f.requests.filter((r) => r.purpose === "verify").map((r) => JSON.parse(r.messages[1]!.text).batch as VerifyBatch);
  expect(briefs[0]!.candidates.map((c) => c.id)).toEqual(["k1", "k2"]);
});
it("gives four finders and their verifier sessions unique call ids and merged usage", async () => {
  const f = setup();
  const r = await runStagedReview(f.args);
  expect(r.sessions.filter((s) => s.role.startsWith("finder:"))).toHaveLength(4);
  const ids = r.usage.calls.map((c) => c.callId);
  expect(new Set(ids).size).toBe(ids.length);
  expect(r.usage.totals.attempts).toBe(f.requests.length);
  expect(r.usage.totals.inputTokens).toBe(f.requests.length * 10);
  expect(f.budgets.at(-1)!.usageSoFar.attempts).toBeGreaterThan(0);
  expect(f.closed.size).toBe(f.opened.length);
});
it("serializes delayed budget checks across four parallel finders so none see stale invoked counts", async () => {
  const f = setup();
  await runStagedReview(f.args);
  expect(f.budgets.slice(0, 4).map((call) => call.usageSoFar.invoked)).toEqual([0, 1, 2, 3]);
});
it("closes every open session when stopped while providers are pending", async () => {
  let pending = 0;
  let reached!: () => void;
  const allStarted = new Promise<void>((resolve) => { reached = resolve; });
  const f = setup(async (answer) => { if (++pending === 4) reached(); await new Promise(() => {}); return answer; });
  const running = runStagedReview(f.args);
  await allStarted;
  f.stop();
  const r = await running;
  expect(f.closed.size).toBe(4);
  expect(r.missing.join(" ")).toContain("the review stopped");
});
it("reserves verifier time when the finder share expires with units unstarted", async () => {
  const f = setup((answer, _request, brief) => { if (brief.unit?.id === "u2" && brief.pass === "contracts") f.advance(31_000); return answer; }, ["a.txt", "b.txt", "c.txt", "d.txt"]);
  const r = await runStagedReview(f.args);
  expect(r.missing.join(" ")).toContain("was not started: the finders' time ran out");
  expect(f.requests.some((r) => r.purpose === "verify")).toBe(true);
  expect(r.report.findings.length).toBeGreaterThan(0);
});
it("corrects verifier prose before assembly and closes accepted sessions", async () => {
  const f = setup((answer, request) => { if (answer.version === "verify-1" && request.purpose === "verify") answer.verdicts.forEach((v) => { v.problem = "word ".repeat(30); }); return answer; });
  const r = await runStagedReview(f.args);
  expect(r.rounds.some((r) => r.errors.some((e) => e.includes("limit is 20")))).toBe(true);
  expect(r.report.findings).toHaveLength(2);
  expect(r.missing).toEqual([]);
});
it("keeps findings from other batches when one verifier cannot fix its prose", async () => {
  const f = setup((answer, _request, brief) => { if (answer.version === "verify-1" && brief.batch?.file === "a.txt") answer.verdicts.forEach((v) => { v.problem = "word ".repeat(30); }); return answer; });
  f.scan.candidates.push(scanner("a.txt"));
  const r = await runStagedReview(f.args);
  expect(r.report.not_reviewed.map((c) => c.id)).toEqual(["c1"]);
  expect(r.report.findings.map((f) => f.file_path)).toEqual(["b.txt"]);
  expect(r.missing.join(" ")).toContain("correction rounds");
});
it("keeps a duplicate finding when its confirmed survivor is only an observation", async () => {
  const f = setup((answer, _request, brief) => {
    if (answer.version === "find-1") answer.candidates = [candidate(brief.unit!.files[0]!, brief.pass === "local" ? "First claim" : "Second claim")];
    if (answer.version === "verify-1") { answer.verdicts[0]!.tier = "observation"; answer.verdicts[1]!.duplicate_of = answer.verdicts[0]!.id; }
    return answer;
  });
  f.config.blockOnSeverity = "major";
  const r = await runStagedReview(f.args);
  expect(r.report.findings.map((finding) => finding.title)).toEqual(["Second claim", "Second claim"]);
  // The survivor is shown once, as the kept finding, not again as an observation.
  expect(r.report.observations).toHaveLength(0);
  expect(r.report.verdict).toBe("blocked");
});
it("keeps a finding whose key an observation below the floor shares", async () => {
  // Two lens candidates on one range share a key whatever their titles say.
  const f = setup((answer, _request, brief) => {
    if (answer.version === "find-1") answer.candidates = [{ ...candidate(brief.unit!.files[0]!, brief.pass === "local" ? "First claim" : "Second claim"), lens: "shape" }];
    if (answer.version === "verify-1") {
      const [survivor, duplicate] = answer.verdicts;
      survivor!.tier = "observation";
      survivor!.confidence = 0.6;
      duplicate!.confidence = 0.95;
      duplicate!.duplicate_of = survivor!.id;
    }
    return answer;
  }, ["a.txt"]);
  f.manifest.lenses.push({ name: "shape", confidenceFloor: 0.5 });
  f.args.confidenceFloor = 0.7;
  f.config.blockOnSeverity = "major";
  const r = await runStagedReview(f.args);
  expect(r.report.findings.map((finding) => finding.title)).toEqual(["Second claim"]);
  expect(r.report.observations ?? []).toHaveLength(0);
  expect(r.report.verdict).toBe("blocked");
});
it("folds a duplicate into the first shown link of its chain when the chain's end is below the floor", async () => {
  const f = setup((answer, _request, brief) => {
    if (answer.version === "find-1") answer.candidates = brief.pass === "local"
      ? [1, 2].map((line) => ({ ...candidate("a.txt", `Claim ${line}`), line_number: line, evidence: [{ file_path: "a.txt", line_number: line, quote: "unsafe operation" }] }))
      : [{ ...candidate("a.txt", "Claim 3"), line_number: 3, evidence: [{ file_path: "a.txt", line_number: 3, quote: "unsafe operation" }] }];
    if (answer.version === "verify-1") {
      const byLine = new Map(brief.batch!.candidates.map((c) => [c.kind === "finder" ? c.candidate.line_number : 0, c.id]));
      for (const v of answer.verdicts) {
        const c = brief.batch!.candidates.find((c) => c.id === v.id)!;
        v.line_number = c.kind === "finder" ? c.candidate.line_number : 1;
        v.title = c.kind === "finder" ? c.candidate.title : v.title;
        if (v.line_number === 1) v.confidence = 0.6;
        if (v.line_number === 2) v.duplicate_of = byLine.get(1);
        if (v.line_number === 3) v.duplicate_of = byLine.get(2);
      }
    }
    return answer;
  }, ["a.txt"]);
  writeFileSync(join(f.dir, "a.txt"), "unsafe operation\n".repeat(3));
  f.change.coverage.set("a.txt", makeLineSet([1, 2, 3]));
  f.args.confidenceFloor = 0.7;
  const r = await runStagedReview(f.args);
  expect(r.report.findings.map((finding) => finding.title)).toEqual(["Claim 2"]);
});
it("lets a stopped session leave the budget queue while another session holds the lock", async () => {
  const budgetState = { pending: Promise.resolve(), refused: false };
  const f = fixture(["a.txt"]);
  const reviewer: ModelReviewer = { kind: "model", model: "fixture", maxOutputTokens: 4096, async complete() { return reply({ version: 2, change_id: f.change.id, summary: "Nothing.", findings: [], dropped: [] }); } };
  const open = (role: "finder:u1:local" | "finder:u1:contracts", authorize: () => Promise<boolean>) => modelSession({ reviewer, role, shared: [], budgetState, box: { snapshotDir: f.dir, change: f.change, secrets: [], graph: null, graphNote: null }, now: () => Date.now(), budget: { deadlineMs: 60_000, authorize } });
  const holder = open("finder:u1:local", () => new Promise<boolean>(() => {}));
  const waiter = open("finder:u1:contracts", async () => true);
  const holding = holder.send("first");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const waiting = waiter.send("second");
  await new Promise((resolve) => setTimeout(resolve, 0));
  waiter.kill();
  const outcome = await Promise.race([waiting.then(() => "returned", () => "returned"), new Promise<string>((resolve) => setTimeout(() => resolve("still waiting"), 300))]);
  expect(outcome).toBe("returned");
  holder.kill();
  await holding.catch(() => undefined);
});
it.each([
  ["keeps a duplicate finding when its survivor is below the confidence floor", "below confidence"],
  ["keeps a duplicate finding when its survivor is below the severity threshold", "below severity"],
  ["folds a duplicate finding when its survivor is visible at the same tier", "a visible finding"],
])("%s", async (_name, condition) => {
  const f = setup((answer, _request, brief) => {
    if (answer.version === "find-1") answer.candidates = [candidate(brief.unit!.files[0]!, brief.pass === "local" ? "First claim" : "Second claim")];
    if (answer.version === "verify-1") {
      const [survivor, duplicate] = answer.verdicts;
      if (condition === "below confidence") survivor!.confidence = 0.6;
      if (condition === "below severity") survivor!.severity = "minor";
      duplicate!.confidence = 0.95;
      duplicate!.duplicate_of = survivor!.id;
    }
    return answer;
  }, ["a.txt"]);
  f.args.confidenceFloor = 0.7;
  f.config.severityThreshold = "major";
  const r = await runStagedReview(f.args);
  expect(r.report.findings.map((finding) => finding.title)).toEqual([condition === "a visible finding" ? "First claim" : "Second claim"]);
});

// B4's real briefs must be exercised after they replace the contract stubs.
const probe = fixture(["a.txt"]);
let briefsBuilt = false;
try { buildFindBrief({ change: probe.change, scan: probe.scan, config: probe.config, lenses: [], secrets: [] }, unitsOf(probe.change, hunkRefs(probe.change))[0]!, "local"); briefsBuilt = true; } catch (error) { if (!(error instanceof Error) || !error.message.includes("not built yet")) throw error; }
it.skipIf(!briefsBuilt)("accepts the real find and verify briefs through a model provider", async () => {
  const f = setup();
  const shared = { change: f.change, scan: f.scan, config: f.config, lenses: [], secrets: [] };
  f.args.findBrief = (unit, pass) => {
    const brief = buildFindBrief(shared, unit, pass);
    f.realBriefs.set(brief.text, { unit, pass });
    return brief;
  };
  f.args.verifyBrief = (batch) => {
    const brief = buildVerifyBrief(shared, batch);
    f.realBriefs.set(brief.text, { batch });
    return brief;
  };
  const r = await runStagedReview(f.args);
  expect(r.missing).toEqual([]);
  expect(r.report.findings).toHaveLength(2);
});

it("delivers a hunk the brief left out when the finder did not read it, whatever the finder says it examined", async () => {
  const f = setup();
  // The brief carries b.txt but not a.txt, as a hunk over the diff budget leaves the brief.
  f.args.findBrief = (unit, pass) => ({ text: JSON.stringify({ unit, pass }), diffFiles: new Set(unit.files.filter((file) => file !== "a.txt")), carried: unit.hunks.filter((h) => h.path !== "a.txt") });
  const r = await runStagedReview(f.args);
  const finderRounds = r.rounds.filter((round) => round.by.startsWith("finder:") && round.by.endsWith(":local"));
  expect(finderRounds.length).toBeGreaterThan(0);
  expect(finderRounds.every((round) => round.delivered.length > 0 && round.delivered.every((h) => h.path === "a.txt"))).toBe(true);
  expect(r.rounds.filter((round) => round.by.startsWith("finder:") && round.by.endsWith(":contracts"))).toEqual([]);
  expect(r.missing).toEqual([]);
  expect(r.report.findings).toHaveLength(2);
});

// Additional failure cases: observations disappear below the findings'
// threshold, refuted duplicates lose provenance, a refusal restarts calls.
it("shows observations below the findings' severity threshold", async () => {
  const f = setup((answer) => { if (answer.version === "verify-1") answer.verdicts.forEach((v) => { v.severity = "nitpick"; v.tier = "observation"; }); return answer; });
  f.config.severityThreshold = "major";
  const r = await runStagedReview(f.args);
  expect(r.report.observations).toHaveLength(2);
  expect(r.report.below_threshold).toBe(0);
  expect(r.submission.findings).toEqual([]);
});
it("rejects refuted duplicates before accepting a corrected verdict", async () => {
  const f = setup((answer, _request, brief) => {
    if (answer.version === "find-1") answer.candidates = [candidate(brief.unit!.files[0]!, brief.pass === "local" ? "First claim" : "Second claim")];
    if (answer.version === "verify-1" && _request.purpose === "verify") { answer.verdicts[1]!.verdict = "refuted"; answer.verdicts[1]!.duplicate_of = answer.verdicts[0]!.id; }
    return answer;
  });
  const r = await runStagedReview(f.args);
  expect(r.rounds.some((round) => round.errors.some((e) => e.includes("both candidates must be confirmed")))).toBe(true);
  expect(r.report.findings.every((f) => f.found_by === undefined)).toBe(true);
});
it("makes no new calls after a budget refusal and keeps it in missing work", async () => {
  const f = setup(undefined, ["a.txt", "b.txt", "c.txt", "d.txt"]);
  f.refuse();
  const r = await runStagedReview(f.args);
  expect(r.usage.calls.some((c) => c.outcome === "refused")).toBe(true);
  expect(r.sessions.some((s) => s.role.endsWith("retry1"))).toBe(false);
  expect(r.missing.join(" ")).toContain("budget refused");
  expect(f.requests.some((r) => r.purpose === "verify")).toBe(false);
  expect(f.budgets).toHaveLength(1);
});

it("refuses a live finder's next tool-result call without asking authorize after another session was refused", async () => {
  const f = setup();
  const shared: import("../src/usage.js").CallRecord[] = [];
  const budgetState = { pending: Promise.resolve(), refused: false };
  const asked: number[] = [];
  let refused!: () => void;
  const refusal = new Promise<void>((resolve) => { refused = resolve; });
  const invoked: ModelRequest[] = [];
  const reviewer: ModelReviewer = { kind: "model", model: "fixture", maxOutputTokens: 4096, async complete(request) {
    invoked.push(request);
    await refusal;
    return { ...reply(null), message: { text: "", toolCalls: [{ id: "read", name: "read_file", args: { path: "a.txt" } }] } };
  } };
  f.args.openSession = (role) => modelSession({ reviewer, role, shared, budgetState, now: f.args.now, box: { snapshotDir: f.dir, change: f.change, secrets: [], graph: null, graphNote: null }, budget: { deadlineMs: 60_000, authorize: async (call) => {
    asked.push(call.usageSoFar.invoked);
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (asked.length === 2) { refused(); return false; }
    return true;
  } } });
  const r = await runStagedReview(f.args);
  expect(asked).toEqual([0, 1]);
  expect(invoked).toHaveLength(1);
  expect(r.usage.calls.filter((call) => call.reviewer === invoked[0]!.callId.slice(0, -2)).map((call) => call.outcome)).toEqual(["ok", "refused"]);
});

it("kills a timed-out finder before awaiting its close so cleanup cannot consume verifier time", async () => {
  const f = setup(undefined, ["a.txt"]);
  const order: string[] = [];
  let opened = 0;
  const open = f.args.openSession;
  f.args.openSession = (role) => {
    if (++opened > 1) return open(role);
    let killed = false;
    let release!: () => void;
    const gone = new Promise<void>((resolve) => { release = resolve; });
    return {
      send: async () => ({ finalText: "", calls: [], usage: { turns: 0, input_tokens: null, output_tokens: null, cost_usd: null }, sessionId: null, failure: TIMED_OUT }),
      kill: () => { killed = true; order.push("kill"); release(); },
      close: async () => { order.push("close"); if (!killed) setTimeout(release, 20); await gone; },
    };
  };
  await runStagedReview(f.args);
  expect(order).toEqual(["kill", "close"]);
  expect(f.requests.some((r) => r.purpose === "verify")).toBe(true);
});

it("names the time cap first in missing when a finder session hit it, in the caller's words", async () => {
  const f = setup();
  const cap = "the reviewer timed out and was stopped at the 1 second cap; pass --timeout <seconds> to allow more";
  f.args.timedOut = cap;
  const open = f.args.openSession;
  let opened = 0;
  f.args.openSession = (role) => {
    if (++opened > 1) return open(role);
    return { send: async () => ({ finalText: "", calls: [], usage: { turns: 0, input_tokens: null, output_tokens: null, cost_usd: null }, sessionId: null, failure: TIMED_OUT }), kill: () => {}, close: async () => {} };
  };
  const r = await runStagedReview(f.args);
  expect(r.missing[0]).toBe(cap);
  expect(r.missing.filter((line) => line === cap)).toHaveLength(1);
  expect(r.sessions[0]!.failure).toBe(cap);
});

it("takes the verifier's category for a confirmed scanner finding", async () => {
  const f = setup((answer) => {
    if (answer.version === "find-1") answer.candidates = [];
    if (answer.version === "verify-1") answer.verdicts.forEach((v) => { v.category = "performance"; });
    return answer;
  }, ["a.txt"]);
  f.scan.candidates.push(scanner("a.txt"));
  const r = await runStagedReview(f.args);
  expect(r.report.findings[0]).toMatchObject({ candidate: "c1", category: "performance" });
});

// A host write failure must stop the run, rather than becoming a retry.
it("propagates a failed started-event writer and closes every session", async () => {
  const f = setup();
  f.args.onStarted = (role) => { if (role === "finder:u2:contracts") throw new Error("host writer failed"); };
  await expect(runStagedReview(f.args)).rejects.toThrow("host writer failed");
  expect(f.closed.size).toBe(f.opened.length);
  expect(f.opened).toHaveLength(4);
});

it("drops one unmatched evidence candidate and keeps the other with a complete review", async () => {
  const f = setup((answer) => {
    if (answer.version === "find-1" && answer.candidates.length) answer.candidates.push({ ...candidate(answer.candidates[0]!.file_path, "Unproved defect"), evidence: [{ file_path: answer.candidates[0]!.file_path, line_number: 1, quote: "invented" }] });
    return answer;
  }, ["a.txt"]);
  const r = await runStagedReview(f.args);
  expect(r.report.findings).toHaveLength(1);
  expect(r.missing).toEqual([]);
  expect(completion(r, f).status).toBe("complete");
  expect(r.sessions[0]!.dropped).toContainEqual(expect.objectContaining({ title: "Unproved defect", line_number: 1, reason: "evidence not found" }));
  expect(r.report.low_confidence).toContainEqual(expect.objectContaining({ title: "Unproved defect", reason: "evidence not found" }));
});
it("reviews a 130 KB hunk in two parts without an indivisible note", async () => {
  const f = setup((answer) => { if (answer.version === "find-1") answer.candidates = []; return answer; }, ["a.txt"]);
  f.change.coverage.set("a.txt", makeLineSet([...Array.from({ length: 2000 }, (_, i) => i + 1)]));
  const text = Array.from({ length: 2000 }, (_, i) => `line_${i}_${"x".repeat(61)}`).join("\n") + "\n";
  writeFileSync(join(f.dir, "a.txt"), text);
  f.change.diffs = [{ path: "a.txt", text: "@@ -0,0 +1,2000 @@\n" + text.trimEnd().split("\n").map((row) => `+${row}`).join("\n") + "\n" }];
  f.args.findBrief = (unit, pass) => { const b = buildFindBrief({ change: f.change, scan: f.scan, config: f.config, lenses: [], secrets: [] }, unit, pass); f.realBriefs.set(b.text, { unit, pass }); return b; };
  const r = await runStagedReview(f.args);
  expect(r.sessions.filter((session) => session.role.startsWith("finder:"))).toHaveLength(4);
  expect(r.report.notes ?? []).toEqual([]);
  expect(r.briefCarried.map((h) => h.part?.of)).toEqual([2, 2, 2, 2]);
  expect(completion(r, f).status).toBe("complete");
});

it("keeps a candidate with an unknown lens without failing its verifier batch", async () => {
  const f = setup((answer) => { if (answer.version === "find-1") answer.candidates.forEach((c) => { c.lens = "unknown"; }); return answer; }, ["a.txt"]);
  const r = await runStagedReview(f.args);
  expect(r.report.findings).toHaveLength(1);
  expect(r.submission.findings[0]!.source).toBeNull();
  expect(r.missing).toEqual([]);
});
it("batches a scanner and finder on the same line together among more than six candidates", async () => {
  const f = setup((answer) => {
    if (answer.version === "find-1" && answer.candidates.length) answer.candidates = Array.from({ length: 7 }, (_, i) => ({ ...candidate("a.txt", `Defect ${i}`), line_number: i + 1 }));
    return answer;
  }, ["a.txt"]);
  f.scan.candidates.push(scanner("a.txt"));
  await runStagedReview(f.args);
  const batch = f.requests.filter((r) => r.purpose === "verify").map((r) => JSON.parse(r.messages[1]!.text).batch as VerifyBatch).find((b) => b.candidates.some((c) => c.id === "c1"))!;
  expect(batch.candidates.map((c) => c.id)).toEqual(expect.arrayContaining(["c1", "k1"]));
});
it("preserves a good item in the same batch when another item exhausts prose corrections", async () => {
  const f = setup((answer) => {
    if (answer.version === "find-1" && answer.candidates.length) answer.candidates.push(candidate("a.txt", "Another defect"));
    if (answer.version === "verify-1") answer.verdicts[0]!.problem = "";
    return answer;
  }, ["a.txt"]);
  const r = await runStagedReview(f.args);
  expect(r.report.findings.map((f) => f.title)).toEqual(["Another defect"]);
  expect(r.report.low_confidence[0]!.reason).toBe("unresolved by the verifier");
});

// Failure cases: accepted sessions accumulate, assembly errors expose array
// offsets, and completion order decides candidate ids.
it("closes an accepted verifier before opening its fresh assembly correction", async () => {
  let corrected = false;
  const f = setup((answer, request) => {
    if (answer.version === "verify-1") {
      answer.verdicts.forEach((v) => { v.verdict = "refuted"; });
      if (!request.callId.includes(":assembly")) answer.verdicts.find((v) => v.id === "c1")!.file_path = "missing.txt";
      else {
        corrected = true;
        expect(f.closed.size).toBe(f.opened.length - 1);
        expect(request.messages[1]!.text).toContain("candidate c1");
        expect(request.messages[1]!.text).not.toContain("dropped[0]");
        expect(request.messages[1]!.text).toContain("Previous answer:");
      }
    }
    return answer;
  }, ["a.txt"]);
  f.scan.candidates.push(scanner("a.txt"));
  const r = await runStagedReview(f.args);
  expect(corrected).toBe(true);
  expect(r.missing).toEqual([]);
  expect(new Set(r.usage.calls.map((call) => call.callId)).size).toBe(r.usage.calls.length);
  expect(f.closed.size).toBe(f.opened.length);
});
it("drops only the offending scanner when its assembly corrections are exhausted", async () => {
  const f = setup((answer) => {
    if (answer.version === "verify-1") {
      const scanner = answer.verdicts.find((v) => v.id === "c1")!;
      scanner.verdict = "refuted";
      scanner.file_path = "missing.txt";
    }
    return answer;
  }, ["a.txt"]);
  f.scan.candidates.push(scanner("a.txt"));
  const r = await runStagedReview(f.args);
  expect(r.report.findings).toHaveLength(1);
  expect(r.report.not_reviewed.map((c) => c.id)).toEqual(["c1"]);
  expect(r.missing.join(" ")).toContain("candidates c1 were not verified");
});
it("keeps candidate ids and session records stable when finders finish in reverse order", async () => {
  const run = async (reverse: boolean) => {
    const f = setup(async (answer, _request, brief) => {
      if (brief.unit) await new Promise((resolve) => setTimeout(resolve, reverse ? 6 - Number(brief.unit.id.slice(1)) : Number(brief.unit.id.slice(1))));
      return answer;
    }, ["a.txt", "b.txt", "c.txt", "d.txt", "e.txt"]);
    const r = await runStagedReview(f.args);
    return { roles: r.sessions.map((s) => s.role), candidates: f.requests.filter((r) => r.purpose === "verify").flatMap((r) => (JSON.parse(r.messages[1]!.text).batch as VerifyBatch).candidates.map((c) => [c.id, c.kind === "finder" ? c.candidate.file_path : c.candidate.filePath])) };
  };
  expect(await run(true)).toEqual(await run(false));
});

it.each(["a missing file", "an inverted line range"])("drops a finder candidate with %s and completes with the good candidate", async (fault) => {
  const f = setup((answer) => {
    if (answer.version === "find-1" && answer.candidates.length) {
      const bad = candidate("a.txt", "Invalid candidate");
      if (fault === "a missing file") bad.file_path = "missing.txt";
      else { bad.line_number = 2; bad.line_end = 1; }
      answer.candidates.push(bad);
    }
    return answer;
  }, ["a.txt"]);
  const r = await runStagedReview(f.args);
  expect(r.report.findings.map((finding) => finding.title)).toEqual(["Unsafe operation"]);
  expect(r.sessions[0]!.dropped).toContainEqual(expect.objectContaining({ title: "Invalid candidate" }));
  expect(r.rounds.filter((round) => round.by === "finder:u1:local")).toHaveLength(2);
  expect(f.requests.filter((request) => request.purpose === "verify")).toHaveLength(1);
  expect(completion(r, f).status).toBe("complete");
});

it("keeps seven candidates in one batch when the sixth and seventh share a line, with the scanner first", async () => {
  const f = setup((answer, _request, brief) => {
    if (answer.version === "find-1" && answer.candidates.length) answer.candidates = Array.from({ length: 6 }, (_, i) => ({ ...candidate("a.txt", `Defect ${i}`), line_number: i + 1, evidence: [{ file_path: "a.txt", line_number: i + 1, quote: "unsafe operation" }] }));
    if (answer.version === "verify-1") for (const v of answer.verdicts) {
      const c = brief.batch!.candidates.find((c) => c.id === v.id)!;
      v.line_number = c.kind === "scanner" ? c.candidate.lineStart : c.candidate.line_number;
    }
    return answer;
  }, ["a.txt"]);
  writeFileSync(join(f.dir, "a.txt"), "unsafe operation\n".repeat(6));
  f.change.coverage.set("a.txt", makeLineSet([1, 2, 3, 4, 5, 6]));
  f.scan.candidates.push({ ...scanner("a.txt"), lineStart: 6, lineEnd: 6 });
  const r = await runStagedReview(f.args);
  const briefs = f.requests.filter((request) => request.purpose === "verify").map((request) => JSON.parse(request.messages[1]!.text).batch as VerifyBatch);
  expect(briefs).toHaveLength(1);
  expect(briefs[0]!.candidates.map((c) => c.id)).toEqual(["k1", "k2", "k3", "k4", "k5", "c1", "k6"]);
  expect(completion(r, f).status).toBe("complete");
});

it("splits twelve scanner candidates on one line into two batches", async () => {
  const f = setup((answer, _request, brief) => {
    if (answer.version === "find-1") answer.candidates = [];
    if (answer.version === "verify-1") for (const v of answer.verdicts) {
      const c = brief.batch!.candidates.find((c) => c.id === v.id)!;
      v.line_number = c.kind === "scanner" ? c.candidate.lineStart : c.candidate.line_number;
    }
    return answer;
  }, ["a.txt"]);
  for (let i = 0; i < 12; i++) f.scan.candidates.push({ ...scanner("a.txt"), id: `c${i + 1}`, ruleId: `rule-${i + 1}` });
  const r = await runStagedReview(f.args);
  const briefs = f.requests.filter((request) => request.purpose === "verify").map((request) => JSON.parse(request.messages[1]!.text).batch as VerifyBatch);
  expect(briefs.map((b) => b.candidates.length)).toEqual([6, 6]);
  expect(completion(r, f).status).toBe("complete");
});

it("keeps six scanners and two finders on one line in a single batch so both can name scanner duplicates", async () => {
  const f = setup((answer) => {
    if (answer.version === "find-1" && answer.candidates.length) answer.candidates.push(candidate("a.txt", "Second defect"));
    return answer;
  }, ["a.txt"]);
  for (let i = 0; i < 6; i++) f.scan.candidates.push({ ...scanner("a.txt", `c${i + 1}`), ruleId: `rule-${i + 1}` });
  await runStagedReview(f.args);
  const batches = f.requests.filter((request) => request.purpose === "verify").map((request) => JSON.parse(request.messages[1]!.text).batch as VerifyBatch);
  expect(batches.map((b) => b.candidates.map((c) => c.id))).toEqual([["c1", "c2", "c3", "c4", "c5", "c6", "k1", "k2"]]);
});

it("corrects a long scanner refutation in its existing verifier session", async () => {
  const f = setup((answer, request) => {
    if (answer.version === "find-1") answer.candidates = [];
    else for (const v of answer.verdicts) {
      v.verdict = "refuted";
      v.reason = request.purpose === "verify" ? "The input is checked. The operation is safe. The caller is trusted." : "The input is checked before this operation.";
    }
    return answer;
  }, ["a.txt"]);
  f.scan.candidates.push(scanner("a.txt"));
  const r = await runStagedReview(f.args);
  expect(r.sessions.filter((s) => s.role.startsWith("verifier:")).map((s) => s.role)).toEqual(["verifier:1"]);
  expect(r.rounds[0]!.errors).toContain("candidate c1.reason: has 3 sentences; the limit is 2");
  expect(r.submission.dropped).toHaveLength(1);
  expect(completion(r, f).status).toBe("complete");
});

// Failure cases: duplicate chains show twice, or possible observations become defects.
it.each([false, true])("drops possible items linked to counted findings in either direction: %s", async (reverse) => {
  const f = setup((answer, _request, brief) => {
    if (answer.version === "find-1") answer.candidates = [candidate(brief.unit!.files[0]!, brief.pass === "local" ? "Counted" : "Possible")];
    if (answer.version === "verify-1") {
      const [counted, possible] = answer.verdicts;
      possible!.confidence = 0.6;
      if (reverse) counted!.duplicate_of = possible!.id;
      else possible!.duplicate_of = counted!.id;
    }
    return answer;
  }, ["a.txt"]);
  const r = await runStagedReview(f.args);
  expect(r.report.findings).toHaveLength(1);
  expect(r.report.possible).toEqual([]);
});
it("puts an observation-tier item at 0.6 under the floor with its reason", async () => {
  const f = setup((answer) => {
    if (answer.version === "verify-1") answer.verdicts.forEach((v) => { v.confidence = 0.6; v.tier = "observation"; });
    return answer;
  }, ["a.txt"]);
  const r = await runStagedReview(f.args);
  expect(r.report.possible).toEqual([]);
  expect(r.report.observations).toEqual([]);
  expect(r.report.low_confidence).toEqual([expect.objectContaining({ confidence: 0.6, reason: "observation under the floor" })]);
});
it("does not block on a critical possible item", async () => {
  const f = setup((answer) => {
    if (answer.version === "verify-1") answer.verdicts.forEach((v) => { v.confidence = 0.6; v.severity = "critical"; });
    return answer;
  }, ["a.txt"]);
  f.config.blockOnSeverity = "major";
  const r = await runStagedReview(f.args);
  expect(r.report.possible).toHaveLength(1);
  expect(r.report.verdict).toBe("passed");
});
it.each([false, true])("drops a possible item linked to a shown observation in either direction: %s", async (reverse) => {
  const f = setup((answer, _request, brief) => {
    if (answer.version === "find-1") answer.candidates = [candidate(brief.unit!.files[0]!, brief.pass === "local" ? "Observation" : "Possible")];
    if (answer.version === "verify-1") {
      const [observation, possible] = answer.verdicts;
      observation!.tier = "observation";
      possible!.confidence = 0.6;
      if (reverse) observation!.duplicate_of = possible!.id;
      else possible!.duplicate_of = observation!.id;
    }
    return answer;
  }, ["a.txt"]);
  const r = await runStagedReview(f.args);
  expect(r.report.observations).toHaveLength(1);
  expect(r.report.possible).toEqual([]);
});

// Failure cases: the severity filter loses under-floor observations or the
// visible check restores possible defects that the primary filter hid.
it("keeps an observation under the confidence and severity floors in low_confidence", async () => {
  const f = setup((answer) => {
    if (answer.version === "verify-1") answer.verdicts.forEach((v) => { v.confidence = 0.6; v.severity = "nitpick"; v.tier = "observation"; });
    return answer;
  }, ["a.txt"]);
  f.config.severityThreshold = "major";
  const r = await runStagedReview(f.args);
  expect(r.report.possible).toEqual([]);
  expect(r.report.low_confidence).toEqual([expect.objectContaining({ confidence: 0.6, reason: "observation under the floor" })]);
});
it("retains a low-confidence trace when severity hides a possible defect", async () => {
  const f = setup((answer) => {
    if (answer.version === "verify-1") answer.verdicts.forEach((v) => { v.confidence = 0.6; v.severity = "minor"; });
    return answer;
  }, ["a.txt"]);
  f.config.severityThreshold = "major";
  const r = await runStagedReview(f.args);
  expect(r.report.possible).toEqual([]);
  expect(r.report.low_confidence).toEqual([expect.objectContaining({ confidence: 0.6, floor: 0.7 })]);
  expect(r.report.below_threshold).toBe(0);
});

// Duplicate ownership must cover possible components and capped observations.
it.each([false, true])("folds linked possible items by severity then confidence, reversed: %s", async (reverse) => {
  const f = setup((answer) => {
    if (answer.version === "find-1" && answer.candidates.length) answer.candidates = ["Minor", "Major", "Best", "Separate"].map((title) => candidate("a.txt", title));
    if (answer.version === "verify-1") {
      const [minor, major, best, separate] = answer.verdicts;
      minor!.severity = "minor"; minor!.confidence = 0.65;
      major!.severity = "major"; major!.confidence = 0.55;
      best!.severity = "major"; best!.confidence = 0.6;
      separate!.confidence = 0.6;
      if (reverse) { best!.duplicate_of = major!.id; major!.duplicate_of = minor!.id; }
      else { minor!.duplicate_of = major!.id; major!.duplicate_of = best!.id; }
    }
    return answer;
  }, ["a.txt"]);
  const r = await runStagedReview(f.args);
  expect(r.missing).toEqual([]);
  expect(r.report.possible.map((f) => f.title).sort()).toEqual(["Best", "Separate"]);
});
it("drops a possible duplicate of the thirteenth observation omitted by the cap", async () => {
  const f = setup((answer) => {
    if (answer.version === "find-1" && answer.candidates.length) answer.candidates = [...Array.from({ length: 13 }, (_, i) => candidate("a.txt", `Observation ${i}`)), candidate("a.txt", "Possible")];
    if (answer.version === "verify-1") {
      const omitted = answer.verdicts.find((v) => v.title === "Observation 12")!;
      for (const v of answer.verdicts) {
        if (v.title === "Possible") { v.confidence = 0.6; v.duplicate_of = omitted.id; }
        else { v.tier = "observation"; v.confidence = v === omitted ? 0.8 : 0.9; }
      }
    }
    return answer;
  }, ["a.txt"]);
  const r = await runStagedReview(f.args);
  expect(r.missing).toEqual([]);
  expect(r.report.observations).toHaveLength(12);
  expect(r.report.observations_omitted).toBe(1);
  expect(r.report.possible).toEqual([]);
});
it.each([[false, 0.6], [true, 0.6], [false, 0.45], [true, 0.45]] as const)("does not list a folded under-floor observation as low confidence, reversed: %s, confidence: %s", async (reverse, confidence) => {
  const f = setup((answer, _request, brief) => {
    if (answer.version === "find-1") answer.candidates = [candidate("a.txt", brief.pass === "local" ? "Counted" : "Low observation")];
    if (answer.version === "verify-1") {
      const [counted, observation] = answer.verdicts;
      observation!.tier = "observation"; observation!.confidence = confidence;
      if (reverse) counted!.duplicate_of = observation!.id;
      else observation!.duplicate_of = counted!.id;
    }
    return answer;
  }, ["a.txt"]);
  const r = await runStagedReview(f.args);
  expect(r.report.findings).toHaveLength(1);
  expect(r.report.possible).toEqual([]);
  expect(r.report.low_confidence).toEqual([]);
});

// Hidden possible traces remain only when no displayed item owns their chain.
it.each([false, true])("removes a hidden possible trace only when folded into a counted finding, duplicate: %s", async (duplicate) => {
  const f = setup((answer, _request, brief) => {
    if (answer.version === "find-1") answer.candidates = [candidate("a.txt", brief.pass === "local" ? "Counted" : "Hidden possible")];
    if (answer.version === "verify-1") {
      const [counted, possible] = answer.verdicts;
      possible!.confidence = 0.6;
      possible!.severity = "nitpick";
      if (duplicate) possible!.duplicate_of = counted!.id;
    }
    return answer;
  }, ["a.txt"]);
  f.config.severityThreshold = "major";
  const r = await runStagedReview(f.args);
  expect(r.missing).toEqual([]);
  expect(r.report.findings.map((f) => f.title)).toEqual(["Counted"]);
  expect(r.report.possible).toEqual([]);
  expect(r.report.low_confidence).toEqual(duplicate ? [] : [{ title: "Hidden possible", file_path: "a.txt", confidence: 0.6, floor: 0.7 }]);
});

// Trace fields omit line numbers, so matching must preserve unrelated twins.
it.each(["finding", "observation"] as const)("keeps the twin hidden item's trace when one item folds, tier: %s", async (tier) => {
  const f = setup((answer, _request, brief) => {
    if (answer.version === "find-1" && answer.candidates.length) answer.candidates = [1, 2, 3].map((line) => ({ ...candidate("a.txt", line === 1 ? "Counted" : "Twin"), line_number: line }));
    if (answer.version === "verify-1") {
      const counted = answer.verdicts.find((v) => v.title === "Counted")!;
      for (const v of answer.verdicts) {
        const c = brief.batch!.candidates.find((c) => c.id === v.id)!;
        v.line_number = c.kind === "finder" ? c.candidate.line_number : 1;
        if (v.line_number > 1) { v.confidence = 0.6; v.severity = "nitpick"; }
        if (v.line_number === 2) { v.duplicate_of = counted.id; v.tier = tier; }
      }
    }
    return answer;
  }, ["a.txt"]);
  writeFileSync(join(f.dir, "a.txt"), "unsafe operation\n".repeat(3));
  f.change.coverage.set("a.txt", makeLineSet([1, 2, 3]));
  f.config.severityThreshold = "major";
  const r = await runStagedReview(f.args);
  expect(r.missing).toEqual([]);
  expect(r.report.findings.map((f) => f.title)).toEqual(["Counted"]);
  expect(r.report.possible).toEqual([]);
  expect(r.report.low_confidence).toEqual([{ title: "Twin", file_path: "a.txt", confidence: 0.6, floor: 0.7 }]);
});
it.each([false, true])("a shown possible item leaves a same-looking hidden item's trace, folded: %s", async (folded) => {
  const f = setup((answer, _request, brief) => {
    if (answer.version === "find-1" && answer.candidates.length) answer.candidates = [1, 2, 3].map((line) => ({ ...candidate("a.txt", line === 3 ? "Counted" : "Twin"), line_number: line }));
    if (answer.version === "verify-1") {
      const counted = answer.verdicts.find((v) => v.title === "Counted")!;
      for (const v of answer.verdicts) {
        const c = brief.batch!.candidates.find((c) => c.id === v.id)!;
        v.line_number = c.kind === "finder" ? c.candidate.line_number : 1;
        if (v.line_number < 3) v.confidence = 0.6;
        if (v.line_number === 2) v.severity = "nitpick";
        if (v.line_number === 1 && folded) v.duplicate_of = counted.id;
      }
    }
    return answer;
  }, ["a.txt"]);
  writeFileSync(join(f.dir, "a.txt"), "unsafe operation\n".repeat(3));
  f.change.coverage.set("a.txt", makeLineSet([1, 2, 3]));
  f.config.severityThreshold = "major";
  const r = await runStagedReview(f.args);
  expect(r.missing).toEqual([]);
  expect(r.report.findings.map((f) => f.title)).toEqual(["Counted"]);
  expect(r.report.possible.map((f) => f.line_number)).toEqual(folded ? [] : [1]);
  expect(r.report.low_confidence).toEqual([{ title: "Twin", file_path: "a.txt", confidence: 0.6, floor: 0.7 }]);
});

it("clips a snapshot-only file's delivery to its own measured part", async () => {
  const f = setup((answer) => { if (answer.version === "find-1") answer.candidates = []; return answer; }, ["a.txt"]);
  const text = Array.from({ length: 9000 }, (_, i) => `distinct_${i + 1}`).join("\n") + "\n";
  writeFileSync(join(f.dir, "a.txt"), text);
  f.change.coverage.set("a.txt", makeLineSet([...Array.from({ length: 9000 }, (_, i) => i + 1)]));
  f.change.diffs = [];
  f.args.findBrief = (unit, pass) => ({ text: JSON.stringify({ unit, pass }), diffFiles: new Set(), carried: [] });
  const r = await runStagedReview(f.args);
  const refs = obligations(f.change, () => text);
  expect(refs.length).toBeGreaterThanOrEqual(3);
  const second = r.rounds.filter((round) => round.by === "finder:u2:local");
  expect(second).toHaveLength(1);
  expect(second[0]!.delivered).toHaveLength(1);
  expect(second[0]!.delivered[0]).toMatchObject({ start: refs[1]!.start, end: refs[1]!.end });
  const coverage = readCoverage({ change: f.change, obligations: refs, briefCarried: r.briefCarried, delivered: r.delivered, trace: [] });
  expect(coverage.unread).toEqual([]);
  expect(coverage.given).toHaveLength(refs.length);
  expect(coverage.given!.every((g) => g.by === "page")).toBe(true);
});
it("carries only nearby parts in a verifier brief for part three", async () => {
  const f = setup((answer, _request, brief) => {
    if (answer.version === "find-1") answer.candidates = brief.unit!.hunks.some((h) => h.start <= 8500 && h.end >= 8500)
      ? [{ ...candidate("a.txt"), line_number: 8500, evidence: [{ file_path: "a.txt", line_number: 8500, quote: "unsafe operation" }] }] : [];
    if (answer.version === "verify-1") answer.verdicts.forEach((v) => { v.line_number = 8500; });
    return answer;
  }, ["a.txt"]);
  const row = "unsafe operation".padEnd(28);
  const text = `${row}\n`.repeat(18000);
  writeFileSync(join(f.dir, "a.txt"), text);
  f.change.coverage.set("a.txt", makeLineSet([...Array.from({ length: 18000 }, (_, i) => i + 1)]));
  f.change.diffs = [{ path: "a.txt", text: "@@ -0,0 +1,18000 @@\n" + `+${row}\n`.repeat(18000) }];
  // Only one of the five parts fits after these fixed convention blocks.
  const shared = { change: f.change, scan: f.scan, config: f.config, lenses: [], secrets: [], instructions: "Repository convention.\n".repeat(4600) };
  f.args.verifyBrief = (batch) => { const b = buildVerifyBrief(shared, batch); f.realBriefs.set(b.text, { batch }); return b; };
  const r = await runStagedReview(f.args);
  expect(r.report.findings).toHaveLength(1);
  const briefs = f.requests.filter((request) => request.purpose === "verify").map((request) => request.messages[1]!.text);
  expect(briefs).toHaveLength(1);
  expect(briefs[0]!.match(/not shown; read with your tools/g)).toHaveLength(4);
  expect(briefs[0]!.match(/^\+unsafe operation *$/gm)).toHaveLength(3999);
  expect(briefs[0]).toContain("(part 3 of 5)\n\n```diff");
  for (const n of [1, 2, 4, 5]) expect(briefs[0]).toMatch(new RegExp(`part ${n}, lines \\d+ to \\d+, not shown; read with your tools`));
  expect(Buffer.byteLength(briefs[0]!)).toBeLessThanOrEqual(MAX_BRIEF_BYTES);
});

it("does not credit a built page when the deadline prevents sending it", async () => {
  const f = setup((answer) => {
    if (answer.version === "find-1") { answer.candidates = []; f.advance(31_000); }
    return answer;
  }, ["a.txt"]);
  f.change.diffs = [];
  f.args.findBrief = (unit, pass) => ({ text: JSON.stringify({ unit, pass }), diffFiles: new Set(), carried: [] });
  const r = await runStagedReview(f.args);
  expect(r.rounds.some((round) => round.delivered.length > 0)).toBe(true);
  expect(r.delivered).toEqual([]);
  const coverage = readCoverage({ change: f.change, obligations: r.obligations, briefCarried: r.briefCarried, delivered: r.delivered, trace: [] });
  expect(coverage.given).toEqual([]);
  expect(coverage.unread).toHaveLength(1);
});

function wideVerifier(lines: number[], instructions = "") {
  const rows = Array.from({ length: 121 }, (_, i) => `wide_${i + 1}_`.padEnd(6200, "x"));
  const f = setup((answer, _request, brief) => {
    if (answer.version === "find-1") answer.candidates = lines.filter((line) => brief.pass === "local" && brief.unit!.hunks.some((h) => h.start <= line && h.end >= line)).map((line) => ({
      ...candidate("a.txt", `Defect at ${line}`), line_number: line,
      evidence: [{ file_path: "a.txt", line_number: line, quote: rows[line - 1]! }],
    }));
    return answer;
  }, ["a.txt"]);
  const text = rows.join("\n") + "\n";
  writeFileSync(join(f.dir, "a.txt"), text);
  f.change.coverage.set("a.txt", makeLineSet([...rows.map((_, i) => i + 1)]));
  f.change.diffs = [{ path: "a.txt", text: "@@ -0,0 +1,121 @@\n" + rows.map((row) => `+${row}`).join("\n") + "\n" }];
  const shared = { change: f.change, scan: f.scan, config: f.config, lenses: [], secrets: [], instructions };
  f.args.verifyBrief = (batch) => { const b = buildVerifyBrief(shared, batch); f.realBriefs.set(b.text, { batch }); return b; };
  return { ...f, rows };
}

it("bounds wide verifier neighbours and names every part it cannot carry", async () => {
  const f = wideVerifier([61]);
  const r = await runStagedReview(f.args);
  const refs = r.obligations;
  expect(refs).toHaveLength(7);
  expect(r.missing).toEqual([]);
  const briefs = f.requests.filter((request) => request.purpose === "verify").map((request) => request.messages[1]!.text);
  expect(briefs).toHaveLength(1);
  const brief = briefs[0]!;
  expect(Buffer.byteLength(brief)).toBeLessThanOrEqual(MAX_BRIEF_BYTES);
  const shown = refs.filter((h) => brief.includes(`+${f.rows[h.start - 1]}\n`));
  expect(shown.map((h) => h.part!.n)).toEqual([3, 4]);
  // Selection is nearest first; the brief still shows the parts in file order.
  expect(brief.indexOf(`+${f.rows[38]}\n`)).toBeLessThan(brief.indexOf(`+${f.rows[57]}\n`));
  for (const h of refs.filter((h) => !shown.includes(h))) {
    expect(brief).toContain(`part ${h.part!.n}, lines ${h.start} to ${h.end}, not shown; read with your tools`);
    expect(brief).not.toContain(`+${f.rows[h.start - 1]}\n`);
  }
});

it("splits wide verifier candidates when their distance-zero parts cannot share a brief", async () => {
  // Leave room for either candidate's part, but not both, after fixed brief blocks.
  const f = wideVerifier([5, 115], "Repository convention.\n".repeat(4600));
  const r = await runStagedReview(f.args);
  expect(r.obligations).toHaveLength(7);
  expect(r.missing).toEqual([]);
  const briefs = f.requests.filter((request) => request.purpose === "verify").map((request) => request.messages[1]!.text);
  expect(briefs).toHaveLength(2);
  expect(briefs.map((brief) => [...f.realBriefs.get(brief)!.batch!.candidates].map((c) => c.kind === "finder" ? c.candidate.line_number : 0))).toEqual([[5], [115]]);
  for (const [i, brief] of briefs.entries()) {
    expect(Buffer.byteLength(brief)).toBeLessThanOrEqual(MAX_BRIEF_BYTES);
    const own = r.obligations.find((h) => h.start <= [5, 115][i]! && h.end >= [5, 115][i]!)!;
    expect(brief).toContain(`+${f.rows[own.start - 1]}\n`);
    for (const h of r.obligations) if (!brief.includes(`+${f.rows[h.start - 1]}\n`)) expect(brief).toContain(`part ${h.part!.n}, lines ${h.start} to ${h.end}, not shown; read with your tools`);
  }
});

it("records examined as distinct hunk ids", async () => {
  const f = setup(undefined, ["a.txt"]);
  const r = await runStagedReview(f.args);
  expect(r.sessions.filter((s) => s.role.startsWith("finder:")).map((s) => s.examined)).toEqual([["h1"], ["h1"]]);
});

it("bounds a candidate's own part before its two cited 120 KB removal fragments", async () => {
  const old = ["old_a", "old_b"].map((s) => s.padEnd(119 * 1024, "x"));
  const next = "unsafe operation".padEnd(119 * 1024, "y");
  const f = setup((answer, _request, brief) => {
    if (answer.version === "find-1") answer.candidates = brief.pass === "local" && brief.unit!.hunks.some((h) => !h.deletion)
      ? [{ ...candidate("a.txt"), evidence: old.map((quote, i) => ({ file_path: "a.txt", line_number: i + 1, quote: quote.slice(0, 5), removed: true as const })) }] : [];
    return answer;
  }, ["a.txt"]);
  writeFileSync(join(f.dir, "a.txt"), next + "\n");
  f.change.diffs = [{ path: "a.txt", text: "@@ -1,2 +1 @@\n" + old.map((s) => "-" + s).join("\n") + "\n+" + next + "\n" }];
  const shared = { change: f.change, scan: f.scan, config: f.config, lenses: [], secrets: [] };
  f.args.verifyBrief = (batch) => { const b = buildVerifyBrief(shared, batch); f.realBriefs.set(b.text, { batch }); return b; };
  const r = await runStagedReview(f.args);
  const briefs = f.requests.filter((r) => r.purpose === "verify").map((r) => r.messages[1]!.text);
  expect(briefs).toHaveLength(1);
  expect(Buffer.byteLength(briefs[0]!)).toBeLessThanOrEqual(MAX_BRIEF_BYTES);
  expect(briefs[0]).toContain("+" + next);
  expect(briefs[0]).toContain("not shown; read with your tools");
  expect(completion(r, f).status).toBe("complete");
});

it("abandons one candidate when its own part and fixed verifier blocks exceed the bound", async () => {
  const f = wideVerifier([61], "convention\n".repeat(14000));
  const r = await runStagedReview(f.args);
  expect(completion(r, f).status).toBe("incomplete");
  expect(r.missing.join(" ")).toContain("MAX_BRIEF_BYTES");
  expect(f.requests.filter((r) => r.purpose === "verify")).toEqual([]);
});

it("renders a 300-part verifier batch a constant number of times", async () => {
  const f = setup((answer) => answer, ["a.txt"]);
  const refs = Array.from({ length: 300 }, (_, i) => ({ id: `h${i + 1}`, path: "a.txt", start: i * 2 + 1, end: i * 2 + 1, deletion: false, old: null, part: { n: 1, of: 1, whole: `a.txt:${i * 2 + 1}` } }));
  f.args.inventory = refs;
  f.args.units = [{ id: "u1", files: ["a.txt"], hunks: refs, diffBytes: 0 }];
  writeFileSync(join(f.dir, "a.txt"), "unsafe operation\n".repeat(600));
  f.change.coverage.set("a.txt", makeLineSet([...refs.map((h) => h.start)]));
  f.change.diffs = [{ path: "a.txt", text: "diff --git a/a.txt b/a.txt\n" + refs.map((h) => `@@ -0,0 +${h.start} @@\n+unsafe operation\n`).join("") }];
  let renders = 0;
  f.args.verifyBrief = (batch) => {
    renders++;
    const b = buildVerifyBrief({ change: f.change, scan: f.scan, config: f.config, lenses: [], secrets: [] }, batch);
    f.realBriefs.set(b.text, { batch });
    return b;
  };
  const r = await runStagedReview(f.args);
  expect(r.missing).toEqual([]);
  expect(renders).toBeLessThanOrEqual(3);
  const brief = f.requests.find((r) => r.purpose === "verify")!.messages[1]!.text;
  expect(brief.match(/^diff --git /gm)).toHaveLength(1);
});

it("verifies one candidate among 3000 single-part hunks without abandoning its batch", async () => {
  const f = setup(undefined, ["a.txt"]);
  const lines = Array.from({ length: 3000 }, (_, i) => i * 2 + 1);
  const refs = lines.map((n, i) => ({ id: `h${i + 1}`, path: "a.txt", start: n, end: n, deletion: false, old: null, part: { n: 1, of: 1, whole: `a.txt:${n}` } }));
  f.args.inventory = refs;
  f.args.units = Array.from({ length: 30 }, (_, i) => ({ id: `u${i + 1}`, files: ["a.txt"], hunks: refs.slice(i * 100, (i + 1) * 100), diffBytes: 0 }));
  writeFileSync(join(f.dir, "a.txt"), "unsafe operation\n".repeat(6000));
  f.change.coverage.set("a.txt", makeLineSet([...lines]));
  f.change.diffs = [{ path: "a.txt", text: lines.map((n) => `@@ -${n} +${n} @@\n-old\n+unsafe operation\n`).join("") }];
  f.args.verifyBrief = (batch) => { const b = buildVerifyBrief({ ...f, lenses: [], secrets: [] }, batch); f.realBriefs.set(b.text, { batch }); return b; };
  const r = await runStagedReview(f.args);
  expect(r.missing).toEqual([]);
  expect(r.report.findings).toHaveLength(1);
  const briefs = f.requests.filter((r) => r.purpose === "verify");
  expect(briefs).toHaveLength(1);
  expect(Buffer.byteLength(briefs[0]!.messages[1]!.text)).toBeLessThanOrEqual(MAX_BRIEF_BYTES);
});

// 7j. A stored or unsent digest must never credit a changed range.
it.each([false, true])("credits digest ranges only after a brief was sent, refused: %s", async (refused) => {
  const f = setup((answer, _request, brief) => {
    if (answer.version === "find-1") {
      answer.examined = ["d1"];
      answer.analysis = [{ hunk: "d1", changed: "Records changed.", could_break: "Values can be invalid." }];
      answer.candidates = [];
      expect(brief.unit!.digest?.kind).toBe("json");
    }
    return answer;
  }, ["a.txt"]);
  const hunks = hunkRefs(f.change);
  f.args.inventory = hunks;
  f.args.units = [{ id: "u1", files: ["a.txt"], hunks, diffBytes: 0, digest: { id: "d1", kind: "json", text: "array length 300", processed: hunks.map((h) => h.id), omitted: [] } }];
  f.args.findBrief = (unit, pass) => ({ text: JSON.stringify({ unit, pass }), diffFiles: new Set(), carried: [] });
  if (refused) f.refuse();
  const r = await runStagedReview(f.args);
  const coverage = readCoverage({ change: f.change, obligations: hunks, trace: [], digestCarried: r.digestCarried, briefCarried: r.briefCarried, delivered: r.delivered });
  expect(coverage.given).toEqual(refused ? [] : [expect.objectContaining({ path: "a.txt", by: "digest" })]);
  expect(coverage.unread).toHaveLength(refused ? 1 : 0);
  expect(r.rounds.flatMap((round) => round.delivered)).toEqual([]);
  if (!refused) expect(r.missing).toEqual([]);
});
