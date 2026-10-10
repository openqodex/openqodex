// The model provider stand-in for the model reviewer tests: it answers from
// a recorded submission, filled with the change id and the candidates the
// brief names, after reading every file the test names with read_file
// (following each cut until the whole file has been carried). It is the
// only stand-in: the brain, the tools, git, the scanners and the graph are
// real. Every request it gets is kept, so a test can read what the brain
// sent and how often.
import type { ModelRequest, ModelResponse, ModelReviewer, ToolCallRequest } from "../src/reviewer.js";

export type Finding = {
  severity: string;
  category: string;
  confidence: number;
  file_path: string;
  line_number: number;
  title: string;
  problem: string;
  consequence: string;
  fix: string;
  source: string | null;
  candidate: string | null;
  suggested_change?: string | null;
};

export type FixtureOptions = {
  // Files to read in full, in order, before the answer.
  reads?: string[];
  // Tool calls put in the first reply as they are, before any read.
  probes?: { name: string; args: unknown }[];
  findings?: Finding[];
  // The first answer, in place of the recorded one: forces a correction round.
  firstAnswer?: string;
  // Answers by their number (1 for the first), in place of the recorded one.
  answers?: Record<number, string>;
  // The call number (1 for the first) whose transport throws.
  throwOn?: number;
  // The model's name, in place of "fixture-model" (a second reviewer).
  model?: string;
  // Raise every candidate the brief names in a finding instead of dropping it.
  raise?: boolean;
};

export type Fixture = ModelReviewer & { requests: ModelRequest[] };

const USAGE = { model: "fixture-model", servedModel: "fixture-model-2026-10-01", outputTokens: 120, cacheReadTokens: 40, costUsd: 0.002 };

// The recorded submission, for the change and candidates the brief names:
// every candidate dropped with the same reason, or with `raise` raised in a
// finding of its own.
export function recorded(brief: string, findings: Finding[] = [], raise = false): string {
  const id = /`change_id`: `([0-9a-f]{12})`/.exec(brief)?.[1] ?? "missing";
  const lines = [...brief.matchAll(/^- (c\d+) \[([^\]]+)\] ([^:\s]+):(\d+) /gm)];
  const dropped = raise ? [] : lines.map((m) => ({ candidate: m[1], reason: "The function is internal and never exposed.", file_path: m[3], line_number: Number(m[4]) }));
  const raised: Finding[] = raise
    ? lines.map((m) => ({ severity: "major", category: "security", confidence: 0.9, file_path: m[3]!, line_number: Number(m[4]), title: "Function open to every caller", problem: "The function runs with the owner's rights.", consequence: "Any caller reads data it should not.", fix: "Revoke execute from public.", source: m[2]!, candidate: m[1]! }))
    : [];
  return JSON.stringify({ version: 2, change_id: id, summary: "Changes the sum and adds an SQL function.", findings: [...findings, ...raised], dropped });
}

export function fixtureModel(opts: FixtureOptions = {}): Fixture {
  const requests: ModelRequest[] = [];
  const queue = [...(opts.reads ?? [])].map((path) => ({ path, next: 1 }));
  let probed = false;
  let answered = 0;
  let calls = 0;
  const reply = (text: string, toolCalls: ToolCallRequest[], request: ModelRequest): ModelResponse => ({
    message: { text, toolCalls },
    usage: { ...USAGE, ...(opts.model ? { model: opts.model } : {}), inputTokens: 1000 + request.messages.length },
  });
  return {
    kind: "model",
    model: opts.model ?? "fixture-model",
    maxOutputTokens: 4096,
    requests,
    async complete(request) {
      requests.push(structuredClone(request));
      calls++;
      if (opts.throwOn === calls) throw new Error("connection reset by the provider");
      const brief = request.messages.find((m) => m.role === "user")?.text ?? "";
      const last = request.messages.at(-1);
      // A read's result moves that read on: to the line after the last one
      // carried, or to the next file once the whole file was carried.
      if (last?.role === "tool" && last.name === "read_file" && queue.length > 0) {
        const m = / lines (\d+) to (\d+) of (\d+)/.exec(last.text.split("\n")[0] ?? "");
        if (m && Number(m[2]) < Number(m[3])) queue[0]!.next = Number(m[2]) + 1;
        else queue.shift();
      }
      if (!probed && opts.probes && opts.probes.length > 0) {
        probed = true;
        return reply("", opts.probes.map((p, i) => ({ id: `probe-${i + 1}`, name: p.name, args: p.args })), request);
      }
      if (queue.length > 0) {
        const r = queue[0]!;
        return reply("", [{ id: `read-${calls}`, name: "read_file", args: r.next === 1 ? { path: r.path } : { path: r.path, start: r.next } }], request);
      }
      answered++;
      const text = opts.answers?.[answered] ?? (answered === 1 && opts.firstAnswer !== undefined ? opts.firstAnswer : recorded(brief, opts.findings, opts.raise));
      return reply(text, [], request);
    },
  };
}
