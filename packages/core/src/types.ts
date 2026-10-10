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
  | "golangci"
  | "zizmor"
  | "trivy"
  | "squawk"
  | "kube-linter"
  | "tflint"
  | "kubeconform"
  | "cargo-deny"
  | "checkov"
  | "sqlfluff";

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
  // The tokens of other scanners' findings that named the same problem on
  // the same lines and were merged into this one; absent when none were.
  alsoReportedBy?: string[];
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
  // The projects the changed files belong to (the nearest folder holding a
  // manifest, "" for the repo root) and the frameworks read from their
  // dependency lists. Absent in a scan an older version saved.
  projects?: { root: string; frameworks: string[] }[];
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
  // What the run left out that is not a failure, such as a folder held back
  // from a scanner that would download from it. The scanner still ran; the
  // runner keeps this as its reason.
  note?: string | null;
  // Rules this run checked, as "<source>:<ruleId>" tokens, with the files it
  // checked them on. A review pattern (lens) one of them covers stands down
  // for those files.
  checked?: { token: string; files: string[] }[];
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

// A place where the change only removed lines: `lines` lines were deleted
// after new-side line `after` (0: at the top of the file). Its `anchors`, the
// new file's lines on either side of it that exist (line 1 for an emptied or
// deleted file), count as changed when a finding is cited, so a change that
// only deletes a check can carry a finding.
export type DeletionPoint = { after: number; lines: number; anchors: number[] };

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
  deletionPoints: Map<string, DeletionPoint[]>; // from the same diff, per file that still exists
  diff: string; // the three-lines-of-context diff, capped
  // The same diff split per file, in the same order; absent where a caller built a Change by hand.
  diffs?: { path: string; text: string }[];
  notReviewed: string[]; // paths left out because the change was too large
  // Changed text files past the coverage cap, whose changed lines are not
  // known: a review counts one as read only when the reviewer read all of it.
  // Absent where a caller built a Change by hand.
  uncovered?: string[];
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
  // the code graph in the brief; enabled by default. maxFiles caps new parses per build.
  graph: { enabled: boolean; budgetMs: number; maxFiles: number; maxFileBytes: number; maxCacheMb: number; maxHeapMb: number };
};

export type LoadedConfig = {
  config: Config;
  path: string | null; // null: no config file, defaults in use
  warnings: string[];
};

// ---------- code graph, as the report and the brief see it ----------
// Serializable. The graph package builds it; the brief and the report show it.
// Ids reference `symbols`. Counts describe what was observed, never what was
// not seen: a count that cannot be known is null, never zero. "ok" means the
// extraction finished, not that every call resolved; `unknown` says what the
// graph could not see.

export type ImpactKind = "file" | "function" | "method" | "class" | "module" | "type";

export type ImpactSymbol = {
  id: string; // file, lexical owner, name and declaration position; unique in the graph
  file: string;
  name: string;
  kind: ImpactKind;
  startLine: number;
  endLine: number;
  snapshot: "base" | "current"; // "base" for a symbol that the change removed
  // On a removed symbol the change moved: its definition now. Set when
  // exactly one file of the change gained a definition of the same kind,
  // owner and name (or git saw the file renamed), or one definition with
  // the same body under another name (`renamed`), and no call site still
  // reaches the old place.
  movedTo?: { id: string; file: string; line: number; renamed?: boolean };
};

// "certain": an import, a definition in the same scope or a known receiver
// type proves the call, and every step it rests on is proved. "likely": a
// stated convention picked the one target; `note` says which. "possible":
// the call may reach this definition and nothing proves it does: a call
// through an interface or a base type to one of its implementations, or a
// function used as a value that a callee, an alias, a table or a returned
// value may call.
export type ImpactTier = "certain" | "likely" | "possible";

export type ImpactSite = {
  file: string;
  line: number;
  column: number;
  tier: ImpactTier;
  // What proved it: same-scope, import, ts-paths, workspace-package,
  // py-root, go-module, receiver-constructor, receiver-annotation,
  // receiver-result, receiver-field, receiver-self or autoload; for a
  // possible site, dispatch-implements, dispatch-override, method-set,
  // invocation-summary, value-alias, value-table or returned-value.
  evidence: string;
  // The import line that proved a binding through a module.
  via: { file: string; line: number; spec: string | null } | null;
  note: string | null; // why it is not certain, in one sentence
  rule: string;
};

// The relations of the code graph. A caller list walks calls, inherits,
// implements, dispatches_to (a call through an interface or a base type to
// an implementation) and may_invoke (a function value a callee, an alias, a
// table or a returned value may call). The other uses of a symbol are
// overrides, uses_value and uses_type.
export type ImpactEdgeKind = "calls" | "inherits" | "implements" | "dispatches_to" | "may_invoke" | "overrides" | "uses_value" | "uses_type" | "imports";

export type ImpactEdge = {
  from: string; // symbol id
  to: string; // symbol id
  kind: ImpactEdgeKind;
  sites: ImpactSite[]; // every site, never only the first
};

// A caller reached in one or two hops, with the actual edges walked.
export type ImpactPath = {
  seed: string; // the touched symbol id
  edges: [ImpactEdge] | [ImpactEdge, ImpactEdge];
};

// One thing the graph could not see near the change.
export type ImpactUnknown = {
  file: string | null;
  line: number | null;
  name: string | null; // the function or member name called, when there is one
  cause: string; // no-receiver-type, ambiguous, miss, dynamic, file-not-parsed, budget, memory, ...
  scope: "file" | "project" | "workspace";
  note: string | null;
  candidates: string[] | null;
};

// A cut the walk or the build made. `omitted` is null when it cannot be
// counted (a stop at a budget cannot count what lies past it).
export type ImpactCut = { by: string; at: string | null; omitted: number | null; exact: boolean; unit: string; note: string };

// A public name a changed file exported in the base version and no longer
// exports (`removed`), or exports bound to another definition now
// (`retargeted`), with the consumers that reached it in the base version.
export type ImpactExportChange = {
  file: string;
  name: string;
  change: "removed" | "retargeted";
  line: number | null; // where the base version exported it
  before: { id: string; file: string; line: number } | null;
  after: { id: string; file: string; line: number } | null;
  // Each consumer the base version bound through this name, and what the
  // same site binds to now: nothing, another definition, or the same one;
  // "unknown" when the consumer's own file changed, so the site has no
  // twin to compare. The summary keeps the first 200 in file and line
  // order; the review's packet lists every one.
  consumers: { file: string; line: number; column: number; from: string; now: "broken" | "retargeted" | "unchanged" | "unknown" }[];
  consumersTotal: number; // every consumer, never cut
};

export type ImpactSummary = {
  version: 2;
  status: "ok" | "partial" | "off" | "skipped" | "failed";
  reasons: string[]; // one plain line each when status is not "ok"
  risk: "none" | "low" | "medium" | "high" | null; // null when the graph did not run
  build: {
    durationMs: number;
    cacheHits: number;
    parses: number;
    eligibleFiles: number;
    parsedFiles: number; // files in the graph
    omittedFiles: number; // over the size cap, past the budget, the parse cap or the memory bound
    unresolvedSites: number | null; // call sites in the repository no rule could bind; null when not counted
    externalSites: number | null; // calls into declared dependencies and the standard library
    mode: "fresh" | "retained" | null;
    generation: string | null; // the build id in .openqodex/graph/, null when not saved
  };
  symbols: ImpactSymbol[];
  touched: string[]; // symbol ids whose span overlaps a changed line
  removed: string[]; // symbol ids present in the base version of a changed file and gone now; a moved one has `movedTo`
  callers: ImpactPath[]; // every step certain or likely
  // Callers that may reach the touched code and are not proved to, one or
  // two hops: a path with a possible step (dispatches_to, may_invoke) is
  // here, never in `callers`. Absent before the graph knew dispatch.
  possible?: ImpactPath[];
  // Uses of the touched and removed symbols that are not calls, one hop:
  // used as a value, named as a type, implemented or overridden. Absent
  // before the graph knew them.
  references?: { seed: string; edge: ImpactEdge }[];
  callees: ImpactPath[];
  importers: ImpactEdge[]; // files that import a changed file
  hubs: { symbol: string; callers: number; sites: number; files: number }[];
  exports: ImpactExportChange[];
  // What the graph could not see. `floor` is true when any listed caller
  // count may be short: a call of the same name was not bound, a file of
  // the project was not read, a call through a value could reach it, or a
  // walk was cut. Per seed, with its reasons.
  unknown: {
    floor: boolean;
    seeds: { seed: string; floor: boolean; reasons: string[] }[];
    causes: Record<string, number | null>; // counts of unbound sites near the change, by cause
    near: ImpactUnknown[]; // in the changed files and their callers' files, at most 40
    nearTotal: number;
    notRead: { file: string; reason: string }[]; // eligible files left out, at most 40
    notReadTotal: number;
  };
  cuts: ImpactCut[];
  truncated: { walk: boolean; inline: boolean; omittedSites: number | null };
  // The folder the reviewer opens for everything the brief leaves out,
  // relative to the root it reads (the review snapshot); null when none was written.
  packet: string | null;
  // What the framework plugins say about the change: the routes that reach
  // it, the templates it renders, the migrations of a changed model, the
  // tests that reference, call or may request it. Absent when the framework
  // stage did not run.
  frameworks?: ImpactFrameworks;
};

// A route registration listed for a change: because it reaches touched code
// (`reach`), because it is declared on a changed line (`declared`), or
// because its handler is gone (`status` other than "bound").
export type ImpactFrameworkRoute = {
  plugin: string;
  app: string | null;
  registration: string;
  methods: string[];
  pattern: string | null; // null when computed
  partial?: string | null; // when pattern is null: the known parts, each computed part shown as "{computed}"
  name: string | null;
  site: { file: string; line: number };
  handler: string; // as written at the registration
  status: "bound" | "missing" | "dynamic" | "external" | "ambiguous" | "unresolved";
  mounted: boolean; // false when no application root includes its route table
  reach: { seed: string; seedName: string; hops: number; tier: ImpactTier; note: string | null } | null;
  declared: boolean;
};

// A static association between a test and the touched code. Never coverage.
export type ImpactFrameworkTest = {
  test: string;
  testName: string;
  target: string;
  targetName: string;
  category: string; // direct-call, route-request, route-name, subject, component-render, type-or-value-reference
  through: string | null; // the route the test requests or names, as "GET blog/<int:pk>/"
  tier: ImpactTier;
  note: string | null;
  site: { file: string; line: number };
};

export type ImpactFrameworks = {
  plugins: { id: string; status: string; reason: string | null; apps: number }[];
  routes: ImpactFrameworkRoute[];
  routesTotal: number;
  renders: { from: string; fromName: string; template: string; file: string | null; tier: ImpactTier; note: string | null; site: { file: string; line: number } }[];
  renderedBy: { template: string; by: string; byName: string; site: { file: string; line: number } }[];
  models: { model: string; name: string; migrations: { file: string; line: number; operation: string }[] }[];
  migrations: { file: string; operations: string[]; models: string[] }[];
  tests: ImpactFrameworkTest[];
  testsTotal: number;
  roles: { target: string; name: string; role: string; detail: string | null }[];
  unknown: { file: string | null; line: number | null; cause: string; note: string }[];
  unknownTotal: number;
  // Uncut, for the review packet: the changed files the section read, and
  // the id of every route it lists before the summary's cut.
  changedFiles?: string[];
  routeIds?: string[];
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

// Submission version 2, what the reviewer process `review` starts returns.
// Every scanner candidate gets exactly one disposition: raised by a finding
// that names it, or dropped with a reason and the line that shows why. The
// prose is in three fields the report prints under fixed labels. Any other
// key (a `reviewer` claim included) is ignored: the tool records who reviewed.
export type FindingV2 = {
  severity: Severity;
  category: Category;
  confidence: number;
  file_path: string;
  line_number: number;
  line_end?: number;
  title: string;
  problem: string; // what is wrong, one or two sentences
  consequence: string; // why it matters
  fix: string;
  suggested_change?: string | null;
  source: string | null;
  candidate?: string | null;
};

export type DroppedV2 = { candidate: string; reason: string; file_path: string; line_number: number };

export type SubmissionV2 = {
  version: 2;
  change_id: string;
  summary: string;
  findings: FindingV2[];
  dropped: DroppedV2[];
};

// What the tool records about the reviewer process it started. Nothing in it
// comes from the model.
export type ReviewerUsage = { turns: number; input_tokens: number | null; output_tokens: number | null; cost_usd: number | null };

export type ReviewerRecord = {
  driver: string;
  version: string;
  pid: number | null;
  started_at: string;
  ended_at: string;
  duration_ms: number;
  rounds: number; // answers asked for: the first plus the correction rounds
  usage: ReviewerUsage;
};

// The completion record: script-owned and versioned, separate from the
// verdict. "complete" only when the reviewer was a process the tool started,
// the snapshot it read is the one the scanners and the diff used and did not
// change, every candidate has a disposition and every changed range was
// given to the reviewer. Anything less is "incomplete", with each missing
// condition in `missing`.
export type CompletionRecord = {
  version: 1;
  contract: "openqodex-review-2";
  status: "complete" | "incomplete";
  missing: string[];
  reviewer: ReviewerRecord | null;
  // The change id, the git tree the change and the snapshot were made from
  // (null for a target, whose head commit is in the change), and a hash of
  // every snapshot file before and after the reviewer ran.
  snapshot: { change_id: string; tree: string | null; before: string; after: string | null };
  candidates: { total: number; disposed: number };
  coverage: {
    hunks: number;
    covered: number;
    unread: { path: string; start: number; end: number; deletion: boolean }[];
    files_read: string[];
    files_not_read: string[];
  };
  outside_reads: string[];
  // Whether the reviewer's event stream shows every tool call (Claude Code).
  // When false (Codex), files_read and outside_reads are not measured, and
  // coverage counts only the changed ranges put in front of the reviewer.
  trace_complete: boolean;
};

// One tool call a model reviewer asked for, as the brain handled it. `path`
// is relative to the snapshot when `inside`; `range` is the first and last
// line the result carried (after the size bound). `inside` is null for a
// call to a tool the brain did not define. `in_scope` is null while the
// review has no scopes. `served`: the brain put a result (a refusal
// included) in the transcript; `delivered`: a request that carried it was
// sent to the model. `reason`: why the call was refused or its result cut,
// else null.
export type ModelToolEntry = {
  tool: string;
  path: string | null;
  range: [number, number] | null;
  inside: boolean | null;
  in_scope: boolean | null;
  ok: boolean;
  served: boolean;
  delivered: boolean;
  reason: string | null;
};

// What the transport reported for one model response: the model asked for,
// the one that answered when the provider named it, the tokens (null when
// not reported) and the cost when the host knows it.
export type ModelCallUsage = {
  model: string;
  servedModel?: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number | null;
};

// One model attempt: one call of the transport, or one the budget refused
// before it was made. `usage` is null when no response came back.
export type ModelAttempt = {
  callId: string;
  purpose: string;
  attempt: number;
  authorized: boolean;
  outcome: "ok" | "failed" | "refused";
  usage: ModelCallUsage | null;
  durationMs: number;
};

// The completion record of a review by a model reviewer: the brain built
// every request and served every tool call itself, so its proof is the
// brain's own log, never the reviewer's word. "complete" under the same
// conditions as the agent record, with coverage counted from what the
// requests that were sent carried. `second`: the second reviewer's own
// record, when one ran.
export type ModelCompletionRecord = {
  contract: "openqodex-model-review-1";
  status: "complete" | "incomplete";
  missing: string[];
  reviewer: { kind: "model"; model: string; servedModels: string[]; calls: number };
  snapshot: { change_id: string; tree: string | null; before: string; after: string | null };
  candidates: { total: number; disposed: number };
  coverage: CompletionRecord["coverage"];
  tool_log: ModelToolEntry[];
  attempts: ModelAttempt[];
  second?: ModelCompletionRecord;
  // With a second reviewer: each candidate one reviewer raised and the
  // other dropped, and the second reviewer's failures that leave the review
  // complete (a budget refusal is in `missing` instead).
  disagreements?: Disagreement[];
  notes?: string[];
  trace_complete: true;
};

// A scanner candidate two reviewers disposed of differently: one raised it
// in a finding, the other dropped it. `raisedBy` and `droppedBy` name the
// reviewers (the model's or the driver's name); `reason` is the drop's.
export type Disagreement = { candidate: string; token: string; raisedBy: string; droppedBy: string; reason: string | null };

// Either record: an agent review's or a model review's.
export type AnyCompletionRecord = CompletionRecord | ModelCompletionRecord;

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
  // Submission version 2 only: the three prose fields the standard report prints.
  problem?: string;
  consequence?: string;
  fix?: string;
  // A model review only: the reviewers that raised it, the primary first.
  found_by?: string[];
};

// "incomplete": a review `review` ran whose completion record is incomplete.
// It has no findings, judges nothing and is never finalized.
export type Verdict = "passed" | "blocked" | "incomplete";

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
  // review only: candidates the agent dropped, with its reason and, from
  // submission version 2 on, the line it cited
  dropped: { candidate: Candidate; reason: string; cited?: { file_path: string; line_number: number } }[];
  scanners: ScannerRunSummary[];
  // The code graph's view of the change. Always present: status "off",
  // "skipped" or "failed" says why there is nothing in it.
  impact: ImpactSummary | null;
  not_reviewed_paths: string[]; // Change.notReviewed
  stats: { files: number; additions: number; deletions: number };
  // A review run by `review` itself: its completion record (a model
  // reviewer's has its own contract). Absent in a scan and in a review from
  // the two-step protocol (a legacy review).
  completion?: AnyCompletionRecord;
  // A legacy review only: the line naming the coding agent as the
  // reviewer (SAME_AGENT_REVIEW). Every renderer prints it.
  reviewed_by?: string;
  // A model review only: the candidates a second reviewer that completed
  // dropped, as `dropped` holds the primary's; and what the review could
  // not hold or a second reviewer's failure, one plain line each.
  second_dropped?: { candidate: Candidate; reason: string; cited?: { file_path: string; line_number: number } }[];
  notes?: string[];
};

// A piece of context a host gives a review with the change (reviewChange):
// a lesson from earlier reviews, a comment on the change, a summary, a note,
// or a finding from an earlier review. The brief quotes it as data, under one
// heading per kind, framed as the owners' instructions are: it never grants a
// tool and never changes a rule. `source`: where it came from, as the host
// names it. `scopes`: the folders it is about; an item whose folders hold no
// file of the change is left out of the brief, and the result says so.
export type ContextKind = "lesson" | "comment" | "summary" | "note" | "prior_finding";
export type ContextItem = { kind: ContextKind; text: string; source: string; scopes?: string[] };

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
  // Set for a review of a branch or a pull request (`review <target>`):
  // what was reviewed and where its files were read. Absent otherwise.
  target?: RunTarget;
  // The run folder's name, which `review --finalize --run` takes.
  run_id?: string;
  // The context items a host gave the review, in the order given: each one's
  // kind, source and the sha256 of the item, and `omitted`, why the brief
  // left it out (null when the brief carries it). Absent when none was given.
  context?: { kind: ContextKind; source: string; sha256: string; omitted: string | null }[];
};

// Where the base of a target review came from, in the order they are tried.
// "the host": the merge base a host gave reviewChange, proved in its clone.
export type BaseSource = "--base" | "the pull request" | "review.default_base" | "the remote's default branch" | "the host";

export type RunTarget = {
  spec: string; // as the developer wrote it: a branch, #<n> or a pull request URL
  base_ref: string;
  base_source: BaseSource;
  base_sha: string;
  merge_base: string; // the change is merge_base to head_sha
  head_sha: string;
  repo_root: string; // the developer's repository: the run folder, the settings, the approvals
  checkout: string | null; // the temporary checkout the files are read from; null: read in place
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
  finalized: boolean; // true only after a submission was accepted
  verdict: Verdict | null;
  // Written by `review` itself; absent in a receipt of the two-step protocol.
  // An incomplete run is never finalized.
  completion?: "complete" | "incomplete";
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
