// How the repo config changes between versions: the file init writes, a
// value a newer version added, the version a repo needs, and the table of
// renamed, removed and default-changed keys that `openqodex config migrate`
// reads.
//
// Ways it could fail, written before the code:
// 19. The file init writes pins today's defaults as live values, so a later
//     default change never reaches the repo, and each line looks like a
//     choice the team made.
// 20. An older version meets a scanner name a newer one added to
//     scanners.disable and stops with exit 2, which the push gate lets
//     through; or a misspelled name is ignored without naming the near one.
// 21. An unknown block_on_severity is ignored, which would weaken the gate.
// 22. A repo that needs a newer version cannot say so, and an older version
//     reads its config anyway.
// 23. A key leaves CONFIG_KEYS without a CONFIG_CHANGES entry, so files that
//     use it break or silently lose it.
// 24. config migrate writes without being asked, drops comments, or changes
//     what the config does.
// 25. A file an earlier init wrote with every default as a live value keeps
//     an old default after the default changed, without a word; or a file
//     the team wrote by hand is warned about its own choice.
// 26. The usage data key lands in the file init writes, even as a comment,
//     or config migrate drops a line that switches usage data off.
import { mkdirSync, readFileSync, realpathSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { CONFIG_CHANGES, CONFIG_KEYS, DEFAULT_CONFIG, DEFAULT_CONFIG_YAML, configHash, loadConfig, parseConfig, type ConfigChange } from "../src/config.js";
import { applyMigration, planMigration } from "../src/config-migrate.js";
import { OpenQodexError } from "../src/types.js";
import { removeTempDirs, tempDir } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

// Every key a release has shipped. Frozen: a key leaves CONFIG_KEYS only
// with a CONFIG_CHANGES entry, and a new key is added here.
const SHIPPED_KEYS = [
  "version",
  "min_version",
  "review.severity_threshold",
  "review.block_on_severity",
  "review.paths.exclude",
  "review.disabled_rules",
  "review.default_base",
  "review.include_fixtures",
  "review.instructions_files",
  "review.stages",
  "review.reviewers",
  "review.reviewer_web",
  "scanners.disable",
  "scanners.custom",
  "graph.enabled",
  "graph.budget_ms",
  "graph.max_files",
  "graph.max_file_bytes",
  "graph.max_cache_mb",
  "graph.max_heap_mb",
  "openqodex_telemetry",
];

function repo(): string {
  return realpathSync(tempDir("oq-config-changes-"));
}

function refused(run: () => unknown): string {
  try {
    run();
  } catch (e) {
    expect(e).toBeInstanceOf(OpenQodexError);
    return (e as Error).message;
  }
  throw new Error("expected the config to be refused");
}

describe("the file init writes", () => {
  it("sets version only; every other key is a comment with its default (failure 19)", () => {
    expect(parseYaml(DEFAULT_CONFIG_YAML)).toEqual({ version: 1 });
    expect(parseConfig(DEFAULT_CONFIG_YAML)).toEqual({ config: DEFAULT_CONFIG, warnings: [] });
    for (const { key, default: value } of CONFIG_KEYS.filter((k) => k.key !== "version" && !k.unlisted)) {
      const leaf = key.split(".").pop()!;
      expect(DEFAULT_CONFIG_YAML, key).toMatch(new RegExp(`^# *${leaf}: ${value.replace(/[[\]]/g, "\\$&")}$`, "m"));
    }
  });

  it("never holds the usage data key, not even as a comment (failure 26)", () => {
    expect(DEFAULT_CONFIG_YAML).not.toContain("openqodex_telemetry");
  });

  it("reads back to the defaults, with no warning, once the `# ` starting each line below version is removed (failure 19)", () => {
    const [, body] = DEFAULT_CONFIG_YAML.split("version: 1\n");
    const live = `version: 1\n${body!.split("\n").map((l) => (l.startsWith("# ") ? l.slice(2) : l)).join("\n")}`;
    expect(live).toMatch(/^review:$/m);
    expect(parseConfig(live)).toEqual({ config: DEFAULT_CONFIG, warnings: [] });
  });
});

describe("a value or key from another version", () => {
  it("an unknown name in scanners.disable is ignored with a warning, naming the scanner it is near (failure 20)", () => {
    const { config, warnings } = parseConfig("scanners:\n  disable: [snyk, semgrp, gitleaks]\n");
    expect(config.disabledScanners).toEqual(["gitleaks"]);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/^scanners\.disable: snyk is not a scanner this version knows; it is ignored \(the scanners are semgrep, gitleaks, /);
    expect(warnings[1]).toBe("scanners.disable: semgrp is not a scanner this version knows; it is ignored (did you mean semgrep?)");
  });

  it("an unknown block_on_severity still stops the run (failure 21)", () => {
    expect(refused(() => parseConfig("review:\n  block_on_severity: blocker\n"))).toMatch(/review\.block_on_severity: /);
  });

  it("min_version stops an older version with the version it needs, and passes a newer one (failure 22)", () => {
    const text = "version: 1\nmin_version: 99.0.0\n";
    expect(refused(() => parseConfig(text, ".openqodex/config.yaml", { runtimeVersion: "0.9.0" }))).toBe(
      ".openqodex/config.yaml: min_version: this repo's config needs openqodex 99.0.0 or newer, and this is 0.9.0; run openqodex update",
    );
    expect(parseConfig(text, ".openqodex/config.yaml", { runtimeVersion: "99.0.1" }).warnings).toEqual([]);
    expect(refused(() => parseConfig("min_version: soon\n"))).toMatch(/min_version: expected a version such as 0\.9\.0/);
    const root = repo();
    mkdirSync(join(root, ".openqodex"));
    writeFileSync(join(root, ".openqodex/config.yaml"), text);
    expect(refused(() => loadConfig(root, undefined, { runtimeVersion: "0.9.0" }))).toMatch(/needs openqodex 99\.0\.0 or newer/);
  });
});

describe("the table of config changes", () => {
  it("every key a release shipped is still read, or has a CONFIG_CHANGES entry (failure 23)", () => {
    const keys = CONFIG_KEYS.map((k) => k.key);
    const changed = new Set(CONFIG_CHANGES.flatMap((c) => (c.kind === "renamed" || c.kind === "removed" ? [c.key] : [])));
    for (const key of SHIPPED_KEYS) expect(keys.includes(key) || changed.has(key), key).toBe(true);
    for (const key of keys) expect(SHIPPED_KEYS, `add ${key} to SHIPPED_KEYS`).toContain(key);
  });

  it("a removed key is ignored with the reason the table gives, not as unknown (failure 23)", () => {
    const changes: ConfigChange[] = [...CONFIG_CHANGES, { kind: "removed", key: "graph.cache", since: "9.9.0", why: "the graph is no longer cached" }];
    const { warnings } = parseConfig("graph:\n  cache: true\n", ".openqodex/config.yaml", { changes });
    expect(warnings).toEqual(["graph.cache was removed in 9.9.0 and is ignored: the graph is no longer cached (openqodex config migrate removes it)"]);
  });

  it("a key an earlier init wrote at a default since changed is told the new default; a hand-written file is not (failure 25)", () => {
    const changes: ConfigChange[] = [...CONFIG_CHANGES, { kind: "default", key: "graph.max_files", was: "3000", since: "9.9.0" }];
    const byInit = "# OpenQodex settings for this repo. Every key is optional; these are the defaults.\ngraph:\n  max_files: 3000\n";
    expect(parseConfig(byInit, ".openqodex/config.yaml", { changes }).warnings).toEqual([
      "graph.max_files: 3000 is the default an earlier openqodex init wrote; since 9.9.0 the default is 4000. Delete the line to follow the default, or keep it to stay on 3000.",
    ]);
    expect(parseConfig("graph:\n  max_files: 3000\n", ".openqodex/config.yaml", { changes }).warnings).toEqual([]);
  });
});

describe("config migrate", () => {
  it("renames a key in place, keeps every comment, keeps what the config does, and writes only when applied (failure 24)", () => {
    const root = repo();
    mkdirSync(join(root, ".openqodex"));
    const before = "# the team's\npr_review: # the review block\n  severity_threshold: info # we want everything\n  block_on_severity: major\n";
    writeFileSync(join(root, ".openqodex/config.yaml"), before);
    const m = planMigration(root);
    expect(m.changes).toEqual(["pr_review renamed to review"]);
    expect(m.text).toBe("# the team's\nreview: # the review block\n  severity_threshold: info # we want everything\n  block_on_severity: major\n");
    expect(readFileSync(join(root, ".openqodex/config.yaml"), "utf8")).toBe(before);
    expect(configHash(parseConfig(m.text!).config)).toBe(configHash(parseConfig(before).config));
    applyMigration(root, m);
    expect(readFileSync(join(root, ".openqodex/config.yaml"), "utf8")).toBe(m.text);
    expect(planMigration(root).changes).toEqual([]);
  });

  it("keeps openqodex_telemetry: 0 beside a key it renames (failure 26)", () => {
    const root = repo();
    mkdirSync(join(root, ".openqodex"));
    writeFileSync(join(root, ".openqodex/config.yaml"), "openqodex_telemetry: 0\npr_review:\n  block_on_severity: major\n");
    const m = planMigration(root);
    expect(m.changes).toEqual(["pr_review renamed to review"]);
    applyMigration(root, m);
    expect(readFileSync(join(root, ".openqodex/config.yaml"), "utf8")).toBe("openqodex_telemetry: 0\nreview:\n  block_on_severity: major\n");
  });

  it("moves the 0.1.0 root file into .openqodex/config.yaml when it is the only one (failure 24)", () => {
    const root = repo();
    writeFileSync(join(root, ".openqodex.yaml"), "review: { block_on_severity: major }\n");
    const m = planMigration(root);
    expect(m.changes).toEqual([".openqodex.yaml moved to .openqodex/config.yaml"]);
    applyMigration(root, m);
    expect(existsSync(join(root, ".openqodex.yaml"))).toBe(false);
    expect(readFileSync(join(root, ".openqodex/config.yaml"), "utf8")).toBe("review: { block_on_severity: major }\n");
  });

  it("says there is nothing to change for a current file or no file (failure 24)", () => {
    expect(planMigration(repo())).toEqual({ file: null, target: null, changes: [], text: null });
    const root = repo();
    mkdirSync(join(root, ".openqodex"));
    writeFileSync(join(root, ".openqodex/config.yaml"), DEFAULT_CONFIG_YAML);
    expect(planMigration(root).changes).toEqual([]);
  });
});
