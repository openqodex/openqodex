import { describe, expect, it } from "vitest";
import { parseRuffJson } from "./ruff.js";

describe("parseRuffJson", () => {
  it("empty or non-list output yields no findings instead of a parse error", () => {
    expect(parseRuffJson("")).toEqual([]);
    expect(parseRuffJson(JSON.stringify({}))).toEqual([]);
  });

  it("a ruff S rule (security) ranks high and a pure style rule ranks info", () => {
    const report = [
      {
        code: "S602",
        message: "subprocess call with shell=True",
        filename: "a.py",
        location: { row: 1, column: 1 },
        end_location: { row: 1, column: 1 },
      },
      {
        code: "E501",
        message: "line too long",
        filename: "a.py",
        location: { row: 2, column: 1 },
        end_location: { row: 2, column: 1 },
      },
    ];
    const out = parseRuffJson(JSON.stringify(report));
    expect(out.map((f) => f.severity)).toEqual(["high", "info"]);
  });

  it("a multi-line ruff diagnostic spans to its end row", () => {
    const report = [
      {
        code: "B006",
        message: "mutable default arg",
        filename: "a.py",
        location: { row: 4, column: 1 },
        end_location: { row: 6, column: 1 },
      },
    ];
    const out = parseRuffJson(JSON.stringify(report));
    expect(out[0].lineStart).toBe(4);
    expect(out[0].lineEnd).toBe(6);
    expect(out[0].severity).toBe("low");
  });

  it("a diagnostic with a null code (a syntax error) gets a rule id; one without a file or row is dropped", () => {
    const report = [
      { code: "F401", message: "m", filename: "", location: { row: 1 } },
      { code: "F401", message: "m", filename: "a.py", location: { row: 0 } },
      { message: "syntax error", filename: "a.py", location: { row: 3 } },
    ];
    const out = parseRuffJson(JSON.stringify(report));
    expect(out).toHaveLength(1);
    expect(out[0].ruleId).toBe("ruff");
    expect(out[0].reference).toBeNull();
  });

  it("a syntax error with the code invalid-syntax (ruff 0.17) gets the same rule id and severity as a null code", () => {
    const report = [
      { code: null, message: "syntax error", filename: "a.py", location: { row: 3 } },
      { code: "invalid-syntax", message: "syntax error", filename: "a.py", location: { row: 3 } },
    ];
    const out = parseRuffJson(JSON.stringify(report));
    expect(out).toHaveLength(2);
    expect(out[1].ruleId).toBe("ruff");
    expect(out[1].severity).toBe(out[0].severity);
    expect(out[1].severity).toBe("info");
  });
});
