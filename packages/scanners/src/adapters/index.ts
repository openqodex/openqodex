// The built-in scanners. Each adapter names the files of a change it
// checks (`files`), so the toolchain is never asked for a tool the change
// does not need, and runs its tool from the resolved path (`run`). The
// selector (select.ts) asks every adapter the same questions for a review,
// init, doctor and the GitHub Action.
import type { AdapterResult, BuiltinScanner, DiffCoverage, ResolvedTool } from "@openqodex/core";
import type { RepoFacts } from "../detect.js";
import type { Scratch } from "../scratch.js";
import { ruffPyproject, sqlfluffIni, sqlfluffPyproject, type SettingsReader } from "../shared-settings.js";
import { actionlint } from "./actionlint.js";
import { bandit } from "./bandit.js";
import { brakeman } from "./brakeman.js";
import { checkov } from "./checkov.js";
import { cargoDeny } from "./cargo-deny.js";
import { gitleaks } from "./gitleaks.js";
import { golangci } from "./golangci.js";
import { hadolint } from "./hadolint.js";
import { kubeLinter } from "./kube-linter.js";
import { kubeconform } from "./kubeconform.js";
import { osvScanner } from "./osv-scanner.js";
import { oxlint } from "./oxlint.js";
import { rubocop } from "./rubocop.js";
import { ruff } from "./ruff.js";
import { semgrep } from "./semgrep.js";
import { shellcheck } from "./shellcheck.js";
import { sqllint } from "./sql-lint.js";
import { sqlfluff } from "./sqlfluff.js";
import { squawk, SQUAWK_CONFIG } from "./squawk.js";
import { tflint } from "./tflint.js";
import { trivy } from "./trivy.js";
import { zizmor, ZIZMOR_CONFIGS } from "./zizmor.js";

export type Adapter = {
  source: BuiltinScanner;
  // The paths of the change this scanner checks; none means it has nothing
  // to check. `facts` says which project each path is in and what an
  // extensionless file is.
  files(changedPaths: string[], facts: RepoFacts): string[];
  // Why it runs, in a few words, for the selection line: "Python files,
  // such as app/views.py", or for brakeman "Rails app in backend/".
  why(files: string[], facts: RepoFacts): string;
  // The project folders that decide how it runs, for the selection record.
  projects?(files: string[], facts: RepoFacts): string[];
  // Why it does not run when `files` is empty, if more can be said than
  // "nothing to check".
  idle?(changedPaths: string[], facts: RepoFacts): string | null;
  // A reason this scanner must not run at all (for example dependency
  // lookups while offline), known before any tool is resolved.
  skip?(): string | null;
  // `tool` is null only for the in-process sqllint. `coverage` is the
  // changed lines, for adapters that choose between places to anchor a
  // finding. `scratch`: where the run may write (scratch.ts); an adapter
  // makes its temporary folders and caches there and nowhere else.
  run(args: {
    repoDir: string;
    changedPaths: string[];
    tool: ResolvedTool | null;
    coverage?: DiffCoverage;
    facts: RepoFacts;
    scratch: Scratch;
  }): Promise<AdapterResult>;
};

// Scanners that run inside OpenQodex and need no tool resolved.
export const IN_PROCESS: ReadonlySet<BuiltinScanner> = new Set<BuiltinScanner>(["sqllint"]);

// The ensemble in merge order. The order is load-bearing: dedup ties go to
// the first, so semgrep precedes gitleaks.
export const ADAPTERS: readonly Adapter[] = [
  semgrep,
  gitleaks,
  // In-process SQL / Postgres analyzer. No-op without changed .sql files.
  sqllint,
  // Postgres migration safety: locks, rewrites, lost data.
  squawk,
  // SQL queries that return a wrong result or hold dead code.
  sqlfluff,
  // Dependency vulnerabilities. No-op unless a lockfile changed.
  osvScanner,
  // Rust dependency policy: RustSec advisories and crate sources. No-op
  // unless a Cargo.lock changed.
  cargoDeny,
  // GitHub Actions workflows under .github/workflows/.
  actionlint,
  // GitHub workflow, action and Dependabot security.
  zizmor,
  // Dockerfiles.
  hadolint,
  // Terraform, Kubernetes and CloudFormation misconfiguration.
  trivy,
  // The same files, by Checkov's checks; deduplicated against trivy's on the same lines.
  checkov,
  // Terraform language mistakes.
  tflint,
  // Kubernetes objects: workload and RBAC checks, then schema validity.
  kubeLinter,
  kubeconform,
  // .sh / .bash scripts.
  shellcheck,
  // Python lint.
  ruff,
  // Rails SAST: a changed Rails-relevant file in a Rails app, run in that app.
  brakeman,
  // Ruby lint.
  rubocop,
  // Python SAST.
  bandit,
  // JavaScript and TypeScript lint.
  oxlint,
  // Go lint and gosec.
  golangci,
];

// The settings and ignore files each scanner really reads from the scanned
// tree, as the adapter runs it. A change to one can hide that scanner's
// findings, so the runner notes it. `path` with no folder and `anyFolder`
// false: only the copy at the repository root (the scanner's working folder
// or the adapter's own lookup). `anyFolder`: that name in any folder, which
// the tool finds by walking up from the scanned file. `reader`: a file the
// scanner shares with other tools (pyproject.toml, setup.cfg), which counts
// only when what the scanner reads from it differs between the base and the
// head, as shared-settings.ts reads it.
// Not listed: oxlint, rubocop, brakeman, golangci, checkov, tflint and
// kube-linter run on settings of their own; kubeconform reads no settings
// file; bandit reads `.bandit` only with -r, which the adapter never passes
// (it names the files).
export type SettingsFile = { path: string; anyFolder?: true; reader?: SettingsReader };

export const SETTINGS_FILES: Partial<Record<BuiltinScanner, readonly SettingsFile[]>> = {
  // gitleaks.ts: the root config and the root ignore list only.
  gitleaks: [{ path: ".gitleaks.toml" }, { path: "gitleaks.toml" }, { path: ".gitleaksignore" }],
  // semgrep, run from the repository root.
  semgrep: [{ path: ".semgrepignore" }],
  // ruff finds its config from each file's folder upwards.
  ruff: [{ path: "ruff.toml", anyFolder: true }, { path: ".ruff.toml", anyFolder: true }, { path: "pyproject.toml", anyFolder: true, reader: ruffPyproject }],
  // hadolint, run from the repository root.
  hadolint: [{ path: ".hadolint.yaml" }, { path: ".hadolint.yml" }],
  // shellcheck looks from each script's folder upwards.
  shellcheck: [{ path: ".shellcheckrc", anyFolder: true }, { path: "shellcheckrc", anyFolder: true }],
  // osv-scanner reads the one beside each lockfile.
  "osv-scanner": [{ path: "osv-scanner.toml", anyFolder: true }],
  // actionlint finds .github from the repository root.
  actionlint: [{ path: ".github/actionlint.yaml" }, { path: ".github/actionlint.yml" }],
  // cargo-deny looks from the project's folder upwards for its licence
  // exceptions; OpenQodex runs no licence check, but a broken file stops it.
  "cargo-deny": [{ path: "deny.exceptions.toml", anyFolder: true }, { path: ".deny.exceptions.toml", anyFolder: true }],
  // zizmor.ts: the first of these at the repository root, passed by path.
  zizmor: ZIZMOR_CONFIGS.map((path) => ({ path })),
  // squawk.ts: the root .squawk.toml, passed by path.
  squawk: [{ path: SQUAWK_CONFIG }],
  // sqlfluff finds these from each file's folder upwards, and reads only its
  // own sections of the shared files.
  sqlfluff: [
    { path: ".sqlfluff", anyFolder: true },
    { path: ".sqlfluffignore", anyFolder: true },
    { path: "setup.cfg", anyFolder: true, reader: sqlfluffIni },
    { path: "tox.ini", anyFolder: true, reader: sqlfluffIni },
    { path: "pep8.ini", anyFolder: true, reader: sqlfluffIni },
    { path: "pyproject.toml", anyFolder: true, reader: sqlfluffPyproject },
  ],
  // trivy.ts hands trivy the ignore list at the repository root.
  trivy: [{ path: ".trivyignore" }],
};
