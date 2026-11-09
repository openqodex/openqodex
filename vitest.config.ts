import { defineConfig } from "vitest/config";
import { quarantined } from "./tests/quarantine.mjs";

// The files that failed at random, with their issues (tests/quarantine.json
// and its rule in tests/quarantine.mjs): run apart, with one retry.
const held = quarantined();

export default defineConfig({
  test: {
    // Two projects with the settings below: unit, every file but the
    // quarantined ones, and quarantine, those with one retry. Each names its
    // own files: a project adds its include and exclude to the root's, so
    // the root names none. An empty list gives the quarantine project a
    // pattern no file has.
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          // benchmark/test: the review benchmark's generator and scorer (no reviewer runs there).
          // tests/*.test.ts: the shared test helpers in tests/.
          include: ["packages/*/src/**/*.test.ts", "packages/*/test/**/*.test.ts", "benchmark/test/**/*.test.mjs", "tests/*.test.ts"],
          // The real-binary adapter checks need every scanner installed; the
          // end-to-end config runs them.
          exclude: ["**/node_modules/**", "packages/scanners/test/*.subprocess.test.ts", ...held],
        },
      },
      { extends: true, test: { name: "quarantine", include: held.length > 0 ? held : ["tests/quarantine.json.none"], retry: 1 } },
    ],
    passWithNoTests: true,
    // Every temp folder a test makes is removed by its file; the run fails
    // when one is left (tests/temp-guard.ts).
    globalSetup: ["tests/temp-guard.ts"],
    // Many tests start the real CLI and git several times; a busy CI runner
    // takes more than the 5 second default for those.
    testTimeout: 30_000,
    // A setup step that makes a disk image or a git repo also needs room
    // there, and so does a file's last step, which removes every home and
    // runtime copy its tests made (a minute and more on a busy machine).
    hookTimeout: 300_000,
    // Off unless the run passes --coverage (pnpm test:coverage). The scope is
    // production sources only: package sources and the benchmark's own code,
    // without the two test helpers that live in src. A test that imports
    // another package runs its dist build; dist stays in scope so its source
    // maps credit the src lines. The CLI bundle has no source maps and its
    // tests run it as a child process, which is not measured.
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**", "packages/*/dist/**/*.js", "benchmark/lib/**", "benchmark/*.mjs"],
      exclude: ["**/*.test.ts", "**/*.test.mjs", "**/test/**", "**/test-support/**", "packages/cli/dist/**", "packages/core/src/test-fixtures.ts", "packages/graph/src/test-timing.ts"],
      reporter: ["text-summary", "json-summary"],
      reportsDirectory: "coverage",
    },
  },
});
