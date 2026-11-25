// 1. Heading suffixes lose hunk ids in either model provider fixture.
// 2. A finder misses an edge plant or raises it without both received halves.
// 3. A verifier confirms a plant without receiving both lines in its Read.
// 5. An omitted context placeholder is mistaken for delivered code.
// 4. Numbered prose after a page is mistaken for another delivered row.
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { tempDir, removeTempDirs } from "../../../tests/temp-dirs.mjs";
import { stagedAnswer } from "./staged-fake.js";

afterAll(removeTempDirs);
const root = join(import.meta.dirname, "../../..");
const find = "# OpenQodex review brief: find pass\nUnit: u1\nPass: local\n`change_id`: `aaaaaaaaaaaa`\n### h1 big.ts 1-2 (custom suffix) (old lines 1-2)\n";
function runPlant(prompt: string, plant: string, text = "first half\nsecond half\n") {
  const dir = tempDir("oq-provider-");
  const provider = join(dir, "provider");
  const snapshot = join(dir, "snapshot");
  mkdirSync(provider);
  mkdirSync(join(snapshot, "app"), { recursive: true });
  writeFileSync(join(snapshot, "app/server.py"), "safe\n");
  writeFileSync(join(snapshot, "big.ts"), text);
  for (const name of ["claude.cjs", "submission.json", "find-answers.json"]) cpSync(join(root, "tests/golden/stand-ins", name), join(provider, name));
  const result = spawnSync(process.execPath, [join(provider, "claude.cjs")], { cwd: snapshot, encoding: "utf8", env: { ...process.env, OPENQODEX_STANDIN_PLANT: plant }, input: JSON.stringify({ message: { content: prompt } }) + "\n" });
  expect(result.status, result.stderr).toBe(0);
  const events = result.stdout.trim().split("\n").map((row) => JSON.parse(row));
  return { answer: JSON.parse(events.find((e) => e.type === "result").result), events };
}
it.each(["staged fake", "convention provider"])("keeps hunk ids after arbitrary parenthesised heading suffixes in the %s", (provider) => {
  if (provider === "staged fake") {
    const fixed = JSON.stringify({ version: 2, change_id: "aaaaaaaaaaaa", summary: "Checked.", findings: [], dropped: [] });
    expect(JSON.parse(stagedAnswer(find, fixed, () => "")).examined).toEqual(["h1"]);
  } else {
    const result = spawnSync(process.execPath, [join(root, "tests/e2e/fixtures/convention-provider.cjs")], { encoding: "utf8", input: JSON.stringify({ message: { content: find } }) + "\n" });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(JSON.parse(result.stdout.trim().split("\n").at(-1)!).result).examined).toEqual(["h1"]);
  }
});

it.each(["first half", "second half"])("reads the missing half before raising an edge plant from %s", (half) => {
  const line = half === "first half" ? 1 : 2;
  const prompt = find + `\n@@ -0,0 +${line} @@\n+${half}\n`;
  const { answer, events } = runPlant(prompt, "big.ts:1-2:Boundary defect");
  expect(answer.candidates.map((c: { title: string }) => c.title)).toEqual(["Boundary defect"]);
  const read = events.find((e) => e.type === "assistant" && e.message.content.some((c: { id?: string }) => c.id === "boundary-read"));
  expect(read?.message.content[0].input).toMatchObject({ offset: 1, limit: 3 });
});
it("does not raise an edge plant when its Read returns only the already received half", () => {
  const prompt = find + "\n@@ -0,0 +1 @@\n+first half\n";
  expect(runPlant(prompt, "big.ts:1-2:Boundary defect", "first half\n").answer.candidates).toEqual([]);
});
it("does not read a plant when its part received neither half", () => {
  const { answer, events } = runPlant(find, "big.ts:1-2:Boundary defect");
  expect(answer.candidates).toEqual([]);
  expect(events.some((e) => e.type === "assistant" && e.message.content.some((c: { id?: string }) => c.id === "boundary-read"))).toBe(false);
});
it.each([50, 51])("reads a paged plant only within 50 lines of its part edge: %s", (distance) => {
  const prompt = find.replace("1-2 (", "1-200 (") + `\nbig.ts lines ${200 - distance} to ${200 - distance} (with context ${200 - distance} to ${200 - distance}):\n${200 - distance}\tfirst half\n`;
  const text = Array.from({ length: 202 }, (_, i) => i === 199 - distance ? "first half" : i === 200 - distance ? "second half" : "safe").join("\n") + "\n";
  const { answer, events } = runPlant(prompt, `big.ts:${200 - distance}-${201 - distance}:Boundary defect`, text);
  expect(answer.candidates.map((c: { title: string }) => c.title)).toEqual(distance === 50 ? ["Boundary defect"] : []);
  expect(events.some((e) => e.type === "assistant" && e.message.content.some((c: { id?: string }) => c.id === "boundary-read"))).toBe(distance === 50);
});
it("raises a two-line plant only after both halves reached the finder", () => {
  const prompt = find + "\n@@ -0,0 +1,2 @@\n+first half\n+second half\n";
  expect(runPlant(prompt, "big.ts:1-2:Boundary defect").answer.candidates.map((c: { title: string }) => c.title)).toEqual(["Boundary defect"]);
});
it.each([true, false])("confirms a boundary candidate only when its Read returns both halves: %s", (both) => {
  const prompt = "# OpenQodex review brief: verify pass\n`change_id`: `aaaaaaaaaaaa`\n### h1 big.ts 1-1\n### h2 big.ts 2-2\n## Candidates to verify\n### c1 (scanner)\n- Location: big.ts:1\n- Title: Boundary defect\n- Category: bug\n## How to verify\n";
  const { answer, events } = runPlant(prompt, "big.ts:1-2:Boundary defect", both ? "first half\nsecond half\n" : "first half\n");
  expect(answer.verdicts[0].verdict).toBe(both ? "confirmed" : "refuted");
  expect(events.some((e) => e.type === "user" && e.message.content.some((c: { tool_use_id?: string }) => c.tool_use_id === "boundary-read"))).toBe(true);
});
it("does not credit numbered prose after the first non-page row", () => {
  const prompt = find + "\nbig.ts lines 1 to 1 (with context 1 to 1):\n1\tfirst half\nEnd of page.\n2\tsecond half\n";
  expect(runPlant(prompt, "big.ts:2:Prose defect").answer.candidates).toEqual([]);
});

it("does not remember an omitted context row as planted code", () => {
  const prompt = find + "\nbig.ts lines 1 to 1 (with context 1 to 2):\n1\tfirst half\n2\t(not shown: a context line over 200 KB)\n";
  expect(runPlant(prompt, "big.ts:2:Omitted context defect").answer.candidates).toEqual([]);
});
