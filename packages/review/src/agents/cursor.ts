// Cursor as the reviewer: not enabled. cursor-agent 2025.09.18 offers no way
// to limit its tools, no read-only sandbox and no switch to skip the
// repository's rules or the developer's settings (docs/internal-reviewer-drivers.md).
// `--reviewer cursor` names it and gets this reason; `auto` passes it by.
import type { Detected, ReviewerDriver, ReviewerSession } from "./driver.js";

export const CURSOR_NOT_ENABLED =
  "not enabled: cursor-agent cannot be limited to reading, and it cannot be kept from loading the repository's rules and your settings";

async function detect(): Promise<Detected> {
  return { ok: false, missing: CURSOR_NOT_ENABLED, fix: "use Claude Code or Codex as the reviewer (--reviewer claude or --reviewer codex)" };
}

function start(): ReviewerSession {
  throw new Error(CURSOR_NOT_ENABLED);
}

export const cursorDriver: ReviewerDriver = { name: "cursor", traced: false, detect, start };
