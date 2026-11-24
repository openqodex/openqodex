import { defineConfig } from "vitest/config";

// End-to-end tests run the built CLI as a real subprocess. Build first.
export default defineConfig({
  test: {
    include: ["tests/e2e/**/*.test.ts"],
    // Every temp folder a test makes is removed by its file; the run fails
    // when one is left (tests/temp-guard.ts).
    globalSetup: ["tests/temp-guard.ts"],
    testTimeout: 300_000,
    hookTimeout: 300_000,
    fileParallelism: false,
    // No usage data from any test: every child that spreads process.env inherits this.
    env: { OPENQODEX_TELEMETRY: "0" },
  },
});
