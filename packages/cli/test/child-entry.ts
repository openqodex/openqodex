// The real modules a test runs in a separate process, bundled by bundle.ts:
// boundary contention, a worker paused or killed at the boundary, and the
// worker's own unpack need two processes or a process that can be killed.
export { boundaryPort, withBoundary } from "../src/agents/lock.js";
export { activateUnpacked, unpackRelease } from "../src/update/worker.js";
