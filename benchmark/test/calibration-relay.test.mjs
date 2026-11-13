// Failure cases 15 to 19 in calibration-failures.md, written before implementation.
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, expect, it } from "vitest";
import { startRelay } from "../lib/aacr-relay.mjs";

// These tests start HTTP servers only, and close them before removing files.
const folders = [];
const tempDir = (prefix) => { const folder = mkdtempSync(join(tmpdir(), prefix)); folders.push(folder); return folder; };
afterAll(() => { for (const folder of folders) rmSync(folder, { recursive: true, force: true }); });

const answer = { choices: [{ message: { content: '{"match":true}' } }], usage: { prompt_tokens: 12, completion_tokens: 3 } };
const body = (text) => JSON.stringify({ model: "judge", messages: [{ role: "user", content: text }] });
async function provider(handle) {
  const server = createServer(handle);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { settings: { baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: "provider-secret", authHeader: "api-key" }, close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }) };
}
async function complete(relay, text) {
  return fetch(`${relay.baseUrl}/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${relay.apiKey}`, "content-type": "application/json" }, body: body(text) });
}

it("replays completed requests after restart with usage and separates changed request bytes", async () => {
  let calls = 0;
  const upstream = await provider((_, res) => { calls++; res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(answer)); });
  const cacheDir = tempDir("oq-calibration-cache-");
  let relay;
  try {
    relay = await startRelay(upstream.settings, { trackUsage: true, cacheDir, maxConnectionDrops: 3 });
    expect(await (await complete(relay, "one")).json()).toEqual(answer);
    await relay.close();
    relay = await startRelay(upstream.settings, { trackUsage: true, cacheDir, maxConnectionDrops: 3 });
    expect(await (await complete(relay, "one")).json()).toEqual(answer);
    expect(calls).toBe(1);
    expect(relay.counts()).toMatchObject({ cacheHits: 1, usage: { responses: 1, inputTokens: 12, outputTokens: 3 } });
    expect(await (await complete(relay, "changed")).json()).toEqual(answer);
    expect(calls).toBe(2);
    const files = readdirSync(cacheDir);
    expect(files).toHaveLength(2);
    for (const file of files) {
      const text = readFileSync(join(cacheDir, file), "utf8");
      expect(text).not.toContain(upstream.settings.apiKey);
      expect(text).not.toContain(upstream.settings.baseUrl);
    }
  } finally { if (relay) await relay.close(); await upstream.close(); }
});

it("retries only the failed request through three drops and stops on the fourth", async () => {
  const calls = [];
  const failures = [];
  const upstream = await provider(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const text = JSON.parse(Buffer.concat(chunks)).messages[0].content;
    calls.push(text);
    if (text === "drop") req.socket.destroy();
    else res.end(JSON.stringify(answer));
  });
  const relay = await startRelay(upstream.settings, { trackUsage: true, cacheDir: tempDir("oq-calibration-drops-"), maxConnectionDrops: 3, onFailure: (error) => failures.push(error) });
  try {
    await (await complete(relay, "done")).json();
    expect((await complete(relay, "drop")).status).toBe(502);
    expect(calls).toEqual(["done", "drop", "drop", "drop", "drop"]);
    expect(relay.counts().connectionDrops).toBe(4);
    expect(failures).toEqual(["judge relay: upstream connection failed; stopped after 4 drops"]);
    expect((await complete(relay, "later")).status).toBe(503);
    expect(calls).toHaveLength(5);
  } finally { await relay.close(); await upstream.close(); }
});

it("recovers a dropped item without repeating completed items", async () => {
  let calls = 0;
  const upstream = await provider((req, res) => { if (++calls === 1) req.socket.destroy(); else res.end(JSON.stringify(answer)); });
  const relay = await startRelay(upstream.settings, { trackUsage: true, cacheDir: tempDir("oq-calibration-retry-"), maxConnectionDrops: 3 });
  try {
    expect(await (await complete(relay, "one")).json()).toEqual(answer);
    expect(await (await complete(relay, "one")).json()).toEqual(answer);
    expect(calls).toBe(2);
    expect(relay.counts()).toMatchObject({ connectionDrops: 1, cacheHits: 1 });
  } finally { await relay.close(); await upstream.close(); }
});

it("does not retry HTTP failures or cache truncated responses", async () => {
  let calls = 0;
  const upstream = await provider((req, res) => {
    calls++;
    if (calls === 1) res.writeHead(429).end("limited");
    else if (calls === 2) { res.writeHead(200, { "content-length": 10000 }); res.write('{"choices":'); setImmediate(() => res.destroy()); }
    else res.end(JSON.stringify(answer));
  });
  const cacheDir = tempDir("oq-calibration-partial-");
  const relay = await startRelay(upstream.settings, { trackUsage: true, cacheDir, maxConnectionDrops: 3 });
  try {
    expect((await complete(relay, "limited")).status).toBe(429);
    expect(calls).toBe(1);
    expect(await (await complete(relay, "partial")).json()).toEqual(answer);
    expect(calls).toBe(3);
    expect(readdirSync(cacheDir)).toHaveLength(1);
    expect(relay.counts().usage.responses).toBe(1);
  } finally { await relay.close(); await upstream.close(); }
});
