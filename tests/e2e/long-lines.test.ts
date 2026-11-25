// Failures guarded:
// 1. A 1 MB changed line never reaches a reviewer or is credited too soon.
// 2. Fragment labels lose byte offsets or present a fragment as one full line.
// 3. A removed long line, a secret inside a long line, or a multi-byte line
//    loses bytes, leaks the secret, or splits a character.
// 4. A Read that returns a cut line credits the bytes it never returned.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import type { ReviewUnit, TraceEntry } from "@openqodex/core";
import "./global-setup.js";
import { baseline, demo, git, readJson, report, reportDir, run, stagedProviderEnv, writeConfig } from "./support.js";
import { fixDemoSecret } from "../golden/fixture-secret.mjs";
import { removeTempDirs } from "../temp-dirs.mjs";

afterAll(removeTempDirs);
const flags = ["review", "--reviewer", "claude", "--offline", "--no-install", "--no-color"];
const staged = (dir: string) => writeConfig(dir, "review:\n  stages: true\n");

// Walks one side's fragment parts in order. Each part's first finder brief
// must carry exactly its bytes, labelled and contiguous. Returns the joined text.
function walk(out: string, path: string, side: "+" | "-", label: string, total: number): string {
  const refs = readJson<ReviewUnit[]>(join(out, "units.json")).flatMap((u) => u.hunks).filter((h) => h.path === path && Boolean(h.deletion) === (side === "-"));
  expect(refs.length).toBeGreaterThan(1);
  const briefs = readdirSync(join(out, "briefs")).filter((n) => n.startsWith("finder-")).map((n) => readFileSync(join(out, "briefs", n), "utf8"));
  const pattern = new RegExp(`^\\${side}${label.replaceAll(".", "\\.")}, bytes ([\\d,]+) to ([\\d,]+) of ${total.toLocaleString("en-US")}\\t(.*)$`, "gm");
  const pieces: string[] = [];
  let next = 1;
  for (const h of refs) {
    // The staged route names the final inventory id.
    expect(h.fragment!.of).toBe(h.id);
    expect(h.fragment!.from).toBe(next);
    const own = briefs.filter((text) => text.includes(`### ${h.id} ${path} `));
    expect(own).toHaveLength(2);
    const labels = [...own[0]!.matchAll(pattern)];
    expect(labels.length).toBeGreaterThan(0);
    for (const m of labels) {
      expect(Number(m[1]!.replaceAll(",", ""))).toBe(next);
      next = Number(m[2]!.replaceAll(",", "")) + 1;
      expect(Buffer.byteLength(m[3]!)).toBe(next - Number(m[1]!.replaceAll(",", "")));
      pieces.push(m[3]!);
    }
    expect(next).toBe(h.fragment!.to + 1);
  }
  expect(next).toBe(total + 1);
  return pieces.join("");
}

it("7m carries a 1 MB changed line through labelled byte fragments", () => {
  const dir = baseline();
  staged(dir);
  writeFileSync(join(dir, "long.txt"), "x".repeat(1024 * 1024) + "\n");
  const result = run("long-line", dir, flags, { env: stagedProviderEnv() });
  expect(result.status, result.stderr).toBe(0);
  const saved = report(dir);
  expect(saved.completion!.status, JSON.stringify(saved.completion!.missing)).toBe("complete");
  const out = reportDir(dir);
  walk(out, "long.txt", "+", "long.txt: line 1", 1024 * 1024);
  expect(saved.completion!.coverage.given!.filter((g) => g.path === "long.txt")).toEqual([
    expect.objectContaining({ by: "brief", lineBytes: 1024 * 1024, fragment: expect.objectContaining({ from: 1, to: 1024 * 1024 }) }),
  ]);
  const briefs = readdirSync(join(out, "briefs")).map((n) => readFileSync(join(out, "briefs", n), "utf8")).join("\n");
  expect(briefs).toContain(`+long.txt: line 1, bytes 1,048,001 to 1,048,576 of 1,048,576\t${"x".repeat(576)}\n`);
}, 300_000);

it("R3.22 carries a removed 700 KB line by old-line fragments", () => {
  const dir = baseline();
  writeFileSync(join(dir, "long.txt"), "keep\n" + "o".repeat(700_000) + "\n");
  git(dir, "add", "long.txt");
  git(dir, "commit", "-qm", "Long line");
  staged(dir);
  // A pure deletion, so the old line has its own obligation.
  writeFileSync(join(dir, "long.txt"), "keep\n");
  const result = run("long-line-removed", dir, flags, { env: stagedProviderEnv() });
  expect(result.status, result.stderr).toBe(0);
  const saved = report(dir);
  expect(saved.completion!.status, JSON.stringify(saved.completion!.missing)).toBe("complete");
  expect(walk(reportDir(dir), "long.txt", "-", "long.txt: old line 2", 700_000)).toBe("o".repeat(700_000));
}, 300_000);

it("R3.22 redacts a secret inside a long line and labels the redacted bytes", () => {
  const dir = baseline();
  staged(dir);
  const secret = ["sk", "live", "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQR"].join("_");
  writeFileSync(join(dir, "key.txt"), `STRIPE_KEY = "${secret}"\n`);
  // Over one part's 120 KB, so the line is cut into several parts.
  const line = "x".repeat(3000) + secret + "y".repeat(200_000);
  writeFileSync(join(dir, "long.txt"), line + "\n");
  const result = run("long-line-secret", dir, ["review", "--reviewer", "claude", "--skip", "semgrep,osv-scanner", "--no-color"], { env: stagedProviderEnv() });
  expect(result.status, result.stderr).toBe(0);
  const saved = report(dir);
  expect(saved.completion!.status, JSON.stringify(saved.completion!.missing)).toBe("complete");
  const out = reportDir(dir);
  const redacted = line.replace(secret, "[redacted]");
  expect(walk(out, "long.txt", "+", "long.txt: line 1", Buffer.byteLength(redacted))).toBe(redacted);
  const briefs = readdirSync(join(out, "briefs")).map((n) => readFileSync(join(out, "briefs", n), "utf8")).join("\n");
  expect(briefs).not.toContain(secret);
}, 300_000);

it("R3.22 cuts a multi-byte line only between characters", () => {
  const dir = baseline();
  staged(dir);
  // Six bytes per unit: a cut at byte 4,000 would land inside the emoji at
  // bytes 3,999 to 4,002, so the second fragment must end at byte 3,998.
  const line = "ab😀".repeat(200_000);
  writeFileSync(join(dir, "long.txt"), line + "\n");
  const result = run("long-line-unicode", dir, flags, { env: stagedProviderEnv() });
  expect(result.status, result.stderr).toBe(0);
  expect(report(dir).completion!.status).toBe("complete");
  expect(walk(reportDir(dir), "long.txt", "+", "long.txt: line 1", 1_200_000)).toBe(line);
}, 300_000);

it("R2.12 credits pages after a stand-in Read returns the 600 KB line cut at 2,000 bytes", () => {
  // The single pass replays the demo's frozen answer, so it reviews the demo.
  const dir = demo("long-line-pages");
  fixDemoSecret(dir);
  writeFileSync(join(dir, "long.txt"), "x".repeat(600000) + "\n");
  writeConfig(dir, "review:\n  stages: false\n");
  const env = stagedProviderEnv("claude", { OPENQODEX_STANDIN_TOOL_SESSION: "primary", OPENQODEX_STANDIN_TOOL_NAME: "Read", OPENQODEX_STANDIN_TOOL_PATH: "long.txt", OPENQODEX_STANDIN_TOOL_CUT: "1" });
  const result = run("long-line-pages", dir, ["review", "--reviewer", "claude", "--skip", "semgrep,osv-scanner", "--no-color"], { env });
  expect(result.status, result.stderr).toBe(0);
  const saved = report(dir);
  expect(saved.completion!.status).toBe("complete");
  // The cut Read is on record with the one line and 2,000 bytes it returned, and credits only those.
  const trace = readJson<TraceEntry[]>(join(reportDir(dir), "trace.json"));
  expect(trace).toContainEqual(expect.objectContaining({ tool: "Read", path: "long.txt", range: [1, 1], byteRanges: [{ line: 1, from: 1, to: 2000 }] }));
  const given = saved.completion!.coverage.given!.filter((g) => g.path === "long.txt");
  expect(given).toContainEqual(expect.objectContaining({ by: "page", lineBytes: 600000 }));
  const reads = given.filter((g) => g.by === "read");
  expect(reads.length).toBeGreaterThan(0);
  expect(reads.every((g) => g.fragment && g.fragment.to <= 2000)).toBe(true);
}, 300_000);
