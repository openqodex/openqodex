// The one way a scanner process is started: execFile with an argument array
// (never a shell), a small allowlisted environment, a timeout and an output
// cap. It never rejects; the caller reads the result.

import { execFile } from "node:child_process";

// Variables a scanner may see from the developer's environment. Everything
// else (tokens, cloud credentials, tool settings) stays out of the process.
const PASSED_VARIABLES = new Set([
  "PATH",
  "HOME",
  "TMPDIR",
  "LANG",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
]);

// The small environment every scanner process gets: PATH, HOME, TMPDIR, LANG,
// LC_*, proxy variables, plus `extra`. Never the whole process.env.
export function scannerEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (PASSED_VARIABLES.has(key) || key.startsWith("LC_")) env[key] = value;
  }
  return { ...env, ...extra };
}

// True when the run must make no network request (`--offline` sets it).
export function isOffline(): boolean {
  return process.env.OPENQODEX_OFFLINE === "1";
}

export type ExecResult = {
  stdout: string;
  stderr: string;
  // The numeric exit code, or null when the process was killed or never started.
  exitCode: number | null;
  // Set when the process could not start, timed out or overflowed its buffer.
  failure: "not_found" | "timeout" | "overflow" | "killed" | null;
};

type ExecError = Error & { code?: unknown; killed?: boolean; signal?: unknown };

// How long after the deadline execTool resolves on its own when the process
// (or a child it started that still holds its output open) has not closed.
const CLOSE_GRACE_MS = 2_000;

// execFile, never a shell. Never rejects: the caller reads the result. At the
// deadline, and when output passes the cap, the process gets SIGKILL, which
// it cannot catch; if its output still does not close soon after, the
// result is returned anyway.
export function execTool(
  file: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number; maxBytes: number; env?: Record<string, string> },
): Promise<ExecResult> {
  return new Promise((resolve) => {
    let settled = false;
    let hardStop: NodeJS.Timeout | null = null;
    const settle = (result: ExecResult): void => {
      if (settled) return;
      settled = true;
      if (hardStop) clearTimeout(hardStop);
      resolve(result);
    };
    try {
      const child = execFile(
        file,
        args,
        {
          cwd: opts.cwd,
          timeout: opts.timeoutMs,
          killSignal: "SIGKILL",
          maxBuffer: opts.maxBytes,
          env: scannerEnv(opts.env),
          encoding: "utf8",
          windowsHide: true,
        },
        (err, stdout, stderr) => {
          const out = stdout ?? "";
          const errText = stderr ?? "";
          if (!err) {
            settle({ stdout: out, stderr: errText, exitCode: 0, failure: null });
            return;
          }
          const e = err as ExecError;
          if (typeof e.code === "number") {
            settle({ stdout: out, stderr: errText, exitCode: e.code, failure: null });
            return;
          }
          if (e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
            settle({ stdout: out, stderr: errText, exitCode: null, failure: "overflow" });
            return;
          }
          // Node sets `killed` only when it ended the process itself, and the
          // buffer case is handled above, so this is the timeout.
          if (e.killed) {
            settle({ stdout: out, stderr: errText, exitCode: null, failure: "timeout" });
            return;
          }
          if (typeof e.signal === "string") {
            settle({ stdout: out, stderr: errText, exitCode: null, failure: "killed" });
            return;
          }
          // ENOENT, EACCES and the like: the process never started.
          settle({ stdout: out, stderr: e.message, exitCode: null, failure: "not_found" });
        },
      );
      hardStop = setTimeout(() => {
        child.kill("SIGKILL");
        child.stdout?.destroy();
        child.stderr?.destroy();
        settle({ stdout: "", stderr: "", exitCode: null, failure: "timeout" });
      }, opts.timeoutMs + CLOSE_GRACE_MS);
    } catch (err) {
      // execFile throws synchronously on an argument it cannot pass (a NUL byte).
      const message = err instanceof Error ? err.message : String(err);
      settle({ stdout: "", stderr: message, exitCode: null, failure: "not_found" });
    }
  });
}

// One line for a run that left nothing to read, or null when it ran.
export function describeFailure(name: string, result: ExecResult, timeoutMs: number): string | null {
  switch (result.failure) {
    case "not_found":
      return `${name} could not start: ${result.stderr.trim().slice(0, 200)}`;
    case "timeout":
      return `${name} timed out after ${Math.round(timeoutMs / 1000)}s`;
    case "overflow":
      return `${name} printed more output than the limit allows`;
    case "killed":
      return `${name} was killed`;
    default:
      return null;
  }
}

// The end of stderr, for an error line. A cut that lands inside a word
// puts "..." in place of that part word, so no piece of a path such as "e/var/..." from
// "/private/var/..." is left that the runner cannot recognise and hide.
export function stderrTail(result: ExecResult): string {
  const text = result.stderr.trim();
  if (text.length <= 300) return text;
  const tail = text.slice(-300);
  return /\s/.test(text[text.length - 301]!) ? tail : `...${tail.replace(/^\S*/, "")}`;
}

// Bytes of file arguments one scanner process may get: well under the limit
// on macOS and Linux, so a whole-repo review never fails with E2BIG.
export const ARG_BUDGET_BYTES = 100 * 1024;

// Splits a file list into chunks whose argument bytes stay within the budget,
// keeping the order. A single name over the budget gets a chunk of its own.
export function splitArgs(files: string[], budgetBytes: number): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let bytes = 0;
  for (const file of files) {
    const size = Buffer.byteLength(file, "utf8") + 1;
    if (current.length > 0 && bytes + size > budgetBytes) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }
    current.push(file);
    bytes += size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

// Runs `step` once per chunk of `files`, one after another, under the
// scanner's one timeout: each step gets the milliseconds still left. The
// findings of every chunk are merged in order; a failed step fails the run.
// `completed`, when given, retains completed chunks even when a later one fails.
export async function runInChunks<T>(
  name: string,
  files: string[],
  timeoutMs: number,
  step: (chunk: string[], timeLeftMs: number) => Promise<T[]>,
  completed?: T[],
): Promise<T[]> {
  const deadline = Date.now() + timeoutMs;
  const out: T[] = completed ?? [];
  for (const chunk of splitArgs(files, ARG_BUDGET_BYTES)) {
    const left = deadline - Date.now();
    if (left <= 0) throw new Error(`${name} timed out after ${Math.round(timeoutMs / 1000)}s`);
    for (const item of await step(chunk, left)) out.push(item);
  }
  return out;
}
