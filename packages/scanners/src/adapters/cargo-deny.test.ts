// cargo-deny reports each crate by name, version and source on a line of a
// crate list it makes up, not of Cargo.lock. These tests read its real
// output (test/fixtures/cargo-deny/check.txt says how it was made).
//
// Failure list, written before the code:
//   1. An advisory lands on a line other than its crate's entry in
//      Cargo.lock: the span runs from the entry's name line to its version
//      line, the span osv-scanner gives the same advisory, so the two can be
//      merged.
//   2. With two versions of one crate in the lockfile, an advisory lands on
//      the entry of the other version.
//   3. The rule id is not the advisory id, or the severity ignores the kind
//      (a vulnerability is high, unsound medium, unmaintained low).
//   4. A line that is not about the crate graph (a log line, the summary, an
//      index failure) becomes a finding.
//   5. An error cargo-deny logs is lost, so a failed run reads clean.
//   6. Crates missing from the Cargo cache read as a clean run instead of a
//      reason that names the fix.
//   7. The owned config lets a repository's deny.toml in, keeps the advisory
//      database outside the OpenQodex home, or checks yanked crates through
//      the developer's index cache.
// Added after the code review of the library branch:
//   8. A server run's own Cargo home gets from the preinstalled one other
//      than what the lock's registry crates need (each registry's settings,
//      the crates' index entries and archives), takes a lock name that is no
//      crate name as a path, copies through a link, or writes in the
//      preinstalled home.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { cargoDenyConfig, cargoPathProblem, metadataFailure, parseCargoDenyOutput, seedCargoHome } from "./cargo-deny.js";

// The temp folders this file made, removed when it ends: a source-package
// test cannot import tests/temp-dirs.mjs, so it keeps its own list.
const made: string[] = [];
const tempDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`../../test/fixtures/cargo-deny/${name}`, import.meta.url)), "utf8");
const CHECK = fixture("check.jsonl");
const LOCK = fixture("Cargo.lock.txt");
const parse = (stderr = CHECK, lockText: string | null = LOCK) => parseCargoDenyOutput(stderr, { lockPath: "Cargo.lock", lockText });

describe("parseCargoDenyOutput", () => {
  it("each advisory lands on its crate's entry, name line to version line, as osv-scanner anchors it (1, 3)", () => {
    const { findings, failure } = parse();
    expect(failure).toBeNull();
    expect(findings.map((f) => [f.ruleId, f.filePath, f.lineStart, f.lineEnd, f.severity])).toEqual([
      ["RUSTSEC-2021-0139", "Cargo.lock", 6, 7, "low"],
      ["RUSTSEC-2021-0003", "Cargo.lock", 15, 16, "high"],
    ]);
    const vuln = findings[1]!;
    expect(vuln).toMatchObject({ source: "cargo-deny", reference: "https://rustsec.org/advisories/RUSTSEC-2021-0003" });
    expect(vuln.message).toContain("smallvec 1.6.0");
    expect(vuln.message).toContain("CVE-2021-25900");
    expect(vuln.message).toContain("Buffer overflow in SmallVec::insert_many");
    expect(vuln.message).toContain("Upgrade to >=0.6.14, <1.0.0 OR >=1.6.1");
  });

  it("with two versions of a crate, the advisory lands on the version it names (2)", () => {
    const lock = LOCK.replace('name = "smallvec"\nversion = "1.6.0"', 'name = "smallvec"\nversion = "1.13.2"\nsource = "x"\n\n[[package]]\nname = "smallvec"\nversion = "1.6.0"');
    const vuln = parse(CHECK, lock).findings.find((f) => f.ruleId === "RUSTSEC-2021-0003")!;
    expect(lock.split("\n")[vuln.lineStart - 1]).toBe('name = "smallvec"');
    expect(lock.split("\n")[vuln.lineEnd - 1]).toBe('version = "1.6.0"');
  });

  it("log lines, the summary and an index failure are not findings (4)", () => {
    const index = JSON.stringify({ fields: { code: "index-failure", labels: [{ column: 1, line: 1, message: "", span: "smallvec 1.6.0 registry+https://github.com/rust-lang/crates.io-index" }], message: "unable to check for yanked crates", notes: [], severity: "warning" }, type: "diagnostic" });
    const info = JSON.stringify({ fields: { level: "INFO", message: "gathered 5 crates" }, type: "log" });
    const { findings, failure } = parse(`${index}\n${info}\n${CHECK}`);
    expect(findings.map((f) => f.ruleId)).toEqual(["RUSTSEC-2021-0139", "RUSTSEC-2021-0003"]);
    expect(failure).toBeNull();
  });

  it("an error cargo-deny logs fails the run, and a run with no summary is not clean (5)", () => {
    const error = JSON.stringify({ fields: { level: "ERROR", message: "failed to validate configuration file /tmp/x/deny.toml" }, type: "log" });
    expect(parse(error).failure).toBe("failed to validate configuration file /tmp/x/deny.toml");
    expect(parse("").failure).toBe("cargo-deny printed no result");
  });

  it("an advisory on a lockfile that cannot be read lands on line 1", () => {
    expect(parse(CHECK, null).findings.map((f) => [f.lineStart, f.lineEnd])).toEqual([
      [1, 1],
      [1, 1],
    ]);
  });
});

describe("metadataFailure", () => {
  it("crates missing from the Cargo cache name the fix, not a clean run (6)", () => {
    expect(metadataFailure(fixture("metadata-missing.txt"), "rust")).toBe(
      "the crates of rust/Cargo.lock are not all in your Cargo cache (failed to download `itoa v0.1.1`); run `cargo fetch` in rust/ once",
    );
    // Cargo 1.99, when its index cache has never seen the crate.
    const unseen = "error: no matching package named `itoa` found\nlocation searched: crates.io index\nrequired by package `miss v0.1.0 (/x)`\nnote: offline mode (via `--frozen`) can sometimes cause surprising resolution failures\n";
    expect(metadataFailure(unseen, "")).toBe(
      "the crates of Cargo.lock are not all in your Cargo cache (no matching package named `itoa` found); run `cargo fetch` in the repository root once",
    );
    expect(metadataFailure("error: the lock file /x/Cargo.lock needs to be updated but --frozen was passed to prevent this\n", "")).toBe(
      "cargo metadata failed: error: the lock file /x/Cargo.lock needs to be updated but --frozen was passed to prevent this",
    );
  });
});

describe("cargoDenyConfig", () => {
  it("keeps the advisory database under the given folder, from RustSec only, with yank checks off (7)", () => {
    const config = cargoDenyConfig("/home/u/.openqodex/cache/cargo-deny/advisory-dbs");
    expect(config).toContain('db-path = "/home/u/.openqodex/cache/cargo-deny/advisory-dbs"');
    expect(config).toContain('db-urls = ["https://github.com/rustsec/advisory-db"]');
    expect(config).toContain("disable-yank-checking = true");
    expect(config).not.toMatch(/\[licenses\]|\[bans\]/);
    // A path with a quote or a backslash stays one TOML string.
    expect(cargoDenyConfig('/a"b\\c')).toContain('db-path = "/a\\"b\\\\c"');
  });
});

// Cargo reads every manifest a project's manifests name: path dependencies,
// workspace members and the workspace root, patches, and the Cargo.toml of
// each folder above the project until one holds a [workspace]. Any of them
// can point outside the repository, so each is checked before Cargo starts.
// Failure list, written before the code:
//   8. A path dependency, a workspace member, `package.workspace`, a patch
//      or a replace path names a folder outside the repository, by an
//      absolute path or by `../`, and Cargo reads its manifest.
//   9. The same path stays inside the repository but runs through a link
//      that leaves it, or the manifest itself is such a link.
//  10. The escape sits in a manifest the project's manifest names in turn.
//  11. No manifest from the project up to the repository root holds a
//      [workspace], so Cargo walks on to a Cargo.toml above the repository.
//  12. A target path (lib, bin, build script, readme) names a file outside.
//  13. A project whose manifests stay inside is refused.
describe("cargoPathProblem", () => {
  const plant = (files: Record<string, string>): { parent: string; repo: string } => {
    const parent = tempDir("oq-cargo-paths-");
    const repo = join(parent, "repo");
    mkdirSync(repo);
    for (const [name, body] of Object.entries(files)) {
      mkdirSync(dirname(join(repo, name)), { recursive: true });
      writeFileSync(join(repo, name), body);
    }
    return { parent, repo };
  };
  const pkg = (name: string, extra = "") => `[package]\nname = "${name}"\nversion = "0.1.0"\nedition = "2021"\n${extra}`;
  const outside = tempDir("oq-cargo-outside-");
  writeFileSync(join(outside, "Cargo.toml"), pkg("outside"));

  it("refuses a dependency, member, workspace, patch or replace path outside the repository (8)", async () => {
    const escapes = [
      `${pkg("app")}\n[dependencies]\nout = { path = "${outside}" }\n`,
      `${pkg("app")}\n[dev-dependencies]\nout = { path = "../../${"../".repeat(20)}${outside.slice(1)}" }\n`,
      `${pkg("app")}\n[target.'cfg(unix)'.build-dependencies]\nout = { path = "${outside}" }\n`,
      `[workspace]\nmembers = ["${outside}"]\n`,
      `[workspace]\nmembers = ["crates/a", "../out"]\n`,
      `${pkg("app", `workspace = "${outside}"\n`)}`,
      `${pkg("app")}\n[patch.crates-io]\nserde = { path = "${outside}" }\n`,
      `${pkg("app")}\n[replace]\n"serde:1.0.0" = { path = "${outside}" }\n`,
      `[workspace]\nmembers = []\n\n[workspace.dependencies]\nout = { path = "${outside}" }\n`,
    ];
    for (const manifest of escapes) {
      const { repo } = plant({ "Cargo.toml": manifest, "src/main.rs": "fn main() {}\n" });
      expect(await cargoPathProblem(repo, ""), manifest).toMatch(/outside the repo/);
    }
  });

  it("refuses a path or a manifest reached through a link that leaves the repository (9)", async () => {
    const { repo } = plant({ "Cargo.toml": `${pkg("app")}\n[dependencies]\nlib = { path = "vendor/lib" }\n` });
    symlinkSync(outside, join(repo, "vendor"));
    expect(await cargoPathProblem(repo, "")).toMatch(/outside the repo|link/);
    const linked = plant({});
    symlinkSync(join(outside, "Cargo.toml"), join(linked.repo, "Cargo.toml"));
    expect(await cargoPathProblem(linked.repo, "")).toMatch(/not a regular file|link|outside the repo/);
  });

  it("follows the manifests a manifest names, and refuses an escape there (10)", async () => {
    const { repo } = plant({
      "Cargo.toml": `${pkg("app")}\n[dependencies]\na = { path = "crates/a" }\n`,
      "crates/a/Cargo.toml": `${pkg("a")}\n[dependencies]\nout = { path = "${outside}" }\n`,
    });
    expect(await cargoPathProblem(repo, "")).toMatch(/crates\/a\/Cargo\.toml.*outside the repo/);
  });

  it("refuses a project whose workspace search would reach a Cargo.toml above the repository (11)", async () => {
    const { parent, repo } = plant({ "crates/a/Cargo.toml": pkg("a"), "crates/a/src/lib.rs": "" });
    writeFileSync(join(parent, "Cargo.toml"), `[workspace]\nmembers = ["repo/crates/a", "${outside}"]\n`);
    expect(await cargoPathProblem(repo, "crates/a")).toMatch(/above the repository/);
    // A [workspace] inside the repository ends the search there.
    writeFileSync(join(repo, "Cargo.toml"), '[workspace]\nmembers = ["crates/a"]\n');
    expect(await cargoPathProblem(repo, "crates/a")).toBeNull();
  });

  it("refuses a target, build script or readme path outside the repository (12)", async () => {
    for (const extra of [`\n[lib]\npath = "${outside}/lib.rs"\n`, `\n[[bin]]\nname = "x"\npath = "../../x.rs"\n`]) {
      const { repo } = plant({ "Cargo.toml": `${pkg("app")}${extra}` });
      expect(await cargoPathProblem(repo, ""), extra).toMatch(/outside the repo/);
    }
    const { repo } = plant({ "Cargo.toml": pkg("app", `build = "${outside}/build.rs"\nreadme = "../README.md"\n`) });
    expect(await cargoPathProblem(repo, "")).toMatch(/outside the repo/);
  });

  // The gate fails closed: Cargo reads each manifest with its own parser and
  // expands member patterns over the file system, following links, so a
  // manifest the gate cannot read whole, a pattern, or a walk past its limit
  // withholds the project.
  //  14. A path dependency, member or workspace root names a folder with no
  //      readable Cargo.toml, and the gate passes it unread.
  //  15. A member manifest does not parse as TOML and is passed unread.
  //  16. A member pattern (`crates/*`) is expanded by the gate differently
  //      from Cargo, which follows a link to a folder outside.
  //  17. A workspace with more manifests than the gate walks is passed.
  it("withholds a project when a manifest it names is missing, does not parse, is a pattern, or the walk is too long (14-17)", async () => {
    const missing = plant({ "Cargo.toml": `${pkg("app")}\n[dependencies]\nlib = { path = "crates/lib" }\n` });
    mkdirSync(join(missing.repo, "crates/lib"), { recursive: true });
    expect(await cargoPathProblem(missing.repo, "")).toMatch(/crates\/lib\/Cargo\.toml/);
    const broken = plant({ "Cargo.toml": '[workspace]\nmembers = ["crates/a"]\n', "crates/a/Cargo.toml": '[package]\nname = "a"\nname = "b"\n' });
    expect(await cargoPathProblem(broken.repo, "")).toMatch(/crates\/a\/Cargo\.toml/);
    const pattern = plant({ "Cargo.toml": '[workspace]\nmembers = ["crates/*"]\n', "crates/a/Cargo.toml": pkg("a") });
    symlinkSync(outside, join(pattern.repo, "crates", "evil"));
    expect(await cargoPathProblem(pattern.repo, "")).toMatch(/pattern/);
    const members = Array.from({ length: 1001 }, (_, k) => `c${k}`);
    const files: Record<string, string> = { "Cargo.toml": `[workspace]\nmembers = ${JSON.stringify(members)}\n` };
    for (const m of members) files[`${m}/Cargo.toml`] = pkg(m);
    expect(await cargoPathProblem(plant(files).repo, "")).toMatch(/more Cargo manifests/);
  });

  it("accepts a workspace whose members, path dependencies and patches stay inside (13)", async () => {
    const { repo } = plant({
      "Cargo.toml": `[workspace]\nmembers = ["crates/app", "crates/local", "crates/shared"]\n\n[workspace.dependencies]\nshared = { path = "crates/shared" }\n\n[patch.crates-io]\nserde = { path = "vendor/serde" }\n`,
      "crates/app/Cargo.toml": `${pkg("app")}\n[dependencies]\nshared = { workspace = true }\nlocal = { path = "../local" }\n`,
      "crates/app/src/main.rs": "fn main() {}\n",
      "crates/local/Cargo.toml": pkg("local"),
      "crates/shared/Cargo.toml": pkg("shared", 'readme = "README.md"\n'),
      "vendor/serde/Cargo.toml": pkg("serde"),
    });
    expect(await cargoPathProblem(repo, "")).toBeNull();
    expect(await cargoPathProblem(repo, "crates/app")).toBeNull();
  });
});

describe("a server run's own Cargo home", () => {
  const put = (path: string, text: string) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  };
  // Every file under `dir`, with its text.
  const files = (dir: string): Record<string, string> =>
    Object.fromEntries(
      readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile() || e.isSymbolicLink())
        .map((e) => join(e.parentPath, e.name))
        .map((p) => [p.slice(dir.length + 1), e2text(p)])
        .sort(),
    );
  const e2text = (p: string) => {
    try {
      return readFileSync(p, "utf8");
    } catch {
      return "(unreadable)";
    }
  };

  it("8. gets each registry's settings and the index entries and archives of the lock's crates, and nothing else", () => {
    const from = tempDir("oq-cargo-from-");
    const reg = "index.crates.io-1949cf8c6b5b557f";
    const index = join(from, "registry", "index", reg);
    const archives = join(from, "registry", "cache", reg);
    put(join(index, "config.json"), '{"dl":"https://static.crates.io/crates"}');
    put(join(index, ".cache", "sm", "al", "smallvec"), "index smallvec");
    put(join(index, ".cache", "3", "l", "log"), "index log");
    put(join(index, ".cache", "2", "cc"), "index cc, not in the lock");
    put(join(archives, "smallvec-1.6.0.crate"), "archive smallvec 1.6.0");
    put(join(archives, "smallvec-1.5.0.crate"), "archive smallvec 1.5.0, another version");
    put(join(archives, "log-0.4.0.crate"), "archive log");
    const outside = tempDir("oq-cargo-outside-");
    put(join(outside, "secret.crate"), "a file outside the Cargo home");
    symlinkSync(join(outside, "secret.crate"), join(archives, "linked-1.0.0.crate"));
    const before = files(from);
    const lock = [
      "version = 4",
      "",
      "[[package]]",
      'name = "smallvec"',
      'version = "1.6.0"',
      'source = "registry+https://github.com/rust-lang/crates.io-index"',
      "",
      "[[package]]",
      'name = "log"',
      'version = "0.4.0"',
      'source = "sparse+https://index.crates.io/"',
      "",
      "[[package]]",
      'name = "linked"',
      'version = "1.0.0"',
      'source = "registry+https://github.com/rust-lang/crates.io-index"',
      "",
      "[[package]]",
      'name = "../../secret"',
      'version = "1.0.0"',
      'source = "registry+https://github.com/rust-lang/crates.io-index"',
      "",
      "[[package]]",
      'name = "tiny"',
      'version = "0.1.0"',
      "",
    ].join("\n");
    const to = join(tempDir("oq-cargo-to-"), "cargo-home");
    seedCargoHome({ from, to, lockText: lock });
    expect(files(to)).toEqual({
      [join("registry", "cache", reg, "log-0.4.0.crate")]: "archive log",
      [join("registry", "cache", reg, "smallvec-1.6.0.crate")]: "archive smallvec 1.6.0",
      [join("registry", "index", reg, ".cache", "3", "l", "log")]: "index log",
      [join("registry", "index", reg, ".cache", "sm", "al", "smallvec")]: "index smallvec",
      [join("registry", "index", reg, "config.json")]: '{"dl":"https://static.crates.io/crates"}',
    });
    expect(files(from)).toEqual(before);
  });
});
