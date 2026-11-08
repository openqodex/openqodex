import { FINDER_CONFIDENCE_FLOOR, GLOBAL_CONFIDENCE_FLOOR, matchesGlob, redactByFingerprint, VERIFY_BATCH_SIZE, checkSubmission, findingKey, modelCoverage, outsideSnapshot, readCoverage, requiredCandidates, severityRank } from "@openqodex/core";
import type { Change, Config, FindAnswer, FindPass, FindingV2, Hunk, Report, ReportFinding, ReviewerSessionRecord, ReviewerUsage, ReviewUnit, RunManifest, ScanResult, SubmissionV2, TraceEntry, VerifyAnswer, VerifyBatch, VerifyCandidate, VerifyVerdict } from "@openqodex/core";
import { MAX_CORRECTIONS, converse, deliverRanges } from "./conversation.js";
import { TIMED_OUT } from "./agents/driver.js";
import type { Conversation, CorrectionRound, Speaker } from "./conversation.js";
import { checkFindAnswer, checkVerifyAnswer } from "./evidence-check.js";
import { snapshotText, lineCounter } from "./snapshot.js";
import { MAX_UNIT_DIFF_BYTES, hunkRefs, unitsOf } from "./units.js";
import { modelToolEntry } from "./model-loop.js";
import { usageTotals } from "./usage.js";
import type { CallRecord, ReviewerRole, ToolLogEntry } from "./usage.js";

export const FINDERS_CONCURRENCY = 4;
export const VERIFIERS_CONCURRENCY = 3;
export type StagedSession = Speaker & { close(): void | Promise<void>; kill?(): void; pid?: number | null; calls?: () => CallRecord[]; attempts?: readonly CallRecord[]; sentRounds?: number };
export type StagedArgs = {
  openSession: (role: ReviewerRole) => StagedSession;
  findBrief: (unit: ReviewUnit, pass: FindPass) => { text: string; diffFiles: Set<string> };
  verifyBrief: (batch: VerifyBatch) => { text: string };
  snapshotDir: string;
  change: Change;
  // Incremental runs examine the delta, but anchor on the full change.
  citationChange?: Change;
  scan: ScanResult;
  config: Config;
  manifest: RunManifest;
  secrets: string[];
  deadline: number;
  now: () => number;
  traced: boolean;
  // True when the sessions are model sessions, whose trace is the tool log
  // (a read counts once its result was sent); otherwise the trace is an
  // agent's, read as a single-pass trace, and only when `traced`.
  model?: boolean;
  // The line a session stopped at the review's time cap fails with, in place
  // of TIMED_OUT, and the first missing line when any stage ran out of time.
  timedOut?: string;
  confidenceFloor?: number;
  say: (line: string) => void;
  onRound?: (round: CorrectionRound) => void;
  onStarted?: (role: ReviewerRole, pid: number | null) => void;
  onEnded?: (session: StagedSessionRecord) => void;
  onBrief?: (role: ReviewerRole, text: string) => void;
  stopped?: () => boolean;
};
export type StagedResult = {
  report: Report;
  submission: SubmissionV2;
  sessions: StagedSessionRecord[];
  trace: TraceEntry[];
  usage: { calls: CallRecord[]; totals: ReturnType<typeof usageTotals> };
  rounds: CorrectionRound[];
  missing: string[];
  required: number;
  disposed: number;
  briefFiles: Set<string>;
  delivered: Hunk[];
};
export type StagedSessionRecord = ReviewerSessionRecord & { dropped?: { title: string; file_path: string; line_number: number; reason: string; confidence: number }[] };
type Run = { order: number; name: string; dropped?: StagedSessionRecord["dropped"]; role: ReviewerRole; unit?: string; session: StagedSession; talk: Conversation; examined?: string[] };
type Verified = { batch: VerifyBatch; run: Run; answer: VerifyAnswer; brief: string; number: number; corrections: number };
const emptyUsage = (): ReviewerUsage => ({ turns: 0, input_tokens: null, output_tokens: null, cost_usd: null });
const noDelivery = () => ({ text: "", delivered: [], left: [], later: 0, leak: false });
const normalTitle = (title: string) => title.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
const candidateFile = (c: VerifyCandidate) => c.kind === "finder" ? c.candidate.file_path : c.candidate.filePath;
const candidateLine = (c: VerifyCandidate) => c.kind === "finder" ? c.candidate.line_number : c.candidate.lineStart;

async function pool<T>(jobs: T[], limit: number, work: (job: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = await Promise.allSettled(Array.from({ length: Math.min(limit, jobs.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= jobs.length) break;
      await work(jobs[i]!);
    }
  }));
  const failed = workers.find((w) => w.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
}

export async function runStagedReview(args: StagedArgs): Promise<StagedResult> {
  const { change, scan, config } = args;
  const citationChange = args.citationChange ?? change;
  const read = snapshotText(args.snapshotDir);
  const lineCount = lineCounter(args.snapshotDir);
  const hunks = hunkRefs(change);
  const units = unitsOf(change, hunks);
  const startedAt = args.now();
  const findDeadline = startedAt + (args.deadline - startedAt) / 2;
  const runs: Run[] = [];
  const missing: string[] = [];
  const notes = units.filter((u) => u.diffBytes > MAX_UNIT_DIFF_BYTES).map((u) => `Unit ${u.id} has ${u.diffBytes} bytes of diff in an indivisible hunk; it was kept as one unit.`);
  const rounds: CorrectionRound[] = [];
  const briefFiles = new Set<string>();
  const closedRuns = new Map<Run, Promise<void>>();
  let live = 0;
  let done = 0;
  let budgetRefused = false;
  let hostFailure: unknown = null;
  const stopped = () => args.stopped?.() === true || budgetRefused || hostFailure !== null;
  const emit = (send: () => void) => {
    try { send(); }
    catch (error) {
      hostFailure = error;
      for (const run of runs) void close(run).catch(() => {});
      throw error;
    }
  };
  const say = (line: string) => emit(() => args.say(line));
  const heartbeat = setInterval(() => {
    try { say(`Reviewers still working: ${live} sessions live, ${done} done`); }
    catch { /* The pool propagates the host failure after closing sessions. */ }
  }, 15_000);
  heartbeat.unref();
  const roundFor = (role: ReviewerRole) => (r: Omit<CorrectionRound, "by">) => {
    const round = { ...r, by: role };
    rounds.push(round);
    emit(() => args.onRound?.(round));
  };
  const failed = (talk: Conversation) => talk.failure ?? (args.traced && talk.trace.some(outsideSnapshot) ? "the reviewer tried to read outside the snapshot" : talk.errors.length > 0 ? talk.errors.join("; ") : null);
  const recordOf = (r: Run): StagedSessionRecord => ({ role: r.role, ...(r.unit ? { unit: r.unit } : {}), rounds: r.talk.rounds, usage: r.talk.usage, failure: failed(r.talk), ...(r.examined ? { examined: r.examined } : {}), ...(r.dropped?.length ? { dropped: r.dropped } : {}) });
  const start = (role: ReviewerRole, order: number, name: string, brief: string, unit?: string): Run => {
    emit(() => args.onBrief?.(role, brief));
    const session = args.openSession(role);
    const talk: Conversation = { rounds: 0, trace: [], usage: emptyUsage(), report: null, checked: null, errors: [], required: 0, disposed: 0, failure: null, submission: null, delivered: [], carried: [], startedAt: args.now(), endedAt: args.now() };
    const run = { role, order, name, ...(unit ? { unit } : {}), session, talk };
    runs.push(run);
    live++;
    emit(() => args.onStarted?.(role, session.pid ?? null));
    say(`${name} started${session.pid != null ? ` (process ${session.pid})` : ""}`);
    return run;
  };
  const close = (run: Run): Promise<void> => {
    const earlier = closedRuns.get(run);
    if (earlier) return earlier;
    const pending = Promise.resolve().then(async () => {
      try {
        if (run.talk.failure === TIMED_OUT || (args.timedOut !== undefined && run.talk.failure === args.timedOut)) { timedOut = true; run.session.kill?.(); }
        await run.session.close();
      } finally { live--; done++; emit(() => args.onEnded?.(recordOf(run))); }
    });
    closedRuns.set(run, pending);
    return pending;
  };
  // Set when a session hit the cap or a stage ran out of time: the review
  // then names the cap first in `missing`, as the single pass does.
  let timedOut = false;
  const ranOut = (text: string) => { timedOut = true; return text; };
  const noteRefusal = (run: Run) => {
    if (run.session.attempts?.some((c) => c.outcome === "refused")) {
      budgetRefused = true;
      missing.push(run.talk.failure ?? "the budget refused a reviewer call");
    }
  };
  // The hunks of a unit no one has put in front of a finder: the brief left
  // them out (a hunk over the diff budget, or without diff rows), no read
  // carried their lines and no earlier round delivered them. The same rule as
  // the single pass: coverage never rests on the finder's own `examined` list.
  const undelivered = (unit: ReviewUnit, briefFiles: ReadonlySet<string>, trace: TraceEntry[], delivered: Hunk[]): Hunk[] => {
    const coverage = args.model
      ? modelCoverage({ change, briefSent: true, briefFiles, toolLog: (trace as ToolLogEntry[]).map(modelToolEntry), delivered, lineCount })
      : readCoverage({ change, briefFiles, trace: args.traced ? trace : [], lineCount, delivered });
    return coverage.unread.filter((h) => unit.hunks.some((u) => u.path === h.path && u.deletion === h.deletion && u.start <= h.end && h.start <= u.end));
  };
  const findings: { run: Run; answer: FindAnswer; passRole: string }[] = [];
  const verified: Verified[] = [];
  const unverified = new Set<string>();
  let allCandidates: VerifyCandidate[] = [];
  try {
    const jobs = units.flatMap((unit) => (["local", "contracts"] as const).map((pass) => ({ unit, pass }))).map((job, index) => ({ ...job, index }));
    await pool(jobs, FINDERS_CONCURRENCY, async ({ unit, pass, index }) => {
      let answer: FindAnswer | null = null;
      let last: string | null = null;
      let began = false;
      const passRole = `finder:${unit.id}:${pass}` as const;
      for (let attempt = 0; attempt < 2 && !stopped() && args.now() < findDeadline; attempt++) {
        let run: Run | null = null;
        try {
          const brief = args.findBrief(unit, pass);
          run = start(attempt === 0 ? passRole : `${passRole}:retry1`, index * 10 + attempt, `Finder for unit ${unit.id} (${pass === "local" ? "correctness and safety" : "interfaces and conventions"})`, brief.text, unit.id);
          began = true;
          let checked: ReturnType<typeof checkFindAnswer> | null = null;
          run.talk = await converse({ session: run.session, snapshotDir: args.snapshotDir, brief: brief.text, deadline: findDeadline, traced: args.traced, heartbeat: false, staged: true, sessionName: run.name, say, now: args.now, timedOut: args.timedOut, onRound: roundFor(run.role),
            check: (value, trace, delivered) => {
              const result = checkFindAnswer(value, unit, citationChange, read, args.manifest.lenses.map((lens) => lens.name));
              checked = result;
              run!.examined = result.answer.examined;
              const unread: Hunk[] = result.parsed && pass === "local" ? unit.hunks.filter((h) => !result.answer.examined.includes(h.id)) : [];
              if (result.parsed && pass === "local") for (const h of undelivered(unit, brief.diffFiles, trace, delivered)) if (!unread.some((u) => u.path === h.path && u.start === h.start && u.end === h.end && u.deletion === h.deletion)) unread.push(h);
              return { report: null, errors: result.errors, unread, required: 0, disposed: 0 };
            },
            deliver: (unread, earlier) => deliverRanges({ snapshotDir: args.snapshotDir, unread, earlier, secrets: args.secrets, change }),
          });
          // Model briefs count only after the transport received them.
          if (run.session.sentRounds === undefined || run.session.sentRounds > 0) for (const file of brief.diffFiles) briefFiles.add(file);
          noteRefusal(run);
          last = failed(run.talk);
          const result = checked as ReturnType<typeof checkFindAnswer> | null;
          if (result && result.answerErrors.length === 0 && run.talk.errors.every((error) => result.errors.includes(error)) && run.talk.failure === null && (!args.traced || !run.talk.trace.some(outsideSnapshot))) {
            const rejected = new Set(result.rejected.map((r) => r.candidate));
            answer = { ...result.answer, candidates: result.answer.candidates.filter((c) => !rejected.has(c)) };
            run.dropped = result.rejected.map(({ candidate: c }) => ({ title: c.title, file_path: c.file_path, line_number: c.line_number, confidence: c.confidence, reason: "evidence not found" }));
            run.talk.errors = [];
            findings.push({ run, answer, passRole });
            break;
          }
        } catch (error) {
          if (hostFailure !== null) throw hostFailure;
          last = (error instanceof Error ? error.message : String(error)).split("\n")[0]!;
          if (run) run.talk.failure = last;
        } finally {
          if (run) await close(run);
        }
      }
      if (answer === null) {
        missing.push(!began ? `unit ${unit.id} was not started: ${last ?? (stopped() ? "the review stopped" : ranOut("the finders' time ran out"))}` : `unit ${unit.id} was not examined by ${pass}: ${last ?? ranOut("the finders' time ran out")}`);
        for (const h of unit.hunks) missing.push(`hunk ${h.id} of ${h.path} was not examined by the ${pass} pass`);
      }
    });

    if (hostFailure !== null) throw hostFailure;
    const candidates: VerifyCandidate[] = [];
    const exact = new Map<string, Extract<VerifyCandidate, { kind: "finder" }>>();
    // Planned job order, independent of session completion and retry order.
    findings.sort((a, b) => a.run.order - b.run.order);
    for (const f of findings) for (const c of f.answer.candidates) {
      const key = [c.file_path, c.line_number, c.line_end ?? c.line_number, c.category, normalTitle(c.title)].join("\0");
      const prior = exact.get(key);
      if (prior) { if (!prior.foundBy.includes(f.passRole)) prior.foundBy.push(f.passRole); continue; }
      const entry = { id: `k${exact.size + 1}`, kind: "finder" as const, candidate: c, foundBy: [f.passRole] };
      exact.set(key, entry);
      candidates.push(entry);
    }
    candidates.push(...requiredCandidates(scan, config).map((c) => ({ id: c.id, kind: "scanner" as const, candidate: c })));
    allCandidates = candidates;
    const files = new Map<string, VerifyCandidate[]>();
    for (const c of candidates) files.set(candidateFile(c), [...(files.get(candidateFile(c)) ?? []), c]);
    const batches: VerifyBatch[] = [];
    for (const [file, list] of files) {
      list.sort((a, b) => candidateLine(a) - candidateLine(b) || Number(a.kind === "finder") - Number(b.kind === "finder"));
      for (let i = 0; i < list.length;) {
        let end = Math.min(i + VERIFY_BATCH_SIZE, list.length);
        // A scanner and a finder claim on one line need one verifier to decide which is
        // the duplicate. Claims of one kind on one line are already distinct, so they cut.
        if (end < list.length && candidateLine(list[end - 1]!) === candidateLine(list[end]!)) {
          let first = end - 1;
          let last = end + 1;
          while (first > i && candidateLine(list[first - 1]!) === candidateLine(list[end]!)) first--;
          while (last < list.length && candidateLine(list[last]!) === candidateLine(list[end]!)) last++;
          if (list.slice(first, last).some((c) => c.kind !== list[first]!.kind)) end = last;
        }
        batches.push({ file, hunks: hunks.filter((h) => h.path === file), candidates: list.slice(i, end) });
        i = end;
      }
    }
    const verifyCheck = (batch: VerifyBatch, accept: (answer: VerifyAnswer | null) => void): Parameters<typeof converse>[0]["check"] => (value) => {
      const result = checkVerifyAnswer(value, batch, citationChange, read, lineCount, scan);
      accept(result.answer);
      return { report: null, errors: result.errors, unread: [], required: batch.candidates.length, disposed: result.errors.length === 0 ? batch.candidates.length : 0 };
    };
    const abandon = (batch: VerifyBatch, reason: string) => {
      batch.candidates.forEach((c) => unverified.add(c.id));
      missing.push(`candidates ${batch.candidates.map((c) => c.id).join(", ")} were not verified: ${reason}`);
    };
    // Only item errors can be isolated. A malformed or incomplete batch is retried.
    const isolate = (batch: VerifyBatch, answer: VerifyAnswer | null, errors: string[]): answer is VerifyAnswer => {
      if (!answer || answer.verdicts.length !== batch.candidates.length || batch.candidates.some((c) => answer.verdicts.filter((v) => v.id === c.id).length !== 1)) return false;
      const ids = errors.map((e) => /^candidate ([^.: ]+)/.exec(e)?.[1]);
      if (ids.some((id) => !id || !batch.candidates.some((c) => c.id === id))) return false;
      for (const id of new Set(ids)) {
        const v = answer.verdicts.find((v) => v.id === id)!;
        v.verdict = "unresolved";
        v.reason = "the verifier exhausted its correction rounds";
        v.duplicate_of = null;
        if (batch.candidates.find((c) => c.id === id)!.kind === "scanner") abandon({ ...batch, candidates: batch.candidates.filter((c) => c.id === id) }, v.reason);
      }
      for (const v of answer.verdicts) if (v.duplicate_of && answer.verdicts.find((target) => target.id === v.duplicate_of)?.verdict !== "confirmed") v.duplicate_of = null;
      return true;
    };
    await pool(batches.map((batch, index) => ({ batch, index })), VERIFIERS_CONCURRENCY, async ({ batch, index }) => {
      let accepted = false;
      for (let attempt = 0; attempt < 2 && !stopped() && args.now() < args.deadline; attempt++) {
        let run: Run | null = null;
        try {
          const brief = args.verifyBrief(batch);
          run = start(`verifier:${index + 1}${attempt ? ":retry1" : ""}`, jobs.length * 10 + index * 10 + attempt, `Verifier ${index + 1} for ${batch.file}`, brief.text);
          let answer: VerifyAnswer | null = null;
          run.talk = await converse({ session: run.session, snapshotDir: args.snapshotDir, brief: brief.text, deadline: args.deadline, traced: args.traced, heartbeat: false, staged: true, sessionName: run.name, say, now: args.now, timedOut: args.timedOut, onRound: roundFor(run.role), check: verifyCheck(batch, (a) => { answer = a; }), deliver: noDelivery });
          noteRefusal(run);
          if (run.talk.failure === null && (!args.traced || !run.talk.trace.some(outsideSnapshot)) && answer !== null && (failed(run.talk) === null || isolate(batch, answer, run.talk.errors))) {
            verified.push({ batch, run, answer, brief: brief.text, number: index + 1, corrections: 0 }); accepted = true; break;
          }
        } catch (error) {
          if (hostFailure !== null) throw hostFailure;
          if (run) run.talk.failure = (error instanceof Error ? error.message : String(error)).split("\n")[0]!;
        } finally {
          if (run) await close(run);
        }
      }
      if (!accepted) abandon(batch, stopped() ? "the review stopped" : args.now() >= args.deadline ? ranOut("the verifier did not finish in time") : "the verifier session failed twice");
    });

    if (hostFailure !== null) throw hostFailure;
    verified.sort((a, b) => a.number - b.number);
    const sourceOf = (c: VerifyCandidate) => c.kind === "scanner" ? c.candidate.token : c.candidate.lens ? `lens:${c.candidate.lens}` : null;
    const findingOf = (v: VerifyVerdict, c: VerifyCandidate): FindingV2 => {
      return { severity: v.severity, category: v.category, confidence: v.confidence, file_path: v.file_path, line_number: v.line_number, ...(v.line_end !== undefined ? { line_end: v.line_end } : {}), title: v.title, problem: v.problem, consequence: v.consequence, fix: v.fix, suggested_change: v.suggested_change ?? null, source: sourceOf(c), candidate: c.kind === "scanner" ? c.id : null };
    };
    const analysis = findings.flatMap((f) => f.answer.analysis).map((a) => a.changed.trim().replace(/\s+/g, " ")).find(Boolean)?.split(/(?<=[.!?])\s+/)[0];
    const summary = `Reviewed ${findings.length === 0 ? "no completed finder units" : `units ${[...new Set(findings.map((f) => f.answer.unit))].join(", ")}`}.${analysis ? ` ${analysis}` : ""}`;
    const assemble = () => {
      const submission: SubmissionV2 = { version: 2, change_id: citationChange.id, summary, findings: [], dropped: [] };
      const findingOwners: Verified[] = [];
      const droppedOwners: Verified[] = [];
      const items: { v: VerifyVerdict; c: VerifyCandidate; owner: Verified; finding: FindingV2 }[] = [];
      for (const owner of verified) for (const v of owner.answer.verdicts) {
        const c = owner.batch.candidates.find((c) => c.id === v.id)!;
        if (unverified.has(c.id)) continue;
        if (v.verdict === "confirmed") {
          // Observations pass the same judge before being taken out of the
          // verdict. This also accounts for confirmed scanner observations.
          const finding = findingOf(v, c);
          submission.findings.push(finding);
          findingOwners.push(owner);
          items.push({ v, c, owner, finding });
        } else if (v.verdict === "refuted" && c.kind === "scanner") {
          submission.dropped.push({ candidate: c.id, reason: v.reason, file_path: v.file_path, line_number: v.line_number });
          droppedOwners.push(owner);
        }
      }
      const filteredScan = { ...scan, candidates: scan.candidates.filter((c) => !unverified.has(c.id)) };
      const checked = checkSubmission({ change: citationChange, scan: filteredScan, manifest: args.manifest, config, submission, lineCount, confidenceFloor: args.confidenceFloor });
      const visible = checked.ok ? checkSubmission({ change: citationChange, scan: filteredScan, manifest: args.manifest, config: { ...config, severityThreshold: "info" }, submission, lineCount, confidenceFloor: args.confidenceFloor }) : null;
      return { submission, findingOwners, droppedOwners, items, checked, visible };
    };
    let built = assemble();
    while (!built.checked.ok) {
      const errors = new Map<Verified, string[]>();
      for (const error of built.checked.errors) {
        const finding = /findings\[(\d+)\]/.exec(error);
        const dropped = /dropped\[(\d+)\]/.exec(error);
        const id = finding ? built.items[Number(finding[1])]?.c.id : dropped ? built.submission.dropped[Number(dropped[1])]?.candidate : /candidate ([ck]\d+)/.exec(error)?.[1];
        const owner = verified.find((o) => o.batch.candidates.some((c) => c.id === id));
        const named = (id ? error.replace(/(?:findings|dropped)\[\d+\]/, `candidate ${id}`) : error).replace(/^\d+\.\s+/, "");
        for (const target of owner ? [owner] : verified) errors.set(target, [...(errors.get(target) ?? []), named]);
      }
      if (errors.size === 0) break;
      await pool([...errors], VERIFIERS_CONCURRENCY, async ([owner, problems]) => {
        if (owner.corrections >= MAX_CORRECTIONS || args.now() >= args.deadline || stopped()) {
          if (!isolate(owner.batch, owner.answer, problems)) {
            abandon(owner.batch, "the verifier exhausted its correction rounds");
            verified.splice(verified.indexOf(owner), 1);
          }
          return;
        }
        owner.corrections++;
        const run = start(`verifier:${owner.number}:assembly${owner.corrections}`, owner.run.order + owner.corrections / 10, owner.run.name, owner.brief);
        try {
          let answer: VerifyAnswer | null = null;
          const saved = { ...run.talk, rounds: 1, submission: owner.answer };
          run.talk = await converse({ session: run.session, snapshotDir: args.snapshotDir, brief: owner.brief, continuation: { conversation: saved, errors: problems }, deadline: args.deadline, traced: args.traced, heartbeat: false, staged: true, sessionName: run.name, now: args.now, timedOut: args.timedOut, say, check: verifyCheck(owner.batch, (a) => { answer = a; }), deliver: noDelivery, onRound: roundFor(run.role) });
          // The saved answer is context, not a call in this new session.
          run.talk.rounds--;
          noteRefusal(run);
          if (answer !== null && run.talk.failure === null && (!args.traced || !run.talk.trace.some(outsideSnapshot)) && (failed(run.talk) === null || isolate(owner.batch, answer, run.talk.errors))) owner.answer = answer;
          else {
            if (!isolate(owner.batch, owner.answer, problems)) {
              abandon(owner.batch, "the verifier did not correct its answer");
              verified.splice(verified.indexOf(owner), 1);
            }
          }
        } finally { await close(run); }
      });
      built = assemble();
    }
    if (!built.checked.ok) throw new Error(`staged assembly could not be checked: ${built.checked.errors.join("; ")}`);
    const report = built.checked.report;
    const shownKeys = new Set(report.findings.map(findingKey));
    const keyOf = (item: typeof built.items[number]) => findingKey({ ...item.finding, line_end: item.finding.line_end ?? item.finding.line_number, candidate: item.finding.candidate ?? null });
    // A key a shown finding owns stays a finding, whatever tier another item with that key was given.
    const shownFindingTierKeys = new Set(built.items.filter((item) => item.v.tier === "finding").map(keyOf).filter((key) => shownKeys.has(key)));
    const observationKeys = new Set(built.items.filter((item) => item.v.tier === "observation").map(keyOf).filter((key) => !shownFindingTierKeys.has(key)));
    const shownObservationKeys = new Set((built.visible?.ok ? built.visible.report.findings : report.findings)
      .filter((f) => observationKeys.has(findingKey(f)))
      .sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || (b.confidence ?? 0) - (a.confidence ?? 0)).slice(0, 12).map(findingKey));
    const duplicateKeys = new Set<string>();
    // Survivors that are only observations while a kept duplicate is shown as a finding.
    const supersededKeys = new Set<string>();
    const byId = new Map(built.items.map((item) => [item.c.id, item]));
    for (const item of built.items) {
      const key = keyOf(item);
      // Along a chain of duplicates, the first link that is shown folds this item.
      let target = item;
      let folded = false;
      const seen = new Set<string>();
      while (target.v.duplicate_of && !seen.has(target.c.id)) {
        seen.add(target.c.id);
        const next = byId.get(target.v.duplicate_of);
        if (!next) break;
        target = next;
        const targetKey = keyOf(target);
        const shown = target.v.tier === "finding" ? shownKeys.has(targetKey) : item.v.tier === "observation" && shownObservationKeys.has(targetKey);
        if (targetKey !== key && shown) { folded = true; break; }
      }
      if (folded) duplicateKeys.add(key);
      else if (target !== item) {
        const targetKey = keyOf(target);
        if (targetKey !== key && item.v.tier === "finding" && target.v.tier === "observation" && shownKeys.has(key) && observationKeys.has(targetKey)) supersededKeys.add(targetKey);
      }
    }
    const observations: ReportFinding[] = [];
    report.findings = report.findings.flatMap((f) => {
      const key = findingKey(f);
      if (duplicateKeys.has(key)) return [];
      const entry = { ...f };
      if (observationKeys.has(key)) { if (!supersededKeys.has(key)) observations.push(entry); return []; }
      return [entry];
    });
    if (built.visible?.ok) for (const f of built.visible.report.findings) {
      const key = findingKey(f);
      if (observationKeys.has(key) && !duplicateKeys.has(key) && !supersededKeys.has(key) && !observations.some((o) => findingKey(o) === key)) observations.push({ ...f });
    }
    observations.sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || (b.confidence ?? 0) - (a.confidence ?? 0));
    report.below_threshold = Math.max(0, report.below_threshold - observations.filter((o) => !shownKeys.has(findingKey(o))).length);
    report.observations = observations.slice(0, 12);
    report.observations_omitted = Math.max(0, observations.length - 12);
    // A shown member owns its whole duplicate chain, in either direction.
    const neighbours = new Map<string, Set<string>>();
    for (const item of built.items) {
      const target = item.v.duplicate_of ? byId.get(item.v.duplicate_of) : undefined;
      if (!target) continue;
      const key = keyOf(item);
      const targetKey = keyOf(target);
      if (!neighbours.has(key)) neighbours.set(key, new Set());
      if (!neighbours.has(targetKey)) neighbours.set(targetKey, new Set());
      neighbours.get(key)!.add(targetKey);
      neighbours.get(targetKey)!.add(key);
    }
    const owned = new Set([...report.findings, ...observations].map(findingKey));
    const ownComponent = (keys: Set<string>, start: string[]) => {
      const pending = [...start];
      for (const key of start) keys.add(key);
      for (let i = 0; i < pending.length; i++) for (const key of neighbours.get(pending[i]!) ?? []) {
        if (keys.has(key)) continue;
        keys.add(key);
        pending.push(key);
      }
    };
    ownComponent(owned, [...owned]);
    const lowConfidenceOf = (f: FindingV2) => {
      if (f.source && config.disabledRules.some((glob) => matchesGlob(f.source!, glob))) return null;
      const lens = f.source?.startsWith("lens:") ? args.manifest.lenses.find((l) => l.name === f.source!.slice("lens:".length)) : undefined;
      const floor = Math.max(args.confidenceFloor ?? GLOBAL_CONFIDENCE_FLOOR, lens?.confidenceFloor ?? 0);
      if (f.confidence >= floor) return null;
      return { title: redactByFingerprint(f.title, scan.secretFingerprints), file_path: redactByFingerprint(f.file_path, scan.secretFingerprints), confidence: f.confidence, floor };
    };
    const matchesLow = (low: Report["low_confidence"][number], entry: Report["low_confidence"][number]) => low.title === entry.title && low.file_path === entry.file_path && low.confidence === entry.confidence && low.floor === entry.floor;
    const removeLow = (entry: Report["low_confidence"][number]) => {
      const index = report.low_confidence.findIndex((low) => matchesLow(low, entry));
      if (index !== -1) report.low_confidence.splice(index, 1);
    };
    const shownPossibleKeys = new Set(report.possible.map(findingKey));
    // Account for under-floor observations even below the severity threshold.
    // Do not use the visible check to restore possible defects.
    const lowObservationKeys = new Set<string>();
    for (const item of built.items) {
      const key = keyOf(item);
      if (item.v.tier !== "observation" || !observationKeys.has(key) || lowObservationKeys.has(key)) continue;
      const entry = lowConfidenceOf(item.finding);
      if (!entry) continue;
      lowObservationKeys.add(key);
      if (duplicateKeys.has(key) || owned.has(key)) {
        if (!shownPossibleKeys.has(key)) removeLow(entry);
        continue;
      }
      // wording: session
      const reason = "observation under the floor";
      const existing = report.low_confidence.find((low) => matchesLow(low, entry));
      if (existing) existing.reason = reason;
      else report.low_confidence.push({ ...entry, reason });
    }
    const possibleOwned = new Set(owned);
    report.possible = report.possible
      .filter((f) => !observationKeys.has(findingKey(f)))
      .sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || (b.confidence ?? 0) - (a.confidence ?? 0))
      .filter((f) => {
        const key = findingKey(f);
        if (possibleOwned.has(key)) return false;
        ownComponent(possibleOwned, [key]);
        return true;
      });
    for (const item of built.items) {
      const key = keyOf(item);
      if (item.v.tier !== "finding" || shownPossibleKeys.has(key) || !possibleOwned.has(key) && !duplicateKeys.has(key)) continue;
      const entry = lowConfidenceOf(item.finding);
      if (entry) removeLow(entry);
    }
    report.not_reviewed = requiredCandidates(scan, config).filter((c) => unverified.has(c.id));
    for (const c of allCandidates) {
      const verdict = verified.flatMap((o) => o.answer.verdicts).find((v) => v.id === c.id);
      if (c.kind !== "finder" || !unverified.has(c.id) && verdict?.verdict !== "unresolved") continue;
      const entry = { title: c.candidate.title, file_path: c.candidate.file_path, confidence: c.candidate.confidence, floor: Math.max(args.confidenceFloor ?? 0.7, FINDER_CONFIDENCE_FLOOR, args.manifest.lenses.find((l) => l.name === c.candidate.lens)?.confidenceFloor ?? 0), reason: unverified.has(c.id) ? "not verified" : "unresolved by the verifier" };
      report.low_confidence.push(entry);
    }
    for (const run of runs) for (const dropped of run.dropped ?? []) {
      const entry = { title: dropped.title, file_path: dropped.file_path, confidence: dropped.confidence, floor: args.confidenceFloor ?? 0.7, reason: dropped.reason };
      report.low_confidence.push(entry);
    }
    if (notes.length) report.notes = [...(report.notes ?? []), ...notes];
    runs.sort((a, b) => a.order - b.order);
    rounds.sort((a, b) => runs.findIndex((r) => r.role === a.by) - runs.findIndex((r) => r.role === b.by) || a.round - b.round);
    const blocking = config.blockOnSeverity;
    report.verdict = missing.length > 0 ? "incomplete" : blocking && report.findings.some((f) => severityRank(f.severity) >= severityRank(blocking)) ? "blocked" : "passed";
    const calls = runs.flatMap((r) => [...(r.session.calls?.() ?? r.session.attempts ?? [])]);
    if (timedOut) missing.unshift(args.timedOut ?? TIMED_OUT);
    const trace = runs.flatMap((r) => r.talk.trace.map((t) => ({ ...t, session: r.role })));
    const sessions = runs.map(recordOf);
    const submission = { ...built.submission, findings: built.submission.findings.filter((_, i) => {
      const item = built.items[i]!;
      if (item.c.kind === "scanner") return true;
      const key = findingKey({ ...item.finding, line_end: item.finding.line_end ?? item.finding.line_number, candidate: null });
      return item.v.tier === "finding" && !duplicateKeys.has(key);
    }) };
    return { report, submission, sessions, trace, usage: { calls, totals: usageTotals(calls) }, rounds, missing: [...new Set(missing)], required: requiredCandidates(scan, config).length, disposed: requiredCandidates(scan, config).filter((c) => !unverified.has(c.id)).length, briefFiles, delivered: runs.flatMap((r) => r.session.sentRounds === undefined ? r.talk.delivered : r.talk.carried.slice(0, Math.max(0, r.session.sentRounds - 1)).flat()) };
  } finally {
    clearInterval(heartbeat);
    await Promise.all(runs.map(close));
  }
}
