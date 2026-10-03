// The update worker: `openqodex __update`, started detached by a normal
// command, and `openqodex update` in the foreground. Everything slow happens
// first, outside any lock: the registry metadata, the tarball, its
// attestations, verification, unpacking and a test start. Then one short
// step inside the commit boundary (agents/lock.ts) checks again that the
// switch is still wanted and publishes it: the runtime folder by a rename,
// then the active record by a rename. A crash between the two leaves the old
// version active and the new folder ready for the next run.
import { existsSync, mkdirSync, renameSync, rmdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { extractArchive, openqodexHome } from "@openqodex/scanners";
import { BoundaryError, withBoundary } from "../agents/lock.js";
import { activeVersion, checkRuns, identicalTree, launcherPath, runtimeDir, tempRuntimes, writeActive } from "../launcher.js";
import { MIN_AGE_MS, selectCandidates } from "./candidate.js";
import { fetchAttestations, fetchMetadata, fetchTarball } from "./fetch.js";
import { readState, updateState, updatesAllowed, type UpdateState } from "./state.js";
import { verifyRelease } from "./verify.js";

// The whole worker ends by this deadline, whatever it is doing.
const LIMIT_MS = 10 * 60_000;
// A release skipped once is tried again after this long.
const RETRY_SKIPPED_MS = 7 * 24 * 60 * 60 * 1000;
const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
const PLAIN_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

// Verification failures that mean the trust data embedded in this release no
// longer knows the signing certificate's CA, the log or the timestamp
// authority (a Sigstore key rotation), as opposed to a signature that is
// wrong or a signer that is not this repository's release workflow.
const TRUST_DATA =
  /^the provenance signature does not verify: .*(no trusted certificate path found|key not found|Public key is not valid for timestamp|expected \d+ (SCTs|tlog entries|timestamps))/;

export type WorkerResult = { outcome: "updated" | "none" | "busy" | "off" | "failed"; lines: string[] };

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split("\n")[0]!.slice(0, 300);
}

// The test seam: honoured only with OPENQODEX_E2E=1 (tests/e2e/README.md).
// OPENQODEX_UPDATE_AS selects candidates as if this were that version;
// OPENQODEX_UPDATE_MIN_AGE_MS replaces the 24 hour age rule.
function seam(env: NodeJS.ProcessEnv): { as: string | null; minAge: number | null } {
  if (env.OPENQODEX_E2E !== "1") return { as: null, minAge: null };
  const as = env.OPENQODEX_UPDATE_AS;
  const minAge = Number(env.OPENQODEX_UPDATE_MIN_AGE_MS);
  return {
    as: as !== undefined && PLAIN_VERSION.test(as) ? as : null,
    minAge: env.OPENQODEX_UPDATE_MIN_AGE_MS !== undefined && Number.isFinite(minAge) && minAge >= 0 ? minAge : null,
  };
}

// The second test seam, also only with OPENQODEX_E2E=1: at the named stage
// the worker writes <home>/update-paused and waits until a test removes it
// (or kills the process). Stages: before-metadata, before-boundary,
// in-boundary, after-publish.
async function pauseAt(home: string, stage: string, env: NodeJS.ProcessEnv): Promise<void> {
  if (env.OPENQODEX_E2E !== "1" || env.OPENQODEX_UPDATE_PAUSE !== stage) return;
  const flag = join(home, "update-paused");
  writeFileSync(flag, `${stage}\n`);
  while (existsSync(flag)) await new Promise((r) => setTimeout(r, 50));
}

function latestOf(metadata: unknown): string | null {
  const latest = (metadata as { "dist-tags"?: { latest?: unknown } } | null)?.["dist-tags"]?.latest;
  return typeof latest === "string" && PLAIN_VERSION.test(latest) ? latest : null;
}

function newer(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
}

// Unpacks a verified tarball into <home>/runtime/<version>.tmp-<pid>/ and
// checks that it starts and prints its version. Returns that temp folder;
// the package is in its unpacked/package. activateUnpacked publishes it and
// removes the temp folder.
export async function unpackRelease(home: string, version: string, tarball: Buffer): Promise<string> {
  const tmp = `${runtimeDir(version, home)}.tmp-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  try {
    const archive = join(tmp, "package.tgz");
    writeFileSync(archive, tarball);
    const unpacked = join(tmp, "unpacked");
    mkdirSync(unpacked);
    // Refuses a member that is a link or escapes the folder. Nothing in the
    // package runs at install: the CLI is one bundled file with its assets.
    await extractArchive(archive, "tar.gz", unpacked);
    const bin = join(unpacked, "package", "dist", "bin.js");
    if (!existsSync(bin)) throw new Error("the release has no dist/bin.js");
    await checkRuns(bin, version);
    return tmp;
  } catch (error) {
    rmSync(tmp, { recursive: true, force: true });
    throw error;
  }
}

// activated: the record names `version`. refused: the switch is no longer
// wanted (updates off, another switch happened, nothing newer). skip: this
// release cannot be used here. gone: OpenQodex was uninstalled meanwhile.
// busy: another process holds the boundary. failed: the boundary or a write failed.
export type ActivateResult = { outcome: "activated" | "refused" | "skip" | "gone" | "busy" | "failed"; reason: string };

// The commit step for a verified, unpacked release in `tmp` (unpackRelease),
// started from the active version `from`. Always removes `tmp`.
export async function activateUnpacked(opts: { home: string; version: string; from: string; tmp: string; env: NodeJS.ProcessEnv; wait: number }): Promise<ActivateResult> {
  const { home, version, from, tmp, env } = opts;
  let result: ActivateResult;
  try {
    await pauseAt(home, "before-boundary", env);
    result = await withBoundary(home, { wait: opts.wait }, async (): Promise<ActivateResult> => {
      await pauseAt(home, "in-boundary", env);
      const allowed = updatesAllowed(home, env);
      if (!allowed.allowed) return { outcome: "refused", reason: `updates were turned ${allowed.why}` };
      if (!existsSync(launcherPath(home))) return { outcome: "gone", reason: "openqodex was uninstalled" };
      const active = activeVersion(home);
      if (active !== from) return { outcome: "refused", reason: `the active version is ${active ?? "unknown"}, not ${from}: another update, rollback or init ran` };
      if (!newer(version, active)) return { outcome: "refused", reason: `${version} is not newer than the active ${active}` };
      const target = runtimeDir(version, home);
      if (existsSync(target)) {
        if (!identicalTree(join(tmp, "unpacked", "package"), target)) return { outcome: "skip", reason: `${target} holds a different copy of ${version}; it was left as it is` };
      } else {
        renameSync(join(tmp, "unpacked", "package"), target);
        // The tarball's own times are from 1985; the age rule counts from now.
        const now = new Date();
        utimesSync(target, now, now);
      }
      await pauseAt(home, "after-publish", env);
      // The commit. What follows is a cache: its failure changes no outcome.
      writeActive(home, { current: version, previous: active });
      try {
        updateState(home, { lastError: null, notice: { version, text: `openqodex updated to ${version} (was ${active}). Roll back: openqodex update --rollback` } });
      } catch {
        // the notice is lost; the switch stands
      }
      return { outcome: "activated", reason: `Updated to ${version} (was ${active}).` };
    });
  } catch (error) {
    result = { outcome: error instanceof BoundaryError && error.held ? "busy" : "failed", reason: message(error) };
  }
  rmSync(tmp, { recursive: true, force: true });
  if (result.outcome === "gone") {
    // Uninstall removed the runtime folder's contents; leave no empty folder behind.
    try {
      rmdirSync(dirname(tmp));
    } catch {
      // not empty: not ours to remove
    }
  }
  return result;
}

// Every state write of the worker outside the commit step: inside the
// boundary when it is free, so it never runs beside an uninstall, and only
// while the launcher exists. When another process holds the boundary (a
// squatter on the port, or a long init) it checks the launcher and writes.
// A home without a launcher is never written to. Never throws.
async function note(home: string, change: Partial<UpdateState>): Promise<void> {
  const write = (): void => {
    if (existsSync(launcherPath(home))) updateState(home, change);
  };
  try {
    await withBoundary(home, { wait: 0 }, write);
  } catch (error) {
    try {
      if (error instanceof BoundaryError && error.held) write();
    } catch {
      // a cache write; the next check writes again
    }
  }
}

// `daily`: started by a normal command; it checks only when no other worker
// checked in the last 24 hours. `wait`: how long the commit step waits for
// the boundary (0 for the daily worker, which tries again tomorrow).
export async function runUpdateWorker(opts: { anyAge: boolean; daily?: boolean; wait: number }): Promise<WorkerResult> {
  const home = openqodexHome();
  const env = process.env;
  const allowed = updatesAllowed(home, env);
  if (!allowed.allowed) return { outcome: "off", lines: [`Updates are ${allowed.why}.`] };
  if (opts.daily) {
    const at = Date.parse(readState(home).checkedAt ?? "");
    const age = Date.now() - at;
    if (Number.isFinite(at) && age >= 0 && age < CHECK_EVERY_MS) return { outcome: "none", lines: ["Checked less than a day ago."] };
  }
  const limit = setTimeout(() => process.exit(2), LIMIT_MS);
  limit.unref();
  try {
    return await work(home, env, opts.anyAge, opts.wait);
  } catch (error) {
    await note(home, { lastError: message(error) });
    return { outcome: "failed", lines: [`The update failed: ${message(error)}`] };
  } finally {
    clearTimeout(limit);
  }
}

async function work(home: string, env: NodeJS.ProcessEnv, anyAge: boolean, wait: number): Promise<WorkerResult> {
  const now = Date.now();
  const test = seam(env);
  const running = test.as ?? __OPENQODEX_VERSION__;
  const from = activeVersion(home);
  if (from === null || !existsSync(launcherPath(home))) return { outcome: "failed", lines: ["No launcher install here; run npx openqodex init."] };
  // What a crashed or killed worker left behind.
  for (const tmp of tempRuntimes(home, false)) rmSync(tmp, { recursive: true, force: true });
  await note(home, { checkedAt: new Date(now).toISOString() });
  await pauseAt(home, "before-metadata", env);

  let metadata: unknown;
  try {
    metadata = await fetchMetadata();
  } catch (error) {
    await note(home, { lastError: message(error) });
    return { outcome: "failed", lines: [`Could not read the registry: ${message(error)}`] };
  }
  await note(home, { latestSeen: latestOf(metadata) });

  // selectCandidates applies the 24 hour rule itself; a shorter rule is
  // the same as asking it later.
  const minAge = anyAge ? 0 : (test.minAge ?? MIN_AGE_MS);
  const candidates = selectCandidates(metadata, { current: running, now: now + (MIN_AGE_MS - minAge), nodeVersion: process.versions.node });
  if (candidates.length === 0) {
    await note(home, { lastError: null });
    return { outcome: "none", lines: [`No newer release than ${running} to install.`] };
  }

  const lines: string[] = [];
  const reasons: string[] = [];
  const skip = async (version: string, reason: string): Promise<void> => {
    reasons.push(reason);
    lines.push(`Skipped ${version}: ${reason}`);
    const skipped = readState(home).skipped.filter((s) => s.version !== version);
    await note(home, { skipped: [...skipped, { version, reason, at: new Date().toISOString() }] });
  };

  for (const c of candidates) {
    const earlier = readState(home).skipped.find((s) => s.version === c.version && now - Date.parse(s.at) < RETRY_SKIPPED_MS);
    if (earlier) {
      reasons.push(earlier.reason);
      lines.push(`${c.version} was skipped earlier: ${earlier.reason}`);
      continue;
    }
    let tarball: Buffer;
    let attestations: unknown;
    try {
      tarball = await fetchTarball(c.tarball);
      attestations = await fetchAttestations(c.attestationsUrl);
    } catch (error) {
      await note(home, { lastError: message(error) });
      return { outcome: "failed", lines: [...lines, `Could not download ${c.version}: ${message(error)}`] };
    }
    const verified = verifyRelease({ name: "openqodex", version: c.version, tarball, integrity: c.integrity, attestations });
    if (!verified.ok) {
      await skip(c.version, verified.reason);
      continue;
    }
    let tmp: string;
    try {
      tmp = await unpackRelease(home, c.version, tarball);
    } catch (error) {
      await skip(c.version, `it did not install: ${message(error)}`);
      continue;
    }
    const result = await activateUnpacked({ home, version: c.version, from, tmp, env, wait });
    if (result.outcome === "skip") {
      await skip(c.version, result.reason);
      continue;
    }
    // After an uninstall, nothing is written: the home folder is not ours.
    if (result.outcome === "gone") return { outcome: "none", lines: [...lines, "OpenQodex was uninstalled meanwhile; nothing was changed."] };
    if (result.outcome === "busy") {
      await note(home, { lastError: result.reason });
      return { outcome: "busy", lines: [...lines, `Downloaded and verified ${c.version}, but did not switch to it: ${result.reason}`] };
    }
    if (result.outcome !== "activated") {
      if (result.outcome === "failed") await note(home, { lastError: result.reason });
      return { outcome: result.outcome === "failed" ? "failed" : "none", lines: [...lines, `Downloaded and verified ${c.version}, but did not switch to it: ${result.reason}`] };
    }
    return { outcome: "updated", lines: [...lines, result.reason] };
  }

  // Every candidate failed. When each failed because the built-in trust
  // data is out of date, one notice says how to update by hand, once.
  const trustStale = reasons.length > 0 && reasons.every((r) => TRUST_DATA.test(r));
  if (trustStale) {
    const text = `openqodex cannot verify new releases with its built-in trust data; it stays on ${from}. To update by hand: npx openqodex@latest init`;
    const state = readState(home);
    await note(home, { lastError: text, ...(state.lastError === text ? {} : { notice: { version: from, text } }) });
  } else await note(home, { lastError: null });
  return { outcome: "none", lines: [...lines, `Stayed on ${from}: no newer release could be installed.`] };
}
