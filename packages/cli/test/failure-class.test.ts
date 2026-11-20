// failureClass turns a scanner's failure reason into one fixed class, so a
// feedback issue groups and never carries the tool's stderr. A reason
// OpenQodex phrases itself (a cold Cargo cache, a package it cannot
// type-check) must name a cause a reader can act on, not fall through to the
// catch-all, which made issue #401 ("cargo-deny: failed for a reason not
// listed") unactionable.
//
// Failure cases, written before the code:
//   1. A cargo-deny run that could not fetch the advisory database, could not
//      make its folder, found a cold Cargo cache, could not read the project
//      with cargo metadata, or printed no result, all read as "failed for a
//      reason not listed".
//   2. A golangci run where a package could not be type-checked, or a changed
//      file had no Go module, reads the same.
//   3. The class still carries a path, a crate name or any other text from the
//      reason (it must be a fixed phrase only).
//   4. A reason already handled (a timeout, an exit code, a file outside the
//      repo) stops being classed, or a genuinely unknown reason stops reading
//      as the catch-all.
import { describe, expect, it } from "vitest";
import { failureClass } from "../src/feedback.js";

describe("failureClass", () => {
  it("names each cargo-deny cause OpenQodex phrases itself (1)", () => {
    expect(failureClass("could not fetch the RustSec advisory database: git exited with code 128")).toBe(
      "could not fetch the advisory database",
    );
    expect(failureClass("cannot make the advisory database folder: EACCES: permission denied")).toBe(
      "could not make the advisory database folder",
    );
    expect(
      failureClass("the crates of Cargo.lock are not all in your Cargo cache (failed to download `itoa v0.1.1`); run `cargo fetch` in the repository root once"),
    ).toBe("a crate was missing from the Cargo cache");
    expect(
      failureClass("cargo metadata failed: error: the lock file /x/Cargo.lock needs to be updated but --frozen was passed to prevent this"),
    ).toBe("cargo metadata could not read the project");
    expect(failureClass("Cargo.lock: cargo-deny printed no result")).toBe("printed no report");
    expect(failureClass("needs Cargo (Rust)")).toBe("the Cargo toolchain was missing");
  });

  it("names each golangci cause OpenQodex phrases itself (2)", () => {
    expect(failureClass("backend: could not type-check: /usr/local/go/src/fmt/print.go:1: undefined: any")).toBe(
      "a package could not be type checked",
    );
    expect(failureClass("backend: parse: unexpected end of JSON input")).toBe("its report could not be read");
    expect(failureClass("no go.mod found for 2 changed dir(s): cmd/app, internal/db")).toBe(
      "a changed file had no Go module",
    );
  });

  it("keeps no text from the reason: a class is a fixed phrase (3)", () => {
    const leaky = "the crates of /home/alice/secret-repo/Cargo.lock are not all in your Cargo cache (failed to download `my-private-crate v0.1.1`)";
    const out = failureClass(leaky);
    expect(out).not.toContain("alice");
    expect(out).not.toContain("secret-repo");
    expect(out).not.toContain("my-private-crate");
    expect(out).not.toContain("/");
  });

  it("still classes the reasons it handled before, and still falls back (4)", () => {
    expect(failureClass("semgrep timed out after 120 s")).toBe("timed out after 120 s");
    expect(failureClass("gitleaks exit 2: fatal: not a git repository")).toBe("exited with code 2");
    expect(failureClass("a file was outside the repo")).toBe("a file was outside the repo");
    expect(failureClass("ledger.sql: larger than 5 MB")).toBe("a file was too large to read");
    expect(failureClass("brakeman blew up in a way nobody wrote down")).toBe("failed for a reason not listed");
    expect(failureClass(null)).toBe("failed for a reason not listed");
  });
});
