// Synthetic prose truth in real pinned files, never the user's bench cache.
// Keep the suite's case names and shape so attachment still covers 50 cases.
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { benchRoot } from "../lib/cases.mjs";
import { GREPTILE_REPOS } from "../lib/greptile.mjs";
import { entryHash, greptileTruth, martianTruth, realCaseId, sha256, suiteHashOf, truthHashOf } from "../lib/suites.mjs";
import { tempDir } from "../../tests/temp-dirs.mjs";

const write = (path, bytes) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes); };
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

export function boardSuiteFixture(name, root = tempDir("oq-board-suite-"), count = 50) {
  const cache = tempDir("oq-board-suite-cache-");
  const suite = JSON.parse(readFileSync(join(benchRoot, `suites/${name}/cases.json`), "utf8"));
  const pin = (path, bytes) => {
    write(join(cache, "raw", name, path), bytes);
    return { file: path, sha256: sha256(bytes) };
  };
  const rows = suite.cases.map((e) => ({ pr_title: name === "greptile" ? e.correctedTitle : e.name, url: e.prUrl, comments: [{ comment: `Fixture defect in ${e.name}.`, severity: "High", category: "bug" }] }));
  const corrected = pin("fixture/golden.json", json(rows));
  let original;
  if (name === "greptile") {
    const text = Object.entries(GREPTILE_REPOS).map(([id, repo]) => {
      const entries = suite.cases.filter((e) => e.repoGroup === repo.upstream);
      const bugs = entries.map((e) => ({ prNumber: Number(e.prUrl.split("/").at(-1)), prTitle: e.name, bugDescription: `Original fixture defect in ${e.name}.`, severity: "High", filePath: "src/a.ts" }));
      return `{id:"${id}",label:"${id}",bugs:${JSON.stringify(bugs)},toolResults:[{name:"Greptile",href:"https://github.com/${entries[0].repo}/pulls"}]}`;
    }).join("\n");
    original = pin("fixture/original.js", text);
  } else suite.dataset.files = [{ path: corrected.file, sha256: corrected.sha256 }];
  for (const [i, e] of suite.cases.entries()) {
    if (name === "greptile") {
      const sources = Object.fromEntries(["greptile", "augment"].map((set) => [set, { url: `https://example.test/fixture/${set}`, revision: "fixture", readDate: "2026-10-24" }]));
      const truth = greptileTruth({ bugDescription: `Original fixture defect in ${e.name}.`, severity: "High", filePath: "src/a.ts" }, rows[i], sources);
      e.truthSets = Object.fromEntries(Object.entries(truth.sets).map(([set, value]) => [set, { kind: value.kind, source: value.source, items: value.items.length, hash: truthHashOf(value.items), ...(set === "greptile" ? original : corrected) }]));
      e.truthHash = truthHashOf(truth.sets);
    } else {
      e.goldenFile = corrected.file;
      e.truth = { kind: "prose", items: rows[i].comments.length };
      e.truthHash = truthHashOf(martianTruth(rows[i]).items);
    }
    e.hash = entryHash(e);
    e.id = realCaseId(name, e.name, e.hash);
  }
  suite.cases = suite.cases.slice(0, count);
  suite.hash = suiteHashOf(suite.cases);
  write(join(root, `suites/${name}/cases.json`), json(suite));
  const split = `splits/${name}-v1.json`;
  mkdirSync(dirname(join(root, split)), { recursive: true });
  cpSync(join(benchRoot, split), join(root, split));
  return { root, cache };
}
