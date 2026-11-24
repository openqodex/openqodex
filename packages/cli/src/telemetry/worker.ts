// `openqodex __telemetry`: the detached worker a command starts with its
// events. It checks the switches again (so starting it by hand gets past
// none, and a project switched off meanwhile still wins), checks every event
// again, makes one request and exits. No retry, no file written. The only
// files it reads are the config files of the switch check.
import { openqodexHome } from "@openqodex/scanners";
import { enabled, telemetryTarget, type PolicyContext } from "./config.js";
import { MAX_BYTES, MAX_EVENTS } from "./dispatch.js";
import { validate } from "./events.js";

// The hard stop: the worker never outlives this, whatever the network does.
const DEADLINE_MS = 4000;
const REQUEST_MS = 3000;

function policy(raw: string | undefined): PolicyContext | null {
  if (raw === undefined || raw.length > 64_000) return null;
  try {
    const c = JSON.parse(raw) as Partial<PolicyContext>;
    if (typeof c.cwd !== "string" || typeof c.offline !== "boolean" || (c.config !== undefined && typeof c.config !== "string")) return null;
    return { cwd: c.cwd, offline: c.offline, ...(c.config !== undefined ? { config: c.config } : {}) };
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
  const ctx = policy(env.OPENQODEX_TELEMETRY_CONTEXT);
  if (ctx === null || !Array.isArray(parsed)) return;
  if (!enabled({ env, home: openqodexHome(), context: ctx }).on) return;
  const target = telemetryTarget(env);
  if (target === null) return;
  // The request body is built from the events alone, each through the tables again.
  const batch = parsed.slice(0, MAX_EVENTS).map(validate).filter((e) => e !== null);
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
