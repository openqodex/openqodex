// AACR's vLLM and sampling fields are not accepted by Azure's reasoning model.
// Keep the pinned evaluator intact and its process free of the Azure key.
//
// Failure list, written before the code (benchmark/test/aacr-board.test.mjs):
// 1. Stripping a top-level field rewrites other JSON bytes or nested fields.
// 2. The key uses bearer auth or leaks through logs, errors or counters.
// 3. Binding or the first upstream 401/404 lets evaluation rounds start.
// 4. Requests, removals or upstream statuses are missing from eval.json.
// 5. Another local process spends the key through the relay while a run lasts.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { join } from "node:path";
import { leaksIn } from "./board-files.mjs";
import { endpointSecrets } from "./model-env.mjs";

const UPSTREAM_TIMEOUT_MS = 120_000;

// Find top-level members without reserializing their values. Commas inside
// strings, arrays and nested objects do not split a member. JSON.parse
// validates the body first; slices retain numbers, escapes and whitespace.
function adaptParameters(body) {
  const parsed = JSON.parse(body);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("expected a JSON object");
  const open = body.indexOf("{");
  const end = body.lastIndexOf("}");
  const members = [];
  let start = open + 1;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let i = start; i < end; i++) {
    const c = body[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") depth--;
    else if (c === "," && depth === 0) {
      members.push(body.slice(start, i));
      start = i + 1;
    }
  }
  members.push(body.slice(start, end));
  const changes = { chat_template_kwargs: 0, temperature: 0, top_p: 0, max_tokens: 0 };
  const kept = members.flatMap((member) => {
    const name = /^\s*("(?:[^"\\]|\\.)*")\s*:/.exec(member);
    const field = name ? JSON.parse(name[1]) : null;
    if (["chat_template_kwargs", "temperature", "top_p"].includes(field)) {
      changes[field]++;
      return [];
    }
    if (field === "max_tokens") {
      changes.max_tokens++;
      return [member.replace(name[1], '"max_completion_tokens"')];
    }
    return [member];
  });
  return { body: Object.values(changes).every((n) => n === 0) ? body : body.slice(0, open + 1) + kept.join(",") + body.slice(end), changes };
}

/** A loopback-only relay with opaque credentials and counters safe to save. */
export async function startRelay(settings, { trackUsage = false, onFailure, cacheDir, maxConnectionDrops = 0, validateAnswer } = {}) {
  const apiKey = randomBytes(32).toString("hex");
  const expected = Buffer.from(`Bearer ${apiKey}`);
  const stats = { relay: true, requests: 0, stripped: 0, parameterChanges: { chat_template_kwargs: 0, temperature: 0, top_p: 0, max_tokens: 0 }, upstreamStatuses: {} };
  if (trackUsage) stats.usage = { responses: 0, missing: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
  if (cacheDir) { mkdirSync(cacheDir, { recursive: true }); stats.cacheHits = 0; stats.connectionDrops = 0; }
  let failed = false;
  const target = new URL(`${settings.baseUrl.replace(/\/+$/, "")}/chat/completions`);
  const request = target.protocol === "https:" ? httpsRequest : httpRequest;
  const digest = (text) => createHash("sha256").update(text).digest("hex");
  const accounted = new Set();
  const secrets = cacheDir ? endpointSecrets(settings.baseUrl, settings.apiKey) : [];
  const judgeFailures = new Map();
  if (validateAnswer) { stats.invalidAnswers = 0; stats.judgeFailures = []; }
  const accountUsage = (body, id) => {
    if (!trackUsage || accounted.has(id)) return;
    accounted.add(id);
    stats.usage.responses++;
    let usage;
    try { usage = JSON.parse(body).usage; } catch { /* Invalid answers still incur cost; missing usage is reported. */ }
    if (!Number.isInteger(usage?.prompt_tokens) || !Number.isInteger(usage?.completion_tokens)) stats.usage.missing++;
    else {
      stats.usage.inputTokens += usage.prompt_tokens;
      stats.usage.outputTokens += usage.completion_tokens;
      stats.usage.cachedTokens += usage.prompt_tokens_details?.cached_tokens ?? 0;
    }
  };
  const invalidDir = cacheDir && join(cacheDir, "invalid");
  const failureDir = cacheDir && join(cacheDir, "failures");
  if (cacheDir && validateAnswer) {
    for (const dir of [invalidDir, failureDir]) mkdirSync(dir, { recursive: true });
    for (const name of readdirSync(invalidDir)) {
      const saved = JSON.parse(readFileSync(join(invalidDir, name), "utf8"));
      accountUsage(saved.body, `invalid:${name}`);
      stats.invalidAnswers++;
    }
    // Failure records are history, not reusable verdicts. A later run may
    // ask a failed item again; only this run's retries share its failure.
  }
  // Buffer a whole response so a dropped body cannot become a cached verdict.
  // Only calibration opts in; other boards retain their original fail-fast relay.
  const completion = (body) => new Promise((resolve, reject) => {
    const upstream = request(target, { method: "POST", headers: { "content-type": "application/json", [settings.authHeader]: settings.apiKey } }, (response) => {
      const status = response.statusCode;
      stats.upstreamStatuses[status] = (stats.upstreamStatuses[status] ?? 0) + 1;
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("error", () => reject(new Error("connection drop")));
      response.on("end", () => resolve({ status, body: Buffer.concat(chunks).toString("utf8") }));
    });
    upstream.on("error", () => reject(new Error("connection drop")));
    upstream.setTimeout(UPSTREAM_TIMEOUT_MS, () => upstream.destroy());
    upstream.end(body);
  });
  const stop = (message) => { failed = true; onFailure?.(message); };
  const cachedCompletion = async (body) => {
    const id = digest(body);
    const file = join(cacheDir, `${id}.json`);
    const failure = () => ({ status: 200, body: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ error: "Judge failed after three invalid answers" }) }, finish_reason: "stop" }] }) });
    if (judgeFailures.has(id)) return failure();
    const inspect = (text) => {
      if (leaksIn(text, secrets)) throw new Error("unsafe verdict");
      if (validateAnswer) return validateAnswer(body, text);
      const answer = JSON.parse(text);
      if (!answer.choices?.[0]?.message || answer.choices[0].finish_reason === "length") throw new Error("malformed verdict");
      return { valid: true };
    };
    const archive = (text, spec, source, cachedFile) => {
      const name = `${id}.${randomBytes(8).toString("hex")}.json`;
      const path = join(invalidDir, name);
      if (cachedFile) renameSync(cachedFile, path);
      else {
        const temporary = join(cacheDir, `${name}.tmp`);
        writeFileSync(temporary, `${JSON.stringify({ requestHash: id, responseHash: digest(text), body: text, stage: spec.stage, source })}\n`, { mode: 0o600 });
        renameSync(temporary, path);
      }
      accountUsage(text, `invalid:${name}`);
      stats.invalidAnswers++;
    };
    if (existsSync(file)) {
      const saved = JSON.parse(readFileSync(file, "utf8"));
      if (saved.requestHash !== id || saved.responseHash !== digest(saved.body) || leaksIn(saved.body, secrets)) throw new Error("invalid cached verdict");
      const spec = inspect(saved.body);
      if (spec.valid) {
        accountUsage(saved.body, id);
        stats.cacheHits++;
        return { status: 200, body: saved.body };
      }
      archive(saved.body, spec, "cache", file);
    }
    let invalid = 0;
    for (;;) {
      if (failed) return { status: 503, body: "Judge relay stopped after an upstream failure" };
      let result;
      try { result = await completion(body); }
      catch {
        stats.connectionDrops++;
        if (!failed && stats.connectionDrops <= maxConnectionDrops) continue;
        if (!failed) stop(`judge relay: upstream connection failed; stopped after ${stats.connectionDrops} drops`);
        return { status: 502, body: "Judge relay: upstream connection failed" };
      }
      if (result.status >= 400) {
        if (onFailure) stop(`judge relay: upstream returned ${result.status}; stopped`);
        return { status: result.status, body: "Judge relay: upstream request failed" };
      }
      const spec = inspect(result.body);
      if (!spec.valid) {
        archive(result.body, spec, "upstream");
        if (++invalid < 3) continue;
        const saved = { requestHash: id, stage: spec.stage, reviews: spec.reviews, attempts: invalid };
        judgeFailures.set(id, saved);
        stats.judgeFailures = [...judgeFailures.values()];
        writeFileSync(join(failureDir, `${id}.json`), `${JSON.stringify(saved)}\n`, { mode: 0o600 });
        return failure();
      }
      const temporary = `${file}.${randomBytes(8).toString("hex")}.tmp`;
      writeFileSync(temporary, `${JSON.stringify({ requestHash: id, responseHash: digest(result.body), body: result.body })}\n`, { mode: 0o600 });
      renameSync(temporary, file);
      accountUsage(result.body, id);
      return result;
    }
  };
  const inFlight = new Map();
  const server = createServer(async (req, res) => {
    // Only the evaluator holds the placeholder; any other caller is refused before anything is forwarded.
    const given = Buffer.from(req.headers.authorization ?? "");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      res.writeHead(401).end();
      return;
    }
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      res.writeHead(404).end();
      return;
    }
    if (failed) { res.writeHead(503).end("Judge relay stopped after an upstream failure"); return; }
    stats.requests++;
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const adapted = adaptParameters(Buffer.concat(chunks).toString("utf8"));
      stats.stripped += adapted.changes.chat_template_kwargs;
      for (const [name, count] of Object.entries(adapted.changes)) stats.parameterChanges[name] += count;
      if (cacheDir) {
        const id = digest(adapted.body);
        if (!inFlight.has(id)) inFlight.set(id, cachedCompletion(adapted.body));
        let result;
        try { result = await inFlight.get(id); } finally { inFlight.delete(id); }
        res.writeHead(result.status, { "content-type": "application/json" }).end(result.body);
        return;
      }
      const upstream = request(target, {
        method: "POST",
        headers: { "content-type": "application/json", [settings.authHeader]: settings.apiKey },
      }, (response) => {
        const status = response.statusCode;
        stats.upstreamStatuses[status] = (stats.upstreamStatuses[status] ?? 0) + 1;
        if (onFailure && status >= 400) {
          failed = true;
          response.resume();
          res.writeHead(status).end("Judge relay: upstream request failed");
          onFailure(`judge relay: upstream returned ${status}; stopped`);
          return;
        }
        if (trackUsage) {
          const chunks = [];
          response.on("data", (chunk) => chunks.push(chunk));
          response.on("end", () => {
            stats.usage.responses++;
            let usage;
            try { usage = JSON.parse(Buffer.concat(chunks).toString("utf8")).usage; } catch { /* Missing usage is a refusal when cost is read. */ }
            if (!Number.isInteger(usage?.prompt_tokens) || !Number.isInteger(usage?.completion_tokens)) stats.usage.missing++;
            else {
              stats.usage.inputTokens += usage.prompt_tokens;
              stats.usage.outputTokens += usage.completion_tokens;
              stats.usage.cachedTokens += usage.prompt_tokens_details?.cached_tokens ?? 0;
            }
          });
        }
        res.writeHead(status, response.headers);
        response.on("error", () => res.destroy());
        response.pipe(res);
      });
      // Never surface a transport error, which can name the real endpoint.
      upstream.on("error", () => {
        if (onFailure) { failed = true; onFailure("judge relay: upstream connection failed; stopped"); }
        if (!res.headersSent) res.writeHead(502).end("AACR judge relay: upstream connection failed");
        else res.destroy();
      });
      res.on("close", () => upstream.destroy());
      upstream.end(adapted.body);
    } catch {
      if (cacheDir) { stop("judge relay: invalid request or cached verdict; stopped"); res.writeHead(502).end("Judge relay stopped"); return; }
      res.writeHead(400).end("AACR judge relay: invalid request body");
    }
  });
  await new Promise((up, fail) => {
    server.once("error", () => fail(new Error("AACR judge relay: cannot bind on 127.0.0.1; stopped before round 1")));
    server.listen(0, "127.0.0.1", up);
  });
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    apiKey,
    counts: () => ({ ...stats, ...(trackUsage ? { usage: { ...stats.usage } } : {}), parameterChanges: { ...stats.parameterChanges }, upstreamStatuses: { ...stats.upstreamStatuses } }),
    close: () => new Promise((down) => {
      server.close(down);
      server.closeAllConnections();
    }),
  };
}

/** Check the judge through the same route before starting any evaluation. */
export async function checkRelay(relay, model) {
  const response = await fetch(`${relay.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${relay.apiKey}` },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "Reply yes." }], temperature: 0.7, max_tokens: 40000, top_p: 0.95, chat_template_kwargs: { enable_thinking: false } }),
  });
  const body = await response.text();
  if (!response.ok) {
    let message = null;
    try {
      const error = JSON.parse(body);
      message = error.error?.message ?? error.message;
    } catch {
      // A non-JSON response supplies no upstream message.
    }
    const detail = typeof message === "string" ? `: ${message}` : "";
    throw new Error(`AACR judge relay: upstream returned ${response.status} on the first call${detail}; stopped before round 1`);
  }
}
