// `openqodex __telemetry`: the detached worker a command starts with its
// events. It checks every switch (so starting it by hand gets past none, and
// a project switched off meanwhile still wins), asks git which work tree the
// command worked on and checks its switch too, reads the install id or, on
// a first run, makes it, stamps the events with it, checks every event
// again, makes one request and exits. No retry. The only file it writes is
// the install id; the files it reads are the config files and the id.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { telemetrySwitch } from "@openqodex/core";
import { openqodexHome } from "@openqodex/scanners";
import { enabled, telemetryTarget } from "./config.js";
import { MAX_BYTES, MAX_EVENTS, type WorkerContext } from "./dispatch.js";
import { validate, type Envelope } from "./events.js";
import { ageDays, createId, installId, readId } from "./identity.js";

// The hard stop: the worker never outlives this, whatever the network does.
const DEADLINE_MS = 4000;
const REQUEST_MS = 3000;
const GIT_MS = 1500;

// The top of the work tree git resolves for the folder, with the command's
// own environment: GIT_DIR, GIT_WORK_TREE or core.worktree can put it
// outside the folder's parents, and the command then works on it. Null
// only when git says the folder is in no repository; "unknown" for any
// other failure (git missing, killed, refused, slow), and then nothing is
// sent. Only git's closing newline comes off: a path may end in spaces.
function workTree(cwd: string, env: NodeJS.ProcessEnv): Promise<string | null | "unknown"> {
  return new Promise((done) => {
    execFile("git", ["rev-parse", "--show-toplevel"], { cwd, env: { ...env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C", LANGUAGE: "C" }, timeout: GIT_MS, maxBuffer: 64 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (error !== null) return done(error.killed !== true && error.code === 128 && /not a git repository/i.test(stderr) ? null : "unknown");
      const line = stdout.replace(/\r?\n$/, "");
      done(line === "" ? "unknown" : line);
    });
  });
}

function workerContext(raw: string | undefined): WorkerContext | null {
  if (raw === undefined || raw.length > 64_000) return null;
  try {
    const c = JSON.parse(raw) as Partial<WorkerContext>;
    if (typeof c.cwd !== "string" || typeof c.offline !== "boolean" || (c.config !== undefined && typeof c.config !== "string")) return null;
    if (c.also !== undefined && !(Array.isArray(c.also) && c.also.every((d) => typeof d === "string"))) return null;
    return { cwd: c.cwd, offline: c.offline, mayCreate: c.mayCreate === true, ...(c.config !== undefined ? { config: c.config } : {}), ...(c.also !== undefined ? { also: c.also } : {}) };
  } catch {
    return null;
  }
}

export async function runTelemetryWorker(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  setTimeout(() => process.exit(0), DEADLINE_MS);
  const raw = env.OPENQODEX_TELEMETRY_EVENTS;
  if (raw === undefined || raw.length > MAX_BYTES) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  const ctx = workerContext(env.OPENQODEX_TELEMETRY_CONTEXT);
  if (ctx === null || !Array.isArray(parsed)) return;
  const home = openqodexHome();
  if (!enabled({ env, home, context: ctx }).on) return;
  // The repository the command worked on can lie outside the folder's
  // parents; its own switch counts too.
  const tree = await workTree(ctx.cwd, env);
  if (tree === "unknown" || (tree !== null && !telemetrySwitch(tree, ctx.config).on)) return;
  for (const dir of ctx.also ?? []) if (!telemetrySwitch(dir).on) return;
  const target = telemetryTarget(env);
  if (target === null) return;
  // install.first_use is made here only, by the worker that made the id.
  const events = parsed.slice(0, MAX_EVENTS).map(validate).filter((e): e is Envelope => e !== null && e.event !== "install.first_use");
  if (events.length === 0) return;
  // The id: read it, or make it when the command may. Two workers started
  // at once on a fresh home make one id: the exclusive create lets one of
  // them make it, and only that one sends install.first_use.
  let id = readId(home);
  if (id === "bad") return;
  if (id === null) {
    if (!ctx.mayCreate) return;
    const made = createId(home);
    if (made === null) return;
    id = made.id;
    if (made.created) events.unshift({ uuid: randomUUID(), event: "install.first_use", distinct_id: events[0]!.distinct_id, timestamp: events[0]!.timestamp, properties: { ...events[0]!.properties } });
  }
  const distinct = installId(id);
  const age = ageDays(id);
  // The request body is built from the events alone, each through the tables again.
  const batch = events
    .map((e) => validate({ ...e, distinct_id: distinct, properties: { ...e.properties, installId: distinct, installAgeDays: age } }))
    .filter((e) => e !== null);
  if (batch.length === 0) return;
  try {
    await fetch(`${target.host}/batch/`, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": `openqodex/${__OPENQODEX_VERSION__}` },
      body: JSON.stringify({ api_key: target.key, batch }),
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_MS),
    });
  } catch {
    // Dropped: there is no retry.
  }
}
