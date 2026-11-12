// Where the benchmark's model calls go: the base URL and key of the selected
// OpenAI-compatible endpoint, read from one file and from nowhere else, and
// the check that a model id is a deployment the session has probed.
//
// The file is ~/.config/openqodex-bench/azure.env, or the path
// OPENQODEX_BENCH_MODEL_ENV names. It holds either AZURE_OPENAI_BASE_URL /
// AZURE_OPENAI_KEY or MINIMAX_BASE_URL / MINIMAX_API_KEY; the selected
// endpoint takes the key in an `api-key` or `bearer` header.
//
// Failure list, written before the code:
// 1. A missing file or field falls back to another provider (OPENAI_API_KEY
//    in the environment, or another field name): it is a refusal that names
//    the file or the field, and only these two field names are read.
// 2. The key or the base URL lands in a saved file, a log line or argv: a
//    refusal never carries a value; the loaded settings show neither value
//    when written as JSON or printed, a spread copy included; appearsIn lets
//    a runner refuse a command line or a file that holds one.
// 3. A base URL that sends the key in clear over a network is taken: only
//    https, or http to this machine (a test's stand-in provider).
// 4. A model id nobody probed is spent on: probedDeployment refuses an id
//    that boards.json does not record as a deployment with a probed date,
//    unless the caller is the session's probe itself.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";

export const MODEL_ENV_FIELDS = Object.freeze({
  azure: Object.freeze({ baseUrl: "AZURE_OPENAI_BASE_URL", apiKey: "AZURE_OPENAI_KEY", authHeader: "api-key" }),
  minimax: Object.freeze({ baseUrl: "MINIMAX_BASE_URL", apiKey: "MINIMAX_API_KEY", authHeader: "bearer" }),
});

const BOARDS = new URL("../outside/boards.json", import.meta.url);
const LOOPBACK = new Set(["127.0.0.1", "[::1]", "localhost"]);

/** The settings file's path: OPENQODEX_BENCH_MODEL_ENV, else the default. */
export function modelEnvPath(env = process.env) {
  return env.OPENQODEX_BENCH_MODEL_ENV ?? join(homedir(), ".config", "openqodex-bench", "azure.env");
}

// The path as a refusal shows it: the home folder as ~, so a refusal line
// that ends up in a log does not carry this machine's home path.
const shown = (path) => (path.startsWith(`${homedir()}/`) ? `~${path.slice(homedir().length)}` : path);

/** What is wrong with a base URL, or null. Never quotes the value. */
export function baseUrlProblem(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return "is not a URL";
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") return "holds a user, a password, a query or a fragment";
  if (url.protocol === "https:") return null;
  if (url.protocol === "http:" && LOOPBACK.has(url.hostname)) return null;
  return "is not an https URL";
}

/**
 * Every text that would give the endpoint away: the key as the file holds it
 * and as a header sends it (fetch strips leading and trailing spaces, tabs
 * and line breaks from a header value, so a provider echoes that form), the
 * base URL, its origin and host. Every non-empty value, however short.
 * Longest first.
 */
export function endpointSecrets(baseUrl, apiKey) {
  const out = new Set([apiKey, apiKey.replace(/^[\t\n\r ]+|[\t\n\r ]+$/g, ""), baseUrl, baseUrl.replace(/\/+$/, "")]);
  try {
    const url = new URL(baseUrl);
    for (const part of [url.origin, url.host, url.hostname]) out.add(part);
  } catch {
    // not a URL: the whole value is already in the set
  }
  return [...out].filter((s) => typeof s === "string" && s !== "").sort((a, b) => b.length - a.length);
}

// One NAME=value line, as a shell reads it: an optional `export`, the value
// bare (a trailing # comment dropped) or in matching quotes.
function fields(text) {
  const out = new Map();
  for (const line of text.split(/\r\n|\n|\r/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    const raw = m[2];
    const quoted = /^(["'])(.*)\1$/.exec(raw);
    out.set(m[1], quoted ? quoted[2] : raw.replace(/\s+#.*$/, ""));
  }
  return out;
}

/**
 * The endpoint settings, or a thrown refusal ("refused: ...") naming the
 * file or the field. `env` is read only for OPENQODEX_BENCH_MODEL_ENV.
 */
export function loadModelEnv({ env = process.env } = {}) {
  const path = modelEnvPath(env);
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new Error(`refused: the model settings file ${shown(path)} cannot be read; it must hold endpoint settings, and no other provider is used in its place`);
  }
  const found = fields(text);
  const provider = (found.get(MODEL_ENV_FIELDS.minimax.baseUrl) ?? found.get(MODEL_ENV_FIELDS.minimax.apiKey)) !== undefined ? "minimax" : "azure";
  const selected = MODEL_ENV_FIELDS[provider];
  for (const name of [selected.baseUrl, selected.apiKey]) {
    if ((found.get(name) ?? "") === "") throw new Error(`refused: the model settings file ${shown(path)} has no ${name}; no other provider is used in its place`);
  }
  const baseUrl = found.get(selected.baseUrl);
  const apiKey = found.get(selected.apiKey);
  const problem = baseUrlProblem(baseUrl);
  if (problem !== null) throw new Error(`refused: ${selected.baseUrl} in ${shown(path)} ${problem}`);
  return modelSettings({ baseUrl, apiKey, authHeader: selected.authHeader });
}

// The settings with the two values usable as properties, and shown as
// "[hidden]" wherever they would be written: as JSON, printed, or as text.
// toJSON and the inspect hook are own enumerable properties, so a spread
// copy ({ ...settings, model }) hides them too.
function modelSettings({ baseUrl, apiKey, authHeader }) {
  const secrets = endpointSecrets(baseUrl, apiKey);
  const hidden = { baseUrl: "[hidden]", apiKey: "[hidden]", authHeader };
  return Object.freeze({
    baseUrl,
    apiKey,
    authHeader,
    /** True when `text` (a command line, a file's content) holds the key, the base URL or its host. */
    appearsIn: (text) => secrets.some((s) => String(text).includes(s)),
    toJSON: () => hidden,
    toString: () => "[model settings, hidden]",
    [inspect.custom]: () => hidden,
  });
}

/**
 * The deployment boards.json records for `model`, or a thrown refusal: an id
 * that is not a deployment, or one whose `probed` is null. `allowUnprobed`
 * is for the session's probe itself, the call that fills `probed` in.
 */
export function probedDeployment(model, { allowUnprobed = false, boards = JSON.parse(readFileSync(BOARDS, "utf8")) } = {}) {
  const deployment = Object.values(boards?.deployments ?? {}).find((d) => d?.id === model);
  if (deployment === undefined) throw new Error(`refused: ${model} is not a deployment boards.json records; the deployments are ${Object.values(boards?.deployments ?? {}).map((d) => d?.id).join(", ")}`);
  if (deployment.probed === null && !allowUnprobed) throw new Error(`refused: ${model} has not been probed; run the probe (node benchmark/lib/openai-reviewer.mjs --probe ${model}) and record probed and served in boards.json first`);
  return deployment;
}
