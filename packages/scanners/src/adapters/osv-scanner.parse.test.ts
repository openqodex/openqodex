// Turning an osv-scanner JSON report into findings. Pure: real report
// shapes and real lockfile lines in, findings out.
//
// The rules (osv-scanner.ts, parseOsvScannerJson):
//   A. Each advisory is anchored to a RANGE of the lockfile that runs from
//      the line naming the package through the line carrying its flagged
//      version, because a version bump changes the version line and not
//      the name line, and the changed-line filter must keep it. With no
//      version found nearby it spans a short window from the name; with no
//      lockfile content it is line 1.
//   B. Severity comes from the advisory's own numeric CVSS score, then its
//      qualitative label, then its group's max CVSS score, and is "high"
//      when there is nothing, because a known CVE in a dependency is worth
//      a look.
//   C. A CVE id links to NVD; anything else links to osv.dev.
//   D. An advisory with no id, a package with no vulnerabilities and a
//      report with no results yield nothing, rather than a finding with a
//      blank rule or a throw.
//
// Failure list, written before the tests:
//   1. The anchor is the name line only, so a bump's changed version line
//      is outside it (A).
//   2. The anchor takes a bare top-level mention of the name over the
//      resolved entry where the version sits (A).
//   3. No lockfile content anchors past line 1 (A).
//   4. A per-advisory CVSS score is ignored in favour of the label (B).
//   5. A GHSA label (HIGH, MODERATE) is not mapped (B).
//   6. The group max_severity is not used when the advisory has nothing
//      (B).
//   7. No severity data yields something below high (B).
//   8. A CVE links to osv.dev, or a GHSA to NVD (C).
//   9. An advisory without an id becomes a finding (D).
//  10. A blank report or a report without results throws (D).
//  11. The finding's path is the absolute temp path osv-scanner printed
//      instead of the repository-relative lockfile path, so it never
//      matches the diff.
//  12. The message loses the package, version or CVE alias a reviewer
//      needs.
//  13. An unchanged declaration that carries the version
//      (`"lodash": "^4.17.20"`) takes the anchor from the changed resolved
//      entry, so the changed-line filter drops the advisory.
//  14. A nested lockfile's findings take the root lockfile's path because
//      its printed path ends with the root key.
//  15. Two advisories osv-scanner groups as aliases of one another (two
//      GHSA ids for one CVE) become two findings for one problem.
//  16. A Rust advisory group whose ids osv.dev lists GHSA first is named by
//      the GHSA id, so cargo-deny's finding of the same advisory, named by
//      its RustSec id, never merges with it.

import { makeLineSet } from "../../../../tests/line-set.mjs";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseOsvScannerJson } from "./osv-scanner.js";

type Vuln = Record<string, unknown>;

function report(path: string, packages: unknown[]): string {
  return JSON.stringify({ results: [{ source: { path }, packages }] });
}

function pkg(name: string, version: string | undefined, vulns: Vuln[] | undefined, groups: unknown[] = []) {
  return {
    package: { name, ...(version ? { version } : {}) },
    ...(vulns ? { vulnerabilities: vulns } : {}),
    groups,
  };
}

// A top-level declaration of lodash, then a dozen other packages, then the
// resolved entry that carries the flagged version (lines 17 to 18).
const LOCK = [
  "{",
  '  "dependencies": {',
  '    "lodash": "^4.17.0"',
  "  },",
  ...Array.from({ length: 12 }, (_, i) => `  "node_modules/other-${i}": {},`),
  '  "node_modules/lodash": {',
  '    "version": "4.17.20",',
  '    "resolved": "https://registry.npmjs.org/lodash/-/lodash-4.17.20.tgz"',
  "  }",
  "}",
];

describe("anchoring an advisory to lockfile lines (A)", () => {
  it("spans the resolved entry from its name line to its version line (1, 2)", () => {
    const out = parseOsvScannerJson(
      report("package-lock.json", [pkg("lodash", "4.17.20", [{ id: "GHSA-p6mc-m468-83gw" }])]),
      new Map([["package-lock.json", LOCK]]),
    );
    // Line 3 is the bare declaration, with no version anywhere near it;
    // lines 17 to 18 are the resolved entry that the bump changed.
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ lineStart: 17, lineEnd: 18 });
  });

  it("covers the version line when the name and version are adjacent (1)", () => {
    const lines = ["{", '  "lodash": {', '    "version": "4.17.20"', "  }", "}"];
    const [finding] = parseOsvScannerJson(
      report("package-lock.json", [pkg("lodash", "4.17.20", [{ id: "GHSA-x" }])]),
      new Map([["package-lock.json", lines]]),
    );
    expect(finding).toMatchObject({ lineStart: 2, lineEnd: 3 });
  });

  it("falls back to line 1 with no lockfile content (3)", () => {
    const [finding] = parseOsvScannerJson(
      report("go.mod", [pkg("golang.org/x/net", undefined, [{ id: "GO-2022-0001" }])]),
      new Map(),
    );
    expect(finding).toMatchObject({ lineStart: 1, lineEnd: 1 });
  });

  it("reports the repository-relative path, not the absolute one osv printed (11)", () => {
    const [finding] = parseOsvScannerJson(
      report("/var/folders/xy/T/clone-abc/package-lock.json", [
        pkg("lodash", "4.17.20", [{ id: "GHSA-x" }]),
      ]),
      new Map([["package-lock.json", LOCK]]),
    );
    expect(finding.filePath).toBe("package-lock.json");
  });
});

describe("severity (B)", () => {
  const sev = (vuln: Vuln, groups: unknown[] = []) =>
    parseOsvScannerJson(report("Cargo.lock", [pkg("openssl", "0.10.0", [vuln], groups)]), new Map())[0]
      .severity;

  it("uses the advisory's own numeric score first (4)", () => {
    expect(
      sev(
        { id: "X-1", severity: [{ type: "CVSS_V3", score: "4.3" }], database_specific: { severity: "CRITICAL" } },
        [{ ids: ["X-1"], max_severity: "9.8" }],
      ),
    ).toBe("medium");
  });

  it("maps the qualitative label when there is no numeric score (5)", () => {
    expect(sev({ id: "X-2", database_specific: { severity: "HIGH" } })).toBe("high");
    expect(sev({ id: "X-3", database_specific: { severity: "MODERATE" } })).toBe("medium");
    expect(sev({ id: "X-4", database_specific: { severity: "LOW" } })).toBe("low");
  });

  it("uses the group's max score when the advisory has nothing (6)", () => {
    expect(sev({ id: "RUSTSEC-2021-0001" }, [{ ids: ["RUSTSEC-2021-0001"], max_severity: "9.8" }])).toBe(
      "critical",
    );
  });

  it("is high when there is no severity data at all (7)", () => {
    expect(sev({ id: "GO-2022-0001" })).toBe("high");
  });
});

describe("references and the message (C)", () => {
  it("links a CVE to NVD and everything else to osv.dev (8)", () => {
    const out = parseOsvScannerJson(
      report("requirements.txt", [pkg("django", undefined, [{ id: "CVE-2023-12345" }, { id: "GHSA-abcd" }])]),
      new Map(),
    );
    expect(out.map((f) => f.reference)).toEqual([
      "https://nvd.nist.gov/vuln/detail/CVE-2023-12345",
      "https://osv.dev/vulnerability/GHSA-abcd",
    ]);
  });

  it("names the package, version, advisory and alias (12)", () => {
    const [finding] = parseOsvScannerJson(
      report("package-lock.json", [
        pkg("lodash", "4.17.20", [
          { id: "GHSA-p6mc-m468-83gw", aliases: ["CVE-2020-8203"], summary: "Prototype pollution in lodash" },
        ]),
      ]),
      new Map(),
    );
    expect(finding).toMatchObject({ source: "osv-scanner", ruleId: "GHSA-p6mc-m468-83gw" });
    expect(finding.message).toBe(
      "lodash@4.17.20: GHSA-p6mc-m468-83gw (CVE-2020-8203). Prototype pollution in lodash. No fixed version published",
    );
  });
});

describe("aliased advisories (15)", () => {
  it("reports one finding per osv-scanner group, under its first id", () => {
    const out = parseOsvScannerJson(
      report("bun.lock", [
        pkg(
          "lodash",
          "4.17.15",
          [{ id: "GHSA-35jh-r3h4-6jhm" }, { id: "GHSA-r5fr-rjxr-66jc" }, { id: "GHSA-p6mc-m468-83gw" }],
          [
            { ids: ["GHSA-35jh-r3h4-6jhm", "GHSA-r5fr-rjxr-66jc"], aliases: ["CVE-2021-23337"], max_severity: "8.1" },
            { ids: ["GHSA-p6mc-m468-83gw"], max_severity: "7.4" },
          ],
        ),
      ]),
      new Map(),
    );
    expect(out.map((f) => f.ruleId)).toEqual(["GHSA-35jh-r3h4-6jhm", "GHSA-p6mc-m468-83gw"]);
  });

  it("names a group by its RustSec id, in whatever order the ids come (16)", () => {
    for (const ids of [
      ["GHSA-43w2-9j62-hq99", "RUSTSEC-2021-0003"],
      ["RUSTSEC-2021-0003", "GHSA-43w2-9j62-hq99"],
    ]) {
      const out = parseOsvScannerJson(
        report("Cargo.lock", [pkg("smallvec", "1.6.0", ids.map((id) => ({ id })), [{ ids, aliases: ["CVE-2021-25900"], max_severity: "9.8" }])]),
        new Map(),
      );
      expect(out.map((f) => f.ruleId)).toEqual(["RUSTSEC-2021-0003"]);
    }
  });
});

describe("what yields nothing (D)", () => {
  it("drops advisories with no id and packages with no vulnerabilities (9)", () => {
    const out = parseOsvScannerJson(
      report("yarn.lock", [pkg("a", "1.0.0", [{}, { id: "" }]), pkg("b", "1.0.0", undefined)]),
      new Map(),
    );
    expect(out).toEqual([]);
  });

  it("reads a blank report or one without results as no findings (10)", () => {
    expect(parseOsvScannerJson("", new Map())).toEqual([]);
    expect(parseOsvScannerJson("{}", new Map())).toEqual([]);
    expect(parseOsvScannerJson(JSON.stringify({ results: "nope" }), new Map())).toEqual([]);
  });
});

describe("choosing the place to anchor (13, 14)", () => {
  const DECLARED = [
    "{",
    '  "dependencies": {',
    '    "lodash": "^4.17.20"',
    "  },",
    '  "node_modules/lodash": {',
    '    "version": "4.17.20",',
    '    "resolved": "https://registry.npmjs.org/lodash/-/lodash-4.17.20.tgz"',
    "  }",
    "}",
  ];

  it("anchors to the candidate that touches a changed line (13)", () => {
    const [finding] = parseOsvScannerJson(
      report("package-lock.json", [pkg("lodash", "4.17.20", [{ id: "GHSA-x" }])]),
      new Map([["package-lock.json", DECLARED]]),
      { coverage: new Map([["package-lock.json", makeLineSet([6, 7])]]) },
    );
    expect(finding).toMatchObject({ lineStart: 5, lineEnd: 6 });
  });

  it("gives a nested lockfile its own path, with or without the repo root (14)", () => {
    const files = new Map([
      ["package-lock.json", LOCK],
      ["service/package-lock.json", LOCK],
    ]);
    const json = report("/work/repo/service/package-lock.json", [pkg("lodash", "4.17.20", [{ id: "GHSA-x" }])]);
    expect(parseOsvScannerJson(json, files, { repoDir: "/work/repo" })[0].filePath).toBe("service/package-lock.json");
    expect(parseOsvScannerJson(json, files)[0].filePath).toBe("service/package-lock.json");
  });
});

// Failure cases: wrong affected entry, missing fixes, reordered fixes, and a cut suffix.
describe("fixed versions", () => {
  const captured = JSON.parse(readFileSync(new URL("../../test/fixtures/osv-lodash-2.6.0.json", import.meta.url), "utf8"));
  function fixed(affected: unknown, summary = "Known vulnerability") {
    const data = structuredClone(captured);
    data.results[0].packages[0].package.ecosystem = "npm:registry";
    data.results[0].packages[0].vulnerabilities = [{ id: "GHSA-fix", affected, summary }];
    data.results[0].packages[0].groups = [];
    return parseOsvScannerJson(JSON.stringify(data), new Map())[0];
  }
  const entry = (name: string, ecosystem: string, versions: string[]) => ({ package: { name, ecosystem }, ranges: [{ events: versions.map((fixed) => ({ fixed })) }] });
  it("reads fixed events from the matching package and ecosystem only", () => {
    expect(fixed([entry("other", "npm", ["9"]), entry("lodash", "PyPI", ["8"]), entry("lodash", "npm", ["4.17.21"])])).toMatchObject({ fixedIn: ["4.17.21"], message: expect.stringMatching(/\. Fixed in 4\.17\.21$/) });
  });
  it("ignores affected entries from another ecosystem", () => {
    expect(fixed([entry("lodash", "PyPI", ["8"])])).toMatchObject({ fixedIn: [], message: expect.stringMatching(/\. No fixed version published$/) });
  });
  it("names the absence of a published fixed event", () => {
    expect(fixed([{ package: { name: "lodash", ecosystem: "npm" }, ranges: [{ events: [{ introduced: "0" }] }] }]).message).toMatch(/No fixed version published$/);
  });
  it("lists distinct fixed events in OSV order", () => {
    expect(fixed([entry("lodash", "npm", ["15.5.28", "16.4.1", "15.5.28"])])).toMatchObject({ fixedIn: ["15.5.28", "16.4.1"], message: expect.stringMatching(/Fixed in 15\.5\.28, 16\.4\.1$/) });
  });
  it("never cuts the fixed version suffix at the message limit", () => {
    const f = fixed([entry("lodash", "npm", ["4.17.21"])], "Long summary ".repeat(100));
    expect(f.message.length).toBeLessThanOrEqual(500);
    expect(f.message).toMatch(/\. Fixed in 4\.17\.21$/);
  });
  it("reads matching npm fixed events from captured 2.6.0 JSON", () => {
    const findings = parseOsvScannerJson(JSON.stringify(captured), new Map());
    expect(findings.find((f) => f.ruleId === "GHSA-p6mc-m468-83gw")?.fixedIn).toEqual(["4.17.19"]);
  });
});
