// The commit boundary: one process at a time per home folder may install,
// uninstall, switch the active runtime or change the update switch. The lock
// is a TCP listener on 127.0.0.1 at a port derived from the home folder,
// bound exclusively. The operating system releases it when the process
// ends, however it ends, so there is no stale lock and no takeover. The
// listener accepts nothing: a connection is closed at once, unread.
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { basename, dirname, join, resolve } from "node:path";
import { errorCode } from "./files.js";

const LOW = 20_000;
const HIGH = 32_000;
const POLL_MS = 100;

// The home folder with every link resolved, so two spellings of one folder
// get one port. A folder that does not exist yet resolves through its
// nearest existing parent.
function realHome(home: string): string {
  const full = resolve(home);
  try {
    return realpathSync.native(full);
  } catch {
    const parent = dirname(full);
    return parent === full ? full : join(realHome(parent), basename(full));
  }
}

// A port in 20000 to 32000, below the ephemeral ranges of macOS and Linux.
export function boundaryPort(home: string): number {
  const digest = createHash("sha256").update(realHome(home)).digest();
  return LOW + (digest.readUInt32BE(0) % (HIGH - LOW + 1));
}

// `held`: another process holds the boundary. Otherwise the listener could
// not be opened at all (a sandbox, a firewall), and `message` says why.
export class BoundaryError extends Error {
  constructor(
    message: string,
    readonly held: boolean,
  ) {
    super(message);
  }
}

function listen(port: number): Promise<Server | null> {
  return new Promise((ok, fail) => {
    const server = createServer((socket) => socket.destroy());
    server.once("error", (error) => {
      if (errorCode(error) === "EADDRINUSE") ok(null);
      else fail(new BoundaryError(`the lock could not be taken (a listener on 127.0.0.1:${port}): ${errorCode(error) ?? (error as Error).message}`, false));
    });
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => ok(server));
  });
}

// Any local program can hold the port: another openqodex run, or one that
// squats on it. Nothing is installed or changed while it is held; the line
// says how to see the holder.
function heldMessage(port: number): string {
  return `another openqodex run or another program holds 127.0.0.1:${port}, which openqodex uses as its lock; see it with: lsof -nP -iTCP:${port} -sTCP:LISTEN`;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Runs `fn` holding the boundary for `home`. Waits up to `wait` ms while
// another process holds it, then throws a BoundaryError with held = true.
// The listener is closed when `fn` ends, so it never keeps the process alive.
export async function withBoundary<T>(home: string, opts: { wait: number }, fn: () => T | Promise<T>): Promise<T> {
  const port = boundaryPort(home);
  const deadline = Date.now() + opts.wait;
  let server = await listen(port);
  while (server === null) {
    if (Date.now() >= deadline) {
      throw new BoundaryError(heldMessage(port), true);
    }
    await sleep(POLL_MS);
    server = await listen(port);
  }
  const held = server;
  try {
    return await fn();
  } finally {
    await new Promise<void>((r) => held.close(() => r()));
  }
}
