// Ways finalize could fail, written before the code:
// 1. A submission that breaks the schema (wrong version, a bad severity, a
//    missing title, confidence above 1, line_end before line_number) still
//    produces a report instead of throwing with the field's path.
// 2. A submission for an older change, or a manifest from another run, is
//    accepted.
// 3. A source that is not a token in this scan or a selected lens is kept or
//    silently set to null instead of rejected.
// 4. A candidate id that is not in the scan, or whose token differs from the
//    finding's source, is accepted.
// 5. A dropped entry naming an unknown candidate, or a candidate both raised
//    and dropped, is accepted.
// 6. A finding under 0.7, or under its lens's floor, reaches the findings.
// 7. A finding on a file outside the change, or on lines the change did not
//    add or modify, counts toward the verdict.
// 8. A disabled rule still shows, as a finding or as a not-reviewed candidate.
// 9. Two findings on the same file, line and category both show, or the
//    lower severity wins.
// 10. A secret the agent quotes reaches the report.
// 11. A candidate neither raised nor dropped is lost instead of listed as
//     not reviewed, or a dropped one is listed as not reviewed.
// 12. The verdict blocks without block_on_severity, misses a not-reviewed
//     candidate at the threshold, or blocks on something below it.
// 13. scanReport maps categories or severities wrongly, or ignores the
//     threshold.
// 14. review.severity_threshold hides a finding at or above
//     block_on_severity, so a blocked verdict names nothing; hides a
//     not-reviewed candidate; or loses count of what it hid.
// 15. An added suppression comment or a changed scanner settings file falls
//     under review.severity_threshold and leaves the report: in a scan, where
//     it counts as minor, or raised by the reviewer at a low severity in
//     either submission version.
import { describe, expect, it } from "vitest";
import { checkSubmission, finalizeReview, proseErrors, scanReport, sentences, SETTINGS_RULE, SUPPRESSION_RULE } from "./finalize.js";
import {
  KEY_CANDIDATE,
  LINT_CANDIDATE,
  SECRET,
  SQL_CANDIDATE,
  finding,
  makeChange,
  makeConfig,
  makeManifest,
  makeScan,
  makeSubmission,
} from "./test-fixtures.js";
import { OpenQodexError } from "./types.js";
import type { Candidate, Config } from "./types.js";

function run(submission: unknown, over: { config?: Partial<Config> } = {}) {
  const change = makeChange();
  return finalizeReview({
    change,
    scan: makeScan(),
    manifest: makeManifest(change),
    config: makeConfig(over.config),
    submission,
  });
}

function expectThrow(submission: unknown, message: RegExp) {
  let caught: unknown;
  try {
    run(submission);
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(OpenQodexError);
  expect((caught as Error).message).toMatch(message);
}

describe("finalizeReview: schema", () => {
  it("rejects a wrong version", () => {
    expectThrow(makeSubmission({ version: 2 }), /invalid at version/);
  });

  it("rejects a missing title", () => {
    expectThrow(makeSubmission({ findings: [finding({ title: undefined })] }), /findings\[0\]\.title/);
  });

  it("rejects confidence above 1", () => {
    expectThrow(makeSubmission({ findings: [finding({ confidence: 1.5 })] }), /findings\[0\]\.confidence/);
  });

  it("rejects line_end before line_number", () => {
    expectThrow(makeSubmission({ findings: [finding({ line_number: 15, line_end: 14 })] }), /findings\[0\]\.line_end/);
  });

  it("rejects a dropped entry without a reason", () => {
    expectThrow(makeSubmission({ dropped: [{ candidate: "c2" }] }), /dropped\[0\]\.reason/);
  });
});

describe("finalizeReview: change binding", () => {
  it("rejects a manifest from another change", () => {
    const change = makeChange();
    expect(() =>
      finalizeReview({
        change,
        scan: makeScan(),
        manifest: makeManifest(change, { change_id: "bbbbbbbbbbbb" }),
        config: makeConfig(),
        submission: makeSubmission(),
      }),
    ).toThrow(/the change moved/);
  });
});

describe("finalizeReview: citations", () => {
  it("rejects a source that is not in this scan", () => {
    expectThrow(
      makeSubmission({ findings: [finding({ source: "semgrep:made.up.rule", candidate: null })] }),
      /finding 0 .* cites source "semgrep:made.up.rule"/,
    );
  });

  it("rejects a lens that was not selected", () => {
    expectThrow(
      makeSubmission({ findings: [finding({ source: "lens:eval-on-user-input", candidate: null })] }),
      /finding 0 .* cites source "lens:eval-on-user-input"/,
    );
  });

  it("rejects a candidate id that is not in this scan", () => {
    expectThrow(makeSubmission({ findings: [finding({ candidate: "c9" })] }), /finding 0 .* raises candidate "c9"/);
  });

  it("rejects a candidate whose token differs from the source", () => {
    expectThrow(
      makeSubmission({ findings: [finding({ candidate: "c2" })], dropped: [] }),
      /raises candidate c2, whose token is "gitleaks:generic-api-key"/,
    );
  });

  it("rejects a dropped entry naming an unknown candidate", () => {
    expectThrow(makeSubmission({ dropped: [{ candidate: "c7", reason: "x" }] }), /dropped\[0\] names candidate "c7"/);
  });

  it("rejects a candidate that is both raised and dropped", () => {
    expectThrow(
      makeSubmission({ dropped: [{ candidate: "c1", reason: "x" }] }),
      /candidate c1 is both raised by finding 0 and listed in dropped\[0\]/,
    );
  });
});

describe("finalizeReview: filters", () => {
  it("shows a finding under 0.7 as possible", () => {
    const report = run(makeSubmission({ findings: [finding({ confidence: 0.65 })] }));
    expect(report.findings).toEqual([]);
    expect(report.possible).toEqual([expect.objectContaining({ confidence: 0.65, description: expect.any(String) })]);
    expect(report.low_confidence).toEqual([]);
  });

  it("applies a lens floor above 0.7", () => {
    const report = run(
      makeSubmission({ findings: [finding({ source: "lens:sql-string-concatenation", candidate: null, confidence: 0.72 })] }),
    );
    expect(report.findings).toEqual([]);
    expect(report.possible[0]?.confidence).toBe(0.72);
  });

  it("moves a finding on a file outside the change to outside_change and does not count it", () => {
    const report = run(
      makeSubmission({ findings: [finding({ file_path: "app/other.py", source: null, candidate: null })] }),
      { config: { blockOnSeverity: "critical" } },
    );
    expect(report.findings).toEqual([]);
    expect(report.outside_change).toHaveLength(1);
    expect(report.outside_change[0]?.notes).toEqual(["the file is not in this change"]);
    expect(report.verdict).toBe("passed");
  });

  it("moves a finding on unchanged lines to outside_change", () => {
    const report = run(makeSubmission({ findings: [finding({ line_number: 20, line_end: 22, source: null, candidate: null })] }));
    expect(report.outside_change[0]?.notes).toEqual(["lines 20 to 22 are not a line this change added or modified"]);
  });

  it("keeps a finding whose range reaches a changed line", () => {
    const report = run(makeSubmission({ findings: [finding({ line_number: 10, line_end: 14 })] }));
    expect(report.findings).toHaveLength(1);
  });

  it("dedups a repeated finding keeping the highest severity, and keeps another category", () => {
    const report = run(
      makeSubmission({
        findings: [
          finding({ severity: "minor", source: null, candidate: null }),
          finding({ severity: "critical", source: null, candidate: null, description: "Worse" }),
          finding({ severity: "minor", source: null, candidate: null, category: "bug" }),
        ],
      }),
    );
    expect(report.findings.map((f) => [f.category, f.severity, f.title])).toEqual([
      ["security", "critical", "SQL built from request input"],
      ["bug", "minor", "SQL built from request input"],
    ]);
  });

  it("redacts a secret the agent quotes, by fingerprint", () => {
    const report = run(
      makeSubmission({
        summary: `Adds ${SECRET} to settings.`,
        findings: [
          finding({
            source: null,
            candidate: null,
            file_path: "app/settings.py",
            line_number: 3,
            line_end: 3,
            title: `Hard-coded key ${SECRET}`,
            description: `The key ${SECRET} is committed.`,
            suggested_change: `API_KEY = os.environ["API_KEY"]  # was ${SECRET}`,
          }),
        ],
        dropped: [{ candidate: "c2", reason: `the value ${SECRET} is a sample` }],
      }),
    );
    expect(JSON.stringify(report)).not.toContain(SECRET);
    expect(report.findings[0]?.description).toBe("The key [redacted] is committed.");
  });
});

describe("finalizeReview: disabled_rules", () => {
  it("drops findings and candidates whose source matches a disabled glob", () => {
    const report = run(makeSubmission({ dropped: [] }), { config: { disabledRules: ["semgrep:*", "gitleaks:generic-api-key"] } });
    expect(report.findings).toEqual([]);
    expect(report.not_reviewed.map((c) => c.id)).toEqual(["c3"]);
  });

  it("drops lens findings by a lens glob", () => {
    const report = run(
      makeSubmission({ findings: [finding({ source: "lens:sql-string-concatenation", candidate: null })] }),
      { config: { disabledRules: ["lens:sql-*"] } },
    );
    expect(report.findings).toEqual([]);
  });
});

describe("finalizeReview: candidates and verdict", () => {
  it("lists candidates neither raised nor dropped as not reviewed, and dropped ones with their reason", () => {
    const report = run(makeSubmission());
    expect(report.not_reviewed.map((c) => c.id)).toEqual(["c3"]);
    expect(report.dropped.map((d) => [d.candidate.id, d.reason])).toEqual([["c2", "a sample key in a local settings file"]]);
  });

  it("passes without block_on_severity whatever it finds", () => {
    const report = run(makeSubmission({ dropped: [] }));
    expect(report.not_reviewed.map((c) => c.id)).toEqual(["c2", "c3"]);
    expect(report.verdict).toBe("passed");
  });

  it("blocks on a not-reviewed candidate at the threshold", () => {
    const report = run(makeSubmission({ findings: [], dropped: [{ candidate: "c1", reason: "parameterised upstream" }] }), {
      config: { blockOnSeverity: "critical" },
    });
    expect(report.not_reviewed.map((c) => c.id)).toEqual(["c2", "c3"]);
    expect(report.verdict).toBe("blocked");
  });

  it("passes when everything counted is below the threshold", () => {
    const report = run(makeSubmission({ findings: [finding({ severity: "minor" })] }), {
      config: { blockOnSeverity: "major" },
    });
    expect(report.verdict).toBe("passed");
  });
});

describe("scanReport", () => {
  it("turns every candidate into a scanner finding with the mapped category", () => {
    const report = scanReport({ change: makeChange(), scan: makeScan(), config: makeConfig() });
    expect(report.kind).toBe("scan");
    expect(report.findings.map((f) => [f.source, f.severity, f.category, f.title, f.origin])).toEqual([
      [SQL_CANDIDATE.token, "major", "security", SQL_CANDIDATE.ruleId, "scanner"],
      [KEY_CANDIDATE.token, "critical", "security", "generic-api-key", "scanner"],
      [LINT_CANDIDATE.token, "nitpick", "maintainability", "F401", "scanner"],
    ]);
    expect(report.verdict).toBe("passed");
  });

  it("blocks at the threshold and passes below it", () => {
    const blocked = scanReport({ change: makeChange(), scan: makeScan(), config: makeConfig({ blockOnSeverity: "critical" }) });
    expect(blocked.verdict).toBe("blocked");
    const passed = scanReport({
      change: makeChange(),
      scan: makeScan({ candidates: [LINT_CANDIDATE] }),
      config: makeConfig({ blockOnSeverity: "minor" }),
    });
    expect(passed.verdict).toBe("passed");
  });
});

// Review round 1, each written to fail on the code before its fix:
// R1. An error message echoes a secret from the agent's title or source.
// R2. A secret survives in a field outside the cleaned list (a file path, a
//     scanner reason).
// R4. A huge line_end stalls finalize.
// R5. Two distinct problems on one line in one category collapse into one.
describe("finalizeReview: review round 1", () => {
  function message(submission: unknown): string {
    try {
      run(submission);
    } catch (err) {
      return (err as Error).message;
    }
    return "did not throw";
  }

  it("R1: redacts the agent's text in error messages", () => {
    const viaTitle = message(makeSubmission({ findings: [finding({ title: `key ${SECRET}`, source: "nope:x", candidate: null })] }));
    expect(viaTitle).toMatch(/cites source "nope:x"/);
    expect(viaTitle).not.toContain(SECRET);
    const viaSource = message(makeSubmission({ findings: [finding({ source: `x:${SECRET}`, candidate: null })] }));
    expect(viaSource).toMatch(/cites source/);
    expect(viaSource).not.toContain(SECRET);
    const viaCandidate = message(makeSubmission({ findings: [finding({ candidate: SECRET })] }));
    expect(viaCandidate).toMatch(/raises candidate/);
    expect(viaCandidate).not.toContain(SECRET);
    const viaDropped = message(makeSubmission({ dropped: [{ candidate: SECRET, reason: "x" }] }));
    expect(viaDropped).toMatch(/dropped\[0\]/);
    expect(viaDropped).not.toContain(SECRET);
  });

  it("R2: redacts possible paths and text alongside hidden entries and scanner reasons", () => {
    const change = makeChange();
    const scan = makeScan();
    change.coverage.set(`possible/${SECRET}.py`, new Set([14]));
    change.changedPaths.push(`possible/${SECRET}.py`);
    change.files.push({ path: `possible/${SECRET}.py`, status: "modified", oldPath: null, binary: false });
    const leakyScan = {
      ...scan,
      scanners: scan.scanners.map((s) => (s.scanner === "brakeman" ? { ...s, reason: `failed near ${SECRET}` } : s)),
    };
    const report = finalizeReview({
      change,
      scan: leakyScan,
      manifest: makeManifest(change),
      config: makeConfig(),
      submission: makeSubmission({
        findings: [
          finding({ source: null, candidate: null, file_path: `debug/${SECRET}.py` }),
          finding({ source: null, candidate: null, file_path: `low/${SECRET}.py`, confidence: 0.45 }),
          finding({ source: null, candidate: null, file_path: `possible/${SECRET}.py`, description: `Exposes ${SECRET}`, confidence: 0.55 }),
        ],
      }),
    });
    expect(report.outside_change).toHaveLength(1);
    expect(report.low_confidence).toHaveLength(1);
    expect(report.possible).toHaveLength(1);
    expect(report.possible[0]!.description).not.toContain(SECRET);
    expect(JSON.stringify(report)).not.toContain(SECRET);
    const scanOnly = scanReport({ change, scan: leakyScan, config: makeConfig() });
    expect(JSON.stringify(scanOnly)).not.toContain(SECRET);
  });

  it("R4: a huge line_end is checked against coverage in bounded time", () => {
    const started = Date.now();
    const report = run(makeSubmission({ findings: [finding({ source: null, candidate: null, line_number: 16, line_end: 300_000_000 })] }));
    expect(Date.now() - started).toBeLessThan(200);
    expect(report.outside_change).toHaveLength(1);
    const reaching = run(makeSubmission({ findings: [finding({ line_number: 1, line_end: 300_000_000 })] }));
    expect(reaching.findings).toHaveLength(1);
  });

  it("R5: keeps distinct problems on one line, removes only true duplicates", () => {
    const report = run(
      makeSubmission({
        findings: [
          finding({}),
          finding({ source: null, candidate: null, title: "Hard-coded credential" }),
          finding({ source: null, candidate: null, title: "Hard-coded credential", severity: "major" }),
          finding({ severity: "major", title: "Same candidate again" }),
        ],
      }),
    );
    expect(report.findings.map((f) => [f.title, f.severity])).toEqual([
      ["SQL built from request input", "critical"],
      ["Hard-coded credential", "critical"],
    ]);
  });
});

describe("severity_threshold", () => {
  const nitpick = finding({ severity: "nitpick", category: "style", title: "Unused import", source: null, candidate: null, file_path: "app/settings.py", line_number: 1, line_end: 1 });

  it("counts a nitpick below the threshold instead of listing it, and keeps not-reviewed candidates", () => {
    const report = run(makeSubmission({ findings: [...(makeSubmission().findings as unknown[]), nitpick] }), {
      config: { severityThreshold: "minor" },
    });
    expect(report.findings.map((f) => f.title)).toEqual(["SQL built from request input"]);
    expect(report.below_threshold).toBe(1);
    expect(report.not_reviewed.map((c) => c.id)).toEqual([LINT_CANDIDATE.id]);
  });

  it("never hides a finding at or above block_on_severity, in a review or a scan", () => {
    const config = { severityThreshold: "critical" as const, blockOnSeverity: "nitpick" as const };
    const review = run(makeSubmission({ findings: [nitpick] }), { config });
    expect(review.findings.map((f) => f.title)).toEqual(["Unused import"]);
    expect(review.below_threshold).toBe(0);
    expect(review.verdict).toBe("blocked");
    const scan = scanReport({ change: makeChange(), scan: makeScan(), config: makeConfig(config) });
    expect(scan.findings).toHaveLength(3);
    expect(scan.below_threshold).toBe(0);
  });

  it("hides scanner findings below the threshold in a scan report", () => {
    const scan = scanReport({ change: makeChange(), scan: makeScan(), config: makeConfig({ severityThreshold: "major" }) });
    expect(scan.findings.map((f) => f.source)).toEqual([SQL_CANDIDATE.token, KEY_CANDIDATE.token]);
    expect(scan.below_threshold).toBe(1);
  });
});

describe("a change that silences a scanner is never hidden by the threshold (15)", () => {
  const suppression: Candidate = {
    ...LINT_CANDIDATE,
    id: "c4",
    token: `bandit:${SUPPRESSION_RULE}`,
    source: "bandit",
    ruleId: SUPPRESSION_RULE,
    lineStart: 2,
    lineEnd: 2,
    severity: "medium",
    reviewSeverity: "minor",
    message: "This change adds # nosec, which stops bandit reporting what it covers; check that it hides no real problem",
  };
  const settings: Candidate = {
    ...LINT_CANDIDATE,
    id: "c5",
    token: `ruff:${SETTINGS_RULE}`,
    source: "ruff",
    ruleId: SETTINGS_RULE,
    filePath: "app/search.py",
    lineStart: 14,
    lineEnd: 14,
    severity: "high",
    reviewSeverity: "major",
    message: "This change edits a scanner settings file; findings of ruff may be hidden by it",
  };
  const scanWithOwn = makeScan({ candidates: [SQL_CANDIDATE, suppression, settings] });
  const raise = (c: Candidate) =>
    finding({ severity: "nitpick", category: "maintainability", title: "Silences a scanner", file_path: c.filePath, line_number: c.lineStart, line_end: c.lineStart, source: c.token, candidate: c.id });

  it("lists both in a scan, as minor, whatever the threshold, and blocks at minor", () => {
    const report = scanReport({ change: makeChange(), scan: scanWithOwn, config: makeConfig({ severityThreshold: "critical" }) });
    expect(report.findings.map((f) => [f.source, f.severity])).toEqual([
      [suppression.token, "minor"],
      [settings.token, "minor"],
    ]);
    expect(report.below_threshold).toBe(1);
    expect(report.verdict).toBe("passed");
    for (const only of [suppression, settings]) {
      const blocked = scanReport({ change: makeChange(), scan: makeScan({ candidates: [only] }), config: makeConfig({ blockOnSeverity: "minor" }) });
      expect(blocked.verdict, only.token).toBe("blocked");
      const passed = scanReport({ change: makeChange(), scan: makeScan({ candidates: [only] }), config: makeConfig({ blockOnSeverity: "major" }) });
      expect(passed.verdict, only.token).toBe("passed");
    }
  });

  it("lists them when the reviewer raises them below the threshold (version 1)", () => {
    const change = makeChange();
    const report = finalizeReview({
      change,
      scan: scanWithOwn,
      manifest: makeManifest(change),
      config: makeConfig({ severityThreshold: "critical" }),
      submission: makeSubmission({ findings: [raise(suppression), raise(settings)], dropped: [{ candidate: "c1", reason: "parameterised elsewhere" }] }),
    });
    expect(report.findings.map((f) => f.candidate)).toEqual(["c4", "c5"]);
    expect(report.below_threshold).toBe(0);
  });

  it("lists them when the reviewer raises them below the threshold (version 2)", () => {
    const change = makeChange();
    const prose = { problem: "The comment makes the scanner skip this line.", consequence: "A real problem here would not be reported.", fix: "Remove the comment or fix the code it hides." };
    const v2 = (c: Candidate) => {
      const { description: _d, suggested_change: _s, ...rest } = raise(c) as Record<string, unknown>;
      return { ...rest, ...prose };
    };
    const r = checkSubmission({
      change,
      scan: scanWithOwn,
      manifest: makeManifest(change),
      config: makeConfig({ severityThreshold: "critical" }),
      submission: {
        version: 2,
        change_id: change.shortId,
        summary: "Checked.",
        findings: [v2(suppression), v2(settings)],
        dropped: [{ candidate: "c1", reason: "Parameterised elsewhere.", file_path: "app/search.py", line_number: 14 }],
      },
      lineCount: (path) => (path === "app/search.py" ? 40 : path === "app/settings.py" ? 3 : null),
    });
    if (!r.ok) throw new Error(r.errors.join("\n"));
    expect(r.report.findings.map((f) => f.candidate)).toEqual(["c4", "c5"]);
    expect(r.report.below_threshold).toBe(0);
  });
});

// Failure cases: a report builder loses scanner information or counts it,
// and a raised candidate loses the scanner's published fix versions.
// An explicit empty fix list loses its no-fix note, or an older scan with
// no fixedIn field incorrectly claims no fix exists, in either review format.
describe("dependency information", () => {
  const outside: Candidate = { id: "o1", token: "osv-scanner:GHSA-old", source: "osv-scanner", ruleId: "GHSA-old", filePath: "package-lock.json", lineStart: 4, lineEnd: 5, severity: "high", reviewSeverity: "major", message: "lodash@4.17.15: GHSA-old. Fixed in 4.17.21", reference: null, fixedIn: ["4.17.21"] };
  it("carries outside entries through legacy review and scan reports without blocking", () => {
    const change = makeChange(); const scan = makeScan({ candidates: [], outside: [outside] });
    const args = { change, scan, manifest: makeManifest(change), config: makeConfig({ blockOnSeverity: "minor", severityThreshold: "critical" }) };
    for (const report of [scanReport(args), finalizeReview({ ...args, submission: makeSubmission({ findings: [], dropped: [] }) })]) {
      expect(report.outside_change).toEqual([expect.objectContaining({ origin: "scanner", candidate: null, source: outside.token, notes: ["In the tree before this change."] })]);
      expect(report.verdict).toBe("passed"); expect(report.below_threshold).toBe(0);
    }
  });
  it("keeps fixed versions when a legacy reviewer raises a candidate", () => {
    const change = makeChange(); const scan = makeScan(); scan.candidates[0] = { ...scan.candidates[0], fixedIn: ["4.17.21"] };
    const report = finalizeReview({ change, scan, manifest: makeManifest(change), config: makeConfig(), submission: makeSubmission() });
    expect(report.findings[0].notes).toContain("Scanner: fixed in 4.17.21");
  });

  it.each([{ fixedIn: undefined }, { fixedIn: [] }, { fixedIn: ["4.17.21"] }])("preserves fixed-version knowledge in both review formats: $fixedIn", ({ fixedIn }) => {
    const change = makeChange();
    const scan = makeScan({ candidates: [{ ...SQL_CANDIDATE }] });
    if (fixedIn !== undefined) scan.candidates[0] = { ...scan.candidates[0], fixedIn };
    const args = { change, scan, manifest: makeManifest(change), config: makeConfig() };
    const legacy = finalizeReview({ ...args, submission: makeSubmission({ dropped: [] }) });
    const { description: _description, suggested_change: _suggested, ...raised } = finding({});
    const modern = checkSubmission({ ...args, lineCount: () => 100, submission: {
      version: 2,
      change_id: change.id,
      summary: "Checked the query.",
      findings: [{
        ...raised,
        problem: "The query inserts untrusted input.",
        consequence: "An attacker can execute SQL.",
        fix: "Bind the value as a query parameter.",
      }],
      dropped: [],
    } });
    if (!modern.ok) throw new Error(modern.errors.join("\n"));
    const notes = fixedIn === undefined ? [] : fixedIn.length ? ["Scanner: fixed in 4.17.21"] : ["Scanner: no fixed version published"];
    expect(legacy.findings[0].notes).toEqual(notes);
    expect(modern.report.findings[0].notes).toEqual(notes);
  });
});

// Failure: a Ruby bang or predicate method name followed by a word (destroy!, admin?) was counted as a
// sentence end, so a three-sentence problem naming such calls failed the sentence limit on every
// correction round and the review went incomplete (planted rails-controller-model, wave 9 candidate).
describe("sentence counting around code names", () => {
  it("does not count a bang or predicate method followed by a lowercase word as a sentence end", () => {
    const problem = "The destroy action looks up the user by params[:id] without scoping it to the caller. The before_action on line 2 excludes destroy from require_admin. Only authenticate! runs, and it checks admin? on the record.";
    expect(sentences(problem)).toHaveLength(3);
    expect(proseErrors("problem", problem, null, 3)).toEqual([]);
  });
  it("still ends a sentence at a bang or question mark followed by a capital, a digit, a quote or a backtick", () => {
    expect(sentences("The action calls destroy! The caller is unscoped. Is it guarded? `authenticate!` runs first. Why? 2 reasons.")).toHaveLength(6);
  });
});
