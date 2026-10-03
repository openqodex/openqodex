import { beforeAll, afterAll } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { receipt, root, run, toolsHome, printReceipt, installed } from "./support.js";

// The shared home keeps the scanners between runs, and also the runtime copy
// an earlier build installed under the same version. A runtime copy is never
// replaced, so a rebuilt CLI would be refused: each run starts without one.
beforeAll(() => {
  const marker = join(receipt, "runtime-reset");
  if (existsSync(marker)) return;
  rmSync(join(toolsHome, "runtime"), { recursive: true, force: true });
  mkdirSync(receipt, { recursive: true });
  writeFileSync(marker, "");
});

// Imported by each group. Vitest runs files serially, and the shared marker
// avoids a second install when a test file has a separate module isolate.
beforeAll(() => {
  if (process.env.OPENQODEX_E2E_OFFLINE === "1" || installed()) return;
  mkdirSync(toolsHome, { recursive: true });
  const result = run("doctor-install", root, ["doctor", "--install"], { tools: toolsHome, timeout: 1_200_000 });
  if (result.status !== 0) throw new Error(`doctor --install exited ${result.status}: ${result.stderr}`);
}, 1_200_000);
afterAll(printReceipt);
