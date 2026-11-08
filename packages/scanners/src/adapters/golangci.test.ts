import { afterAll, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import {
  groupGoPackagesByModule,
  parseGolangciJson,
} from "./golangci.js";

describe("parseGolangciJson", () => {
  it("empty output or null Issues from a clean run yields no findings instead of a parse error", () => {
    const empty = { findings: [], typecheckErrors: [], notDownloaded: [] };
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
