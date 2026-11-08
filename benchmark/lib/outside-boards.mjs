// The board key set lives here. A failed read leaves one null block and
// one problem line, so board output never changes the run's own score.
import { readAacrOutside } from "./aacr-board.mjs";
import { readMartianOutside } from "./martian-board.mjs";
import { readGreptileOutside } from "./greptile-board.mjs";

export const BOARDS = { aacr: readAacrOutside, martian: readMartianOutside, greptile: readGreptileOutside };

export function readOutside(folder, jobs, specs, names, options = {}) {
  const outside = {};
  for (const name of names) {
    if (!Object.hasOwn(BOARDS, name)) throw new Error(`outside.${name} is not in the board registry`);
    try { outside[name] = BOARDS[name](folder, jobs, specs, options); }
    catch (error) {
      outside[name] = null;
      console.error(`outside.${name} is null: ${String(error.message).split("\n")[0]}`);
    }
  }
  return outside;
}

// Entry validation needs no run folder. Readers check the saved evidence;
// this checks the shape an index reader can use without fetching it.
export function outsideProblems(outside) {
  const problems = [];
  const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  const count = (v) => Number.isInteger(v) && v >= 0;
  const ratio = (v) => Number.isFinite(v) && v >= 0 && v <= 1;
  if (!object(outside)) return ["outside must be an object"];
  for (const [name, block] of Object.entries(outside)) {
    const need = (ok, what) => { if (!ok) problems.push(`outside.${name}: ${what}`); };
    if (!Object.hasOwn(BOARDS, name)) { need(false, "board key is not in the registry"); continue; }
    if (block === null) continue;
    need(object(block), "block must be an object or null");
    if (!object(block)) continue;
    need(/^[a-f0-9]{64}$/.test(block.evidenceHash ?? ""), "evidenceHash must be a sha256");
    need(object(block.board), "board must give its pins");
    const tools = name === "aacr" ? block.folders : object(block.perTool) ? Object.values(block.perTool) : null;
    need(Array.isArray(tools) && tools.length > 0, "block must hold each tool's results");
    for (const t of tools ?? []) {
      need(typeof t?.config === "string" && t.config !== "", "each tool needs config");
      need(typeof t?.boardConfig === "string" && t.boardConfig !== "", "each tool needs boardConfig");
      if (name === "greptile") {
        need(count(t?.of) && count(t?.planned) && count(t?.notRun) && t.planned + t.notRun === t.of, "each tool must count of, planned and notRun");
        if (Array.isArray(t?.held) && t.held.length > 0) need(t.caught === null && t.missed === null && t.rate === null, "held tools have null counts and rate");
        else need(count(t?.caught) && count(t?.missed) && t.caught + t.missed === t.of && ratio(t.rate) && Array.isArray(t.labels) && t.labels.length === t.of, "each tool needs caught, missed, rate and per-case labels");
      } else if (name === "martian") {
        if (typeof t?.held === "string" && t.held.trim() !== "") need(t.official === null && t.ours === null && Array.isArray(t.matches) && Array.isArray(t.candidates), "held tools have null official totals and ours, and lists of candidates and matches");
        else need(object(t?.official?.core) && ["tp", "fp", "fn"].every((k) => count(t.official.core[k])) && ratio(t.official.core.f1) && object(t.ours) && Array.isArray(t.matches) && Array.isArray(t.candidates), "each tool needs official core totals, ours, candidates and matches");
        need(Array.isArray(t?.empty), "each tool must list the cases sent empty");
      } else need(Array.isArray(t?.rounds) && object(t?.ours) && typeof t?.judged === "boolean", "each tool needs rounds, ours and judged");
    }
    if (name === "aacr") need(object(block.byConfig), "byConfig is missing");
  }
  return problems;
}
