// Failure cases: a form overwrites the plain record or changes the wrong comment boundaries.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, it } from "vitest";
import { calibrationPaths, casesInForm, main, writeCalibration } from "../outside/calibrate.mjs";
import { judgeGreptile } from "../outside/boards/greptile-judge.mjs";

const folders = [];
const tempDir = () => { const folder = mkdtempSync(join(tmpdir(), "oq-calibration-form-")); folders.push(folder); return folder; };
afterAll(() => { for (const folder of folders) rmSync(folder, { recursive: true, force: true }); });
const startedAt = "2026-10-24T12:34:56.789Z";
const date = new Intl.DateTimeFormat("en-CA").format(new Date(startedAt));

it("a form variant writes under its own name and never replaces the plain record", () => {
  const root = tempDir();
  const plain = calibrationPaths("greptile", startedAt, { root });
  expect(plain.output).toBe(join(root, "index/calibration", `greptile-${date}.json`));
  expect(plain.run).toBe(join(root, "results/calibration-greptile-2026-10-24T12-34-56-789Z"));
  mkdirSync(join(root, "index/calibration"), { recursive: true });
  const bytes = '{"status":"complete","plain":"unchanged"}\n';
  writeFileSync(plain.output, bytes);
  for (const form of ["flat", "joined"]) {
    const variant = calibrationPaths("greptile", startedAt, { root, form });
    expect(variant.output).toBe(join(root, "index/calibration", `greptile-${date}-${form}.json`));
    expect(variant.run).toBe(`${plain.run}-${form}`);
    writeCalibration(variant.output, { status: "complete" }, form);
    expect(JSON.parse(readFileSync(variant.output, "utf8"))).toEqual({ form, status: "complete" });
    expect(readFileSync(plain.output, "utf8")).toBe(bytes);
    expect(() => calibrationPaths("greptile", startedAt, { root, form })).toThrow(`greptile-${date}-${form}.json exists`);
  }
  expect(() => calibrationPaths("greptile", startedAt, { root })).toThrow(`greptile-${date}.json exists`);

  const variantsOnly = tempDir();
  mkdirSync(join(variantsOnly, "index/calibration"), { recursive: true });
  for (const form of ["flat", "joined"]) writeFileSync(calibrationPaths("greptile", startedAt, { root: variantsOnly, form }).output, JSON.stringify({ form }));
  const afterVariants = calibrationPaths("greptile", startedAt, { root: variantsOnly });
  expect(afterVariants.output).toBe(join(variantsOnly, "index/calibration", `greptile-${date}.json`));
  writeCalibration(afterVariants.output, { status: "complete" });
  expect(JSON.parse(readFileSync(afterVariants.output, "utf8"))).toEqual({ status: "complete" });
});

it.each(["plain", "flat", "joined"])("casesInForm gives the judge the %s comment form", async (name) => {
  const form = name === "plain" ? undefined : name;
  const comments = Object.freeze(["  First issue\n\n````js\nawait task()\n```  ", "Second\tissue\r\nwith impact."]);
  const expected = {
    plain: comments,
    flat: ["First issue `js await task() `", "Second issue with impact."],
    joined: [comments.join("\n\n")],
  };
  const inputs = { cases: [comments, []].map((bodies, i) => ({ id: `case-${i}`, comments: bodies, truthSets: { greptile: { items: [{ text: "The callback is not awaited." }] } } })) };
  const requests = [];
  const verdicts = await judgeGreptile(casesInForm(inputs, form), { truthSet: "greptile", complete: async (request) => {
    requests.push(request); return { match: request.comments.length > 0 };
  } });
  expect(requests.map((r) => r.comments)).toEqual([expected[name], []]);
  expect(verdicts).toEqual([{ id: "case-0", label: "caught" }, { id: "case-1", label: "missed" }]);
  expect(inputs.cases[0].comments).toBe(comments);
});

it("refuses --help with exit 2 and usage showing the form flag", () => {
  const script = fileURLToPath(new URL("../outside/calibrate.mjs", import.meta.url));
  for (const args of [["--help"], ["--board", "greptile", "--form", "flat", "--help"]]) {
    const result = spawnSync(process.execPath, [script, ...args], { cwd: tempDir(), encoding: "utf8" });
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toMatch(/^usage:.*--form flat\|joined/);
  }
});

it("refuses a Martian form in one line", async () => {
  await expect(main(["--board", "martian", "--form", "flat"])).rejects.toThrow(/^--form is only supported for --board greptile$/);
});

it("refuses an unknown or missing form or an unknown flag with usage", async () => {
  for (const args of [["--form", "unknown"], ["--form"], ["--other", "flat"]]) {
    await expect(main(["--board", "greptile", ...args])).rejects.toThrow(/usage:.*--form flat\|joined/);
  }
});
