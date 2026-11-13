// Only the relay child loads model settings. Its parent receives loopback
// credentials and safe counters over IPC, never the upstream key or URL.
// Failure cases: benchmark/test/calibration-failures.md and aacr-board.test.mjs.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startRelay, checkRelay } from "./aacr-relay.mjs";
import { hash } from "./calibration.mjs";

const itemKey = (stage, text) => hash(`${stage}\0${text}`);
const numbered = (texts) => texts.map((text, i) => `${i}. ${text}`).join("\n");

// Match each request to its input review without storing prompts or guessing
// candidate counts from numbers that may occur inside a comment's text.
export function martianItems(data, candidates) {
  const items = {};
  const add = (stage, text, review, n) => {
    const key = itemKey(stage, text);
    items[key] ??= { stage, reviews: [], ...(n === undefined ? {} : { n }) };
    if (!items[key].reviews.includes(review)) items[key].reviews.push(review);
  };
  for (const [url, entry] of Object.entries(data)) {
    for (const review of entry.reviews) {
      add("extract", review.review_comments.filter((c) => c.body).map((c) => c.body).join("\n\n---\n\n"), url);
      const extracted = candidates[url]?.[review.tool];
      const texts = extracted ? extracted.filter((c) => c.text).map((c) => c.text) : review.review_comments.filter((c) => c.body).map((c) => c.body);
      if (extracted) add("dedup", numbered(texts), url, texts.length);
      for (const golden of entry.golden_comments) for (const text of texts) add("judge", JSON.stringify([golden.comment, text]), url);
    }
  }
  return items;
}

export function startCalibrationRelay(settings, { items = {}, ...options } = {}) {
  const validateAnswer = (body, text) => {
    const request = JSON.parse(body);
    const system = request.messages.find((m) => m.role === "system")?.content;
    const prompt = request.messages.find((m) => m.role === "user")?.content;
    // The connection probe asks for plain text and is not a pipeline item.
    if (!system && prompt === "Reply yes.") return { valid: true };
    let stage; let subject;
    if (system === "You extract code review issues from comments. Always respond with valid JSON.") {
      stage = "extract"; subject = prompt.slice(prompt.indexOf("Code Review Comment:\n") + 21, prompt.lastIndexOf("\n\nInstructions:"));
    } else if (system === "You group duplicate code review comments. Always respond with valid JSON only.") {
      stage = "dedup"; subject = prompt.slice(prompt.indexOf("Candidates:\n") + 12, prompt.lastIndexOf("\n\nReturn ONLY"));
    } else if (system === "You are a precise code review evaluator. Always respond with valid JSON.") {
      stage = "judge";
      const start = "Golden Comment (the issue we're looking for):\n";
      const middle = "\n\nCandidate Issue (from the tool's review):\n";
      const at = prompt.indexOf(middle);
      subject = JSON.stringify([prompt.slice(prompt.indexOf(start) + start.length, at), prompt.slice(at + middle.length, prompt.lastIndexOf("\n\nInstructions:"))]);
    } else throw new Error("unrecognized calibration stage");
    const spec = (typeof items === "function" ? items() : items)[itemKey(stage, subject)];
    if (!spec) throw new Error("calibration request differs from the stage inputs");
    let valid = false;
    try {
      const envelope = JSON.parse(text);
      const choice = envelope.choices[0];
      let content = choice.message.content.trim();
      if (content.startsWith("```")) content = content.split("```")[1].replace(/^json/, "").trim();
      const value = JSON.parse(content);
      if (value && typeof value === "object" && !Array.isArray(value) && !value.error && choice.finish_reason !== "length") {
        if (stage === "extract") valid = Array.isArray(value.issues) && value.issues.every((s) => typeof s === "string");
        else if (stage === "judge") valid = typeof value.match === "boolean" && typeof value.confidence === "number" && Number.isFinite(value.confidence) && value.confidence >= 0 && value.confidence <= 1;
        else if (Array.isArray(value.groups) && value.groups.every(Array.isArray)) {
          const indices = value.groups.flat();
          valid = indices.length === spec.n && new Set(indices).size === spec.n && indices.every((i) => Number.isInteger(i) && i >= 0 && i < spec.n);
        }
      }
    } catch { /* The invalid text is archived by the cache owner, never cached. */ }
    return { ...spec, valid };
  };
  return startRelay(settings, { ...options, validateAnswer });
}

export async function relayClient({ cacheDir } = {}) {
  const child = spawn("/bin/sh", ["-c", 'ulimit -c 0 && exec "$0" "$@"', process.execPath, fileURLToPath(import.meta.url), "--serve", ...(cacheDir ? [cacheDir] : [])], { stdio: ["ignore", "ignore", "ignore", "ipc"], env: process.env });
  const controller = new AbortController();
  let next = 0;
  const pending = new Map();
  const ready = await new Promise((resolve, reject) => {
    child.on("error", () => reject(new Error("judge relay: could not start child")));
    child.on("exit", (code) => { const error = new Error(`judge relay: child exited ${code}`); reject(error); for (const p of pending.values()) p.reject(error); });
    child.on("message", (m) => {
      if (m.error) {
        const error = new Error(m.error); controller.abort(error); reject(error);
        for (const p of pending.values()) p.reject(error);
      } else if (m.ready) resolve(m);
      else if (pending.has(m.id)) { pending.get(m.id).resolve(m.counts); pending.delete(m.id); }
    });
  });
  return {
    model: ready.model, settings: { baseUrl: ready.baseUrl, apiKey: ready.apiKey, authHeader: "authorization" }, signal: controller.signal,
    async complete(prompt, request) {
      controller.signal.throwIfAborted();
      const response = await fetch(`${ready.baseUrl}/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${ready.apiKey}` }, body: JSON.stringify({ model: ready.model, messages: [{ role: "system", content: prompt }, { role: "user", content: JSON.stringify(request) }], response_format: { type: "json_object" }, max_completion_tokens: 1000 }), signal: controller.signal });
      if (!response.ok) throw new Error(`judge relay: upstream returned ${response.status}; stopped`);
      const answer = await response.json();
      try { return JSON.parse(answer.choices[0].message.content); } catch { throw new Error("malformed judge verdict"); }
    },
    counts: () => new Promise((resolve, reject) => { const id = ++next; pending.set(id, { resolve, reject }); child.send({ id, op: "counts" }); }),
    setItems: (items) => new Promise((resolve, reject) => { const id = ++next; pending.set(id, { resolve, reject }); child.send({ id, op: "items", items }); }),
    close: () => new Promise((resolve) => { if (child.exitCode !== null) resolve(); else { child.once("exit", resolve); child.send({ op: "close" }); } }),
  };
}

async function serve() {
  const { loadModelEnv, probedDeployment, endpointSecrets } = await import("./model-env.mjs");
  const { redactor } = await import("./board-files.mjs");
  const settings = loadModelEnv();
  const model = probedDeployment("gpt-5.2").id;
  const safeError = (error) => {
    let safe = ""; const filter = redactor(endpointSecrets(settings.baseUrl, settings.apiKey), (s) => { safe += s; });
    filter.write(error.message); filter.end(); process.send({ error: safe });
  };
  const cacheDir = process.argv[3];
  let items = {};
  const relay = await (cacheDir ? startCalibrationRelay : startRelay)(settings, { trackUsage: true, ...(cacheDir ? { cacheDir, maxConnectionDrops: 3, items: () => items } : {}), onFailure: (error) => process.send({ error }) });
  process.on("disconnect", () => { relay.close().finally(() => process.exit()); });
  process.on("message", async (m) => {
    if (m.op === "counts") process.send({ id: m.id, counts: relay.counts() });
    else if (m.op === "items") { items = m.items; process.send({ id: m.id }); }
    else if (m.op === "close") { await relay.close(); process.exit(); }
  });
  try { await checkRelay(relay, model); } catch (error) { safeError(error); await relay.close(); process.exit(2); }
  process.send({ ready: true, model, baseUrl: relay.baseUrl, apiKey: relay.apiKey });
}
if (process.argv[2] === "--serve" && process.send) serve().catch((error) => { process.send({ error: error.message }); process.exit(2); });
