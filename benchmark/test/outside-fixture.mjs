import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readAacrOutside, toolName } from "../lib/aacr-board.mjs";
import { tempDir } from "../../tests/temp-dirs.mjs";

export function aacrOutside(config, { generated = 5, expected = 4, matched = 2, semanticMatched = matched, mode = "mock" } = {}) {
  const folder = tempDir("oq-aacr-block-");
  const write = (file, value) => { const path = join(folder, "outside/aacr", file); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value)); };
  write("convert.json", { reader: "ocr", lineK: null, references: {}, withoutLine: [], folders: [{ config, repeat: 1, tool: toolName(config, 1), dir: `${config}/r1`, files: 1 }] });
  write("eval.json", { folders: [{ config, repeat: 1, mode, judgeErrors: 0, metrics: ["metrics_ocr_fixture.json"] }] });
  write(`${config}/r1/metrics_ocr_fixture.json`, { summary: { evaluated_instances: 1, missing_instances: 0, expected_notes: expected, generated_notes: generated, matched_line_notes: matched, matched_semantic_notes: semanticMatched } });
  const jobs = [{ case: "fixture", config, repeat: 1, findings: Array.from({ length: generated }, (_, i) => ({ file: i < matched ? "fixture.ts" : "unmatched.ts", line: 10 * (i + 1) })) }];
  const specs = { fixture: { bugs: Array.from({ length: expected }, (_, i) => ({ file: "fixture.ts", lines: [10 * (i + 1), 10 * (i + 1)] })) } };
  return { aacr: readAacrOutside(folder, jobs, specs) };
}
