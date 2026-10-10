#!/usr/bin/env node
// Entry point. The Node version check runs before anything else is loaded, so
// an old Node prints the requirement instead of a syntax or import error.
const REQUIRED_MAJOR = 22;
const major = Number(process.versions.node.split(".")[0]);

if (!Number.isFinite(major) || major < REQUIRED_MAJOR) {
  process.stderr.write(
    `openqodex needs Node ${REQUIRED_MAJOR} or newer. This is Node ${process.versions.node}.\n`,
  );
  process.exit(2);
} else {
  import("./program.js")
    .then(({ main }) => main(process.argv))
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`openqodex failed: ${message}\n`);
      process.exit(2);
    });
}
