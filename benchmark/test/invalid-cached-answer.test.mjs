// Failure cases 20 to 23 in calibration-failures.md, written before the fix.
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { martianItems, startCalibrationRelay } from "../lib/calibration-relay.mjs";

const captured = JSON.parse(readFileSync(new URL("./fixtures/martian/invalid-dedup-answer.json", import.meta.url)));
const folders = [];
afterAll(() => { for (const folder of folders) rmSync(folder, { recursive: true, force: true }); });
const digest = (s) => createHash("sha256").update(s).digest("hex");
const answer = (content) => JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 3 } });
const texts = Array.from({ length: captured.candidates }, (_, i) => `issue ${i}`);
const numbered = texts.map((text, i) => `${i}. ${text}`).join("\n");
const data = { review: { golden_comments: [{ comment: "golden" }], reviews: [{ tool: "augment", review_comments: [{ body: "comment" }] }] } };
const items = martianItems(data, { review: { augment: texts.map((text) => ({ text })) } });
const request = (system, prompt) => JSON.stringify({ model: "judge", messages: [{ role: "system", content: system }, { role: "user", content: prompt }] });
const dedup = request("You group duplicate code review comments. Always respond with valid JSON only.", `Candidates:\n${numbered}\n\nReturn ONLY a JSON object`);
const valid = JSON.stringify({ groups: texts.map((_, i) => [i]) });

async function setup(handle, cacheDir = mkdtempSync(join(tmpdir(), "oq-invalid-answer-"))) {
  folders.push(cacheDir);
  const server = createServer(handle);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const settings = { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "test-only", authHeader: "api-key" };
  const relay = await startCalibrationRelay(settings, { cacheDir, items, trackUsage: true, maxConnectionDrops: 3 });
  return { relay, settings, cacheDir, close: async () => { await relay.close(); await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }); } };
}
async function ask(relay, body = dedup) {
  const res = await fetch(`${relay.baseUrl}/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${relay.apiKey}` }, body });
  expect(res.status).toBe(200);
  return res.json();
}

it("an invalid cached answer is not replayed; a fresh ask follows", async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), "oq-invalid-cached-"));
  const bad = answer(captured.content);
  writeFileSync(join(cacheDir, `${digest(dedup)}.json`), JSON.stringify({ requestHash: digest(dedup), responseHash: digest(bad), body: bad }));
  let calls = 0;
  const run = await setup((_, res) => { calls++; res.end(answer(valid)); }, cacheDir);
  try {
    expect((await ask(run.relay)).choices[0].message.content).toBe(valid);
    expect(calls).toBe(1);
    const archives = readdirSync(join(cacheDir, "invalid"));
    expect(archives).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(cacheDir, "invalid", archives[0]))).body).toBe(bad);
    await run.relay.close();
    run.relay = await startCalibrationRelay(run.settings, { cacheDir, items, trackUsage: true });
    expect((await ask(run.relay)).choices[0].message.content).toBe(valid);
    expect(calls).toBe(1);
    expect(run.relay.counts()).toMatchObject({ cacheHits: 1, invalidAnswers: 1, judgeFailures: [], usage: { responses: 2, inputTokens: 24, outputTokens: 6 } });
  } finally { await run.relay.close(); await run.close(); }
});

it("records three invalid answers as one judge failure, preserves usage, and continues with the next item", async () => {
  let calls = 0;
  const run = await setup((_, res) => { calls++; res.end(answer(calls <= 3 ? captured.content : valid)); });
  try {
    expect(JSON.parse((await ask(run.relay)).choices[0].message.content)).toHaveProperty("error");
    expect(calls).toBe(3);
    await ask(run.relay);
    expect(calls).toBe(3);
    expect(readdirSync(run.cacheDir).filter((f) => f.endsWith(".json"))).toHaveLength(0);
    expect(readdirSync(join(run.cacheDir, "invalid"))).toHaveLength(3);
    expect(run.relay.counts()).toMatchObject({ invalidAnswers: 3, judgeFailures: [{ stage: "dedup", reviews: ["review"], attempts: 3 }], usage: { responses: 3, inputTokens: 36, outputTokens: 9 } });
    expect((await ask(run.relay, dedup.replace('"judge"', '"next-model"'))).choices[0].message.content).toBe(valid);
    expect(calls).toBe(4);
    await run.relay.close();
    run.relay = await startCalibrationRelay(run.settings, { cacheDir: run.cacheDir, items, trackUsage: true });
    expect((await ask(run.relay)).choices[0].message.content).toBe(valid);
    expect(calls).toBe(5);
    expect(run.relay.counts().judgeFailures).toEqual([]);
  } finally { await run.relay.close(); await run.close(); }
});

it("maps raw candidates after failed extraction so later items can still be judged", async () => {
  const run = await setup((_, res) => res.end(answer('{"match":false,"confidence":0.8}')));
  await run.relay.close();
  run.relay = await startCalibrationRelay(run.settings, { cacheDir: run.cacheDir, items: martianItems(data, {}), trackUsage: true });
  try {
    const body = request("You are a precise code review evaluator. Always respond with valid JSON.", "Golden Comment (the issue we're looking for):\ngolden\n\nCandidate Issue (from the tool's review):\ncomment\n\nInstructions:\nmatch");
    expect(JSON.parse((await ask(run.relay, body)).choices[0].message.content).match).toBe(false);
  } finally { await run.relay.close(); await run.close(); }
});

it.each([
  ["unparseable JSON", dedup, "not JSON", valid],
  ["missing dedup index", dedup, '{"groups":[[0],[1],[2],[3],[4],[5]]}', valid],
  ["noninteger dedup index", dedup, '{"groups":[[0],[1],[2],[3],[4],[5],["6"]]}', valid],
  ["wrong extraction shape", request("You extract code review issues from comments. Always respond with valid JSON.", "Code Review Comment:\ncomment\n\nInstructions:\nextract"), '{"issues":"one"}', '{"issues":["one"]}'],
  ["wrong match shape", request("You are a precise code review evaluator. Always respond with valid JSON.", "Golden Comment (the issue we're looking for):\ngolden\n\nCandidate Issue (from the tool's review):\nissue 0\n\nInstructions:\nmatch"), '{"match":"false","confidence":1}', '{"match":false,"confidence":0.8}'],
])("retries %s before caching", async (_, body, bad, good) => {
  let calls = 0;
  const run = await setup((_, res) => res.end(answer(++calls === 1 ? bad : good)));
  try {
    expect((await ask(run.relay, body)).choices[0].message.content).toBe(good);
    await ask(run.relay, body);
    expect(calls).toBe(2);
    expect(run.relay.counts()).toMatchObject({ invalidAnswers: 1, cacheHits: 1, judgeFailures: [], usage: { responses: 2 } });
  } finally { await run.close(); }
});
