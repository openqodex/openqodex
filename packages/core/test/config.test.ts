// Ways the config loader could fail:
// 1. No file, or an empty file, does not give the defaults.
// 2. A key is read under the wrong name or lands in the wrong Config field.
// 3. An unknown key (a typo, a key from a newer version) stops the run
//    instead of being ignored with a warning naming its path.
// 4. A wrong type is accepted, or the error does not name the key path.
// 5. The minimal custom entry (source and run) does not get its defaults.
// 6. The install forms (path, npm, uv, asset by hand) map to the wrong kind,
//    or two forms at once are accepted.
// 7. A custom entry with a non-GitHub source is accepted for a release
//    install, or refused for path, npm or uv.
// 8. Two custom entries share a name, or a name could escape a folder.
// 9. json-map without a map block is accepted.
// 10. The hashes change with key order, or do not change with a value.
// 11. An explicit config path that does not exist is silently ignored.
// 12. Invalid YAML throws something other than OpenQodexError.
// 13. Dropping an unknown key edits the parsed YAML, so a YAML alias shared
//     by two sections loses a valid key too.
// 14. A hosted file's pr_review block is ignored instead of read as review,
//     or an error inside it names review, a key the developer never wrote.
// 15. A hosted-only key stops the run, or is ignored without a warning
//     naming its path and why.
// 16. With both the folder file and the 0.1.0 root file, the root file is
//     read, the run fails, or nothing says the root file was skipped.
// 18. A 0.1.0 root file without severity_threshold silently loses nitpick
//     and info findings after the upgrade to the minor default.
// 17. The default config text that init writes reads back to something
//     other than DEFAULT_CONFIG, warns, or misses a key the schema reads.
// 19. A glob longer than the matcher takes (MAX_GLOB) is accepted and then
//     matches nothing: an exclude stops excluding, a disabled rule comes
//     back on, and a custom scanner's paths select no file, so the scanner
//     never runs. The error must name the file, the key, the limit and the
//     pattern itself, so a long glob can be found in the config and fixed.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  CONFIG_KEYS,
  configHash,
  customEntryHash,
  DEFAULT_CONFIG,
  loadConfig,
  parseConfig,
  schemaKeys,
} from "../src/config.js";
import { MAX_GLOB } from "../src/glob.js";
import { OpenQodexError } from "../src/types.js";
import { removeTempDirs, tempDir } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

// `yaml` goes to the 0.1.0 root file; `folder` to .openqodex/config.yaml.
function repoWith(yaml: string | null, folder: string | null = null): string {
  const d = tempDir("oq-config-test-");
  dirs.push(d);
  if (yaml !== null) writeFileSync(join(d, ".openqodex.yaml"), yaml);
  if (folder !== null) {
    mkdirSync(join(d, ".openqodex"));
    writeFileSync(join(d, ".openqodex", "config.yaml"), folder);
  }
  return d;
}

function error(yaml: string): string {
  try {
    parseConfig(yaml);
  } catch (e) {
    expect(e).toBeInstanceOf(OpenQodexError);
    return (e as Error).message;
  }
  throw new Error("expected the config to be refused");
}

const FULL = `
version: 1
review:
  severity_threshold: nitpick
  block_on_severity: major
  paths: { exclude: ["vendor/**", "*.min.js"] }
  disabled_rules: ["gitleaks:generic-api-key", "lens:react-*"]
  default_base: develop
  include_fixtures: true
  instructions_files: [CONTRIBUTING.md, docs/style.md]
  stages: false
scanners:
  disable: [brakeman, rubocop]
  custom:
    - source: https://github.com/aquasecurity/trivy
      run: trivy config --format sarif --output {report} {target}
      name: trivy-config
      version: 0.56.2
      paths: ["**/*.tf", "**/Dockerfile*"]
      target: repo
      timeout_seconds: 300
      install: { asset: "trivy_0.56.2_macOS-ARM64.tar.gz", binary: trivy, sha256: "${"a".repeat(64)}" }
    - source: https://github.com/example/jsontool
      run: jsontool --json {target}
      format: json-map
      map:
        items: results
        file: path
        line: start.line
        end_line: end.line
        rule: check_id
        severity: level
        message: text
        reference: url
        severity_map: { error: high, warning: medium }
graph:
  enabled: false
  budget_ms: 2500
  max_files: 900
  max_file_bytes: 65536
  max_cache_mb: 64
  max_heap_mb: 1500
`;

describe("loadConfig", () => {
  it("gives the defaults with no file and with an empty file", () => {
    expect(loadConfig(repoWith(null))).toEqual({ config: DEFAULT_CONFIG, path: null, warnings: [] });
    const repo = repoWith("");
    const loaded = loadConfig(repo);
    expect(loaded.config).toEqual(DEFAULT_CONFIG);
    expect(loaded.path).toBe(join(repo, ".openqodex.yaml"));
  });

  it("reads every key into its Config field", () => {
    const { config, warnings } = loadConfig(repoWith(FULL));
    expect(warnings).toEqual([]);
    expect(config).toEqual({
      blockOnSeverity: "major",
      severityThreshold: "nitpick",
      defaultBase: "develop",
      graph: { enabled: false, budgetMs: 2500, maxFiles: 900, maxFileBytes: 65536, maxCacheMb: 64, maxHeapMb: 1500 },
      exclude: ["vendor/**", "*.min.js"],
      disabledRules: ["gitleaks:generic-api-key", "lens:react-*"],
      includeFixtures: true,
      instructionsFiles: ["CONTRIBUTING.md", "docs/style.md"],
      stages: false,
      disabledScanners: ["brakeman", "rubocop"],
      custom: [
        {
          name: "trivy-config",
          source: "https://github.com/aquasecurity/trivy",
          run: "trivy config --format sarif --output {report} {target}",
          version: "0.56.2",
          format: "sarif",
          map: null,
          paths: ["**/*.tf", "**/Dockerfile*"],
          target: "repo",
          timeoutSeconds: 300,
          install: {
            kind: "github-release",
            asset: "trivy_0.56.2_macOS-ARM64.tar.gz",
            binary: "trivy",
            sha256: "a".repeat(64),
          },
        },
        {
          name: "jsontool",
          source: "https://github.com/example/jsontool",
          run: "jsontool --json {target}",
          version: null,
          format: "json-map",
          map: {
            items: "results",
            file: "path",
            line: "start.line",
            end_line: "end.line",
            rule: "check_id",
            severity: "level",
            message: "text",
            reference: "url",
            severity_map: { error: "high", warning: "medium" },
          },
          paths: null,
          target: "changed",
          timeoutSeconds: 120,
          install: { kind: "github-release", asset: null, binary: null, sha256: null },
        },
      ],
    });
  });

  it("reads an explicit path and refuses one that does not exist", () => {
    const repo = repoWith(null);
    writeFileSync(join(repo, "other.yaml"), "review: { include_fixtures: true }\n");
    const loaded = loadConfig(repo, "other.yaml");
    expect(loaded.config.includeFixtures).toBe(true);
    expect(loaded.path).toBe(join(repo, "other.yaml"));
    expect(() => loadConfig(repo, "missing.yaml")).toThrow(OpenQodexError);
  });
});

describe("config file location", () => {
  it("reads the folder file first, and warns naming both when the 0.1.0 root file is also there", () => {
    const only = repoWith(null, "review: { block_on_severity: major }\n");
    expect(loadConfig(only)).toEqual({
      config: { ...DEFAULT_CONFIG, blockOnSeverity: "major" },
      path: join(only, ".openqodex", "config.yaml"),
      warnings: [],
    });
    const both = repoWith("review: { block_on_severity: critical }\n", "review: { block_on_severity: major }\n");
    const loaded = loadConfig(both);
    expect(loaded.config.blockOnSeverity).toBe("major");
    expect(loaded.path).toBe(join(both, ".openqodex", "config.yaml"));
    expect(loaded.warnings).toHaveLength(1);
    expect(loaded.warnings[0]).toContain(".openqodex/config.yaml");
    expect(loaded.warnings[0]).toContain(".openqodex.yaml");
  });

  it("warns a 0.1.0 root file without severity_threshold about the new minor default, and nothing else", () => {
    const warning =
      "the report now hides findings below minor by default; set review.severity_threshold: info in .openqodex.yaml to keep seeing them";
    expect(loadConfig(repoWith("review: { block_on_severity: major }\n")).warnings).toEqual([warning]);
    expect(loadConfig(repoWith("pr_review: { block_on_severity: major }\n")).warnings).toContain(warning);
    expect(loadConfig(repoWith("review: { severity_threshold: info }\n")).warnings).toEqual([]);
    expect(loadConfig(repoWith("pr_review: { severity_threshold: info }\n")).warnings).not.toContain(warning);
    expect(loadConfig(repoWith(null, "review: { block_on_severity: major }\n")).warnings).toEqual([]);
  });

  it("names the 0.1.0 root file in an error from it", () => {
    expect(() => loadConfig(repoWith("review: { include_fixtures: 3 }\n"))).toThrow(
      /^\.openqodex\.yaml: review\.include_fixtures: /,
    );
  });
});

describe("the default config text", () => {
  it("lists every key the schema reads, so init writes and the docs show each one", () => {
    expect(CONFIG_KEYS.map((k) => k.key)).toEqual(schemaKeys());
  });
});

describe("keys from the hosted file", () => {
  it("reads pr_review as review and warns, naming pr_review in errors", () => {
    const { config, warnings } = parseConfig("pr_review:\n  severity_threshold: major\n  block_on_severity: critical\n");
    expect(config.severityThreshold).toBe("major");
    expect(config.blockOnSeverity).toBe("critical");
    expect(warnings).toEqual(["pr_review is the hosted name of the review block; it is read as review"]);
    expect(error("pr_review:\n  include_fixtures: 3\n")).toMatch(/: pr_review\.include_fixtures: /);
    expect(parseConfig("pr_review:\n  colour: x\n").warnings).toContain("unknown key pr_review.colour is ignored");
    expect(error("review: {}\npr_review: {}\n")).toMatch(/pr_review: review and pr_review are the same block/);
  });

  it("warns once for each hosted-only key, with its full path, and ignores it", () => {
    const hosted = [
      "enabled: false",
      "block_pr_merge: true",
      "allow_approve: true",
      "authors: [octocat]",
      "base_branches: [staging]",
      "style_placement_threshold: major",
    ];
    const reason = "is used by the hosted review only and is ignored";
    for (const block of ["review", "pr_review"]) {
      const { config, warnings } = parseConfig(
        `${block}:\n${hosted.map((l) => `  ${l}`).join("\n")}\nprobes:\n  allow_non_get: true\n`,
      );
      expect(config).toEqual(DEFAULT_CONFIG);
      expect(warnings.filter((w) => w.endsWith(reason)).sort()).toEqual(
        [...hosted.map((l) => `${block}.${l.split(":")[0]} ${reason}`), `probes ${reason}`].sort(),
      );
      expect(warnings.filter((w) => w.startsWith("unknown key"))).toEqual([]);
    }
  });
});

describe("parseConfig", () => {
  it("fills every default for the minimal two-line custom entry", () => {
    const { config } = parseConfig(`
scanners:
  custom:
    - source: https://github.com/aquasecurity/trivy.git
      run: trivy fs --format sarif --output {report} {target}
`);
    expect(config.custom).toEqual([
      {
        name: "trivy",
        source: "https://github.com/aquasecurity/trivy.git",
        run: "trivy fs --format sarif --output {report} {target}",
        version: null,
        format: "sarif",
        map: null,
        paths: null,
        target: "changed",
        timeoutSeconds: 120,
        install: { kind: "github-release", asset: null, binary: null, sha256: null },
      },
    ]);
  });

  it("ignores unknown keys with a warning naming each path", () => {
    const { config, warnings } = parseConfig(`
colour: blue
review:
  block_on_severty: critical
  include_fixtures: true
  instructions_files: [CONTRIBUTING.md, docs/style.md]
scanners:
  custom:
    - source: https://github.com/a/b
      run: b {target}
      flavour: x
`);
    expect(warnings.sort()).toEqual([
      "unknown key colour is ignored",
      "unknown key review.block_on_severty is ignored",
      "unknown key scanners.custom[0].flavour is ignored",
    ]);
    expect(config.includeFixtures).toBe(true);
    expect(config.blockOnSeverity).toBeNull();
    expect(config.custom[0].name).toBe("b");
  });

  it("refuses a wrong type and names the key path", () => {
    expect(error("review:\n  include_fixtures: yes please\n")).toMatch(/^\.openqodex\/config\.yaml: review\.include_fixtures: /);
    expect(error("review:\n  block_on_severity: high\n")).toMatch(/review\.block_on_severity: /);
    expect(error("review:\n  paths:\n    exclude: vendor\n")).toMatch(/review\.paths\.exclude: /);
    // An unknown name in scanners.disable is a warning now (config-changes.test.ts, failure 20).
    expect(error("scanners:\n  disable: nope\n")).toMatch(/scanners\.disable: /);
    expect(error("version: 2\n")).toMatch(/version: /);
    expect(error("- a\n- b\n")).toMatch(/\(top level\): /);
    expect(
      error("scanners:\n  custom:\n    - source: https://github.com/a/b\n      run: b\n      timeout_seconds: soon\n"),
    ).toMatch(/scanners\.custom\[0\]\.timeout_seconds: /);
    expect(error("scanners:\n  custom:\n    - source: https://github.com/a/b\n")).toMatch(/scanners\.custom\[0\]\.run: /);
  });

  it("reports a wrong type even when an unknown key sits beside it", () => {
    expect(error("typo: 1\nreview:\n  include_fixtures: 3\n")).toMatch(/review\.include_fixtures: /);
  });

  it("refuses invalid YAML with a plain error", () => {
    expect(error("review: [unclosed\n")).toMatch(/^\.openqodex\/config\.yaml: not valid YAML: /);
  });

  it("maps each install form to its kind", () => {
    const entry = (install: string, source = "https://github.com/a/tool"): unknown =>
      parseConfig(`scanners:\n  custom:\n    - source: ${source}\n      run: tool {target}\n      install: ${install}\n`)
        .config.custom[0].install;
    expect(entry("path", "my-local-tool")).toEqual({ kind: "path" });
    expect(entry("{ npm: \"pkg@1.2.3\" }", "https://www.npmjs.com/package/pkg")).toEqual({ kind: "npm", spec: "pkg@1.2.3" });
    expect(entry("{ uv: \"pkg==1.2.3\" }", "pkg")).toEqual({ kind: "uv", spec: "pkg==1.2.3" });
    expect(entry("{ binary: tool }")).toEqual({ kind: "github-release", asset: null, binary: "tool", sha256: null });
    expect(() => entry("{ npm: \"a@1\", uv: \"a==1\" }")).toThrow(/scanners\.custom\[0\]\.install: use one of/);
    expect(() => entry("{ npm: \"a@1\", asset: x.tgz }")).toThrow(/scanners\.custom\[0\]\.install: use one of/);
    expect(() => entry("brew")).toThrow(/scanners\.custom\[0\]\.install: /);
  });

  it("requires a GitHub repo link for a release install only", () => {
    const bad = (source: string): string =>
      error(`scanners:\n  custom:\n    - source: ${source}\n      run: x {target}\n`);
    expect(bad("https://gitlab.com/a/b")).toMatch(/scanners\.custom\[0\]\.source: expected a link/);
    expect(bad("https://github.com/a")).toMatch(/scanners\.custom\[0\]\.source: /);
    expect(bad("https://github.com/a/b/releases")).toMatch(/scanners\.custom\[0\]\.source: /);
    expect(bad("http://github.com/a/b")).toMatch(/scanners\.custom\[0\]\.source: /);
  });

  it("refuses duplicate names and names that are not plain words", () => {
    expect(
      error(
        "scanners:\n  custom:\n    - { source: https://github.com/a/tool, run: t }\n    - { source: https://github.com/b/tool, run: t }\n",
      ),
    ).toMatch(/scanners\.custom\[1\]\.name: "tool" is used by two entries/);
    expect(error("scanners:\n  custom:\n    - { source: https://github.com/a/b, run: t, name: ../x }\n")).toMatch(
      /scanners\.custom\[0\]\.name: /,
    );
  });

  it("refuses a glob longer than the matcher takes, naming the file, the key, the limit and the pattern", () => {
    const long = JSON.stringify(`${"x".repeat(MAX_GLOB)}*`);
    const limit = `longer than ${MAX_GLOB} characters, the most a glob can have: ${long}; shorten it`;
    expect(error(`review:\n  paths:\n    exclude: ["vendor/**", ${long}]\n`)).toBe(`.openqodex/config.yaml: review.paths.exclude[1]: ${limit}`);
    expect(error(`review:\n  disabled_rules: [${long}]\n`)).toBe(`.openqodex/config.yaml: review.disabled_rules[0]: ${limit}`);
    expect(error(`scanners:\n  custom:\n    - { source: https://github.com/a/b, run: t, paths: ["**/*.tf", ${long}] }\n`)).toBe(
      `.openqodex/config.yaml: scanners.custom[0].paths[1]: ${limit}`,
    );
    // The hosted file's pr_review block is named as written.
    expect(error(`pr_review:\n  disabled_rules: [${long}]\n`)).toBe(`.openqodex/config.yaml: pr_review.disabled_rules[0]: ${limit}`);
    // A glob at the limit is read as written.
    const atLimit = `${"x".repeat(MAX_GLOB - 1)}*`;
    expect(parseConfig(`review:\n  paths:\n    exclude: [${JSON.stringify(atLimit)}]\n`).config.exclude).toEqual([atLimit]);
  });

  it("requires a map block for json-map", () => {
    expect(error("scanners:\n  custom:\n    - { source: https://github.com/a/b, run: t, format: json-map }\n")).toMatch(
      /scanners\.custom\[0\]\.map: required when format is json-map/,
    );
  });
});

describe("hashes", () => {
  it("ignore key order and change with any value", () => {
    const a = parseConfig(FULL).config;
    const reordered = { ...a, custom: a.custom.map((c) => Object.fromEntries(Object.entries(c).reverse())) };
    expect(configHash(reordered as typeof a)).toBe(configHash(a));
    expect(configHash(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(configHash({ ...a, includeFixtures: false })).not.toBe(configHash(a));
    const entry = a.custom[0];
    expect(customEntryHash(Object.fromEntries(Object.entries(entry).reverse()) as typeof entry)).toBe(
      customEntryHash(entry),
    );
    expect(customEntryHash({ ...entry, run: `${entry.run} --quiet` })).not.toBe(customEntryHash(entry));
    expect(configHash(DEFAULT_CONFIG)).toBe(configHash({ ...DEFAULT_CONFIG }));
  });

  it("keeps a valid key when an alias shares it with a section where it is unknown", () => {
    const { config, warnings } = parseConfig("review: &r { block_on_severity: critical }\nscanners: *r\n");
    expect(config.blockOnSeverity).toBe("critical");
    expect(warnings).toEqual(["unknown key scanners.block_on_severity is ignored"]);
  });
});
