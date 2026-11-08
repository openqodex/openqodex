// Read saved Greptile labels, never a model or pinned truth. Rebuild first attempts.
// Verdicts, rather than the summary, fix the rate. Empty reviews must miss.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { greptileInput } from "./board-reviews.mjs";
import { hashFolder, sha256 } from "./index.mjs";
import { boardConfigOf, boardToolName } from "./martian-board.mjs";
import { canonical, value } from "./score.mjs";
import { readSuite } from "./suites.mjs";

const PINS = JSON.parse(readFileSync(new URL("../outside/boards.json", import.meta.url), "utf8"));

export function readGreptileOutside(folder, jobs, _specs, options = {}) {
  const out = join(folder, "outside", "greptile");
  if (!existsSync(join(out, "eval.json"))) throw new Error(`${out} holds no eval.json; judge the run first (benchmark/outside/boards/greptile-run.mjs)`);
  const paths = [];
  const read = (path) => { paths.push(`outside/greptile/${path}`); return JSON.parse(readFileSync(join(out, path), "utf8")); };
  const evaluation = read("eval.json");
  const input = read("input.json");
  const manifestBytes = readFileSync(join(folder, "manifest.json"));
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const need = (ok, why) => { if (!ok) throw new Error(`Greptile ${why}`); };
  need(evaluation.manifestSha256 === sha256(manifestBytes) && input.manifestSha256 === evaluation.manifestSha256, "manifest sha256 differs from this run's manifest hash");
  const pin = PINS.boards.greptile;
  const model = PINS.deployments[pin.judge.deployment].id;
  const board = { name: "greptile", repository: pin.repo, commit: pin.commit, judgeModel: model, promptHash: pin.judge.prompt.sha256 };
  need(evaluation.version === 1 && canonical(evaluation.board) === canonical(board), "board pins differ from boards.json");
  need(evaluation.promptHash === board.promptHash, "prompt hash differs from the board pin");
  need(manifest.suite === "greptile" && input.splitHash === manifest.splitHash && evaluation.splitHash === manifest.splitHash, "suite or split hash differs from this run");
  need(["greptile", "augment"].includes(input.truthSet) && input.truthSet === evaluation.truthSet, "truth set differs from the saved input");
  const suite = readSuite("greptile", options);
  const ids = suite.file.cases.map((c) => c.id);
  need(input.suite?.name === "greptile" && canonical(input.suite.cases) === canonical(ids), "input does not cover the frozen suite");
  need(Array.isArray(input.tools) && input.tools.length > 0 && Array.isArray(input.cases), "input needs tools and cases");
  const names = input.tools.map((t) => t.tool);
  need(new Set(names).size === names.length && names.every((name) => /^[a-z0-9-]+$/.test(name)), "input repeats or misnames a tool");
  need(canonical(Object.keys(evaluation.perTool ?? {}).sort()) === canonical([...names].sort()), "summary tools differ from the input");
  need(canonical([...new Set(jobs.map((j) => boardToolName(j.config, j.repeat)))].sort()) === canonical([...names].sort()), "tools differ from the run's planned jobs");
  need(input.cases.every((c) => names.includes(c.tool) && Array.isArray(c.comments)), "a case names an unknown tool or has no comment list");
  const truth = (c) => input.cases.find((row) => row.caseId === c.id && row.status === "not-run")?.truthSets;
  need(canonical(input) === canonical(greptileInput(folder, input.truthSet, { ...options, truth })), "input.json differs from the run's first attempt rebuild");
  const judged = input.cases.some((c) => !input.tools.find((t) => t.tool === c.tool).held?.length && c.comments.length > 0);
  need(evaluation.judgeModel === model || (evaluation.judgeModel === null && !judged), "judge model differs from the board pin or is missing for comments that needed judging");
  const perTool = {};
  for (const t of input.tools) {
    const mine = input.cases.filter((c) => c.tool === t.tool);
    const repeat = Number(/-r(\d+)$/.exec(t.tool)?.[1]);
    need(t.boardConfig === boardConfigOf(t.config) && t.tool === boardToolName(t.config, repeat), `${t.tool}: config or boardConfig differs from its tool name`);
    need(mine.length === ids.length && new Set(mine.map((c) => c.id)).size === ids.length && mine.every((c) => ids.includes(c.id) && c.caseId === c.id && c.config === t.config && c.boardConfig === t.boardConfig), `${t.tool}: input does not cover every suite case once`);
    const of = ids.length;
    const notRun = mine.filter((c) => c.status === "not-run").length;
    let labels = [];
    let summary;
    if (t.held?.length > 0) summary = { config: t.config, boardConfig: t.boardConfig, held: t.held, caught: null, missed: null, of, planned: of - notRun, notRun, rate: null };
    else {
      labels = read(`${t.tool}/verdicts.json`);
      need(Array.isArray(labels) && labels.length === of && new Set(labels.map((v) => v.id)).size === of && labels.every((v) => ids.includes(v.id) && ["caught", "missed"].includes(v.label) && typeof v.reason === "string"), `${t.tool}: verdicts must label every suite case once`);
      for (const c of mine.filter((c) => c.comments.length === 0)) {
        const v = labels.find((v) => v.id === c.id);
        const reason = ["not-run", "failed", "unstarted"].includes(c.status) ? c.status : "empty";
        need(v.label === "missed" && v.reason === reason, `${t.tool}: an empty case has a judged verdict or the wrong reason`);
      }
      const caught = labels.filter((v) => v.label === "caught").length;
      summary = { config: t.config, boardConfig: t.boardConfig, caught, missed: of - caught, of, planned: of - notRun, notRun, rate: value({ hit: caught, of }) };
    }
    need(canonical(evaluation.perTool[t.tool]) === canonical(summary), `${t.tool}: eval.json summary differs from its verdicts or held input`);
    // A judge reason keeps its words; an em dash becomes a comma, so the score and the index entry pass the scrub.
    perTool[t.tool] = { ...summary, labels: labels.map((v) => (typeof v.reason === "string" ? { ...v, reason: v.reason.replace(/\s*\u2014\s*/g, ", ") } : v)) };
  }
  return { board, truthSet: evaluation.truthSet, judgeModel: evaluation.judgeModel, promptHash: evaluation.promptHash, perTool, evidenceHash: hashFolder(folder, paths).listHash };
}
