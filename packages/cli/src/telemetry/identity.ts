// The install id: one random id per OpenQodex home, in <home>/telemetry/id,
// with the date it was made. It is the only file usage data ever writes.
// Events carry sha256 of it, never the id itself. It is created
// exclusively, private (0600), through the home guard, never through a link.
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { homeGuard } from "../agents/guarded-fs.js";

export type InstallId = { id: string; created: string };

const SHAPE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\n(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z)\n$/;

export function telemetryDir(home: string): string {
  return join(home, "telemetry");
}

function idPath(home: string): string {
  return join(telemetryDir(home), "id");
}

// The id, null when there is none, or "bad" when the file is there and
// cannot be read or is not in the expected shape: then nothing is sent and
// the file is left alone.
export function readId(home: string): InstallId | null | "bad" {
  let buf: Buffer | null;
  try {
    buf = homeGuard(home, true).read(idPath(home), 1024);
  } catch {
    return "bad";
  }
  if (buf === null) return null;
  const m = SHAPE.exec(buf.toString("utf8"));
  if (m === null || !Number.isFinite(Date.parse(m[2]!))) return "bad";
  return { id: m[1]!, created: m[2]! };
}

// Creates the id when there is none. `created` is true only for the process
// whose exclusive create made the file: two commands started at once make
// one id, and only one of them says so. Null when the home cannot be
// written or the file there is not usable.
export function createId(home: string, now = new Date()): { id: InstallId; created: boolean } | null {
  const id: InstallId = { id: randomUUID(), created: now.toISOString() };
  try {
    if (homeGuard(home, true).write(idPath(home), `${id.id}\n${id.created}\n`, { mode: 0o600, exclusive: true })) return { id, created: true };
  } catch {
    return null;
  }
  const other = readId(home);
  return other === null || other === "bad" ? null : { id: other, created: false };
}

// What goes on the wire: sha256 of the id, in hex.
export function installId(id: InstallId): string {
  return createHash("sha256").update(id.id).digest("hex");
}

// Whole days since the id was made; 0 for a date in the future.
export function ageDays(id: InstallId, now = Date.now()): number {
  return Math.max(0, Math.floor((now - Date.parse(id.created)) / 86_400_000));
}
