// The wave journal (benchmark/lib/wave.mjs): what a benchmark wave may
// spend, accounted at spend time, and the paid paths that must name a wave.
//
// Failures guarded, written before the code:
// 1. Two runs of 6 USD each, one after the other and neither attached to a
//    comparison record, both pass a 10 USD cap.
// 2. A run killed after it reserved frees its room before a person settles it.
// 3. A judge is started without a wave and spends outside any cap.
// 4. Two spenders reserve against one wave at once; or a dead spender's lock
//    blocks the wave for good.
// 5. A cap above 10 USD is written without a reason.
// 6. A subscription review's reported dollars, which nothing billed, use up
//    the cap; or a billed review is taken for one that bills nothing.
// 7. The AACR judge forecasts from the wrong calibration, or not at all.
// 8. A review run reserves its estimate though it may spend up to its
//    --max-usd, so one run overspends the wave's room.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { benchRoot, repoRoot } from "../lib/cases.mjs";
import { laptopMetered } from "../lib/reviewers.mjs";
import { lockHolder, main as waveMain, newWave, openWave, outstanding, reserve, settle, waveState, WaveRefused } from "../lib/wave.mjs";
import { aacrForecast, main as aacrJudge } from "../outside/boards/aacr-judge.mjs";
import { main as greptileRun } from "../outside/boards/greptile-run.mjs";
import { main as calibrate } from "../outside/calibrate.mjs";
import { removeTempDirs, tempDir } from "../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

const lines = (wave) => readFileSync(wave.file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const WAVE_MODULE = pathToFileURL(join(benchRoot, "lib/wave.mjs")).href;

// A real second process that reserves in the wave and then waits until it
// is killed: a spender that holds the lock, or a run that dies mid-way.
function spender(root, waveId, id, usd) {
  const code = `import { openWave, reserve } from ${JSON.stringify(WAVE_MODULE)};
reserve(openWave(${JSON.stringify(waveId)}, { root: ${JSON.stringify(root)} }), { id: ${JSON.stringify(id)}, path: "run", forecastUsd: ${usd} });
process.stdout.write("reserved\\n");
setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "pipe"] });
  const reserved = new Promise((resolve, reject) => {
    let err = "";
    child.stdout.on("data", (chunk) => { if (String(chunk).includes("reserved")) resolve(); });
    child.stderr.on("data", (chunk) => { err += chunk; });
    child.on("close", (code) => reject(new Error(`the spender exited ${code} before it reserved: ${err}`)));
  });
  const killed = () => new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once("close", resolve);
    child.kill("SIGKILL");
  });
  return { child, reserved, killed };
}

describe("the wave cap", () => {
  it("refuses the second of two sequential, unattached 6 USD forecasts against a cap of 10", () => {
    const root = tempDir("oq-wave-");
    const wave = newWave("w1", { root });
    expect(wave.cap).toBe(10);
    reserve(wave, { id: "run-a", path: "run", forecastUsd: 6 });
    settle(wave, "run-a", 6);
    const before = lines(wave);
    expect(() => reserve(wave, { id: "run-b", path: "run", forecastUsd: 6 })).toThrow(/cap of \$10\.00; \$6\.00 is settled.*run-b is forecast at \$6\.00/);
    // Nothing was written by the refusal, and no lock was left behind.
    expect(lines(wave)).toEqual(before);
    expect(lockHolder(wave)).toBeNull();
  });

  it("counts an outstanding reservation as spent: the second 6 USD forecast is refused while the first is unsettled", () => {
    const root = tempDir("oq-wave-");
    const wave = newWave("w2", { root });
    reserve(wave, { id: "run-a", path: "judge-greptile", forecastUsd: 6 });
    expect(() => reserve(wave, { id: "run-b", path: "run", forecastUsd: 6 })).toThrow(/\$6\.00 reserved by run-a, not settled/);
  });

  it("keeps a killed run's reservation standing until a person settles it with --settle", async () => {
    const root = tempDir("oq-wave-");
    newWave("w3", { root });
    const run = spender(root, "w3", "killed-run", 6);
    try {
      await run.reserved;
    } finally {
      await run.killed();
    }
    const wave = openWave("w3", { root });
    expect(outstanding(wave).map((r) => r.id)).toEqual(["killed-run"]);
    // The dead run's lock is stale and cleared; its reservation is not.
    expect(() => reserve(wave, { id: "next-run", path: "run", forecastUsd: 6 })).toThrow(/reserved by killed-run, not settled.*--settle/);
    expect(waveMain(["--settle", "w3", "killed-run", "1.5"], { root })).toBe(0);
    expect(lines(wave).at(-1)).toMatchObject({ kind: "settle", id: "killed-run", actualUsd: 1.5 });
    reserve(wave, { id: "next-run", path: "run", forecastUsd: 6 });
    expect(outstanding(wave).map((r) => r.id)).toEqual(["next-run"]);
  });

  it("refuses a second spender while the first holds the lock, and clears the lock once its process is dead", async () => {
    const root = tempDir("oq-wave-");
    newWave("w4", { root });
    const first = spender(root, "w4", "first-run", 1);
    const wave = openWave("w4", { root });
    try {
      await first.reserved;
      expect(() => reserve(wave, { id: "second-run", path: "run", forecastUsd: 1 })).toThrow(new RegExp(`one spender at a time, and process ${first.child.pid} \\(run first-run\\)`));
      expect(() => waveMain(["--settle", "w4", "first-run", "1"], { root })).toThrow(/may be the run itself/);
    } finally {
      await first.killed();
    }
    expect(lockHolder(wave)).toMatchObject({ pid: first.child.pid, live: false });
    reserve(wave, { id: "second-run", path: "run", forecastUsd: 1 });
    expect(lockHolder(wave)).toMatchObject({ pid: process.pid, live: true });
    settle(wave, "second-run", 0.5);
    expect(lockHolder(wave)).toBeNull();
  });

  it("refuses a cap above 10 USD without a why, and without a signed record that allows it", () => {
    const root = tempDir("oq-wave-");
    expect(() => newWave("w5", { root, cap: 11 })).toThrow(/above \$10\.00 and says no why/);
    expect(() => waveMain(["--wave-new", "w5", "--cap", "11"], { root })).toThrow(WaveRefused);
    expect(() => newWave("w5", { root, cap: 11, why: "three repeats need it" })).toThrow(/names no signed comparison record/);
    expect(() => newWave("w5", { root, cap: 11, why: "three repeats need it", record: "compare-none" })).toThrow(/not in/);
    expect(() => openWave("w5", { root })).toThrow(/there is no wave w5/);
    expect(newWave("w5", { root, cap: 10 }).cap).toBe(10);
  });

  it("leaves the room alone for an unmetered 6 USD settle, takes it for a metered one, and --status shows both sums", () => {
    const root = tempDir("oq-wave-");
    const wave = newWave("w6", { root });
    reserve(wave, { id: "subscription-run", path: "run", forecastUsd: 0, metered: false });
    settle(wave, "subscription-run", 6);
    expect(lines(wave).slice(1).map((l) => [l.kind, l.metered])).toEqual([["reserve", false], ["settle", false]]);
    expect(waveState(wave)).toMatchObject({ settledUsd: 0, unmeteredUsd: 6, roomUsd: 10 });
    // An unmetered reservation forecasts 0: a dollar figure there would be a billed forecast in disguise.
    expect(() => reserve(wave, { id: "odd", path: "run", forecastUsd: 1, metered: false })).toThrow(/forecasts 0/);
    reserve(wave, { id: "api-run", path: "run", forecastUsd: 6 });
    settle(wave, "api-run", 6);
    expect(waveState(wave)).toMatchObject({ settledUsd: 6, unmeteredUsd: 6, roomUsd: 4 });
    expect(() => reserve(wave, { id: "api-run-2", path: "run", forecastUsd: 6 })).toThrow(/\$6\.00 is settled/);
    const status = spawnSync(process.execPath, [join(benchRoot, "lib/wave.mjs"), "--status", "w6"], { encoding: "utf8", env: { ...process.env, OPENQODEX_BENCH_WAVES: join(root, "index/waves") } });
    expect(status.stdout.split("\n")[0]).toBe("Wave w6: $6.00 settled (metered), $6.00 reported but not metered, $0.00 reserved, $4.00 left of $10.00.");
  });

  it("counts Claude Code as metered only with an Anthropic key, and Codex as unmetered only on a ChatGPT login", () => {
    const home = tempDir("oq-wave-codex-");
    const login = (doc) => writeFileSync(join(home, "auth.json"), JSON.stringify(doc));
    expect(laptopMetered("claude", { PATH: "/usr/bin" })).toBe(false);
    expect(laptopMetered("claude", { PATH: "/usr/bin", ANTHROPIC_API_KEY: "test-placeholder" })).toBe(true);
    expect(laptopMetered("control", { ANTHROPIC_API_KEY: "test-placeholder" })).toBe(true);
    login({ auth_mode: "chatgpt", OPENAI_API_KEY: null, tokens: {} });
    expect(laptopMetered("codex", { CODEX_HOME: home })).toBe(false);
    login({ auth_mode: "apikey", OPENAI_API_KEY: "test-placeholder" });
    expect(laptopMetered("codex", { CODEX_HOME: home })).toBe(true);
    // A login that cannot be read is counted as billed.
    expect(laptopMetered("codex", { CODEX_HOME: join(home, "none") })).toBe(true);
  });

  it("forecasts the AACR judging from the newest calibration's cost per review, never from the run's --max-usd", () => {
    const root = tempDir("oq-wave-aacr-");
    const dir = join(root, "index/calibration");
    mkdirSync(dir, { recursive: true });
    const cal = (name, costUsd, ids) => writeFileSync(join(dir, name), JSON.stringify({ costUsd, labels: ids.map((id) => ({ id })) }));
    // Older and dearer, so a forecast from it would be wrong.
    cal("martian-2026-10-01.json", 100, ["a#g1"]);
    // The newest date: $2 over two reviews (four golden comments) is $1 a review, dearer than Greptile's $0.01.
    cal("martian-2026-10-27.json", 2, ["r1#g1", "r1#g2", "r2#g1", "r2#g2"]);
    cal("greptile-2026-10-27.json", 0.02, ["c1", "c2"]);
    expect(aacrForecast({ reviews: 3, rounds: 2, root })).toMatchObject({ usd: 6, estimated: true });
  });
});

describe("a review run's wave reservation", () => {
  // A dry run of a metered control review (an Anthropic key placeholder
  // makes Claude Code billed): it prints the reservation and spends nothing.
  const dryRun = (root, maxUsd) => spawnSync(process.execPath, ["benchmark/run.mjs", "--reviewers", "control", "--cases", "ts-removed-export", "--repeat", "1", "--max-usd", String(maxUsd), "--max-minutes", "2", "--wave", "w8", "--dry-run"], { cwd: repoRoot, encoding: "utf8", env: { ...process.env, ANTHROPIC_API_KEY: "test-placeholder", OPENQODEX_BENCH_WAVES: join(root, "index/waves") } });

  it("refuses a run whose --max-usd is above the wave's room, and reserves the --max-usd ceiling when it fits (failure 8)", () => {
    const root = tempDir("oq-wave-run-");
    const wave = newWave("w8", { root });
    reserve(wave, { id: "earlier-run", path: "run", forecastUsd: 6 });
    settle(wave, "earlier-run", 6);
    const over = dryRun(root, 6);
    expect(over.status).toBe(2);
    expect(over.stderr).toContain("the wave w8 has $4.00 of room left of its $10.00 cap, and this run may spend up to $6.00");
    expect(over.stderr).toContain("Lower --max-usd to $4.00 or less, or start a new wave");
    const fits = dryRun(root, 4);
    expect(fits.status).toBe(0);
    expect(fits.stdout).toContain("this run reserves $4.00 (its --max-usd room, the most it may spend)");
    // Nothing was reserved by either dry run.
    expect(outstanding(wave)).toEqual([]);
    // The reservation is the ceiling; the settlement is what the run spent.
    reserve(wave, { id: "this-run", path: "run", forecastUsd: 4 });
    expect(waveState(wave)).toMatchObject({ reservedUsd: 4, roomUsd: 0 });
    settle(wave, "this-run", 1.25);
    expect(waveState(wave)).toMatchObject({ settledUsd: 7.25, reservedUsd: 0, roomUsd: 2.75 });
  });
});

describe("paid paths without a wave", () => {
  it("refuses a priced Greptile judge call without --wave before reading the record", async () => {
    await expect(greptileRun(["/nonexistent-run", "--release", "compare-2026-10", "--max-usd", "1"], { root: tempDir("oq-wave-root-") })).rejects.toThrow(/--wave <id> is required for a priced run/);
  });

  it("refuses the AACR judge without --wave unless it is a dry run", async () => {
    await expect(aacrJudge(["/nonexistent-run", "--evaluation", "/nonexistent", "--python", "/nonexistent"])).rejects.toThrow(/--wave <id> is required/);
    await expect(aacrJudge(["/nonexistent-run", "--evaluation", "/nonexistent", "--python", "/nonexistent", "--dry-run"])).rejects.not.toThrow(/--wave/);
  });

  it("refuses the wording pass without --wave", () => {
    const r = spawnSync(process.execPath, ["benchmark/judge.mjs", tempDir("oq-wave-run-")], { cwd: repoRoot, encoding: "utf8" });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/--wave <id> is required/);
  });

  it("refuses a calibration without --wave", async () => {
    await expect(calibrate(["--board", "greptile"])).rejects.toThrow(/--wave <id> is required/);
  });

  it("refuses a paid review run without --wave, and --allow-over does not pass it", () => {
    const r = spawnSync(process.execPath, ["benchmark/run.mjs", "--reviewers", "claude", "--cases", "ts-removed-export", "--repeat", "1", "--max-usd", "1", "--max-minutes", "2", "--allow-over"], { cwd: repoRoot, encoding: "utf8" });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/--wave <id> is required/);
  });

  it("refuses release-check review runs that pay a model without --wave", () => {
    const r = spawnSync(process.execPath, ["benchmark/release-check.mjs", "--reviewers", "claude", "--max-usd", "1", "--max-minutes", "2"], { cwd: repoRoot, encoding: "utf8" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/need --wave <id>/);
  });
});
