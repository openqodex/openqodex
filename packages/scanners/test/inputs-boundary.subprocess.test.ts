// What a built-in scanner may be handed from the repository: a regular file
// inside it, reached through no link. A change can add a file that is a
// symbolic link to anything on the machine, under a name a scanner checks
// (`report.sql`, a workflow, a Dockerfile); a scanner handed that name opens
// whatever the link points at and puts it in a finding or an error. Each
// case plants such a link to a sentinel outside the repository that no one
// can read, so a scanner that followed it fails with a permission error,
// and asserts the scanner neither failed on it nor reported anything there.
// Run by the end-to-end config (tests/e2e/adapters.test.ts).
import { makeLineSet } from "../../../tests/line-set.mjs";
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseConfig } from "@openqodex/core";
import type { BuiltinScanner } from "@openqodex/core";
import { runScanners } from "@openqodex/scanners";
import { afterAll, describe, expect, it } from "vitest";
import { installedOnly } from "./subprocess-support.js";
import { removeTempDirs, tempDir } from "../../../tests/temp-dirs.mjs";

// Removes the temp folders this file made.
afterAll(removeTempDirs);

// The name each scanner checks, and a body with a problem it reports, so a
// scanner that could read the sentinel would have something to say.
const LINKS: [BuiltinScanner, string, string][] = [
  ["sqlfluff", "reports/active.sql", "SELECT id FROM users WHERE deleted_at = NULL;\n"],
  ["squawk", "db/migrations/0002.sql", "CREATE INDEX orders_customer_idx ON orders (customer_id);\n"],
  ["zizmor", ".github/workflows/greet.yml", 'on: pull_request\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo "${{ github.event.pull_request.title }}"\n'],
  ["zizmor", ".github/actions/greet/action.yml", 'name: g\ndescription: d\nruns:\n  using: composite\n  steps:\n    - run: echo "${{ github.event.issue.title }}"\n      shell: bash\n'],
  ["actionlint", ".github/workflows/greet.yml", 'on: pull_request\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo "${{ github.event.pull_request.title }}"\n'],
  ["hadolint", "Dockerfile", "FROM python:latest\n"],
  ["shellcheck", "scripts/deploy.sh", "#!/bin/sh\nrm -rf $DIR/\n"],
  ["ruff", "app/main.py", "import os\n"],
  ["bandit", "app/main.py", "import subprocess\nsubprocess.call(input(), shell=True)\n"],
  ["oxlint", "web/app.js", "debugger;\n"],
  ["osv-scanner", "package-lock.json", '{"name":"x","lockfileVersion":3,"packages":{"":{"name":"x"},"node_modules/lodash":{"version":"4.17.15"}}}\n'],
  ["tflint", "infra/variables.tf", 'variable "region" {\n  type = string\n}\n'],
  ["trivy", "infra/main.tf", 'resource "aws_security_group" "w" {\n  ingress {\n    from_port   = 22\n    to_port     = 22\n    protocol    = "tcp"\n    cidr_blocks = ["0.0.0.0/0"]\n  }\n}\n'],
  ["checkov", "infra/main.tf", 'resource "aws_security_group" "w" {\n  ingress {\n    from_port   = 22\n    to_port     = 22\n    protocol    = "tcp"\n    cidr_blocks = ["0.0.0.0/0"]\n  }\n}\n'],
  ["kube-linter", "k8s/pod.yaml", "apiVersion: v1\nkind: Pod\nmetadata:\n  name: a\nspec:\n  containers:\n    - name: a\n      image: nginx:1.27\n      securityContext:\n        privileged: true\n"],
  ["cargo-deny", "Cargo.lock", 'version = 3\n\n[[package]]\nname = "x"\nversion = "0.1.0"\n'],
];

describe("a changed file that is a link out of the repository", () => {
  for (const [scanner, name, body] of LINKS) {
    it(`${scanner} never reads ${name} when it links outside the repository`, async () => {
      const outside = tempDir("oq-outside-");
      const sentinel = join(outside, "sentinel");
      writeFileSync(sentinel, body);
      chmodSync(sentinel, 0o000);
      const repo = tempDir(`oq-link-${scanner}-`);
      mkdirSync(dirname(join(repo, name)), { recursive: true });
      symlinkSync(sentinel, join(repo, name));
      const coverage = new Map([[name, makeLineSet(body.split("\n").map((_, i) => i + 1))]]);
      const result = await runScanners({ repoDir: repo, changedPaths: [name], coverage, config: parseConfig("").config, resolveTool: installedOnly(), only: [scanner] });
      const status = result.scan.scanners[0]!;
      // A scanner this machine cannot run (no Cargo, no Ruby) proves nothing here.
      if (status.status === "not_installed") return;
      expect(status.status, status.reason ?? "").not.toBe("failed");
      expect(status.reason ?? "").not.toMatch(/permission|denied|EACCES/i);
      expect(result.scan.candidates.filter((c) => c.source === scanner && c.filePath === name)).toEqual([]);
    }, 300_000);
  }
});
