// The model settings loader (benchmark/lib/model-env.mjs): the base URL and
// key of the benchmark's model endpoint, from the settings file only.
//
// Failures guarded, written before the code:
// 1. A missing file or a missing field falls back to another provider's key
//    (OPENAI_API_KEY in the environment, or another field name in the file)
//    instead of refusing with the field it needs.
// 2. The key or the base URL lands in a saved file, a log line or argv: the
//    loaded settings written as JSON or printed show either value, a
//    refusal message carries one, or nothing can tell a caller that its argv
//    holds one.
// 3. A model id boards.json has not recorded as probed is used, so a run
//    spends on a deployment nobody checked answers.
// 4. A base URL that would send the key in clear over a network is taken.
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { loadModelEnv, modelEnvPath, probedDeployment } from "../lib/model-env.mjs";
import { removeTempDirs, tempDir } from "../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

// Made at run time, so no secret scanner reading this file takes it for a real key.
const KEY = `test-model-key-${randomBytes(16).toString("hex")}`;
const BASE = "https://test-resource.openai.example/openai/v1";

const settingsFile = (text) => {
  const path = join(tempDir("oq-model-env-"), "azure.env");
  writeFileSync(path, text);
  return path;
};
const refusal = (fn) => {
  try {
    fn();
  } catch (error) {
    return error.message;
  }
  throw new Error("expected a refusal");
};
const boards = () => JSON.parse(readFileSync(new URL("../outside/boards.json", import.meta.url), "utf8"));

describe("the model settings loader", () => {
  it("reads the MiniMax endpoint with bearer authentication", () => {
    const path = settingsFile(`MINIMAX_API_KEY="${KEY}"\nMINIMAX_BASE_URL=https://api.minimax.io/v1\n`);
    const settings = loadModelEnv({ env: { OPENQODEX_BENCH_MODEL_ENV: path } });
    expect(settings.baseUrl).toBe("https://api.minimax.io/v1");
    expect(settings.apiKey).toBe(KEY);
    expect(settings.authHeader).toBe("bearer");
  });

  it("refuses an incomplete MiniMax endpoint configuration", () => {
    const path = settingsFile(`MINIMAX_API_KEY=${KEY}\n`);
    const message = refusal(() => loadModelEnv({ env: { OPENQODEX_BENCH_MODEL_ENV: path } }));
    expect(message).toMatch(/^refused: .*has no MINIMAX_BASE_URL/);
    expect(message).not.toContain(KEY);
  });

  it("reads the base URL and key from the file OPENQODEX_BENCH_MODEL_ENV names, with the api-key header style", () => {
    const path = settingsFile(`# the benchmark's Azure resource\nexport AZURE_OPENAI_KEY="${KEY}"\nAZURE_OPENAI_BASE_URL=${BASE} # v1\n`);
    const settings = loadModelEnv({ env: { OPENQODEX_BENCH_MODEL_ENV: path } });
    expect(settings.baseUrl).toBe(BASE);
    expect(settings.apiKey).toBe(KEY);
    expect(settings.authHeader).toBe("api-key");
  });

  it("looks in ~/.config/openqodex-bench/azure.env when the variable is not set", () => {
    expect(modelEnvPath({})).toBe(join(homedir(), ".config", "openqodex-bench", "azure.env"));
  });

  it("refuses a missing file instead of falling back to another provider's key in the environment", () => {
    const missing = join(tempDir("oq-model-env-"), "azure.env");
    const env = { OPENQODEX_BENCH_MODEL_ENV: missing, OPENAI_API_KEY: KEY, AZURE_OPENAI_KEY: KEY, AZURE_OPENAI_BASE_URL: BASE };
    const message = refusal(() => loadModelEnv({ env }));
    expect(message).toMatch(/^refused: the model settings file .*azure\.env cannot be read/);
    expect(message).not.toContain(KEY);
  });

  it("refuses a file without AZURE_OPENAI_KEY, naming that field, even when it holds another provider's key", () => {
    const path = settingsFile(`OPENAI_API_KEY=${KEY}\nAZURE_OPENAI_BASE_URL=${BASE}\n`);
    const message = refusal(() => loadModelEnv({ env: { OPENQODEX_BENCH_MODEL_ENV: path } }));
    expect(message).toMatch(/^refused: .*has no AZURE_OPENAI_KEY/);
    expect(message).not.toContain(KEY);
    expect(message).not.toContain(BASE);
  });

  it("refuses a file without AZURE_OPENAI_BASE_URL, or with an empty one, naming that field", () => {
    for (const text of [`AZURE_OPENAI_KEY=${KEY}\n`, `AZURE_OPENAI_KEY=${KEY}\nAZURE_OPENAI_BASE_URL=""\n`, `AZURE_OPENAI_KEY=${KEY}\nOPENAI_BASE_URL=${BASE}\n`]) {
      const message = refusal(() => loadModelEnv({ env: { OPENQODEX_BENCH_MODEL_ENV: settingsFile(text) } }));
      expect(message).toMatch(/^refused: .*has no AZURE_OPENAI_BASE_URL/);
      expect(message).not.toContain(KEY);
    }
  });

  it("refuses a base URL that would send the key in clear, without printing it", () => {
    const plain = "http://test-resource.openai.example/openai/v1";
    const message = refusal(() => loadModelEnv({ env: { OPENQODEX_BENCH_MODEL_ENV: settingsFile(`AZURE_OPENAI_KEY=${KEY}\nAZURE_OPENAI_BASE_URL=${plain}\n`) } }));
    expect(message).toMatch(/^refused: AZURE_OPENAI_BASE_URL in .* is not an https URL/);
    expect(message).not.toContain(plain);
    expect(message).not.toContain("test-resource.openai.example");
  });

  it("never shows the key or the base URL when the settings are saved as JSON, printed, or spread into another object", () => {
    const settings = loadModelEnv({ env: { OPENQODEX_BENCH_MODEL_ENV: settingsFile(`AZURE_OPENAI_KEY=${KEY}\nAZURE_OPENAI_BASE_URL=${BASE}\n`) } });
    const copy = { ...settings, model: "gpt-6.1-sol" };
    for (const shown of [JSON.stringify(settings), inspect(settings), String(settings), JSON.stringify(copy), inspect(copy), JSON.stringify({ reviewer: settings })]) {
      expect(shown).not.toContain(KEY);
      expect(shown).not.toContain(BASE);
      expect(shown).not.toContain("test-resource.openai.example");
    }
    // The values themselves stay usable for the one place that needs them.
    expect(copy.apiKey).toBe(KEY);
    expect(copy.baseUrl).toBe(BASE);
  });

  it("tells a caller when a command line holds the key, the base URL or its host", () => {
    const settings = loadModelEnv({ env: { OPENQODEX_BENCH_MODEL_ENV: settingsFile(`AZURE_OPENAI_KEY=${KEY}\nAZURE_OPENAI_BASE_URL=${BASE}\n`) } });
    expect(settings.appearsIn(["node", "run.mjs", "--key", KEY].join(" "))).toBe(true);
    expect(settings.appearsIn(["node", "run.mjs", `--base=${BASE}`].join(" "))).toBe(true);
    expect(settings.appearsIn("curl https://test-resource.openai.example/x")).toBe(true);
    expect(settings.appearsIn(["node", "run.mjs", "--reviewers", "model:gpt-6.1-sol"].join(" "))).toBe(false);
  });
});

describe("the probed deployment check", () => {
  it("refuses a model id that boards.json does not record as a deployment", () => {
    expect(refusal(() => probedDeployment("gpt-6.1", { boards: boards() }))).toMatch(/^refused: gpt-6\.1 is not a deployment boards\.json records/);
  });

  it("refuses a deployment whose probed date is null, unless the caller is the session's probe itself", () => {
    const pins = boards();
    pins.deployments.reviewer.probed = null;
    pins.deployments.reviewer.served = null;
    expect(refusal(() => probedDeployment(pins.deployments.reviewer.id, { boards: pins }))).toMatch(/^refused: gpt-6\.1-sol has not been probed/);
    expect(probedDeployment(pins.deployments.reviewer.id, { boards: pins, allowUnprobed: true }).id).toBe("gpt-6.1-sol");
  });

  it("accepts a deployment with a probed date and returns its record", () => {
    const pins = boards();
    pins.deployments.judge.probed = "2026-10-10T00:00:00Z";
    pins.deployments.judge.served = "gpt-5.2-2025-12-11";
    expect(probedDeployment("gpt-5.2", { boards: pins })).toMatchObject({ id: "gpt-5.2", served: "gpt-5.2-2025-12-11" });
  });
});
