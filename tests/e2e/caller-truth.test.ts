// The truth list of tests/e2e/caller-truth.ts must be right before it can
// judge the graph. A call on a union receiver may run any member's method,
// so the truth names every member's declaration; an overloaded method
// still names its one implementation.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { compilerTruth } from "./caller-truth.js";
import { removeTempDirs, tempDir } from "../temp-dirs.mjs";

afterAll(removeTempDirs);

function sample(files: Record<string, string>): string {
  const dir = tempDir("oq-e2e-caller-truth-");
  mkdirSync(join(dir, "src"), { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, "src", name), text);
  return dir;
}

const targetsOf = (dir: string, call: string) =>
  compilerTruth({ root: dir, scope: ["src"] }).calls.filter((c) => c.name === call).flatMap((c) => c.targets.map((t) => `${t.owner}.${t.name}`)).sort();

describe("the caller truth list", () => {
  it("names every member's method for a call on a union receiver", () => {
    const dir = sample({
      "a.ts": [
        "export class Cat { run(speed: number): number { return speed; } }",
        "export class Dog { run(speed: number): number { return speed * 2; } }",
        "export function go(x: Cat | Dog): number { return x.run(1); }",
        "",
      ].join("\n"),
    });
    expect(targetsOf(dir, "run")).toEqual(["Cat.run", "Dog.run"]);
  });

  it("names the one implementation of an overloaded method (negative control)", () => {
    const dir = sample({
      "a.ts": [
        "export class Box {",
        "  put(x: string): void;",
        "  put(x: number): void;",
        "  put(x: string | number): void { void x; }",
        "}",
        "export function go(b: Box): void { b.put(1); }",
        "",
      ].join("\n"),
    });
    expect(targetsOf(dir, "put")).toEqual(["Box.put"]);
  });
});
