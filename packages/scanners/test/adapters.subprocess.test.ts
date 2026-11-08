// Real binaries on tiny planted inputs, one case per builtin scanner: each
// guards that scanner's invocation, output parser, changed-line filter and tool
// resolution together. Run by the end-to-end config, not the unit config.
import { randomBytes } from "node:crypto";
import { readdirSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { REDACTED } from "@openqodex/core";
import { removeTempDirs, tempDir } from "../../../tests/temp-dirs.mjs";
import { plant, resolveFirst, scan, withLoggingProxy } from "./subprocess-support.js";
import type { Case } from "./subprocess-support.js";

const generatedSecret = `sk_live_${randomBytes(12).toString("hex")}`;
// A React page whose effect reads `id` and leaves it out of its dependencies.
const REACT_PAGE = `import { useEffect, useState } from "react";
export default function Page({ id }: { id: string }) {
  const [data, setData] = useState<string | null>(null);
  useEffect(() => {
    fetch(\`/api/\${id}\`).then((r) => r.text()).then(setData);
  }, []);
  return <p>{data}</p>;
}
`;

const cases: Case[] = [
  { scanner: "gitleaks", rule: "stripe-access-token", files: { "config.py": `STRIPE_KEY = '${generatedSecret}'\n` }, anchor: "config.py" },
  { scanner: "osv-scanner", rule: "GHSA-p6mc-m468-83gw", files: { "package-lock.json": JSON.stringify({ name: "tiny", lockfileVersion: 2, packages: { "": { name: "tiny" }, "node_modules/lodash": { version: "4.17.15" } } }, null, 2) }, anchor: "package-lock.json", network: true },
  { scanner: "sqllint", rule: "security-definer-no-search-path", files: { "db/unsafe.sql": "CREATE FUNCTION public.do_thing() RETURNS void\nLANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN END $$;\n" }, anchor: "db/unsafe.sql" },
  { scanner: "semgrep", rule: "python.lang.security.audit.formatted-sql-query.formatted-sql-query", files: { "search.py": `import sqlite3
from flask import request
def query():
    user = request.args.get("name")
    db = sqlite3.connect("test.db")
    return db.execute(f"SELECT * FROM users WHERE name = '{user}'")
` }, anchor: "search.py", network: true },
  { scanner: "actionlint", rule: "expression", files: { ".github/workflows/ci.yml": "on: pull_request\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ${{ github.event.pull_request.title }}\n" }, anchor: ".github/workflows/ci.yml" },
  { scanner: "hadolint", rule: "DL3007", files: { Dockerfile: "FROM python:latest\n" }, anchor: "Dockerfile" },
  { scanner: "shellcheck", rule: "SC2086", files: { "deploy.sh": "#!/bin/sh\necho $FOO\n" }, anchor: "deploy.sh" },
  { scanner: "ruff", rule: "F401", files: { "main.py": "import os\n" }, anchor: "main.py" },
  { scanner: "brakeman", rule: "SQL", files: { Gemfile: "source 'https://rubygems.org'\ngem 'rails'\n", "config/application.rb": "require 'rails/all'\nmodule Tiny\n  class Application < Rails::Application\n  end\nend\n", "app/controllers/users_controller.rb": "class UsersController < ApplicationController\n  def index\n    User.where(\"name = '#{params[:name]}'\")\n  end\nend\n" }, anchor: "app/controllers/users_controller.rb", runtime: /^needs Ruby/ },
  { scanner: "rubocop", rule: "Lint/UselessAssignment", files: { "app.rb": "unused = 1\n" }, anchor: "app.rb", runtime: /^needs Ruby/ },
  { scanner: "bandit", rule: "B608", files: { "search.py": "def query(user):\n    return f'SELECT * FROM users WHERE name = {user}'\n" }, anchor: "search.py" },
  { scanner: "oxlint", rule: "eslint/no-debugger", files: { "main.js": "debugger;\n" }, anchor: "main.js" },
  // Framework rules the project's manifest switches on (detect.ts): oxlint's
  // react plugin in a React project, ruff's DJ rules in a Django one.
  { scanner: "oxlint", rule: "react-hooks/exhaustive-deps", files: { "web/package.json": JSON.stringify({ dependencies: { react: "18.3.1" } }), "web/page.tsx": REACT_PAGE }, anchor: "web/page.tsx" },
  { scanner: "ruff", rule: "DJ001", files: { "requirements.txt": "Django==5.0\n", "shop/models.py": "from django.db import models\n\n\nclass Item(models.Model):\n    name = models.CharField(max_length=10, null=True)\n\n    def __str__(self):\n        return self.name\n" }, anchor: "shop/models.py" },
  { scanner: "golangci", rule: "gosec", files: { "go.mod": "module example.com/tiny\n\ngo 1.22\n", "main.go": "package main\nimport \"crypto/md5\"\nfunc main() { _ = md5.New() }\n" }, anchor: "main.go", runtime: /^needs Go/ },
];

let ran = 0; let skipped = 0;
afterAll(() => {
  process.stdout.write(`${ran} ran, ${skipped} skipped\n`);
  if (process.env.CI) expect(skipped, "a builtin scanner was skipped under CI").toBe(0);
});
// Vitest runs the last registered after-all hook first, and a hook that
// throws stops the rest: registered here, the cleanup runs before the check
// above, so a failed check still removes this file's temp folders.
afterAll(removeTempDirs);
describe("builtin scanner subprocesses", () => {
  for (const spec of cases) it(`${spec.scanner} reports ${spec.rule} on a changed line`, async () => {
    if (spec.network && process.env.OPENQODEX_E2E_OFFLINE === "1") {
      skipped++; process.stdout.write(`${spec.scanner}: skipped, OPENQODEX_E2E_OFFLINE=1\n`); return;
    }
    const result = await scan(spec);
    const status = result.scan.scanners[0]!;
    // A missing runtime is reported with its reason and the case is skipped.
    if (spec.runtime && status.status === "not_installed") {
      expect(status.reason).toMatch(spec.runtime);
      skipped++; process.stdout.write(`${spec.scanner}: ${status.reason}\n`); return;
    }
    ran++;
    expect(status.status).toBe("ran");
    expect(result.scan.candidates).toContainEqual(expect.objectContaining({ source: spec.scanner, ruleId: spec.rule, filePath: spec.anchor }));
  }, 300_000);

  // golangci-lint caches issues by package content and replays the first
  // folder's absolute paths for the same package elsewhere (two worktrees of
  // one repo), which matched no changed line, so the second scan read clean.
  it("golangci reports gosec in a second checkout of the same package", async () => {
    const spec = cases.find((c) => c.scanner === "golangci")!;
    const first = await scan(spec);
    if (first.scan.scanners[0]!.status === "not_installed") { process.stdout.write(`golangci: ${first.scan.scanners[0]!.reason}\n`); return; }
    const second = await scan(spec);
    expect(second.scan.candidates).toContainEqual(expect.objectContaining({ source: "golangci", ruleId: spec.rule, filePath: spec.anchor }));
  }, 300_000);

  // A package golangci-lint cannot type-check is never linted. The pinned
  // binary must report that in a form the adapter reads, or the scan reads clean.
  it("golangci reports a type-check failure instead of a clean scan", async () => {
    const result = await scan({
      scanner: "golangci",
      rule: "",
      files: {
        "go.mod": "module example.com/broken\n\ngo 1.26\n",
        "main.go": "package main\nimport \"fmt\"\nfunc main() { fmt.Println(undefinedName) }\n",
      },
      anchor: "main.go",
    });
    if (result.scan.scanners[0]!.status === "not_installed") { process.stdout.write(`golangci: ${result.scan.scanners[0]!.reason}\n`); return; }
    expect(result.scan.scanners[0]!.status).toBe("failed");
    expect(result.scan.scanners[0]!.reason).toContain("could not type-check");
    expect(result.scan.scanners[0]!.reason).toContain("undefinedName");
    expect(result.scan.candidates).toEqual([]);
  }, 300_000);

  // Issues 289 and 290: two states of the developer's machine read as a
  // golangci failure, "failed for a reason not listed". A Go file with no
  // go.mod above it, and a module whose dependencies are not in the Go module
  // cache (the scan keeps Go offline), are skips with the fixing command.
  it("golangci skips a changed Go file outside any module with the reason, and does not fail", async () => {
    const result = await scan({
      scanner: "golangci",
      rule: "",
      files: { "tools/gen.go": "package main\nfunc main() {}\n" },
      anchor: "tools/gen.go",
    });
    if (result.scan.scanners[0]!.status === "not_installed") { process.stdout.write(`golangci: ${result.scan.scanners[0]!.reason}\n`); return; }
    expect(result.scan.scanners[0]!.status).toBe("disabled");
    expect(result.scan.scanners[0]!.reason).toBe("not run on tools/: no go.mod at or above these Go files, so they are not in a Go module. To fix, run go mod init <module path> in their folder");
  }, 300_000);

  it("golangci skips a module whose dependencies are not downloaded, names go mod download, and does not fail", async () => {
    const result = await scan({
      scanner: "golangci",
      rule: "",
      files: {
        "go.mod": "module example.com/needsdeps\n\ngo 1.22\n\nrequire github.com/openqodex-test/not-downloaded v1.2.3\n",
        // A real project has its go.sum; only the module cache is empty.
        "go.sum": "github.com/openqodex-test/not-downloaded v1.2.3 h1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\ngithub.com/openqodex-test/not-downloaded v1.2.3/go.mod h1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\n",
        "main.go": "package main\n\nimport \"github.com/openqodex-test/not-downloaded\"\n\nfunc main() { notdownloaded.Do() }\n",
      },
      anchor: "main.go",
    });
    if (result.scan.scanners[0]!.status === "not_installed") { process.stdout.write(`golangci: ${result.scan.scanners[0]!.reason}\n`); return; }
    expect(result.scan.scanners[0]!.status).toBe("disabled");
    expect(result.scan.scanners[0]!.reason).toBe("not run on the Go module at the repository root: its dependencies are not in the Go module cache, such as github.com/openqodex-test/not-downloaded. To fix, run go mod download");
  }, 300_000);

  // The other side of the line above: an import that no required module
  // provides is a defect of the change, so it stays a failure.
  it("golangci still fails on a changed import that no required module provides", async () => {
    const result = await scan({
      scanner: "golangci",
      rule: "",
      files: {
        "go.mod": "module example.com/noreq\n\ngo 1.22\n",
        "main.go": "package main\n\nimport \"github.com/openqodex-test/not-required\"\n\nfunc main() { notrequired.Do() }\n",
      },
      anchor: "main.go",
    });
    if (result.scan.scanners[0]!.status === "not_installed") { process.stdout.write(`golangci: ${result.scan.scanners[0]!.reason}\n`); return; }
    expect(result.scan.scanners[0]!.status).toBe("failed");
    expect(result.scan.scanners[0]!.reason).toContain("could not type-check");
  }, 300_000);

  it("oxlint's React rules stay off for a file outside a React project, and the run says which files had them", async () => {
    const spec: Case = {
      scanner: "oxlint",
      rule: "",
      files: {
        "web/package.json": JSON.stringify({ dependencies: { react: "18.3.1" } }),
        "web/page.tsx": REACT_PAGE,
        "api/package.json": JSON.stringify({ dependencies: { express: "4.21.0" } }),
        "api/hooks.tsx": REACT_PAGE,
      },
      anchor: "",
    };
    const result = await scan(spec);
    expect(result.scan.scanners[0]!.status).toBe("ran");
    const deps = result.scan.candidates.filter((c) => c.ruleId === "react-hooks/exhaustive-deps").map((c) => c.filePath);
    expect(deps).toEqual(["web/page.tsx"]);
    expect([...(result.checked.get("oxlint:react-hooks/exhaustive-deps") ?? [])]).toEqual(["web/page.tsx"]);
  }, 300_000);

  // osv-scanner 2 asks deps.dev and sends file hashes unless told not to;
  // OpenQodex promises names and versions to osv.dev only. A proxy that
  // logs every host the scan opens a tunnel to holds that promise.
  it("osv-scanner reads a bun.lock and opens api.osv.dev only", async () => {
    if (process.env.OPENQODEX_E2E_OFFLINE === "1") return;
    // Resolved first, outside the proxy, so the download is not counted.
    await resolveFirst("osv-scanner");
    const bun = '{\n  "lockfileVersion": 1,\n  "workspaces": { "": { "name": "tiny", "dependencies": { "lodash": "4.17.15" } } },\n  "packages": {\n    "lodash": ["lodash@4.17.15", "", {}, "sha512-x"]\n  }\n}\n';
    const pom = "<project><modelVersion>4.0.0</modelVersion><groupId>a</groupId><artifactId>b</artifactId><version>1</version><dependencies><dependency><groupId>org.apache.logging.log4j</groupId><artifactId>log4j-core</artifactId><version>2.14.1</version></dependency></dependencies></project>\n";
    const { result, hosts } = await withLoggingProxy(() => scan({ scanner: "osv-scanner", rule: "", files: { "bun.lock": bun, "pom.xml": pom }, anchor: "" }));
    expect(result.scan.scanners[0]!.status).toBe("ran");
    expect(result.scan.candidates).toContainEqual(expect.objectContaining({ source: "osv-scanner", ruleId: "GHSA-p6mc-m468-83gw", filePath: "bun.lock" }));
    expect(hosts).toEqual(["api.osv.dev"]);
  }, 300_000);

  // Semgrep writes each rule pack to its temp folder as semgrep-*.rules and
  // never removes them, about 2.7 MB a scan (#76). The developer's temp
  // folder must gain nothing from a scan, and the finding must still come.
  it("semgrep leaves nothing in the developer's temp folder", async () => {
    if (process.env.OPENQODEX_E2E_OFFLINE === "1") return;
    const spec = cases.find((c) => c.scanner === "semgrep")!;
    const repo = plant(spec);
    const developerTmp = tempDir("oq-adapter-developer-tmp-");
    const saved = process.env.TMPDIR;
    process.env.TMPDIR = developerTmp;
    try {
      const result = await scan(spec, repo);
      expect(result.scan.scanners[0]!.status).toBe("ran");
      expect(result.scan.candidates).toContainEqual(expect.objectContaining({ source: "semgrep", ruleId: spec.rule, filePath: spec.anchor }));
    } finally {
      if (saved === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = saved;
    }
    expect(readdirSync(developerTmp)).toEqual([]);
  }, 300_000);

  // A test checks its results with assert, so bandit's B101 raised one
  // security candidate per check in a test file, and the reviewer dropped
  // every one. B101 still guards application code, where python -O removes
  // the assert, and bandit's other rules still read the test file.
  it("an assert in a test file is not raised as a security candidate", async () => {
    const tests = ["tests/test_money.py", "app/money_test.py", "test_cli.py"];
    const testBody = "import subprocess\n\n\ndef test_total(name):\n    assert total([1, 2]) == 3\n    subprocess.call('ls ' + name, shell=True)\n";
    const spec: Case = {
      scanner: "bandit",
      rule: "B101",
      files: { "app/money.py": "def total(xs):\n    assert xs is not None\n    return sum(xs)\n", ...Object.fromEntries(tests.map((t) => [t, testBody])) },
      anchor: "app/money.py",
    };
    const result = await scan(spec);
    expect(result.scan.scanners[0]!.status).toBe("ran");
    const asserts = result.scan.candidates.filter((c) => c.source === "bandit" && c.ruleId === "B101").map((c) => c.filePath);
    expect(asserts).toEqual(["app/money.py"]);
    const shell = result.scan.candidates.filter((c) => c.source === "bandit" && c.ruleId === "B602").map((c) => c.filePath);
    expect(shell.sort()).toEqual([...tests].sort());
  }, 300_000);

  it("gitleaks finds a secret and never puts its value in the scan result", async () => {
    const result = await scan(cases[0]!);
    expect(result.scan.candidates.some((c) => c.ruleId === "stripe-access-token")).toBe(true);
    expect(JSON.stringify(result.scan)).not.toContain(generatedSecret);
  }, 300_000);

  // The scan records each project of the change with the frameworks its
  // manifests list, Flask among them. semgrep's registry packs carry a rule
  // family per web framework whose request rules fire on other frameworks'
  // apps; leaving a family out by framework was measured and rejected
  // (benchmark/index/ledger/scanner.jsonl, SC-0002), so both families still
  // reach the review. Ways it could fail, written before the code:
  //  1. A Flask project is recorded with no framework.
  //  2. A project that lists Django and Flask, or Django or FastAPI alone,
  //     is recorded with another set.
  //  3. A rule family is left out by framework: semgrep's django rules stop
  //     reaching the review from a Flask app.
  it("a scan records Flask for a Flask project, and semgrep's django rules still reach the review from it", async () => {
    if (process.env.OPENQODEX_E2E_OFFLINE === "1") return;
    const SEARCH = (request: string) => `    q = ${request}.get("q", "")\n`;
    const flaskApp = `import sqlite3\n\nfrom flask import Flask, request\n\napp = Flask(__name__)\n\n\n@app.get("/search")\ndef search():\n${SEARCH("request.args")}    conn = sqlite3.connect("items.db")\n    cur = conn.cursor()\n    cur.execute(f"SELECT id FROM items WHERE name = '{q}'")\n    return str(cur.fetchall())\n`;
    const files = {
      "flask/requirements.txt": "flask==3.1.3\n",
      "flask/app.py": flaskApp,
      "both/requirements.txt": 'flask==3.1.3\nDjango==5.0 ; sys_platform == "linux"\n',
      "both/app.py": flaskApp,
      "django/requirements.txt": "Django==5.0\n",
      "django/views.py": `from django.db import connection\nfrom django.http import HttpResponse\n\n\ndef search(request):\n${SEARCH("request.GET")}    with connection.cursor() as cur:\n        cur.execute(f"SELECT id FROM items WHERE name = '{q}'")\n        return HttpResponse(str(cur.fetchall()))\n`,
      "fastapi/requirements.txt": "fastapi==0.115.0\n",
      "fastapi/app.py": `from fastapi import FastAPI, Request\nfrom fastapi.responses import HTMLResponse\n\napp = FastAPI()\n\n\n@app.get("/hello", response_class=HTMLResponse)\ndef hello(request: Request):\n    name = request.query_params.get("name", "")\n    return "<p>Hello " + name + "</p>"\n`,
    };
    const result = await scan({ scanner: "semgrep", rule: "", files, anchor: "" });
    expect(result.scan.scanners[0]!.status).toBe("ran");
    // 1, 2.
    expect(result.scan.projects).toEqual([
      { root: "both", frameworks: ["django", "flask"] },
      { root: "django", frameworks: ["django"] },
      { root: "fastapi", frameworks: ["fastapi"] },
      { root: "flask", frameworks: ["flask"] },
    ]);
    // 3.
    const rules = (file: string, family: string) => result.scan.candidates.filter((c) => c.filePath === file && c.ruleId.startsWith(family)).map((c) => c.ruleId);
    expect(rules("flask/app.py", "python.django.")).toContain("python.django.security.injection.tainted-sql-string.tainted-sql-string");
    expect(rules("flask/app.py", "python.flask.")).toContain("python.flask.security.injection.tainted-sql-string.tainted-sql-string");
  }, 300_000);

  // The fixture filter drops the finding, so only the trail keeps its file,
  // and that file's name is the secret.
  it("a secret gitleaks finds in a fixture file named after it never reaches the scan's trail", async () => {
    const file = `fixtures/${generatedSecret}.txt`;
    const result = await scan({ scanner: "gitleaks", rule: "stripe-access-token", files: { [file]: `STRIPE_KEY = '${generatedSecret}'\n` }, anchor: file });
    const entries = (result.scan.trail ?? []).filter((e) => e.token === "gitleaks:stripe-access-token");
    expect(entries.map((e) => e.stage)).toEqual(["fixture"]);
    expect(entries[0]!.file).toBe(`fixtures/${REDACTED}.txt`);
    expect(JSON.stringify(result.scan)).not.toContain(generatedSecret);
  }, 300_000);
});
