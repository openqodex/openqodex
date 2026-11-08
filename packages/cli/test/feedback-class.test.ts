// The failure class a scanner failure becomes in the feedback issue. The
// inputs are the reason texts the golangci adapter writes (issues 289 and
// 290), so an issue names the reason instead of "a reason not listed".
//
// Ways it could fail, written before the code:
// 1. A golangci type-check failure, whose reason starts with the Go module,
//    falls through to "failed for a reason not listed".
// 2. A golangci parse error behind its module prefix ("backend: parse:")
//    misses the parse class.
// 3. "timed out before module ..." falls through, or reads as a timeout with
//    a number it does not have.
// 4. A joined list of module reasons gets only its first class, or falls
//    through, so the other modules' reasons are lost.
// 5. Tool text quoted after a class is kept in the class.
// Added after review round 1:
// 6. A "; " inside Go's own text (the missing go.sum message) is read as a
//    part break, so the issue gains "a reason not listed".
// 7. Another scanner's reason with "; " in its tool text changes class.
import { describe, expect, it } from "vitest";
import { failureClass } from "../src/feedback.js";

describe("failureClass on golangci reasons", () => {
  it("names a type-check failure behind its module prefix", () => {
    expect(failureClass(".: could not type-check: /home/dev/app/main.go:3: undefined: x", "golangci")).toBe("could not type-check a changed package");
  });

  it("names a parse error behind its module prefix", () => {
    expect(failureClass("backend: parse: Unexpected token < in JSON at position 0", "golangci")).toBe("its report could not be read");
  });

  it("names the time running out before a module started", () => {
    expect(failureClass("timed out before module services/billing", "golangci")).toBe("ran out of time before a Go module");
  });

  it("names every part of a joined list, once each, and keeps no tool text", () => {
    const reason = [
      "a: could not type-check: /home/dev/a/x.go:1: undefined: y",
      "b: golangci-lint exit 3: Error: can't load config",
      "timed out before module c",
      "not run on tools/. No go.mod is at or above these Go files, so they are not in a Go module. To fix, run go mod init <module path> in that folder",
      "not run on the Go module at backend/. Its dependencies are not in the Go module cache, such as github.com/x/y. To fix, run go mod download in backend/",
      "d: could not type-check: /home/dev/d/z.go:2: undefined: w",
      "and 2 more",
    ].join("; ");
    expect(failureClass(reason, "golangci")).toBe(
      "could not type-check a changed package, exited with code 3, ran out of time before a Go module, a changed Go file was outside any Go module, Go dependencies were not downloaded, more reasons left out",
    );
  });

  it("reads a cut last part of a reason at the runner's 300-character cap as a cut, not a reason not listed", () => {
    // The runner puts a held-back file before the adapter's reason, then cuts the whole to 300.
    const held = "vendor/x.go: outside the repo";
    const skip = "not run on the Go module at backend. Its dependencies are not in the Go module cache, such as github.com/acme/" + "a".repeat(200) + ". To fix, run go mod download in backend";
    const reason = `${held}; ${skip}`.slice(0, 300);
    expect(reason.length).toBe(300);
    expect(failureClass(reason, "golangci")).toBe("a file was outside the repo, Go dependencies were not downloaded");
  });

  it("says a part is not listed when it is next to a listed one", () => {
    expect(failureClass("a: could not type-check: x.go:1: bad; something new", "golangci")).toBe("could not type-check a changed package, a reason not listed");
  });

  it("reads Go's missing go.sum text, with its own semicolon made a comma by the adapter, as one type-check class", () => {
    const reason = ".: could not type-check: <checkout>/main.go:3: could not import github.com/x/y (main.go:3:8: missing go.sum entry for module providing package github.com/x/y (imported by example.com/m), to add: go get example.com/m)";
    expect(failureClass(reason, "golangci")).toBe("could not type-check a changed package");
  });

  it("keeps another scanner's reason whole, so a semicolon in its tool text adds no class", () => {
    expect(failureClass("cargo-deny exit 2: error; see the log", "cargo-deny")).toBe("exited with code 2");
  });
});
