// A written rule in AGENTS.md, chosen in review.instructions_files, read by
// the real Claude Code as the reviewer. It costs real usage, so the group
// runs only in the model tier (pnpm gate:model, which sets
// OPENQODEX_MODEL_TESTS=1); anywhere else it skips with a printed reason.
//
// Ways it could fail, written before the code:
//  1. A change that breaks the rule gives no finding, or a finding that does
//     not cite AGENTS.md with the rule's own words, or one that is only an
//     observation.
//  2. A change that follows the rule gives a finding citing it.
//  3. A change the rule's stated exception covers ("except in tests") gives
//     a finding citing it.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Report } from "@openqodex/core";
import "./global-setup.js";
import { git, modelTestsOff, readJson, reportDir, requireReviewer, reviewerMissing, run, writeConfig } from "./support.js";
import { removeTempDirs, tempDir } from "../temp-dirs.mjs";

afterAll(removeTempDirs);

const RULE = "Every tenant-scoped query goes through can(user, tenant) before it runs, except in tests.";
const BASELINE: Record<string, string> = {
  "AGENTS.md": `# Team rules\n\n## Data access\n\n- ${RULE}\n- Log with the request id.\n`,
  "app/__init__.py": "",
  "app/auth.py": "def can(user, tenant):\n    return tenant in user.tenants\n",
  "app/db.py": "def query(sql, params):\n    raise NotImplementedError\n",
  "app/orders.py": [
    "from app.auth import can",
    "from app.db import query",
    "",
    "",
    "def list_orders(user, tenant):",
    "    if not can(user, tenant):",
    '        raise PermissionError("forbidden")',
    '    return query("SELECT * FROM orders WHERE tenant_id = %s", (tenant,))',
    "",
  ].join("\n"),
};
const INVOICES = (guarded: boolean) => [
  "",
  "",
  "def list_invoices(user, tenant):",
  ...(guarded ? ["    if not can(user, tenant):", '        raise PermissionError("forbidden")'] : []),
  '    return query("SELECT * FROM invoices WHERE tenant_id = %s", (tenant,))',
  "",
].join("\n");

// The baseline committed with the rule chosen, and `change` left uncommitted.
function review(label: string, change: (dir: string) => void): Report {
  const dir = tempDir("oq-rule-");
  for (const [path, text] of Object.entries(BASELINE)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  writeConfig(dir, "review:\n  instructions_files: [AGENTS.md]\n");
  git(dir, "init", "-q"); git(dir, "add", "-A"); git(dir, "commit", "-qm", "Baseline");
  change(dir);
  const out = run(label, dir, ["review", "--reviewer", "claude", "--skip", "semgrep,osv-scanner", "--no-color"], { home: process.env.HOME, timeout: 900_000 });
  expect([0, 1], out.stderr).toContain(out.status);
  const report = readJson<Report>(join(reportDir(dir), "report.json"));
  expect(report.completion?.status).toBe("complete");
  return report;
}
const cited = (report: Report) => report.findings.filter((f) => f.rule?.file === "AGENTS.md");

describe.skipIf(modelTestsOff("rule citations with claude"))("rule citations with Claude Code as the reviewer", () => {
  it("1. a query that skips the permission check gives a finding quoting the rule", () => {
    requireReviewer(reviewerMissing());
    const report = review("rule-break", (dir) => writeFileSync(join(dir, "app/orders.py"), BASELINE["app/orders.py"] + INVOICES(false)));
    const hits = cited(report).filter((f) => f.file_path === "app/orders.py");
    expect(hits.length, JSON.stringify(report.findings)).toBeGreaterThan(0);
    expect(BASELINE["AGENTS.md"]!.replace(/\s+/g, " ")).toContain(hits[0]!.rule!.quote.replace(/\s+/g, " ").trim());
    expect(hits[0]!.rule!.quote.length).toBeGreaterThan(20);
    expect(hits[0]!.rule!.source).toBe("work tree");
  }, 1_000_000);

  it("2. a query that goes through the permission check gives no finding citing the rule", () => {
    requireReviewer(reviewerMissing());
    const report = review("rule-kept", (dir) => writeFileSync(join(dir, "app/orders.py"), BASELINE["app/orders.py"] + INVOICES(true)));
    expect(cited(report), JSON.stringify(report.findings)).toEqual([]);
  }, 1_000_000);

  it("3. a test that queries without the check, as the rule's exception allows, gives no finding citing the rule", () => {
    requireReviewer(reviewerMissing());
    const report = review("rule-exception", (dir) => {
      mkdirSync(join(dir, "tests"));
      writeFileSync(join(dir, "tests/test_orders.py"), [
        "from app.db import query",
        "",
        "",
        "def test_orders_query_shape():",
        '    rows = query("SELECT * FROM orders WHERE tenant_id = %s", ("t1",))',
        "    assert rows == []",
        "",
      ].join("\n"));
    });
    expect(cited(report), JSON.stringify(report.findings)).toEqual([]);
  }, 1_000_000);
});
