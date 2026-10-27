// The repo's config file: every key optional, defaults work with no file at
// all. The file comes from whatever repo the developer cloned, so it is
// untrusted input: unknown keys are ignored with a warning, a wrong type stops
// the run with the key path, and nothing in it runs until `openqodex trust`
// approves.
//
// Keys mirror the hosted product's `.qodex.yaml` where the meaning holds on
// the developer's machine. Hosted keys with no local meaning are read, warned
// about once each and ignored, so one file can serve both.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { MAX_GLOB } from "./glob.js";
import { nearestName } from "./names.js";
import { isRepoState, readFileBounded, readRepoFile } from "./repo-state.js";
import { SEVERITIES } from "./severity.js";
import type { BuiltinScanner, Config, CustomInstall, CustomScanner, JsonMap, LoadedConfig, Severity } from "./types.js";
import { OpenQodexError } from "./types.js";

// Read first. The 0.1.0 location at the repo root is still read when this
// one is absent.
export const CONFIG_FILE = ".openqodex/config.yaml";
// The reason recorded, with status "disabled", for a scanner switched off by
// `scanners.disable`. That is the developer's choice; any other "disabled"
// entry (an --offline skip, folders held back) is a gap the verdict counts.
export const DISABLED_REASON = `disabled in ${CONFIG_FILE}`;
export const LEGACY_CONFIG_FILE = ".openqodex.yaml";
// Far above any real config, low enough that no read runs away.
export const CONFIG_MAX_BYTES = 1024 * 1024;

export const DEFAULT_CONFIG: Config = {
  blockOnSeverity: null,
  severityThreshold: "minor",
  exclude: [],
  disabledRules: [],
  defaultBase: null,
  includeFixtures: false,
  instructionsFiles: [],
  stages: true,
  disabledScanners: [],
  custom: [],
  graph: { enabled: true, budgetMs: 10_000, maxFiles: 4000, maxFileBytes: 512 * 1024, maxCacheMb: 512, maxHeapMb: 1536 },
};

// Every key of the file in order, with its default as YAML text and one line
// on what it does. The default config text and the key table in
// docs/config.md are both written from this list, and a test holds it equal
// to the schema's keys and to DEFAULT_CONFIG.
export type ConfigKey = { key: string; default: string; description: string };

export const CONFIG_KEYS: readonly ConfigKey[] = [
  { key: "version", default: "1", description: "The file format version. 1 is the only one." },
  {
    key: "min_version",
    default: "null",
    description: "The oldest openqodex that may read this file, such as 0.9.0; an older one stops with exit 2 and names the version it needs.",
  },
  {
    key: "review.severity_threshold",
    default: "minor",
    description: "Findings below this severity stay out of the report; one at or above block_on_severity is always shown.",
  },
  {
    key: "review.block_on_severity",
    default: "null",
    description: "Exit 1 and deny the push when a finding on a changed line is at or above this severity; null never blocks.",
  },
  { key: "review.paths.exclude", default: "[]", description: "Globs of files left out of the change." },
  {
    key: "review.disabled_rules",
    default: "[]",
    description: "Globs on a finding's citation, such as gitleaks:generic-api-key or lens:react-*.",
  },
  {
    key: "review.default_base",
    default: "null",
    description: "The branch or ref to diff against when the branch has no upstream; null uses the remote's default branch.",
  },
  {
    key: "review.include_fixtures",
    default: "false",
    description: "Keep scanner findings in test fixtures, mocks and snapshots.",
  },
  { key: "review.instructions_files", default: "[]", description: "Repo-relative convention paths or globs the owners chose for the reviewer. Empty reads none." },
  {
    key: "review.stages",
    default: "true",
    description: "The staged review when openqodex starts its own reviewer: two finder sessions per changed file, then a fresh verifier per batch of candidates. false runs one pass. --agent and --all always run one pass.",
  },
  { key: "scanners.disable", default: "[]", description: "Built-in scanners to switch off, by name." },
  {
    key: "scanners.custom",
    default: "[]",
    description: "Open source scanners to add by GitHub link; each runs only after openqodex trust.",
  },
  { key: "graph.enabled", default: "true", description: "Show the callers and importers of the changed code in the brief." },
  { key: "graph.budget_ms", default: "10000", description: "Time the code graph may take, in milliseconds." },
  {
    key: "graph.max_files",
    default: "4000",
    description: "New parses per build: files past this count wait for a later build. Facts already cached are not counted.",
  },
  {
    key: "graph.max_file_bytes",
    default: "524288",
    description: "Files larger than this, in bytes, are left out of the code graph.",
  },
  {
    key: "graph.max_cache_mb",
    default: "512",
    description: "The size bound of .openqodex/graph/, in MB; the oldest builds and facts no kept build names are removed first.",
  },
  {
    key: "graph.max_heap_mb",
    default: "1536",
    description: "The memory the code graph may use, in MB; files past it are left out and the graph says so.",
  },
];

// The config `init` and the first review write as .openqodex/config.yaml:
// `version: 1` set, every other key a comment holding its default. A default
// lives in the code, so a release that changes one reaches every repo that
// never set the key; a line here would freeze it as a choice nobody made.
// Removing the `# ` that starts a line sets it.
export const DEFAULT_CONFIG_YAML = defaultYaml();

// The first line of the file `init` wrote up to 0.8.1, with every default
// as a live value: a value there that equals an old default was not chosen.
export const LIVE_DEFAULTS_HEADER = "# OpenQodex settings for this repo. Every key is optional; these are the defaults.";

function defaultYaml(): string {
  const out = [
    "# OpenQodex settings for this repo. Only version is set: every other key below is",
    "# a comment that shows its default, and a later release may change a default.",
    "# To set a key, remove the `# ` that starts its line and the lines of the blocks",
    "# above it. Each key is explained by: openqodex guide config",
  ];
  let open: string[] = [];
  for (const { key, default: value, description } of CONFIG_KEYS) {
    if (key === "version") {
      out.push(`${key}: ${value}`);
      continue;
    }
    const parts = key.split(".");
    const parents = parts.slice(0, -1);
    let same = 0;
    while (same < open.length && same < parents.length && open[same] === parents[same]) same++;
    for (let i = same; i < parents.length; i++) out.push(`# ${"  ".repeat(i)}${parents[i]}:`);
    open = parents;
    const indent = "  ".repeat(parents.length);
    out.push(`# ${indent}# ${description}`, `# ${indent}${parts[parts.length - 1]}: ${value}`);
  }
  return `${out.join("\n")}\n`;
}

// Keys of the hosted file that mean nothing on the developer's machine.
// base_branches there picks which pull requests get reviewed, which is not
// a diff base; review.default_base is the local key for that.
const HOSTED_ONLY_REVIEW_KEYS = [
  "enabled",
  "block_pr_merge",
  "allow_approve",
  "authors",
  "base_branches",
  "style_placement_threshold",
];
const HOSTED_ONLY_TOP_KEYS = ["probes"];
const HOSTED_ONLY = "is used by the hosted review only and is ignored";

// Every change to a key or to the file's place, one row each. The parser
// reads, warns and fails from this table; `openqodex config migrate`
// applies the renames, removals and the move. A key leaves CONFIG_KEYS only
// with a row here (test/config-changes.test.ts holds every key a release
// shipped).
//   renamed: read under the old top-level name, with a warning; a file with
//            both is refused. migrate renames it.
//   removed: warned about and ignored. migrate removes it.
//   hosted:  a key of the hosted review's file: warned about and ignored, and
//            left by migrate, since one file can serve both.
//   default: the default moved from `was` in `since`. A file an earlier
//            init wrote with every default live (LIVE_DEFAULTS_HEADER) that
//            still holds `was` is told; `unset`, when given, is said to a
//            file at the place the file had before the default moved that
//            leaves the key unset.
//   moved:   the file's place; the old one is read while the new one is
//            absent. migrate moves it.
export type ConfigChange =
  | { kind: "renamed"; key: string; to: string; since: string; why: string; what: string }
  | { kind: "removed"; key: string; since: string; why: string }
  | { kind: "hosted"; key: string }
  | { kind: "default"; key: string; was: string; since: string; unset?: string }
  | { kind: "moved"; file: string; to: string; since: string };

export const CONFIG_CHANGES: readonly ConfigChange[] = [
  { kind: "moved", file: LEGACY_CONFIG_FILE, to: CONFIG_FILE, since: "0.2.0" },
  { kind: "renamed", key: "pr_review", to: "review", since: "0.1.0", why: "the hosted name of the review block", what: "block" },
  ...HOSTED_ONLY_REVIEW_KEYS.map((k): ConfigChange => ({ kind: "hosted", key: `review.${k}` })),
  ...HOSTED_ONLY_TOP_KEYS.map((k): ConfigChange => ({ kind: "hosted", key: k })),
  {
    kind: "default",
    key: "review.severity_threshold",
    was: "info",
    since: "0.2.0",
    unset: "the report now hides findings below minor by default; set review.severity_threshold: info in {file} to keep seeing them",
  },
];

const BUILTIN: Record<BuiltinScanner, true> = {
  semgrep: true,
  gitleaks: true,
  sqllint: true,
  "osv-scanner": true,
  actionlint: true,
  hadolint: true,
  shellcheck: true,
  ruff: true,
  brakeman: true,
  rubocop: true,
  bandit: true,
  oxlint: true,
  golangci: true,
  zizmor: true,
  trivy: true,
  squawk: true,
  "kube-linter": true,
  tflint: true,
  kubeconform: true,
  "cargo-deny": true,
  checkov: true,
  sqlfluff: true,
};
const BUILTIN_NAMES = Object.keys(BUILTIN) as [BuiltinScanner, ...BuiltinScanner[]];

const VERSION_TEXT = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const GITHUB_REPO = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const strings = z.array(z.string());
// The matcher matches nothing with a longer glob, which would quietly undo
// the key: an exclude would keep its files, a disabled rule would come back
// on, a custom scanner's paths would select no file. So the file is refused.
const globs = z.array(
  z.string().max(MAX_GLOB, { error: (issue) => `longer than ${MAX_GLOB} characters, the most a glob can have: ${JSON.stringify(issue.input)}; shorten it` }),
);
// YAML reads `version: 1.2` as a number; a version is always text here.
const text = z.union([z.string(), z.number()]).transform(String);
const scannerSeverity = z.enum(["critical", "high", "medium", "low", "info"]);
const severityLevel = z.enum(SEVERITIES as [Severity, ...Severity[]]);

// Built twice: strict, to name every unknown key, and stripping, to read the
// values. The parsed YAML is never edited, because a YAML alias can share one
// object between two sections.
function schemas(strict: boolean) {
  const obj = strict ? z.strictObject : z.object;

  const map = obj({
    items: z.string(),
    file: z.string(),
    line: z.string(),
    end_line: z.string().nullish(),
    rule: z.string(),
    severity: z.string().nullish(),
    message: z.string(),
    reference: z.string().nullish(),
    severity_map: z.record(z.string(), scannerSeverity).optional(),
  });

  const install = z.union([
    z.literal("path"),
    obj({
      asset: z.string().nullish(),
      binary: z.string().nullish(),
      sha256: z.string().regex(/^[0-9a-f]{64}$/, "expected a sha256 in lowercase hex").nullish(),
      npm: z.string().optional(),
      uv: z.string().optional(),
    }),
  ]);

  const custom = obj({
    source: z.string(),
    run: z.string().trim().min(1, "expected a command"),
    name: z.string().regex(NAME, "expected letters, digits, dot, dash or underscore").optional(),
    version: text.nullish(),
    format: z.enum(["sarif", "json-map"]).optional(),
    map: map.optional(),
    paths: globs.nullish(),
    target: z.enum(["changed", "repo"]).optional(),
    timeout_seconds: z.number().int().positive().optional(),
    install: install.optional(),
  });

  const hostedOnly = (keys: string[]) => Object.fromEntries(keys.map((k) => [k, z.unknown().optional()]));
  const positive = z.number().int().positive();

  const file = obj({
    version: z.literal(1).optional(),
    min_version: text.pipe(z.string().regex(VERSION_TEXT, "expected a version such as 0.9.0")).nullish(),
    review: obj({
      severity_threshold: severityLevel.optional(),
      block_on_severity: severityLevel.nullish(),
      paths: obj({ exclude: globs.optional() }).optional(),
      disabled_rules: globs.optional(),
      default_base: z.string().trim().min(1, "expected a branch or ref").nullish(),
      include_fixtures: z.boolean().optional(),
      instructions_files: strings.optional(),
      stages: z.boolean().optional(),
      ...hostedOnly(HOSTED_ONLY_REVIEW_KEYS),
    }).optional(),
    scanners: obj({
      // A name this version does not know is warned about and ignored
      // (parseConfig): a newer version may know it.
      disable: strings.optional(),
      custom: z.array(custom).optional(),
    }).optional(),
    graph: obj({
      enabled: z.boolean().optional(),
      budget_ms: positive.optional(),
      max_files: positive.optional(),
      max_file_bytes: positive.optional(),
      max_cache_mb: positive.optional(),
      max_heap_mb: positive.optional(),
    }).optional(),
    ...hostedOnly(HOSTED_ONLY_TOP_KEYS),
  });

  return { file, map, custom };
}

const STRICT = schemas(true);
const STRIPPING = schemas(false);

// Every key path the schema reads, in schema order, leaving out the hosted
// keys that are only warned about. Lists are not walked: a custom scanner's
// keys are documented with the scanner, not in the key table.
export function schemaKeys(): string[] {
  const out: string[] = [];
  const walk = (shape: Record<string, z.ZodType>, prefix: string): void => {
    for (const [key, value] of Object.entries(shape)) {
      let inner: z.ZodType = value;
      while (inner instanceof z.ZodOptional || inner instanceof z.ZodNullable) inner = inner.unwrap() as z.ZodType;
      if (inner instanceof z.ZodUnknown) continue;
      if (inner instanceof z.ZodObject) walk(inner.shape as Record<string, z.ZodType>, `${prefix}${key}.`);
      else out.push(`${prefix}${key}`);
    }
  };
  walk(STRICT.file.shape as Record<string, z.ZodType>, "");
  return out;
}

type CustomYaml = z.infer<typeof STRIPPING.custom>;
type MapYaml = z.infer<typeof STRIPPING.map>;

function keyPath(path: PropertyKey[]): string {
  let out = "";
  for (const p of path) out += typeof p === "number" ? `[${p}]` : out === "" ? String(p) : `.${String(p)}`;
  return out === "" ? "(top level)" : out;
}

function fail(file: string, path: PropertyKey[], message: string): never {
  throw new OpenQodexError(`${file}: ${keyPath(path)}: ${message}`);
}

function toInstall(file: string, path: PropertyKey[], raw: CustomYaml["install"]): CustomInstall {
  if (raw === undefined) return { kind: "github-release", asset: null, binary: null, sha256: null };
  if (raw === "path") return { kind: "path" };
  const { npm, uv, ...release } = raw;
  const releaseKeys = Object.values(release).some((v) => v !== undefined && v !== null);
  if ([npm !== undefined, uv !== undefined, releaseKeys].filter(Boolean).length > 1) {
    fail(file, path, "use one of npm, uv, or asset/binary/sha256");
  }
  if (npm !== undefined) return { kind: "npm", spec: npm };
  if (uv !== undefined) return { kind: "uv", spec: uv };
  return {
    kind: "github-release",
    asset: release.asset ?? null,
    binary: release.binary ?? null,
    sha256: release.sha256 ?? null,
  };
}

function toMap(raw: MapYaml): JsonMap {
  return {
    items: raw.items,
    file: raw.file,
    line: raw.line,
    end_line: raw.end_line ?? null,
    rule: raw.rule,
    severity: raw.severity ?? null,
    message: raw.message,
    reference: raw.reference ?? null,
    severity_map: raw.severity_map ?? {},
  };
}

function lastSegment(source: string): string {
  const parts = source.replace(/\/+$/, "").replace(/\.git$/, "").split("/");
  return parts[parts.length - 1] ?? "";
}

function toCustom(file: string, index: number, raw: CustomYaml): CustomScanner {
  const at = (...rest: PropertyKey[]): PropertyKey[] => ["scanners", "custom", index, ...rest];
  const install = toInstall(file, at("install"), raw.install);
  if (install.kind === "github-release" && !GITHUB_REPO.test(raw.source)) {
    fail(file, at("source"), "expected a link of the form https://github.com/<owner>/<repo>");
  }
  const name = raw.name ?? lastSegment(raw.source);
  if (!NAME.test(name)) fail(file, at("name"), `"${name}" cannot be used as a name; set name explicitly`);
  const format = raw.format ?? "sarif";
  if (format === "json-map" && raw.map === undefined) fail(file, at("map"), "required when format is json-map");
  return {
    name,
    source: raw.source,
    run: raw.run,
    version: raw.version ?? null,
    format,
    map: raw.map === undefined ? null : toMap(raw.map),
    paths: raw.paths ?? null,
    target: raw.target ?? "changed",
    timeoutSeconds: raw.timeout_seconds ?? 120,
    install,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type ParseOptions = {
  // The running openqodex: min_version is checked against it. Without it,
  // min_version is read but not checked.
  runtimeVersion?: string;
  // The table of changes; tests pass their own rows.
  changes?: readonly ConfigChange[];
};

function versionParts(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  return m === null ? null : [Number(m[1]), Number(m[2]), Number(m[3])];
}

function olderThan(a: string, b: string): boolean {
  const pa = versionParts(a);
  const pb = versionParts(b);
  if (pa === null || pb === null) return false;
  return pa[0] < pb[0] || (pa[0] === pb[0] && (pa[1] < pb[1] || (pa[1] === pb[1] && pa[2] < pb[2])));
}

// Whether a dotted key path is set in the parsed file, and its value.
function lookup(data: unknown, path: string[]): { set: boolean; value: unknown } {
  let at: unknown = data;
  for (const p of path) {
    if (!isRecord(at) || !(p in at)) return { set: false, value: undefined };
    at = at[p];
  }
  return { set: true, value: at };
}

// Parses the text of a config file. `file` names it in error messages.
export function parseConfig(source: string, file: string = CONFIG_FILE, opts: ParseOptions = {}): { config: Config; warnings: string[] } {
  const changes = opts.changes ?? CONFIG_CHANGES;
  let data: unknown;
  try {
    data = parseYaml(source);
  } catch (e) {
    throw new OpenQodexError(`${file}: not valid YAML: ${(e as Error).message.split("\n")[0]}`);
  }
  if (data === null || data === undefined) return { config: structuredClone(DEFAULT_CONFIG), warnings: [] };

  const warnings: string[] = [];
  // A renamed top-level key (the hosted file names the review block
  // pr_review) is read under its new name, through a new top-level object so
  // the parsed YAML is never edited, and every message names the key the
  // developer wrote.
  let shown = (path: PropertyKey[]): PropertyKey[] => path;
  for (const c of changes) {
    if (c.kind !== "renamed" || !isRecord(data) || !(c.key in data)) continue;
    if (c.to in data) fail(file, [c.key], `${c.to} and ${c.key} are the same ${c.what}; keep only ${c.to}`);
    const { [c.key]: value, ...rest } = data;
    data = { ...rest, [c.to]: value };
    const before = shown;
    shown = (path) => before(path[0] === c.to ? [c.key, ...path.slice(1)] : path);
    warnings.push(`${c.key} is ${c.why}; it is read as ${c.to}`);
  }
  function failAt(path: PropertyKey[], message: string): never {
    fail(file, shown(path), message);
  }

  // Keys of the hosted file, and keys a release removed: each warned about
  // once, with its reason, and not again as unknown.
  const named = new Set<string>();
  for (const c of changes) {
    if (c.kind !== "hosted" && c.kind !== "removed") continue;
    const path = c.key.split(".");
    if (!lookup(data, path).set) continue;
    named.add(c.key);
    const where = keyPath(shown(path));
    warnings.push(c.kind === "hosted" ? `${where} ${HOSTED_ONLY}` : `${where} was removed in ${c.since} and is ignored: ${c.why} (openqodex config migrate removes it)`);
  }

  // A file an earlier init wrote with every default live, still at a
  // default a release changed since.
  if (source.startsWith(LIVE_DEFAULTS_HEADER)) {
    for (const c of changes) {
      if (c.kind !== "default") continue;
      const found = lookup(data, c.key.split("."));
      const now = CONFIG_KEYS.find((k) => k.key === c.key)?.default;
      if (!found.set || now === undefined || String(found.value) !== c.was) continue;
      warnings.push(`${c.key}: ${c.was} is the default an earlier openqodex init wrote; since ${c.since} the default is ${now}. Delete the line to follow the default, or keep it to stay on ${c.was}.`);
    }
  }

  const strict = STRICT.file.safeParse(data);
  if (!strict.success) {
    const real = strict.error.issues.find((i) => i.code !== "unrecognized_keys");
    if (real) failAt(real.path, real.message);
    for (const issue of strict.error.issues) {
      if (issue.code !== "unrecognized_keys") continue;
      for (const key of issue.keys) {
        if (named.has([...issue.path, key].join("."))) continue;
        warnings.push(`unknown key ${keyPath(shown([...issue.path, key]))} is ignored`);
      }
    }
  }
  const result = STRIPPING.file.safeParse(data);
  if (!result.success) failAt(result.error.issues[0].path, result.error.issues[0].message);
  const yaml = result.data;

  if (yaml.min_version !== undefined && yaml.min_version !== null && opts.runtimeVersion !== undefined && olderThan(opts.runtimeVersion, yaml.min_version)) {
    failAt(["min_version"], `this repo's config needs openqodex ${yaml.min_version} or newer, and this is ${opts.runtimeVersion}; run openqodex update`);
  }

  // A name a newer version added is ignored here, not fatal: an older
  // teammate's review still runs, and the warning names the near one.
  const disabled: BuiltinScanner[] = [];
  for (const name of yaml.scanners?.disable ?? []) {
    if (name in BUILTIN) {
      disabled.push(name as BuiltinScanner);
      continue;
    }
    const near = nearestName(name, BUILTIN_NAMES);
    warnings.push(
      `${keyPath(shown(["scanners", "disable"]))}: ${name} is not a scanner this version knows; it is ignored (${near === null ? `the scanners are ${BUILTIN_NAMES.join(", ")}` : `did you mean ${near}?`})`,
    );
  }

  const custom = (yaml.scanners?.custom ?? []).map((c, i) => toCustom(file, i, c));
  const seen = new Set<string>();
  custom.forEach((c, i) => {
    if (seen.has(c.name)) fail(file, ["scanners", "custom", i, "name"], `"${c.name}" is used by two entries`);
    seen.add(c.name);
  });

  const graph = DEFAULT_CONFIG.graph;
  return {
    config: {
      blockOnSeverity: yaml.review?.block_on_severity ?? null,
      severityThreshold: yaml.review?.severity_threshold ?? DEFAULT_CONFIG.severityThreshold,
      exclude: yaml.review?.paths?.exclude ?? [],
      disabledRules: yaml.review?.disabled_rules ?? [],
      defaultBase: yaml.review?.default_base ?? null,
      includeFixtures: yaml.review?.include_fixtures ?? false,
      instructionsFiles: yaml.review?.instructions_files ?? [],
      stages: yaml.review?.stages ?? DEFAULT_CONFIG.stages,
      disabledScanners: disabled,
      custom,
      graph: {
        enabled: yaml.graph?.enabled ?? graph.enabled,
        budgetMs: yaml.graph?.budget_ms ?? graph.budgetMs,
        maxFiles: yaml.graph?.max_files ?? graph.maxFiles,
        maxFileBytes: yaml.graph?.max_file_bytes ?? graph.maxFileBytes,
        maxCacheMb: yaml.graph?.max_cache_mb ?? graph.maxCacheMb,
        maxHeapMb: yaml.graph?.max_heap_mb ?? graph.maxHeapMb,
      },
    },
    warnings,
  };
}

// `--config` wins. Otherwise .openqodex/config.yaml, then the 0.1.0 file at
// the root (the "moved" row of CONFIG_CHANGES). With both, the folder file
// is read and a warning names both, so a 0.1.0 repo keeps working once
// `init` has written the folder file.
export function loadConfig(repoRoot: string, explicitPath?: string, opts: ParseOptions = {}): LoadedConfig {
  if (explicitPath !== undefined) {
    const path = isAbsolute(explicitPath) ? explicitPath : resolve(repoRoot, explicitPath);
    // A file in the repo state is read as repo state, never through a link.
    const state = isRepoState(repoRoot, path);
    if (state !== null) {
      const text = readRepoFile(repoRoot, state, CONFIG_MAX_BYTES);
      if (text === null) throw new OpenQodexError(`config file not found: ${path}`);
      return { ...parseConfig(text, explicitPath, opts), path };
    }
    if (!existsSync(path)) throw new OpenQodexError(`config file not found: ${path}`);
    // Any other file the developer named: a link is followed; it must still be a regular file within the cap.
    return { ...parseConfig(readFileBounded(path, CONFIG_MAX_BYTES), explicitPath, opts), path };
  }
  const changes = opts.changes ?? CONFIG_CHANGES;
  const moved = changes.find((c): c is Extract<ConfigChange, { kind: "moved" }> => c.kind === "moved");
  // The repo's own files: never through a link, never past the cap.
  const names = moved === undefined ? [CONFIG_FILE] : [moved.to, moved.file];
  const texts = names.map((name) => ({ name, text: readRepoFile(repoRoot, name, CONFIG_MAX_BYTES) }));
  const found = texts.filter((t) => t.text !== null).map((t) => t.name);
  if (found.length === 0) return { config: structuredClone(DEFAULT_CONFIG), path: null, warnings: [] };
  const path = join(repoRoot, found[0]);
  const text = texts.find((t) => t.name === found[0])!.text!;
  const { config, warnings } = parseConfig(text, found[0], opts);
  // A file at the old place was written before the move: a default changed
  // by then reached it without a word, so say so (the `unset` of a row).
  if (moved !== undefined && found[0] === moved.file) {
    const data: unknown = parseYaml(text);
    const renamed = changes.filter((c): c is Extract<ConfigChange, { kind: "renamed" }> => c.kind === "renamed");
    for (const c of changes) {
      if (c.kind !== "default" || c.unset === undefined || olderThan(moved.since, c.since)) continue;
      const path = c.key.split(".");
      const spellings = [path, ...renamed.filter((r) => r.to === path[0]).map((r) => [r.key, ...path.slice(1)])];
      if (spellings.some((p) => lookup(data, p).set)) continue;
      warnings.push(c.unset.replaceAll("{file}", moved.file));
    }
  }
  if (found.length === 2 && moved !== undefined) {
    warnings.unshift(
      `both ${moved.to} and ${moved.file} exist; read ${moved.to} only, so move anything still needed from ${moved.file} into it and delete it`,
    );
  }
  return { config, path, warnings };
}

// JSON with object keys sorted at every level, so equal values hash equally.
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return v;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) sorted[k] = (v as Record<string, unknown>)[k];
    return sorted;
  });
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// sha256 of the canonical JSON of the effective config.
export function configHash(config: Config): string {
  return sha256(canonicalJson(config));
}

// sha256 of the canonical JSON of one custom scanner entry.
export function customEntryHash(entry: CustomScanner): string {
  return sha256(canonicalJson(entry));
}
