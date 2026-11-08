#!/usr/bin/env node
// The wave journal: what a benchmark wave may spend, accounted at spend time.
//
//   node benchmark/lib/wave.mjs --wave-new <id> [--cap <usd> --why <text> --record <comparison>]
//   node benchmark/lib/wave.mjs --settle <wave> <id> <usd>
//   node benchmark/lib/wave.mjs --status <wave>
//
// A wave is one round of paid benchmark work. Its journal is
// benchmark/index/waves/<wave>.jsonl, committed like heldout-access.jsonl:
// one JSON line per event, appended only.
//   {"kind":"wave","wave":"<id>","cap":10,"created":"<iso>"}       first line, by --wave-new
//   {"kind":"reserve","id":"<run id>","path":"<path>","forecastUsd":n,"at":"<iso>"}
//   {"kind":"settle","id":"<run id>","actualUsd":n,"at":"<iso>"}  with "estimated":true when the
//                                                                  path cannot read its spend
// Every paid path (run.mjs review runs, loop.mjs, the Greptile, Martian and
// AACR judges, the wording pass, calibration) names --wave and reserves its
// forecast before it spends. The reservation is refused when what is
// settled, plus every reservation not settled yet, plus this forecast,
// would pass the wave's cap. At its end the path settles with what it
// spent. A path that dies leaves its reservation standing, so it keeps
// counting until a person settles it with --settle.
//
// The cap counts money billed. A run that bills nothing per call (Claude
// Code on a subscription, Codex on a ChatGPT login) still reports a dollar
// figure: its lines carry "metered":false, it reserves 0, and its settled
// figure is shown apart and never counted toward the cap.
//
// The cap is 10 USD. A wave line with a higher cap must say why and name a
// comparison record Sid signed whose capUsd allows it; the writer and the
// reader both refuse one that does not.
//
// One spender at a time: reserve takes <wave>.lock in the journal folder
// (the pid and the time) and settle gives it back. A second spender is
// refused while the holder's process is alive; a lock whose process is
// dead is stale and is cleared by the next spender.
//
// Failure list, written before the code:
// 1. Two runs of 6 USD each, run one after the other without either being
//    attached to a record, pass a 10 USD cap: each reservation counts the
//    reservations not settled yet, not only attached spend.
// 2. A run killed after it reserved frees its room: its reservation stands
//    until a person settles it.
// 3. --allow-over or a larger --max-usd passes the wave cap: the paths ask
//    the journal after their own checks, and nothing here reads either.
// 4. Two spenders reserve against the same room at once: the lock.
// 5. A cap above 10 is written without a reason or a signature.
// 6. A subscription review's reported dollars fill the cap though nothing
//    was billed: a line with "metered":false is summed apart.
import { closeSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { benchRoot } from "./cases.mjs";
import { comparisonHash } from "./comparison.mjs";

export const WAVE_CAP_USD = 10;
export const WAVE_PATHS = ["run", "loop", "judge-greptile", "judge-martian", "judge-aacr", "judge-wording", "calibrate"];
const ID = /^[a-z0-9][a-z0-9.-]*$/;

/** A refusal of the wave journal: nothing was spent. */
export class WaveRefused extends Error {}

const nano = (usd) => Math.round(usd * 1e9);
const money = (usd) => `$${usd.toFixed(2)}`;
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const SETTLE_HELP = "settle a dead run's reservation with node benchmark/lib/wave.mjs --settle <wave> <id> <usd>";

/** The journal folder under a benchmark root, or the folder OPENQODEX_BENCH_WAVES names (a test's own). */
export const wavesDir = (root = benchRoot) => (process.env.OPENQODEX_BENCH_WAVES ? resolve(process.env.OPENQODEX_BENCH_WAVES) : join(root, "index/waves"));

function append(file, line) {
  const fd = openSync(file, "a");
  try {
    writeSync(fd, `${JSON.stringify(line)}\n`);
  } finally {
    closeSync(fd);
  }
}

// A cap above WAVE_CAP_USD needs a reason and a comparison record that Sid
// signed (its acceptance hash matches) whose capUsd allows the cap.
function capProblem(line, root) {
  if (!(Number.isFinite(line.cap) && line.cap > 0)) return "its cap must be positive dollars";
  if (line.cap <= WAVE_CAP_USD) return null;
  if (typeof line.why !== "string" || line.why.trim() === "") return `a cap of ${money(line.cap)} is above ${money(WAVE_CAP_USD)} and says no why`;
  if (typeof line.record !== "string" || !ID.test(line.record)) return `a cap of ${money(line.cap)} is above ${money(WAVE_CAP_USD)} and names no signed comparison record`;
  const path = join(root, "index/comparisons", `${line.record}.json`);
  if (!existsSync(path)) return `a cap of ${money(line.cap)} names the comparison record ${line.record}, which is not in ${join(root, "index/comparisons")}`;
  const record = readJson(path);
  const signed = typeof record.acceptance?.person === "string" && record.acceptance.person !== "" && record.acceptance.hash === comparisonHash(record);
  if (!signed) return `a cap of ${money(line.cap)} names ${line.record}, which is not signed as it stands`;
  if (!(record.capUsd >= line.cap)) return `a cap of ${money(line.cap)} is above ${line.record}'s signed capUsd ${record.capUsd}`;
  return null;
}

/** Starts a wave's journal with its first line. Refuses a wave that exists and a cap above 10 without why and a signed record. */
export function newWave(id, { cap = WAVE_CAP_USD, why = null, record = null, root = benchRoot, now = () => new Date() } = {}) {
  if (typeof id !== "string" || !ID.test(id)) throw new WaveRefused("a wave id is lower case letters, digits, dots and dashes");
  const line = { kind: "wave", wave: id, cap, created: now().toISOString(), ...(why !== null ? { why } : {}), ...(record !== null ? { record } : {}) };
  const problem = capProblem(line, root);
  if (problem) throw new WaveRefused(`refused, no wave written: ${problem}`);
  const dir = wavesDir(root);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${id}.jsonl`);
  if (existsSync(file)) throw new WaveRefused(`refused: the wave ${id} exists already (${file})`);
  append(file, line);
  return openWave(id, { root });
}

/** A wave's journal, read: its id, cap, files and lines. Refuses a wave with no journal or a bad first line. */
export function openWave(id, { root = benchRoot } = {}) {
  if (typeof id !== "string" || !ID.test(id)) throw new WaveRefused("--wave takes a wave id: lower case letters, digits, dots and dashes");
  const dir = wavesDir(root);
  const file = join(dir, `${id}.jsonl`);
  if (!existsSync(file)) throw new WaveRefused(`refused, nothing spent: there is no wave ${id} (${file}); start it with node benchmark/lib/wave.mjs --wave-new ${id}`);
  const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l));
  const head = lines[0];
  if (head?.kind !== "wave" || head.wave !== id) throw new WaveRefused(`refused: ${file} does not start with the wave line for ${id}`);
  const problem = capProblem(head, root);
  if (problem) throw new WaveRefused(`refused, nothing spent: the wave ${id} ${problem}`);
  return { id, root, dir, file, lockFile: join(dir, `${id}.lock`), cap: head.cap, lines };
}

// What the lines say: settled spend that was billed, settled spend reported
// but not billed ("metered":false), and the reservations not settled yet.
function fold(lines) {
  const open = new Map();
  let settled = 0;
  let unmetered = 0;
  for (const l of lines.slice(1)) {
    if (l.kind === "reserve") open.set(l.id, l);
    else if (l.kind === "settle") {
      if (l.metered === false) unmetered += nano(l.actualUsd);
      else settled += nano(l.actualUsd);
      open.delete(l.id);
    }
  }
  return { settled, unmetered, open: [...open.values()] };
}

// What the reservations not settled yet hold against the cap: the billed ones' forecasts.
const held = (open) => open.filter((r) => r.metered !== false).reduce((n, r) => n + nano(r.forecastUsd), 0);

const fresh = (wave) => openWave(wave.id, { root: wave.root });

/** The reservations not settled yet, oldest first. */
export function outstanding(wave) {
  return fold(fresh(wave).lines).open;
}

/** Settled spend that was billed, settled spend reported but not billed, outstanding reservations and room left, in dollars. */
export function waveState(wave) {
  const w = fresh(wave);
  const { settled, unmetered, open } = fold(w.lines);
  const reserved = held(open);
  return { cap: w.cap, settledUsd: settled / 1e9, unmeteredUsd: unmetered / 1e9, reservedUsd: reserved / 1e9, roomUsd: Math.max(0, nano(w.cap) - settled - reserved) / 1e9, outstanding: open };
}

// ---------- the lock ----------

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};

/** Who holds the wave's lock: { pid, at, id, path, live }, or null. `text` is the lock's bytes when already read. */
export function lockHolder(wave, text = null) {
  if (text === null && !existsSync(wave.lockFile)) return null;
  let held;
  try {
    held = JSON.parse(text ?? readFileSync(wave.lockFile, "utf8"));
  } catch {
    held = {};
  }
  return { ...held, live: Number.isInteger(held.pid) && alive(held.pid) };
}

const holderText = (h) => `process ${h.pid}${h.id ? ` (${h.path} ${h.id})` : ""}, since ${h.at}`;

// Clears a stale lock whose bytes were `staleText` when its holder was seen
// dead. The lock is renamed aside first, so of two processes that saw the
// same dead holder only one moves those bytes; one that moved another
// spender's fresh lock instead puts it back. True when the stale lock is gone.
export function takeOver(lockFile, staleText) {
  const aside = `${lockFile}.stale-${process.pid}`;
  try {
    renameSync(lockFile, aside);
  } catch (error) {
    if (error.code === "ENOENT") return true;
    throw error;
  }
  const moved = readFileSync(aside, "utf8");
  if (moved !== staleText) {
    try {
      linkSync(aside, lockFile);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  unlinkSync(aside);
  return moved === staleText;
}

// Takes the lock for this process, clearing a stale one. Returns true when
// it took it now, false when this process held it already. The lock is
// written whole to a temp file and linked into place, so no reader sees it
// half written.
function takeLock(wave, who) {
  const tmp = `${wave.lockFile}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ pid: process.pid, at: new Date().toISOString(), ...who })}\n`);
  try {
    for (let tries = 0; tries < 3; tries++) {
      try {
        linkSync(tmp, wave.lockFile);
        return true;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
      let staleText;
      try {
        staleText = readFileSync(wave.lockFile, "utf8");
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
      const h = lockHolder(wave, staleText);
      if (h.pid === process.pid) return false;
      if (h.live) throw new WaveRefused(`refused, nothing spent: the wave ${wave.id} has one spender at a time, and ${holderText(h)} holds ${wave.lockFile}`);
      takeOver(wave.lockFile, staleText);
    }
  } finally {
    unlinkSync(tmp);
  }
  throw new WaveRefused(`refused, nothing spent: could not take ${wave.lockFile}`);
}

function releaseLock(wave) {
  const h = lockHolder(wave);
  if (h && h.pid === process.pid) unlinkSync(wave.lockFile);
}

// ---------- reserve and settle ----------

/**
 * Reserves `forecastUsd` for the run `id` on `path` before it spends, under
 * the wave's lock, which this process keeps until it settles. Throws
 * WaveRefused, naming the sums, when settled plus outstanding plus this
 * forecast would pass the cap. A run that bills nothing per call passes
 * `metered: false` and a forecast of 0.
 */
export function reserve(wave, { id, path, forecastUsd, metered = true }) {
  if (typeof id !== "string" || id === "") throw new WaveRefused("a reservation names its run id");
  if (!WAVE_PATHS.includes(path)) throw new WaveRefused(`a reservation's path is one of ${WAVE_PATHS.join(", ")}, not ${path}`);
  if (!(Number.isFinite(forecastUsd) && forecastUsd >= 0)) throw new WaveRefused(`refused, nothing spent: ${id} has no forecast in dollars`);
  if (!metered && forecastUsd !== 0) throw new WaveRefused(`a reservation that bills nothing forecasts 0, not ${forecastUsd}`);
  const took = takeLock(wave, { id, path });
  try {
    const w = fresh(wave);
    const { settled, open } = fold(w.lines);
    if (open.some((r) => r.id === id)) throw new WaveRefused(`refused, nothing spent: ${id} holds a reservation in the wave ${w.id} that is not settled; ${SETTLE_HELP}`);
    const reserved = held(open);
    if (settled + reserved + nano(forecastUsd) > nano(w.cap)) {
      const held = open.length > 0 ? ` and ${money(reserved / 1e9)} reserved by ${open.map((r) => r.id).join(", ")}, not settled` : "";
      throw new WaveRefused(`refused, nothing spent: the wave ${w.id} has a cap of ${money(w.cap)}; ${money(settled / 1e9)} is settled${held}, and ${id} is forecast at ${money(forecastUsd)}. No flag passes the wave cap${open.length > 0 ? `; ${SETTLE_HELP}` : ""}`);
    }
    const line = { kind: "reserve", id, path, forecastUsd, at: new Date().toISOString(), ...(metered ? {} : { metered: false }) };
    append(w.file, line);
    return line;
  } catch (error) {
    if (took) releaseLock(wave);
    throw error;
  }
}

/**
 * Settles the reservation of `id` with what it spent (`estimated` when that
 * is the forecast), and gives back this process's lock. A reservation made
 * with `metered: false` settles the same way, unless `metered` says otherwise.
 */
export function settle(wave, id, actualUsd, { estimated = false, metered } = {}) {
  if (!(Number.isFinite(actualUsd) && actualUsd >= 0)) throw new WaveRefused(`a settlement is dollars spent, not ${actualUsd}`);
  const w = fresh(wave);
  const reservation = fold(w.lines).open.find((r) => r.id === id);
  if (!reservation) throw new WaveRefused(`refused: ${id} has no reservation in the wave ${w.id} that is not settled`);
  const billed = metered ?? reservation.metered !== false;
  const line = { kind: "settle", id, actualUsd, at: new Date().toISOString(), ...(estimated ? { estimated: true } : {}), ...(billed ? {} : { metered: false }) };
  append(w.file, line);
  releaseLock(wave);
  return line;
}

// ---------- the command ----------

const stateText = (w, s = waveState(w)) => `Wave ${w.id}: ${money(s.settledUsd)} settled (metered), ${money(s.unmeteredUsd)} reported but not metered, ${money(s.reservedUsd)} reserved, ${money(s.roomUsd)} left of ${money(s.cap)}.`;

const USAGE = "usage: node benchmark/lib/wave.mjs --wave-new <id> [--cap <usd> --why <text> --record <comparison>]\n       node benchmark/lib/wave.mjs --settle <wave> <id> <usd>\n       node benchmark/lib/wave.mjs --status <wave>";

/** The command: --wave-new, --settle (a person settling a dead run) or --status. Returns its exit code. */
export function main(argv = process.argv.slice(2), { root = benchRoot } = {}) {
  const [command, ...rest] = argv;
  if (command === "--wave-new") {
    const [id, ...flags] = rest;
    const o = { cap: WAVE_CAP_USD, why: null, record: null };
    for (let i = 0; i < flags.length; i++) {
      const v = flags[i + 1];
      if (v === undefined) throw new WaveRefused(`${flags[i]} needs a value\n${USAGE}`);
      if (flags[i] === "--cap") o.cap = Number(v);
      else if (flags[i] === "--why") o.why = v;
      else if (flags[i] === "--record") o.record = v;
      else throw new WaveRefused(`unknown flag ${flags[i]}\n${USAGE}`);
      i++;
    }
    const w = newWave(id, { ...o, root });
    console.log(`Wave ${w.id}: cap ${money(w.cap)}, journal ${w.file}. Commit it.`);
    return 0;
  }
  if (command === "--settle") {
    if (rest.length !== 3) throw new WaveRefused(USAGE);
    const [waveId, id, usd] = rest;
    const w = openWave(waveId, { root });
    const h = lockHolder(w);
    if (h?.live && h.pid !== process.pid) throw new WaveRefused(`refused: ${holderText(h)} holds ${w.lockFile} and may be the run itself; settle once it has ended`);
    if (h && !h.live) unlinkSync(w.lockFile);
    settle(w, id, Number(usd));
    console.log(`Settled ${id} at ${money(Number(usd))}. ${stateText(w)}`);
    return 0;
  }
  if (command === "--status" && rest.length === 1) {
    const w = openWave(rest[0], { root });
    const s = waveState(w);
    const h = lockHolder(w);
    console.log(stateText(w, s));
    for (const r of s.outstanding) console.log(`  not settled: ${r.id} (${r.path}), forecast ${money(r.forecastUsd)}${r.metered === false ? " (not metered)" : ""}, reserved ${r.at}`);
    if (h) console.log(`  lock: ${holderText(h)}${h.live ? "" : " (the process is dead; the next spender clears it)"}`);
    return 0;
  }
  throw new WaveRefused(USAGE);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
