import { beforeAll, describe, expect, it } from "vitest";
import "./global-setup.js";
import { bin, demo, root, run, writeConfig } from "./support.js";

// Four visible commands; `scan` stays as a hidden alias that behaves exactly
// as it did, because released hooks, pre-commit and the Action call it.
//
// Ways it could fail, written before the code:
//  a. `--help` lists a hidden command, or misses one of the four.
//  b. `scan` and plain `review` report different findings or exit codes on
//     the demo repo under block_on_severity.
//  c. Plain `review` writes its hint on stdout and breaks --format json.
//  d. A 0.2.1-style hook line that calls `scan` stops working.

type Json = { verdict: string; findings: { source: string | null; file_path: string; line_number: number; severity: string }[] };
const key = (r: Json): string[] => r.findings.map((f) => `${f.severity} ${f.source} ${f.file_path}:${f.line_number}`).sort();

describe("the command menu", () => {
  it("a. --help lists exactly init, review, update and trust", () => {
    const r = run("menu-help", root, ["--help"]);
    expect(r.status).toBe(0);
    const section = r.stdout.split(/^Commands:$/m)[1] ?? "";
    const names = [...section.matchAll(/^ {2}(\S+)/gm)].map((m) => m[1]).filter((n) => n !== "help");
    expect(names).toEqual(["init", "review", "update", "trust"]);
  });

  describe("scan and plain review on the demo repo", () => {
    let dir: string;
    let scan: ReturnType<typeof run>;
    let review: ReturnType<typeof run>;
    beforeAll(() => {
      dir = demo("menu");
      writeConfig(dir, "review:\n  block_on_severity: major\n");
      scan = run("menu-scan", dir, ["scan", "--format", "json"]);
      review = run("menu-review", dir, ["review", "--format", "json"]);
    }, 300_000);

    it("b. report the same findings and the same exit code", () => {
      expect(scan.status).toBe(1);
      expect(review.status).toBe(scan.status);
      expect(key(JSON.parse(review.stdout) as Json)).toEqual(key(JSON.parse(scan.stdout) as Json));
    });

    it("c. plain review keeps stdout one JSON document and puts its hint on stderr", () => {
      expect(() => JSON.parse(review.stdout)).not.toThrow();
      expect(review.stdout).not.toContain("ask your coding agent");
      expect(review.stderr).toContain("ask your coding agent");
    });

    it("d. a 0.2.1-style hook line calling scan still stops the push on a blocking finding", () => {
      const line = `node ${JSON.stringify(bin)} scan; s=$?; [ "$s" -eq 1 ] && exit 1; exit 0`;
      expect(run("menu-hook-line", dir, [line], { shell: true }).status).toBe(1);
    });
  });
});
