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
import { describe, expect, it } from "vitest";
import { failureClass } from "../src/feedback.js";

describe("failureClass on golangci reasons", () => {
  it("names a type-check failure behind its module prefix", () => {
    expect(failureClass(".: could not type-check: /home/dev/app/main.go:3: undefined: x")).toBe("could not type-check a changed package");
  });

  it("names a parse error behind its module prefix", () => {
    expect(failureClass("backend: parse: Unexpected token < in JSON at position 0")).toBe("its report could not be read");
  });

  it("names the time running out before a module started", () => {
    expect(failureClass("timed out before module services/billing")).toBe("ran out of time before a Go module");
  });

  it("names every part of a joined list, once each, and keeps no tool text", () => {
    const reason = [
      "a: could not type-check: /home/dev/a/x.go:1: undefined: y",
      "b: golangci-lint exit 3: Error: can't load config",
      "timed out before module c",
      "not run on tools/: no go.mod at or above these Go files, so they are not in a Go module. To fix, run go mod init <module path> in their folder",
      "d: could not type-check: /home/dev/d/z.go:2: undefined: w",
    ].join("; ");
    expect(failureClass(reason)).toBe(
      "could not type-check a changed package, exited with code 3, ran out of time before a Go module, a changed Go file was outside any Go module",
    );
  });

  it("says a part is not listed when it is next to a listed one", () => {
    expect(failureClass("a: could not type-check: x.go:1: bad; something new")).toBe("could not type-check a changed package, a reason not listed");
  });
});
