#!/usr/bin/env node
// The model configuration's review (RB_CONFIG_REVIEWER=model): the library's
// reviewChange in the server profile (docs/library.md), the path the
// benchmark calls model-gpt-6.1-sol, with the model reached over an
// OpenAI-compatible Responses API and a bearer key. entry.mjs starts it as
// the review's user in place of `openqodex review`, and reads the two files
// it writes, report.json and usage.json, as it reads the command's.
//
//   node model-review.mjs --lib <openqodex dist/lib.js> --clone <dir>
//     --base <sha> --head <sha> --report-dir <dir> --work-dir <dir>
//     --model <id> --base-url <url> --timeout <s>
//   OPENROUTER_API_KEY   the key, sent as `Authorization: Bearer`. It is read
//                        once and removed from the environment before the
//                        review starts, so no scanner process inherits it.
//
// The library sends nothing itself: a host hands it a model reviewer
// (`{ kind: "model", model, maxOutputTokens, complete }`). This one maps the
// library's messages to the Responses API as benchmark/lib/openai-reviewer.mjs
// does, which the image cannot import (its build context is
// benchmark/outside), and which refuses any model boards.json does not record.
//
// Exit 0 complete, 1 complete with a blocking finding, 2 incomplete (each
// with both files written); 3 the review threw, with no file written.
// Every line it prints has the key replaced.
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

/** Output tokens one call may use, as the benchmark's model runs give it. */
export const MAX_OUTPUT_TOKENS = 32000;

const count = (v) => (Number.isInteger(v) && v >= 0 ? v : null);

/**
 * A model reviewer over the Responses API at `baseUrl` with a bearer key:
 * one fetch per call, no retry, no redirect followed. The model id is sent
 * as given. Every thrown message has the key replaced.
 */
export function createBearerReviewer({ model, baseUrl, apiKey, maxOutputTokens = MAX_OUTPUT_TOKENS }) {
  const url = `${baseUrl.replace(/\/+$/, "")}/responses`;
  const headers = { "content-type": "application/json", authorization: `Bearer ${apiKey}` };
  const scrub = scrubber(apiKey);
  const fail = (message) => new Error(scrub(message).split("\n")[0].slice(0, 500));
  return {
    kind: "model",
    model,
    maxOutputTokens,
    async complete(request) {
      let response;
      try {
        response = await fetch(url, { method: "POST", headers, body: JSON.stringify(requestBody(model, request)), redirect: "error" });
      } catch (error) {
        throw fail(`the request to the model API failed: ${error?.cause?.code ?? error?.cause?.message ?? error?.message ?? String(error)}`);
      }
      const text = await response.text().catch(() => "");
      if (!response.ok) {
        let detail = text;
        try {
          const message = JSON.parse(text)?.error?.message;
          if (typeof message === "string") detail = message;
        } catch {
          // not JSON: the text as it came
        }
        throw fail(`HTTP ${response.status}: ${detail}`);
      }
      let answer;
      try {
        answer = JSON.parse(text);
      } catch {
        throw fail("the model API's answer is not JSON");
      }
      if (answer?.status === "failed") throw fail(`the model API answered status failed: ${answer?.error?.code ?? ""} ${answer?.error?.message ?? ""}`);
      const u = answer?.usage;
      const input = count(u?.input_tokens);
      const output = count(u?.output_tokens);
      if (input === null || output === null) throw fail("the model API's answer has no usage");
      if (!Array.isArray(answer.output)) throw fail("the model API's answer has no output");
      return {
        message: readOutput(answer.output),
        usage: {
          model,
          ...(typeof answer.model === "string" && answer.model !== "" ? { servedModel: answer.model } : {}),
          inputTokens: input,
          outputTokens: output,
          cacheReadTokens: Math.min(count(u?.input_tokens_details?.cached_tokens) ?? 0, input),
          // The cost the provider reported for this call, when it reported one.
          ...(typeof u?.cost === "number" && Number.isFinite(u.cost) && u.cost >= 0 ? { costUsd: u.cost } : {}),
        },
      };
    },
  };
}

// Replaces the key, as given and as a header sends it, in any text. An
// empty key replaces nothing.
function scrubber(apiKey) {
  const secrets = [...new Set([apiKey, apiKey.trim()])].filter((s) => s !== "");
  return (text) => secrets.reduce((t, s) => t.split(s).join("[hidden]"), String(text));
}

// The library's request as a Responses API request: system messages become
// the instructions, the rest input items in order (benchmark/lib/openai-reviewer.mjs).
function requestBody(model, request) {
  const system = [];
  const input = [];
  for (const m of request.messages) {
    if (m.role === "system") system.push(m.text);
    else if (m.role === "user") input.push({ type: "message", role: "user", content: m.text });
    else if (m.role === "assistant") {
      if (m.text !== "") input.push({ type: "message", role: "assistant", content: m.text });
      for (const call of m.toolCalls) input.push({ type: "function_call", call_id: call.id, name: call.name, arguments: typeof call.args === "string" ? call.args : JSON.stringify(call.args) });
    } else if (m.role === "tool") input.push({ type: "function_call_output", call_id: m.toolCallId, output: m.text });
  }
  return {
    model,
    ...(system.length > 0 ? { instructions: system.join("\n\n") } : {}),
    input,
    // strict false: a strict schema must require every property, and the
    // brain's tools have optional ones.
    ...(request.tools.length > 0 ? { tools: request.tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters, strict: false })) } : {}),
    max_output_tokens: request.maxOutputTokens,
    store: false,
  };
}

// The answer's text and function calls, as the library's message.
function readOutput(items) {
  let text = "";
  const toolCalls = [];
  for (const item of items) {
    if (item?.type === "message" && Array.isArray(item.content)) {
      for (const part of item.content) {
        if (part?.type === "output_text" && typeof part.text === "string") text += part.text;
        else if (part?.type === "refusal" && typeof part.refusal === "string") text += part.refusal;
      }
    } else if (item?.type === "function_call") {
      let args = item.arguments;
      try {
        args = JSON.parse(item.arguments);
      } catch {
        // kept as the model's text; the brain's tools refuse it with a reason
      }
      toolCalls.push({ id: item.call_id, name: item.name, args });
    }
  }
  return { text, toolCalls };
}

const EXIT = { complete: 0, complete_blocking: 1, incomplete: 2 };

async function main() {
  const { values: o } = parseArgs({
    options: Object.fromEntries(["lib", "clone", "base", "head", "report-dir", "work-dir", "model", "base-url", "timeout"].map((k) => [k, { type: "string" }])),
  });
  const apiKey = process.env.OPENROUTER_API_KEY ?? "";
  delete process.env.OPENROUTER_API_KEY;
  const scrub = scrubber(apiKey);
  try {
    if (apiKey.trim() === "") throw new Error("OPENROUTER_API_KEY is not set");
    const { reviewChange } = await import(pathToFileURL(resolve(o.lib)).href);
    const reviewer = createBearerReviewer({ model: o.model, baseUrl: o["base-url"], apiKey });
    mkdirSync(o["work-dir"], { recursive: true });
    const result = await reviewChange(
      { clonePath: o.clone, mergeBaseSha: o.base, headSha: o.head },
      reviewer,
      {
        profile: "server",
        workDir: o["work-dir"],
        installRoot: join(process.env.OPENQODEX_HOME || join(homedir(), ".openqodex"), "tools"),
        budget: { authorize: () => true, deadlineMs: Number(o.timeout) * 1000 },
        tools: { web: false, shell: false },
        scanners: "preinstalled",
        onProgress: (line) => process.stderr.write(`${scrub(line)}\n`),
      },
    );
    writeFileSync(join(o["report-dir"], "report.json"), result.render.json());
    writeFileSync(join(o["report-dir"], "usage.json"), `${JSON.stringify(result.usage, null, 2)}\n`);
    return EXIT[result.status] ?? 2;
  } catch (error) {
    process.stderr.write(`openqodex-reviewbench: the model review threw: ${scrub(error instanceof Error ? error.message : error).split("\n")[0]}\n`);
    return 3;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
