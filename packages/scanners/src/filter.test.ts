import { makeLineSet } from "../../../tests/line-set.mjs";
import { describe, expect, it } from "vitest";
import {
  filterToChangedLines,
  isFixturePath,
  dropFixtureFindings,
} from "./filter.js";
import type { StaticFinding } from "@openqodex/core";

function finding(over: Partial<StaticFinding>): StaticFinding {
  return {
    source: "semgrep",
    ruleId: "rule",
    filePath: "src/a.ts",
    lineStart: 10,
    lineEnd: 10,
    severity: "high",
    message: "msg",
    reference: null,
    ...over,
  };
}

describe("filterToChangedLines", () => {
  it("a finding whose whole span misses the changed lines is dropped", () => {
    const coverage = new Map([["src/a.ts", makeLineSet([1, 2, 3])]]);
    const out = filterToChangedLines(
      [finding({ lineStart: 10, lineEnd: 12 })],
      coverage,
    );
    expect(out).toHaveLength(0);
  });

  it("a multi-line finding that reaches one changed line is kept", () => {
    const coverage = new Map([["src/a.ts", makeLineSet([12])]]);
    const out = filterToChangedLines(
      [finding({ lineStart: 10, lineEnd: 14 })],
      coverage,
    );
    expect(out).toHaveLength(1);
  });
});

describe("filterToChangedLines with an unsafe line number", () => {
  // A custom scanner's report can carry any number. Past 2^53, n + 1 === n,
  // so a loop over the span never ends.
  it("does not loop forever on a span ending at 2^53", () => {
    const coverage = new Map([["src/a.ts", makeLineSet([3])]]);
    const huge = 9007199254740992;
    const kept = filterToChangedLines(
      [finding({ lineStart: 1, lineEnd: huge }), finding({ lineStart: huge - 1, lineEnd: huge })],
      coverage,
    );
    expect(kept.map((f) => f.lineStart)).toEqual([1]);
  }, 5_000);
});

describe("isFixturePath", () => {
  it("a finding in a real test file is never hidden as a fixture", () => {
    // Real tests can have genuine bugs: security finding in
    // integration setup, leaked admin token in a test runner. Don't
    // suppress them.
    expect(isFixturePath("src/foo.test.ts")).toBe(false);
    expect(isFixturePath("src/foo.spec.ts")).toBe(false);
    expect(isFixturePath("src/__tests__/foo.test.ts")).toBe(false);
    expect(isFixturePath("test/integration/foo.ts")).toBe(false);
    expect(isFixturePath("tests/integration/foo.ts")).toBe(false);
  });

  it("a production path holding a fixture-like word is never hidden", () => {
    // "mockingbird" or "fixtureRetrieve" aren't fixture paths
    expect(isFixturePath("src/mockingbird/server.ts")).toBe(false);
    expect(isFixturePath("src/myfixturestore.ts")).toBe(false);
    expect(isFixturePath("src/components/MockUpRenderer.ts")).toBe(false);
  });
});

describe("dropFixtureFindings", () => {
  it("fixture findings are dropped and counted, the rest kept in order", () => {
    const f1 = finding({ filePath: "src/api/billing.ts" });
    const f2 = finding({ filePath: "src/__fixtures__/users.json" });
    const f3 = finding({ filePath: "src/db.mock.ts" });
    const f4 = finding({ filePath: "ui/src/App.tsx" });
    const out = dropFixtureFindings([f1, f2, f3, f4]);
    expect(out.kept).toEqual([f1, f4]);
    expect(out.droppedCount).toBe(2);
  });
});
