import { afterAll, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import {
  groupGoPackagesByModule,
  joinParts,
  parseGolangciJson,
} from "./golangci.js";

describe("parseGolangciJson", () => {
  it("empty output or null Issues from a clean run yields no findings instead of a parse error", () => {
    const empty = { findings: [], typecheckErrors: [], notDownloaded: [], blockedDirs: [] };
    expect(parseGolangciJson("")).toEqual(empty);
    expect(parseGolangciJson(JSON.stringify({ Issues: null }))).toEqual(empty);
    expect(parseGolangciJson(JSON.stringify({ Issues: "nope" }))).toEqual(empty);
  });

  it("a golangci issue takes its linter as rule id, its file and line from Pos, and gosec ranks high", () => {
    const report = {
      Issues: [
        {
          FromLinter: "gosec",
          Text: "G401: Use of weak cryptographic primitive",
          Severity: "",
          Pos: { Filename: "internal/auth/hash.go", Offset: 0, Line: 17, Column: 5 },
        },
      ],
      Report: { Linters: [{ Name: "gosec", Enabled: true }] },
    };
    const out = parseGolangciJson(JSON.stringify(report)).findings;
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      source: "golangci",
      ruleId: "gosec",
      filePath: "internal/auth/hash.go",
      lineStart: 17,
      lineEnd: 17,
      severity: "high",
      reference: null,
    });
    expect(out[0].message).toContain("gosec: G401");
  });

  it("a log line printed before the JSON does not break parsing; an issue without a linter gets a rule id and one without a file or line is dropped", () => {
    const report = {
      Issues: [
        { Text: "unnamed linter", Pos: { Filename: "a.go", Line: 8 } },
        { FromLinter: "govet", Text: "t", Pos: { Filename: "", Line: 1 } },
        { FromLinter: "govet", Text: "t", Pos: { Filename: "a.go", Line: 0 } },
        { FromLinter: "govet", Text: "t" },
      ],
    };
    const noisy = `level=warning msg="running with deprecated flag"\n${JSON.stringify(report)}`;
    const out = parseGolangciJson(noisy).findings;
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ ruleId: "golangci", filePath: "a.go", lineStart: 8 });
  });

  // Real output, see fixtures/golangci/typecheck-newer-go.txt: Go 1.27 on
  // PATH, golangci-lint built with Go 1.26. The package was never linted, and
  // the one issue sits in the standard library, so as a finding it was
  // dropped by the changed-line filter and the scan read as clean.
  it("a typecheck issue means the package was not linted: it comes back as an error, never as a finding", () => {
    const fixture = fileURLToPath(new URL("../../test/fixtures/golangci/typecheck-newer-go.json", import.meta.url));
    const out = parseGolangciJson(fs.readFileSync(fixture, "utf8"));
    expect(out.findings).toEqual([]);
    expect(out.typecheckErrors).toEqual([
      "/usr/local/go/src/internal/poll/splice_linux.go:237: unknown field rfd in struct literal of type splicePipe",
    ]);
  });
});

// Module-root discovery. The bug these cover: the adapter used to run
// golangci-lint at the directory it was handed and pass package args
// relative to it, assuming go.mod lived there. A repo is free to put
// go.mod deeper, such as `backend/src/factors/go.mod` in a monorepo. Go
// then exits 5 in package loading without analyzing anything, and the
// adapter reported raw=0 next to the error, so from the outside it
// looked like a clean scan rather than a scan that never happened.

const tmpRoots: string[] = [];

function repo(layout: { modules: string[] }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openqodex-golangci-"));
  tmpRoots.push(dir);
  for (const m of layout.modules) {
    const abs = m === "." ? dir : path.join(dir, ...m.split("/"));
    fs.mkdirSync(abs, { recursive: true });
    fs.writeFileSync(path.join(abs, "go.mod"), "module example.com/x\n");
  }
  return dir;
}

afterAll(() => {
  for (const d of tmpRoots) fs.rmSync(d, { recursive: true, force: true });
});

describe("groupGoPackagesByModule", () => {
  it("expresses package args relative to the module root, not the run dir", () => {
    const dir = repo({ modules: ["src/factors"] });

    const { groups, orphans } = groupGoPackagesByModule(dir, [
      "src/factors/model/model/billing.go",
      "src/factors/handler/auth.go",
    ]);

    expect(orphans).toEqual([]);
    expect(groups).toHaveLength(1);
    expect(groups[0].moduleRoot).toBe("src/factors");
    // Relative to src/factors -- NOT "./src/factors/model/model", which
    // is what the old code passed and what Go could not resolve.
    expect(groups[0].packages.sort()).toEqual(["./handler", "./model/model"]);
  });

  it("splits a diff that spans two modules and orders the heavier first", () => {
    const dir = repo({ modules: ["a", "b"] });

    const { groups } = groupGoPackagesByModule(dir, [
      "b/one.go",
      "a/x/1.go",
      "a/x/2.go",
      "a/y/3.go",
    ]);

    expect(groups.map((g) => g.moduleRoot)).toEqual(["a", "b"]);
    expect(groups[0].fileCount).toBe(3);
    expect(groups[0].packages.sort()).toEqual(["./x", "./y"]);
    expect(groups[1].packages).toEqual(["."]);
  });

  it("reports directories with no module above them instead of linting them", () => {
    const dir = repo({ modules: ["backend"] });

    const { groups, orphans } = groupGoPackagesByModule(dir, [
      "backend/svc/a.go",
      "scripts/tool.go",
    ]);

    expect(groups.map((g) => g.moduleRoot)).toEqual(["backend"]);
    expect(orphans).toEqual(["scripts"]);
  });
});

// Review round 1: two skip parts joined and cut at 300 characters ended the
// second part mid-word, inside the command the developer should run.
describe("joinParts", () => {
  it("leaves out a part that does not fit whole and counts it, so no fix is cut", () => {
    const part = (n: number) => `not run on the Go module at m${n}/. Its dependencies are not in the Go module cache, such as github.com/x/y. To fix, run go mod download in m${n}/`;
    const parts = [part(1), part(2), part(3)];
    const out = joinParts(parts);
    expect(out.length).toBeLessThanOrEqual(300);
    const pieces = out.split("; ");
    expect(pieces[pieces.length - 1]).toMatch(/^and \d+ more$/);
    for (const piece of pieces.slice(0, -1)) expect(parts).toContain(piece);
    expect(joinParts([part(1)])).toBe(part(1));
  });

  // Second review: a deep module folder made the first part longer than 300
  // characters, and the cut at 300 lost the "To fix" sentence.
  it("keeps the To fix sentence of a first part longer than the limit", () => {
    const deep = `not run on some packages of the Go module at ${"d".repeat(77)}.../. Its dependencies are not in the Go module cache, such as ${"github.com/x/".padEnd(77, "y")}... and 4 more. To fix, run go mod download in ${"d".repeat(77)}.../`;
    expect(deep.length).toBeGreaterThan(300);
    const out = joinParts([deep, "timed out before module c"]);
    expect(out.length).toBeLessThanOrEqual(300);
    expect(out).toBe(`not run on some packages of the Go module at ${"d".repeat(77)}.../. To fix, run go mod download in ${"d".repeat(77)}.../; timed out before module c`);
  });
});

// Review round 3: the names Go reports as undefined when an import did not
// load. Too wide a set drops a real error of the change as a skip; too narrow
// a set turns the skip of issue 289 back into a failure.
describe("parseGolangciJson on an import that is not downloaded", () => {
  const missing = (importPath: string, file = "/repo/a.go") => ({
    FromLinter: "typecheck",
    Text: `could not import ${importPath} (a.go:3:8: module lookup disabled by GOPROXY=off)`,
    SourceLines: [`import "${importPath}"`],
    Pos: { Filename: file, Line: 3 },
  });
  const undefinedName = (name: string, file = "/repo/a.go") => ({
    FromLinter: "typecheck",
    Text: `undefined: ${name}`,
    Pos: { Filename: file, Line: 7 },
  });

  it("keeps a real undefined: limiter next to the missing github.com/acme/rate-limiter as a failure", () => {
    const out = parseGolangciJson(JSON.stringify({ Issues: [missing("github.com/acme/rate-limiter"), undefinedName("ratelimiter"), undefinedName("limiter")] }));
    expect(out.notDownloaded).toEqual(["github.com/acme/rate-limiter"]);
    expect(out.typecheckErrors).toEqual(["/repo/a.go:7: undefined: limiter"]);
  });

  it("reads undefined: uuid next to the missing github.com/satori/go.uuid as part of the skip", () => {
    const out = parseGolangciJson(JSON.stringify({ Issues: [missing("github.com/satori/go.uuid"), undefinedName("uuid")] }));
    expect(out.notDownloaded).toEqual(["github.com/satori/go.uuid"]);
    expect(out.typecheckErrors).toEqual([]);
  });
});
