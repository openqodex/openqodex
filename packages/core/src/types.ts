// Shared contracts for every OpenQodex package. Code against these types;
// a change here is agreed first, never made inside a feature branch.

// ---------- scanners ----------

export type BuiltinScanner =
  | "semgrep"
  | "gitleaks"
  | "sqllint"
  | "osv-scanner"
  | "actionlint"
  | "hadolint"
  | "shellcheck"
  | "ruff"
  | "brakeman"
  | "rubocop"
  | "bandit"
  | "oxlint"
  | "golangci";

// A custom scanner from .openqodex.yaml is "custom:<name>".
export type ScannerSource = BuiltinScanner | `custom:${string}`;

// The scale scanners speak. Never shown to the developer as a threshold.
export type ScannerSeverity = "critical" | "high" | "medium" | "low" | "info";

// The one scale the developer sees, shared with the hosted product.
export type Severity = "critical" | "major" | "minor" | "nitpick" | "info";

export type Category = "bug" | "security" | "performance" | "maintainability" | "style";

// What an adapter returns, before ids are assigned.
export type StaticFinding = {
  source: ScannerSource;
  ruleId: string;
  filePath: string; // repo-relative, forward slashes
  lineStart: number;
  lineEnd: number;
  severity: ScannerSeverity;
  message: string; // secrets already redacted by the adapter
  reference: string | null;
};

// A scanner finding that survived the changed-line filter, the fixture
// filter and dedup. `id` is "c1", "c2", ... in report order and is stable
// for one scan. `token` is "<source>:<ruleId>", the citation an agent uses.
export type Candidate = StaticFinding & {
  id: string;
  token: string;
  reviewSeverity: Severity;
};

export type ScannerStatus =
  | "ran"
  | "no_matching_files"
  | "not_installed"
  | "installing"
  | "failed"
  | "disabled"
  | "untrusted";

export type ScannerRunSummary = {
  scanner: ScannerSource;
  status: ScannerStatus;
  version: string | null;
  rawCount: number;
  keptCount: number;
  durationMs: number;
  // One plain line for every status except "ran" and "no_matching_files".
  reason: string | null;
};

// A secret a scanner matched, kept only as its length and sha256 so later
// steps can redact it from text without the secret ever being stored.
export type SecretFingerprint = { length: number; sha256: string };

export type ScanResult = {
  candidates: Candidate[];
  scanners: ScannerRunSummary[];
  fixturesDropped: number;
  secretFingerprints: SecretFingerprint[];
};

// What one adapter run returns to the runner. `secrets` are the raw matched
// strings, held in memory only, never written or printed.
export type AdapterResult = {
  findings: StaticFinding[];
  error: string | null;
  secrets?: string[];
  // Set when the adapter chose not to run (for example dependency lookups
  // while offline). The runner records status "disabled" with this reason.
  skipped?: string | null;
};

// One row of `openqodex doctor`.
export type ToolStatus = {
  scanner: BuiltinScanner;
  state: "ready" | "will_install" | "needs_runtime" | "installing" | "unsupported";
  version: string;
  detail: string | null;
};

// ---------- toolchain ----------

export type ResolvedTool = {
  path: string; // absolute path of the executable
  version: string;
  env: Record<string, string>; // extra variables this tool needs (GEM_HOME, PATH additions)
};

export type ToolResolution =
  | { ok: true; tool: ResolvedTool }
  | { ok: false; status: "not_installed" | "installing" | "failed"; reason: string };

// The runner calls this only for a scanner whose file gate matched the change.
export type ResolveTool = (scanner: BuiltinScanner) => Promise<ToolResolution>;

// ---------- change ----------

// Path to the set of new-side line numbers the developer added or changed.
export type DiffCoverage = Map<string, Set<number>>;

export type ChangeScope = {
  base?: string; // explicit ref
  uncommitted?: boolean; // diff against HEAD only
  // Compare the tree to `base` itself, never its merge base with HEAD: the
  // pre-push hook's remote tip, so a force push to an ancestor shows the
  // code it removes.
  exact?: boolean;
};

export type ChangedFile = {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  oldPath: string | null;
  binary: boolean;
};

export type Change = {
  repoRoot: string;
  baseRef: string; // what the base was resolved from, for display
  baseSha: string;
  id: string; // sha256 hex of baseSha + "\n" + `git diff --cached --raw -z --no-abbrev <base>`; covers binary files and anything past the diff cap
  shortId: string;
  files: ChangedFile[]; // everything in the change, exclusions already applied
  changedPaths: string[]; // files that still exist (not deleted), what scanners receive
  coverage: DiffCoverage; // from the zero-context diff
  diff: string; // the three-lines-of-context diff, capped
  notReviewed: string[]; // paths left out because the change was too large
  stats: { files: number; additions: number; deletions: number };
};

// ---------- config ----------

export type JsonMap = {
  items: string; // dotted path to the array; "." means the root
  file: string;
  line: string;
  end_line: string | null;
  rule: string;
  severity: string | null;
  message: string;
  reference: string | null;
  severity_map: Record<string, ScannerSeverity>;
};

export type CustomInstall =
  | { kind: "github-release"; asset: string | null; binary: string | null; sha256: string | null }
  | { kind: "path" }
  | { kind: "npm"; spec: string }
  | { kind: "uv"; spec: string };

export type CustomScanner = {
  name: string; // default: the repo name from `source`
  source: string; // the GitHub link
  run: string; // the command line, split into arguments, never run through a shell
  version: string | null; // null: the latest release at trust time
  format: "sarif" | "json-map";
  map: JsonMap | null;
  paths: string[] | null; // null: every changed file
  target: "changed" | "repo";
  timeoutSeconds: number;
  install: CustomInstall;
};

export type Config = {
  blockOnSeverity: Severity | null; // null: warn only
  severityThreshold: Severity; // findings below this stay out of the report, unless at or above blockOnSeverity; default "minor", as in the hosted product
  exclude: string[];
  disabledRules: string[];
  defaultBase: string | null; // the branch or ref the default scope diffs against when there is no upstream; null: the remote's default branch
  includeFixtures: boolean;
  disabledScanners: BuiltinScanner[];
  custom: CustomScanner[];
  graph: { enabled: boolean; budgetMs: number; maxFiles: number; maxFileBytes: number }; // the code graph in the brief; enabled by default
};

export type LoadedConfig = {
  config: Config;
  path: string | null; // null: no config file, defaults in use
  warnings: string[];
};

// ---------- code graph, as the report and the brief see it ----------
// Serializable. The graph package builds it; the brief and the report show it.
// Ids reference `symbols`. Counts describe what was observed, never what was
// not seen. "ok" means the extraction finished, not that every call resolved.

export type ImpactKind = "file" | "function" | "method" | "class" | "module" | "type";

export type ImpactSymbol = {
  id: string; // file, lexical owner, name and declaration position; unique in the graph
  file: string;
  name: string;
  kind: ImpactKind;
  startLine: number;
  endLine: number;
  snapshot: "base" | "current"; // "base" for a symbol that the change removed
};

export type ImpactSite = {
  file: string;
  line: number;
  column: number;
  confidence: "high" | "low";
  // What proved the edge: a lexical or import binding, a receiver whose type
  // is known, or a Ruby constant found by autoload convention.
  evidence: "binding" | "receiver-type" | "autoload";
};

export type ImpactEdge = {
  from: string; // symbol id
  to: string; // symbol id
  kind: "calls" | "inherits" | "imports";
  sites: ImpactSite[]; // every site, never only the first
};

// A caller reached in one or two hops, with the actual edges walked.
export type ImpactPath = {
  seed: string; // the touched symbol id
  edges: [ImpactEdge] | [ImpactEdge, ImpactEdge];
};

export type ImpactSummary = {
  version: 1;
  status: "ok" | "partial" | "off" | "skipped" | "failed";
  reasons: string[]; // one plain line each when status is not "ok"
  risk: "none" | "low" | "medium" | "high" | null; // null when the graph did not run
  build: {
    durationMs: number;
    cacheHits: number;
    eligibleFiles: number;
    parsedFiles: number;
    omittedFiles: number; // over the size cap, past the budget or the file cap
    unresolvedSites: number; // call sites no rule could bind
  };
  symbols: ImpactSymbol[];
  touched: string[]; // symbol ids whose span overlaps a changed line
  removed: string[]; // symbol ids present in the base version of a changed file and gone now
  callers: ImpactPath[];
  callees: ImpactPath[];
  importers: ImpactEdge[]; // files that import a changed file
  hubs: { symbol: string; callers: number; sites: number; files: number }[];
  truncated: { walk: boolean; inline: boolean; omittedSites: number | null };
};

// ---------- review ----------

export type SelectedLens = {
  name: string;
  description: string;
  confidenceFloor: number;
  body: string;
};

// What the host agent writes. Field names match the hosted finding.
export type AgentFinding = {
  severity: Severity;
  category: Category;
  confidence: number; // 0 to 1
  file_path: string;
  line_number: number;
  line_end?: number;
  title: string;
  description: string;
  suggested_change: string | null; // the schema reads a missing value as null
  source: string | null; // null, a candidate token, or "lens:<name>"; missing reads as null
  candidate?: string | null; // the candidate id this finding raises, when it raises one
};

export type AgentSubmission = {
  version: 1;
  change_id: string;
  summary: string;
  findings: AgentFinding[];
  dropped?: { candidate: string; reason: string }[];
  // Who reviewed: a separate subagent, or the agent that wrote the code.
  reviewer?: "subagent" | "same-agent";
};

export type ReportFinding = {
  origin: "agent" | "scanner";
  severity: Severity;
  category: Category;
  confidence: number | null; // null for a scanner finding
  file_path: string;
  line_number: number;
  line_end: number;
  title: string;
  description: string;
  suggested_change: string | null;
  source: string | null;
  candidate: string | null;
  notes: string[]; // what finalize flagged, in plain words
};

export type Verdict = "passed" | "blocked";

export type Report = {
  version: 1;
  kind: "scan" | "review";
  change_id: string;
  base: { ref: string; sha: string };
  generated_at: string; // ISO 8601
  verdict: Verdict;
  block_on_severity: Severity | null;
  summary: string | null;
  // Findings on lines the developer changed. Only these and `not_reviewed`
  // count toward the verdict.
  findings: ReportFinding[];
  // How many findings on changed lines were left out of `findings` because
  // they sit below review.severity_threshold (and below block_on_severity).
  below_threshold: number;
  // Findings whose file is not in the change or whose line range touches no
  // changed line. Shown, never counted toward the verdict.
  outside_change: ReportFinding[];
  // review only: agent findings dropped for low confidence, with the floor
  low_confidence: { title: string; file_path: string; confidence: number; floor: number }[];
  // review only: candidates the agent neither raised nor dropped. They count
  // toward the verdict at their reviewSeverity.
  not_reviewed: Candidate[];
  // review only: candidates the agent dropped, with its reason
  dropped: { candidate: Candidate; reason: string }[];
  scanners: ScannerRunSummary[];
  // The code graph's view of the change. Always present: status "off",
  // "skipped" or "failed" says why there is nothing in it.
  impact: ImpactSummary | null;
  not_reviewed_paths: string[]; // Change.notReviewed
  stats: { files: number; additions: number; deletions: number };
};

// manifest.json in the report folder, written by `review --agent`, read by
// `review --finalize` so a review is bound to the change, the config and the
// scan it was briefed on.
export type RunManifest = {
  version: 1 | 2 | 3; // 2: the submission must name its reviewer; 3: runtime_version is set
  change_id: string;
  config_hash: string; // sha256 of the canonical JSON of the effective Config
  created_at: string;
  lenses: { name: string; confidenceFloor: number }[];
  // sha256 of .openqodex/custom-instructions.md as the brief read it, null
  // when there was none; absent in runs made before the field existed.
  instructions_hash?: string | null;
  // The openqodex version that wrote the brief; finalize runs on that
  // version. Absent in manifests before version 3.
  runtime_version?: string;
};

// What the agent hook does. It never allows: allowing would skip the
// developer's own permission prompt for the push.
export type PushDecision = {
  decision: "abstain" | "deny";
  message: string | null; // shown to the agent and the developer when set
};

// .openqodex/latest.json
export type Latest = {
  dir: string; // repo-relative report folder
  change_id: string;
  kind: "scan" | "review";
  finalized: boolean; // true only after `review --finalize` accepted a submission
  verdict: Verdict | null;
};

// ---------- errors ----------

// Thrown for anything that is the tool's or the input's fault: bad flag,
// invalid config, not a git repository, stale or invalid submission.
// The CLI prints `message` and exits 2.
export class OpenQodexError extends Error {
  readonly exitCode = 2;
  constructor(message: string) {
    super(message);
    this.name = "OpenQodexError";
  }
}
