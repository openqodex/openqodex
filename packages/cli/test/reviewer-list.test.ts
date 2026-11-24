// The project's reviewer list (review.reviewers in .openqodex/config.yaml):
// which entries are passed over before anything starts, what happens when
// the serving entry cannot serve partway, the --reviewer override, the
// retired reviewer keys of the user config, and the list init writes. The
// reviewer model is the one stand-in, a driver object that answers with a
// recorded submission or fails the way the real agents fail.
//
// Ways it could fail, written before the code:
//  1. An entry whose agent is not installed or not logged in stops the run
//     instead of being passed over with its reason.
//  2. A Codex entry whose model the login's own list does not hold is
//     started anyway, or one whose list cannot be read is passed over,
//     though the model may well be there.
//  3. A reviewer that hits a usage limit or names its model unknown partway
//     ends the run as incomplete, or the next entry continues the first
//     one's conversation instead of a fresh review.
//  4. In a staged run, a finder that finished before another hit its limit
//     keeps its answer, so the report mixes two models; or the other
//     sessions keep running after the limit.
//  5. A timeout or a crash moves on to the next entry, though the next
//     entry would fail the same way and cost a second full review.
//  6. A list whose every entry fails ends as anything but Full review
//     unavailable naming every entry and why.
//  7. A reviewer the list does not name is started, when every listed one
//     failed or was passed over.
//  8. --reviewer <tool>:<model> falls back to the project's list when it
//     fails.
//  9. The report does not name the entry that served and every entry passed
//     over or failed before it, with why.
// 10. The retired reviewer keys of the user config are still read, give no
//     warning naming the lines to move, or pause automatic updates as
//     unknown keys; a personal reviewer_web: off is dropped on upgrade, or
//     honoured without saying so. The lines name a file the project does
//     not read, add a second review block, repeat a key the file has, turn
//     `reviewer: auto` into a Codex-only list, or leave a model unquoted.
// 11. init writes a reviewer the developer cannot start (the other agent,
//     not installed), puts the running agent second, or fails when Codex's
//     model list cannot be read.
// 13. doctor or init says an entry can start here as if its model were
//     confirmed, when no list of models could say so (Claude Code has none).
// 12. The list init inserts loses the file's comments, replaces a list the
//     team set (even an empty one), changes a min_version already there,
//     writes a second review block beside a hosted pr_review one, or writes
//     a min_version the running build itself refuses.
import { stagedFake } from "../../review/test/staged-fake.js";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { parse as parseYaml } from "yaml";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Report } from "@openqodex/core";
import { REVIEWERS_SINCE, parseConfig, reviewerLine } from "@openqodex/core";
import { parseFlags } from "../src/flags.js";
import { runReview } from "../src/review-run.js";
import { defaultReviewerList, insertReviewerList, listReadiness } from "../src/reviewers/list.js";
import { projectFile, retiredReviewerWarning, userConfigNotes } from "../src/reviewers/settings.js";
import { readUserConfig, unknownKeys } from "../src/user-config.js";
import { updatesAllowed } from "../src/update/state.js";
import { DEPTH_ENV, reviewerError } from "@openqodex/review";
import type { ReviewerDriver, ReviewerSession, Turn } from "@openqodex/review";
import { removeTempDirs, tempDir } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

(globalThis as Record<string, unknown>).__OPENQODEX_VERSION__ = "0.0.0-test";

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync("git", ["-c", "user.name=T", "-c", "user.email=t@openqodex.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

// A repo whose base commit holds `config` as .openqodex/config.yaml, with an
// uncommitted edit to a tracked text file (so no global ignore can hide it):
// no scanner candidate.
function repo(config: string): string {
  const dir = tempDir("oq-list-");
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "hello\n");
  writeFileSync(join(dir, "notes.txt"), "first line\n");
  mkdirSync(join(dir, ".openqodex"));
  writeFileSync(join(dir, ".openqodex", "config.yaml"), config);
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "Base");
  writeFileSync(join(dir, "notes.txt"), "first line\none line\n");
  return dir;
}

// The failures, as the real agents' words come through reviewerError.
const LIMIT = reviewerError("You've hit your usage limit. Upgrade to Pro or try again later.");
const NO_MODEL = reviewerError("There's an issue with the selected model (bogus-model-xyz). It may not exist or you may not have access to it. model_not_found not_found_error");

type Start = { model?: string | null; effort?: string | null; web: boolean; sent: number; closed: boolean };
type Fake = ReviewerDriver & { starts: Start[] };
// `fail` answers a start's failure from its model and its order among this
// driver's starts, or null for the recorded answer. `wait` holds a start's
// first answer until it resolves. `catalog` is the login's model list.
type Behaviour = {
  available?: boolean;
  fail?: (model: string | null | undefined, index: number) => string | null;
  wait?: (index: number) => Promise<void> | null;
  catalog?: { models: string[]; top: string | null } | null;
  answered?: () => void;
  // Calls a start's first turn adds; it may also change the snapshot.
  extra?: (index: number, snapshotDir: string) => Turn["calls"];
};

function fake(name: string, b: Behaviour = {}): Fake {
  const driver: Fake = {
    name,
    traced: name === "claude",
    starts: [],
    async detect() {
      return b.available === false ? { ok: false as const, missing: `${name} is not logged in`, fix: `run ${name} login` } : { ok: true as const, version: "9.9.9", bin: `/fake/${name}` };
    },
    ...("catalog" in b ? { async models() { return b.catalog ?? null; } } : {}),
    start(opts): ReviewerSession {
      const index = driver.starts.length;
      const start: Start = { ...("model" in opts ? { model: opts.model } : {}), ...("effort" in opts ? { effort: opts.effort } : {}), web: opts.web, sent: 0, closed: false };
      driver.starts.push(start);
      return stagedFake({
        pid: 4242 + index,
        async send(text: string): Promise<Turn> {
          start.sent++;
          await b.wait?.(index);
          const usage = { turns: 1, input_tokens: 1, output_tokens: 1, cost_usd: null };
          const extra = start.sent === 1 ? (b.extra?.(index, opts.snapshotDir) ?? []) : [];
          const failure = b.fail?.(opts.model, index) ?? null;
          if (failure !== null) return { finalText: "", calls: extra, usage, sessionId: "fake", failure };
          const id = /`change_id`: `([0-9a-f]{12})`/.exec(text)?.[1] ?? "missing";
          const finalText = JSON.stringify({ version: 2, change_id: id, summary: `Reviewed by ${opts.model ?? name}.`, findings: [], dropped: [] });
          const read = { tool: "Read", input: { file_path: "notes.txt" }, ok: true, read: { path: "notes.txt", start: 1, lines: 1 } };
          b.answered?.();
          return { finalText, calls: [read], usage, sessionId: "fake", failure: null };
        },
        async close() {
          start.closed = true;
        },
      }, opts.snapshotDir);
    },
  };
  return driver;
}

let out: string;
let err: string;
let home: string;
beforeEach(() => {
  out = "";
  err = "";
  home = tempDir("oq-list-home-");
  vi.stubEnv("OPENQODEX_HOME", home);
  vi.stubEnv(DEPTH_ENV, "");
  // The agent running the tests must not decide `auto` or init's order.
  vi.stubEnv("CLAUDECODE", "");
  vi.stubEnv("CODEX_THREAD_ID", "");
  vi.stubEnv("CODEX_SANDBOX", "");
  vi.stubEnv("CURSOR_AGENT", "");
  vi.spyOn(process.stdout, "write").mockImplementation((s) => ((out += String(s)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((s) => ((err += String(s)), true));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const listing = (entries: string[], extra = "") => `version: 1\nreview:\n${extra}  reviewers:\n${entries.map((e) => `    - ${e}\n`).join("")}`;
const SINGLE = "  stages: false\n";

// The repository of the last review(), for its run folder.
let lastRepo = "";
const runFile = (name: string): string | null => {
  const reviews = join(lastRepo, ".openqodex", "reviews");
  for (const d of readdirSync(reviews)) if (existsSync(join(reviews, d, name))) return readFileSync(join(reviews, d, name), "utf8");
  return null;
};

function review(drivers: ReviewerDriver[], config: string, more: { reviewer?: string; reviewerEffort?: string; web?: boolean } = {}): Promise<number> {
  lastRepo = repo(config);
  const { global } = parseFlags(["--cwd", lastRepo, "--no-color", "--format", "json"], {});
  return runReview({ flags: global, scope: {}, noGraph: true, only: "sqllint", timeoutMs: 60_000, drivers, ...more });
}

const reviewerOf = () => (JSON.parse(out) as Report).completion?.reviewer;

describe("entries passed over before anything starts", () => {
  it("1, 9. an entry that is not logged in is passed over with its reason, and the report names it", async () => {
    const codex = fake("codex", { available: false });
    const claude = fake("claude");
    expect(await review([claude, codex], listing(["tool: codex\n      model: gpt-x", "tool: claude\n      model: haiku\n      effort: low"]))).toBe(0);
    expect(codex.starts).toHaveLength(0);
    expect(claude.starts.length).toBeGreaterThan(0);
    for (const s of claude.starts) expect(s).toMatchObject({ model: "haiku", effort: "low" });
    const record = reviewerOf();
    expect(record).toMatchObject({ driver: "claude", model: "haiku", effort: "low" });
    expect(record?.passed).toEqual([{ tool: "codex", model: "gpt-x", outcome: "skipped", reason: "codex is not logged in; run codex login" }]);
    expect(reviewerLine(record ?? null)).toMatch(/tried first: codex, model gpt-x skipped: codex is not logged in; run codex login/);
  });

  it("2. a Codex model the login's list does not hold is passed over; a list that cannot be read is tried", async () => {
    const missing = fake("codex", { catalog: { models: ["gpt-a", "gpt-b"], top: "gpt-a" } });
    const claude = fake("claude");
    expect(await review([claude, missing], listing(["tool: codex\n      model: gpt-gone", "tool: claude"]))).toBe(0);
    expect(missing.starts).toHaveLength(0);
    expect(reviewerOf()?.passed?.[0]?.reason).toBe("this codex login has no model gpt-gone (its models: gpt-a, gpt-b)");

    out = "";
    const unread = fake("codex", { catalog: null });
    const other = fake("claude");
    expect(await review([other, unread], listing(["tool: codex\n      model: gpt-gone", "tool: claude"]))).toBe(0);
    expect(unread.starts.length).toBeGreaterThan(0);
    expect(other.starts).toHaveLength(0);
    expect(reviewerOf()).toMatchObject({ driver: "codex", model: "gpt-gone" });
  });
});

describe("an entry that cannot serve partway", () => {
  it("3, 9. a model that does not exist hands the whole review to the next entry, in a fresh conversation", async () => {
    const claude = fake("claude", { fail: (model) => (model === "bogus-model-xyz" ? NO_MODEL : null) });
    expect(await review([claude], listing(["tool: claude\n      model: bogus-model-xyz", "tool: claude\n      model: haiku\n      effort: low"], SINGLE))).toBe(0);
    expect(claude.starts.map((s) => s.model)).toEqual(["bogus-model-xyz", "haiku"]);
    // The second session is new: its first message is the brief again.
    expect(claude.starts.every((s) => s.closed)).toBe(true);
    const record = reviewerOf();
    expect(record).toMatchObject({ driver: "claude", model: "haiku", effort: "low" });
    expect(record?.passed).toHaveLength(1);
    expect(record?.passed?.[0]).toMatchObject({ tool: "claude", model: "bogus-model-xyz", outcome: "failed" });
    expect(record?.passed?.[0]?.reason).toMatch(/^the reviewer's model cannot serve this review: it does not exist or this login has no access to it \(There's an issue with the selected model \(bogus-model-xyz\)/);
    expect((JSON.parse(out) as Report).completion?.status).toBe("complete");
    expect(err).toMatch(/openqodex: claude, model bogus-model-xyz failed: the reviewer's model cannot serve this review: .*; the review starts again with claude, model haiku, effort low/);
  });

  it("3. a usage limit hands the review from Codex to the next entry, Claude Code", async () => {
    const codex = fake("codex", { fail: () => LIMIT });
    const claude = fake("claude");
    expect(await review([claude, codex], listing(["tool: codex", "tool: claude\n      model: opus"], SINGLE))).toBe(0);
    expect(codex.starts).toHaveLength(1);
    expect(reviewerOf()).toMatchObject({ driver: "claude", model: "opus" });
    expect(reviewerOf()?.passed?.[0]).toMatchObject({ tool: "codex", outcome: "failed" });
    expect(reviewerOf()?.passed?.[0]?.reason).toMatch(/^the reviewer hit its usage or plan limit/);
  });

  it("4. in a staged run, a finder that finished first is discarded with the rest when another hits its limit", async () => {
    let firstDone: () => void = () => {};
    const done = new Promise<void>((resolve) => (firstDone = resolve));
    const codex = fake("codex", {
      answered: () => firstDone(),
      // The second finder waits until the first has answered, then fails.
      wait: (index) => (index === 1 ? done : null),
      fail: (_model, index) => (index === 1 ? LIMIT : null),
    });
    const claude = fake("claude");
    expect(await review([claude, codex], listing(["tool: codex\n      model: gpt-first", "tool: claude\n      model: haiku"]))).toBe(0);
    // The first finder answered; then the limit stopped Codex for good.
    expect(codex.starts[0]?.sent).toBeGreaterThan(0);
    expect(codex.starts.length).toBeLessThanOrEqual(2);
    expect(codex.starts.every((s) => s.closed)).toBe(true);
    // Claude Code ran the whole review again: every finder and verifier.
    expect(claude.starts.length).toBeGreaterThanOrEqual(2);
    for (const s of claude.starts) expect(s.model).toBe("haiku");
    const report = JSON.parse(out) as Report;
    expect(report.completion?.status).toBe("complete");
    expect(report.completion?.reviewer).toMatchObject({ driver: "claude", model: "haiku" });
    expect(JSON.stringify(report)).not.toContain("Reviewed by gpt-first");
  });

  it("5. a reviewer that stops with any other error ends the run without trying the next entry", async () => {
    const claude = fake("claude", { fail: () => reviewerError("Segmentation fault") });
    const codex = fake("codex");
    expect(await review([claude, codex], listing(["tool: claude", "tool: codex"], SINGLE))).toBe(2);
    expect(codex.starts).toHaveLength(0);
    expect(err).not.toContain("the review starts again");
  });

  it("6, 7. when every entry fails or is passed over, the run is Full review unavailable naming each, and no unlisted reviewer starts", async () => {
    const codex = fake("codex", { fail: () => LIMIT });
    const cursor = fake("cursor");
    const claude = fake("claude", { available: false });
    expect(await review([claude, codex, cursor], listing(["tool: codex\n      model: gpt-a", "tool: codex\n      model: gpt-b", "tool: claude"], SINGLE))).toBe(2);
    expect(codex.starts.map((s) => s.model)).toEqual(["gpt-a", "gpt-b"]);
    expect(cursor.starts).toHaveLength(0);
    expect(claude.starts).toHaveLength(0);
    expect(err).toContain("Full review unavailable");
    expect(err).toMatch(/codex, model gpt-a failed: the reviewer hit its usage or plan limit/);
    expect(err).toMatch(/codex, model gpt-b failed: the reviewer hit its usage or plan limit/);
    expect(err).toMatch(/- claude skipped: claude is not logged in; run claude login/);
    // Reviewers did start: the record says so, and the calls they made are kept.
    expect(err).toContain("every reviewer of the project's list failed or was passed over");
    expect(JSON.parse(runFile("reviewer.json")!)).toMatchObject({ started: true });
    expect((JSON.parse(runFile("usage.json")!) as { calls: unknown[] }).calls.length).toBeGreaterThanOrEqual(2);
  });

  it("6. a boundary crossed by an entry that then hit its limit ends the review; no later entry starts", async () => {
    const outside = { tool: "Read", input: { file_path: "/etc/hosts" }, ok: true, read: { path: "/etc/hosts", start: 1, lines: 1 } };
    const claude = fake("claude", { fail: (_m, index) => (index === 0 ? LIMIT : null), extra: (index) => (index === 0 ? [outside] : []) });
    const codex = fake("codex");
    expect(await review([claude, codex], listing(["tool: claude\n      model: opus", "tool: codex"], SINGLE))).toBe(2);
    expect(codex.starts).toHaveLength(0);
    expect(err).not.toContain("the review starts again");
    expect((JSON.parse(out) as Report).completion?.missing.join("\n")).toMatch(/the reviewer read outside the snapshot: \/etc\/hosts/);
  });

  it("6. a snapshot an entry changed before it hit its limit ends the review, checked against the first baseline", async () => {
    const claude = fake("claude", { fail: (_m, index) => (index === 0 ? LIMIT : null), extra: (index, snapshotDir) => (index === 0 && writeFileSync(join(snapshotDir, "notes.txt"), "changed\n"), []) });
    const codex = fake("codex");
    expect(await review([claude, codex], listing(["tool: claude\n      model: opus", "tool: codex"], SINGLE))).toBe(2);
    expect(codex.starts).toHaveLength(0);
    expect((JSON.parse(out) as Report).completion?.missing).toContain("the snapshot changed while the reviewer read it");
  });

  it("8. --reviewer <tool>:<model> replaces the list and has no fallback", async () => {
    const claude = fake("claude", { fail: () => NO_MODEL });
    const codex = fake("codex");
    expect(await review([claude, codex], listing(["tool: codex"], SINGLE), { reviewer: "claude:bogus-model-xyz", reviewerEffort: "low" })).toBe(2);
    expect(claude.starts).toEqual([expect.objectContaining({ model: "bogus-model-xyz", effort: "low" })]);
    expect(codex.starts).toHaveLength(0);
    expect(err).toContain("Full review unavailable");
  });
});

describe("the retired reviewer keys of the user config", () => {
  it("10. are not read, warn once with the project lines, keep a personal web opt-out, and do not pause automatic updates", async () => {
    writeFileSync(join(home, "config.yaml"), "update: on\nreviewer: codex\nreviewer_web: off\nreviewer_model: gpt-old\nreviewer_effort: high\n");
    const claude = fake("claude");
    const codex = fake("codex");
    expect(await review([claude, codex], "version: 1\n", { reviewer: "claude" })).toBe(0);
    for (const s of claude.starts) expect(s).not.toHaveProperty("model");
    expect(codex.starts).toHaveLength(0);
    expect(err).toContain(`${readUserConfig(home).path} sets reviewer: codex, reviewer_web: off, reviewer_model: gpt-old, reviewer_effort: high. openqodex no longer reads them there: each project chooses its reviewer in its own config file, which the whole team shares.`);
    expect(err).toContain("add these lines to the project's .openqodex/config.yaml:\n  review:\n    reviewers:\n      - tool: codex\n        model: \"gpt-old\"\n        effort: high\n    reviewer_web: off\n");
    // The opt-out made before the move holds until the project's file says so.
    expect(claude.starts.length).toBeGreaterThan(0);
    for (const s of claude.starts) expect(s.web).toBe(false);
    expect(err).toContain("Your reviewer_web: off still keeps the reviewer's web tools off for now");
    expect(err.match(/no longer reads them there/g)).toHaveLength(1);
    const config = readUserConfig(home);
    expect(unknownKeys(config)).toBeNull();
    expect(updatesAllowed(home, { ...process.env, CI: "", OPENQODEX_OFFLINE: "", OPENQODEX_AUTO_UPDATE: "" })).toEqual({ allowed: true, why: "on" });
  });

  it("10. a broken user config warns and the review still runs", async () => {
    writeFileSync(join(home, "config.yaml"), "reviewer: [unclosed\n");
    expect(userConfigNotes(home)[0]).toMatch(/automatic updates are off until it is fixed$/);
    expect(await review([fake("claude")], "version: 1\n", { reviewer: "claude" })).toBe(0);
  });

  it("10. the lines go into the file the project reads and its existing block, never repeat a key, and keep auto as auto", async () => {
    const user = (text: string): ReturnType<typeof readUserConfig> => ({ path: "/home/config.yaml", raw: text, error: null, values: parseYaml(text) as Record<string, unknown>, unknown: [] });
    // The root file of before 0.2.0, with a hosted pr_review block.
    const legacy = tempDir("oq-list-legacy-");
    git(legacy, "init", "-q");
    writeFileSync(join(legacy, ".openqodex.yaml"), "pr_review:\n  severity_threshold: major\n");
    const w = retiredReviewerWarning(user("reviewer: claude\nreviewer_web: off\n"), projectFile(legacy))!;
    expect(w).toContain("add these lines inside the pr_review: block of the project's .openqodex.yaml:\n    reviewers:\n      - tool: claude\n    reviewer_web: off\n");
    expect(w).not.toMatch(/^ *review:$/m);
    expect(w).toContain("move it into the project's .openqodex.yaml");
    // A key the file already has is not repeated.
    const listed = repo("review:\n  reviewers:\n    - tool: codex\n");
    const w2 = retiredReviewerWarning(user("reviewer: claude\nreviewer_web: off\n"), projectFile(listed))!;
    expect(w2).toContain("inside the review: block of the project's .openqodex/config.yaml:\n    reviewer_web: off");
    expect(w2).not.toContain("- tool: claude");
    expect(retiredReviewerWarning(user("reviewer: claude\n"), projectFile(listed))).toContain("The project's .openqodex/config.yaml already sets its own, and a review uses that.");
    // auto with Codex tuning: no list, auto order kept.
    const w3 = retiredReviewerWarning(user("reviewer: auto\nreviewer_model: \"123\"\nreviewer_effort: high\n"), projectFile(null))!;
    expect(w3).not.toContain("tool: codex");
    expect(w3).not.toContain("add these lines");
    expect(w3).toContain("reviewer: auto needs no line: a project with no review.reviewers keeps the auto order");
    // A model a YAML reader would take for a number stays a string.
    const w4 = retiredReviewerWarning(user("reviewer: codex\nreviewer_model: \"123\"\n"), projectFile(null))!;
    expect(w4).toContain('model: "123"');
    const pasted = w4.split("\n").filter((l) => l.startsWith("  ")).map((l) => l.slice(2)).join("\n");
    expect(parseConfig(`${pasted}\n`).config.reviewers).toEqual([{ tool: "codex", model: "123" }]);
    // --reviewer-web on still wins over the personal opt-out.
    writeFileSync(join(home, "config.yaml"), "reviewer_web: off\n");
    const claude = fake("claude");
    expect(await review([claude], "version: 1\n", { reviewer: "claude", web: true })).toBe(0);
    for (const s of claude.starts) expect(s.web).toBe(true);
  });
});

describe("what doctor says of each entry", () => {
  it("13. a model no list could confirm is named as checked only when a review starts", async () => {
    const root = tempDir("oq-list-ready-");
    const rows = await listReadiness(
      [{ tool: "claude", model: "opus" }, { tool: "claude" }, { tool: "codex", model: "gpt-a" }, { tool: "codex", model: "gpt-b" }],
      [fake("claude"), fake("codex", { catalog: { models: ["gpt-a"], top: "gpt-a" } })],
      root,
    );
    expect(rows.map((r) => r.line)).toEqual([
      "can start here (claude 9.9.9); whether model opus serves this login shows only when a review starts",
      "can start here (claude 9.9.9)",
      "can start here (codex 9.9.9)",
      "cannot start here: this codex login has no model gpt-b (its models: gpt-a)",
    ]);
  });

  it("13. a long list checks each tool once and reads its list of models once", async () => {
    const counts = { detect: 0, models: 0 };
    const codex = fake("codex", { catalog: { models: ["gpt-a"], top: "gpt-a" } });
    const counted: ReviewerDriver = { ...codex, detect: (root) => (counts.detect++, codex.detect(root)), models: (bin) => (counts.models++, codex.models!(bin)) };
    const rows = await listReadiness(Array.from({ length: 40 }, (_, i) => ({ tool: "codex", model: i % 2 === 0 ? "gpt-a" : "gpt-b" })), [counted], tempDir("oq-list-ready-"));
    expect(rows).toHaveLength(40);
    expect(counts).toEqual({ detect: 1, models: 1 });
  });
});

describe("the list init writes", () => {
  it("11. the running agent first, the other only when it can start, Claude at opus and high, Codex at its top model", async () => {
    const root = tempDir("oq-list-init-");
    const claude = fake("claude");
    const codex = fake("codex", { catalog: { models: ["gpt-top", "gpt-old"], top: "gpt-top" } });
    expect(await defaultReviewerList([claude, codex], root)).toEqual({ entries: [{ tool: "claude", model: "opus", effort: "high" }, { tool: "codex", model: "gpt-top", effort: "high" }], ready: [true, true] });
    vi.stubEnv("CODEX_THREAD_ID", "t1");
    expect((await defaultReviewerList([claude, codex], root)).entries.map((e) => e.tool)).toEqual(["codex", "claude"]);
    vi.stubEnv("CODEX_THREAD_ID", "");
    // Codex not installed and not running init: left out.
    expect(await defaultReviewerList([claude, fake("codex", { available: false })], root)).toEqual({ entries: [{ tool: "claude", model: "opus", effort: "high" }], ready: [true] });
    // A model list that cannot be read: the entry has no model.
    expect((await defaultReviewerList([fake("claude", { available: false }), fake("codex", { catalog: null })], root)).entries).toEqual([{ tool: "codex", effort: "high" }]);
    // Claude Code running init, though its login cannot start here: it stays first, marked.
    vi.stubEnv("CLAUDECODE", "1");
    expect(await defaultReviewerList([fake("claude", { available: false }), fake("codex", { available: false })], root)).toEqual({ entries: [{ tool: "claude", model: "opus", effort: "high" }], ready: [false] });
  });

  it("12. inserts the list and min_version, keeping every comment and key", () => {
    const before = "# Team settings\nversion: 1\nreview:\n  # keep minor findings\n  severity_threshold: minor\nscanners:\n  disable: [semgrep] # too slow here\n";
    const next = insertReviewerList(before, [{ tool: "claude", model: "opus", effort: "high" }, { tool: "codex", effort: "high" }], "99.0.0");
    expect(next?.oldMin).toBeNull();
    const text = next!.text;
    for (const kept of ["# Team settings", "# keep minor findings", "severity_threshold: minor", "# too slow here"]) expect(text).toContain(kept);
    expect(text).toMatch(/^# Team settings\nversion: 1\nmin_version: \d+\.\d+\.\d+\n/);
    const parsed = parseConfig(text);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.config.reviewers).toEqual([{ tool: "claude", model: "opus", effort: "high" }, { tool: "codex", effort: "high" }]);
    expect(parsed.config.severityThreshold).toBe("minor");
  });

  it("12. leaves a list the team set, even an empty one, and an existing min_version; uses a hosted pr_review block", () => {
    expect(insertReviewerList("review:\n  reviewers: []\n", [{ tool: "claude" }])).toBeNull();
    expect(insertReviewerList("review:\n  reviewers:\n    - tool: codex\n", [{ tool: "claude" }])).toBeNull();
    expect(insertReviewerList("review: [unclosed\n", [{ tool: "claude" }])).toBeNull();
    const old = insertReviewerList("version: 1\nmin_version: 0.20.0\n", [{ tool: "claude" }], "99.0.0");
    expect(old?.oldMin).toBe("0.20.0");
    expect(old?.text).toMatch(/min_version: 0\.20\.0\n/);
    // A higher min_version is never lowered; an empty one is set in place, once.
    expect(insertReviewerList("version: 1\nmin_version: 98.0.0\n", [{ tool: "claude" }], "99.0.0")?.text).toMatch(/min_version: 98\.0\.0\n/);
    const blank = insertReviewerList("version: 1\nmin_version:\n", [{ tool: "claude" }], "99.0.0")!.text;
    expect(blank.match(/min_version/g)).toHaveLength(1);
    expect(blank).toContain(`min_version: ${REVIEWERS_SINCE}\n`);
    const hosted = insertReviewerList("pr_review:\n  severity_threshold: major\n", [{ tool: "claude" }])!.text;
    expect(hosted).not.toMatch(/^review:/m);
    expect(parseConfig(hosted).config.reviewers).toEqual([{ tool: "claude" }]);
    expect(parseConfig(insertReviewerList("# only a comment\n", [{ tool: "codex" }])!.text).config.reviewers).toEqual([{ tool: "codex" }]);
    // A build made before the release that reads lists writes no min_version
    // it would itself refuse.
    const unreleased = insertReviewerList("version: 1\n", [{ tool: "claude" }], "0.0.1")!.text;
    expect(unreleased).not.toContain("min_version");
    expect(parseConfig(unreleased, undefined, { runtimeVersion: "0.0.1" }).config.reviewers).toEqual([{ tool: "claude" }]);
  });
});
