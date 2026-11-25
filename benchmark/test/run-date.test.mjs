// Failure cases: a new review or scan accepts another day's output name,
// an undated loop candidate folder is refused, or today's date and an older
// resume refuse.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { benchRoot } from "../lib/cases.mjs";
import { removeTempDirs, tempDir } from "../../tests/temp-dirs.mjs";
import { newWave } from "../lib/wave.mjs";

afterAll(removeTempDirs);

// A review run that pays a model names a wave (lib/wave.mjs): one of this file's own.
const waveRoot = tempDir("oq-run-date-wave-");
newWave("run-date", { root: waveRoot });
const run = (out, args) => spawnSync(process.execPath, [join(benchRoot, "run.mjs"), "--out", out, ...args], { encoding: "utf8", env: { ...process.env, OPENQODEX_BENCH_WAVES: join(waveRoot, "index/waves") } });
const review = ["--max-usd", "1", "--max-minutes", "1", "--wave", "run-date"];

it.each([review, ["--mode", "scan"]].map((args) => ({ args })))("refuses another day's output date before a run starts with $args", ({ args }) => {
  const date = new Date().toISOString().slice(0, 10);
  const out = join(tempDir("oq-run-date-"), "2000-01-01-test");
  const result = run(out, args);
  expect(result.status).toBe(2);
  expect(result.stderr.trim()).toBe(`--out must start with ${date}, the UTC date this run starts, not 2000-01-01`);
  expect(result.stdout).toBe("");
  expect(existsSync(out)).toBe(false);
});

// benchmark/loop.mjs names a candidate run <change id>-<parent run id>.
it("accepts an undated output name, as the loop names its candidate runs", () => {
  const root = tempDir("oq-run-date-");
  const out = join(root, "RC-0001-2000-01-01-parent");
  const result = run(out, ["--mode", "scan", "--cases", "demo-polyglot", "--package", `file:${join(root, "missing.tgz")}`]);
  expect(result.status).toBe(2);
  expect(result.stderr).not.toContain("--out must start with");
  expect(result.stderr).toContain(`there is no file ${join(root, "missing.tgz")}`);
  expect(existsSync(out)).toBe(false);
});

it("accepts today's UTC output date before preparing the package", () => {
  const root = tempDir("oq-run-date-");
  const out = join(root, `${new Date().toISOString().slice(0, 10)}-test`);
  const result = run(out, ["--mode", "scan", "--cases", "demo-polyglot", "--package", `file:${join(root, "missing.tgz")}`]);
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("--package file:");
  expect(result.stderr).toContain(`there is no file ${join(root, "missing.tgz")}`);
  expect(existsSync(out)).toBe(false);
});

it.each([["--resume"], ["--add-repeats", "1"]].map((args) => ({ args })))("keeps an older run's date when continuing it with $args", ({ args }) => {
  const root = tempDir("oq-run-date-");
  const out = join(root, "2000-01-01-test");
  const result = run(out, [...review, ...args, "--cases", "demo-polyglot", "--package", `file:${join(root, "missing.tgz")}`]);
  expect(result.status).toBe(2);
  expect(result.stderr).not.toContain("--out must start with");
  expect(result.stderr).toContain("--package file:");
  expect(result.stderr).toContain(`there is no file ${join(root, "missing.tgz")}`);
});
