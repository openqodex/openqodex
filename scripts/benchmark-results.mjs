// Publishes accepted benchmark numbers from the committed index only: the
// full results page, the README block and the README chart (one SVG per
// GitHub theme). --check writes nothing and names the first differing line
// in each file.
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { acceptedProblems, entryProblems, groupKeys, listEntries } from "../benchmark/lib/index.mjs";
import { SUITES } from "../benchmark/lib/suites.mjs";
import { boardConfigOf } from "../benchmark/lib/martian-board.mjs";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const START = "<!-- benchmark-results:start -->";
const END = "<!-- benchmark-results:end -->";
const percent = (n) => typeof n === "number" ? `${(n * 100).toFixed(1)}%` : "not measured";
const ratio = (r, interval = false) => {
  if (!r || r.of === 0) return "not measured";
  const value = `${r.hit}/${r.of} (${percent(r.hit / r.of)})`;
  return interval ? `${value}${Array.isArray(r.ci) ? ` [${r.ci.map(percent).join(", ")}]` : " [interval not available]"}` : value;
};
const cell = (value) => String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
const table = (head, rows) => [head, head.map(() => "---"), ...rows].map((row) => `| ${row.map(cell).join(" | ")} |`).join("\n");
const reviewer = (g) => ({ none: "Scanner only", claude: "Claude Code", codex: "Codex" }[g.reviewer] ?? (g.reviewer.startsWith("model") ? "Library" : g.reviewer));
const cost = (s) => typeof s.costUsdMean === "number" ? `$${s.costUsdMean.toFixed(4)}` : "not measured";
const runLink = (e) => `[${e.runId}](${e.asset.url})`;
const suiteName = (suite) => ({ planted: "Planted bugs", aacr: "AACR-Bench" }[suite] ?? suite);
// The group key can name a model reviewer's model unknown (issue #206); the entry's one reviewer names it.
const modelName = (e, g) => {
  if (g.model === "none") return "no model";
  const named = Object.values(e.reviewers ?? {}).map((r) => r.model).filter(Boolean);
  return g.model === "unknown" && named.length === 1 ? named[0] : g.model;
};
// Findings exist, and every one still waits for a person's ruling: issue recall is unknown, not zero.
const unruled = (s) => s.issueRecall.all.hit === 0 && s.precision.upper.of > 0 && s.precision.lower.hit === 0 && s.precision.upper.hit === s.precision.upper.of;
const board = (e, g) => e.outside?.aacr?.byConfig?.[g.config]?.mean;
// A suite with a board has no matching words in its known issues, so only a ruling credits a hit.
// The README shows its row once the row has board numbers or a ruled hit. The full page shows every row.
const boardCells = (numbers) => [numbers?.semantic?.precision, numbers?.semantic?.recall, numbers?.semantic?.f1, numbers?.semantic?.noiseRate, numbers?.line?.precision, numbers?.line?.recall].map(percent);
const boardHead = ["Semantic precision", "Semantic recall", "Semantic F1", "Noise rate", "Line precision", "Line recall"];
const readable = ({ e, g, s }) => !SUITES[e.suite]?.board || Boolean(board(e, g)) || s.issueRecall.all.hit > 0;
const recall = (s, interval = false) => (unruled(s) ? "not yet ruled" : ratio(s.issueRecall.all, interval));
// A number whose reviewer was tuned on the very cases it scored says so beside it.
const tuned = (e, text) => (e.tunedOn === true ? `${text} (tuned on these cases)` : text);
const suiteLabel = (e) => `${suiteName(e.suite)}, ${e.split} split${e.subset ? `, ${e.subset} subset` : ""}`;
// The scoring rules a run was scored under; an entry from before the rules had versions is legacy.
const rulesLabel = (e) => `scoring rules ${e.rulesVersion ?? "legacy"}`;
// A README row names its scoring rules, so two runs that differ only there read apart (issue #280).
// Rows that still read alike also name the rest of their group key: mode, path, split hash and purpose.
const casesCells = (rows) => {
  const short = ({ e }) => `${suiteLabel(e)}, ${rulesLabel(e)}`;
  const seen = (r) => [reviewer(r.g), r.g.config, modelName(r.e, r.g), short(r)].join("\n");
  const count = new Map();
  for (const r of rows) count.set(seen(r), (count.get(seen(r)) ?? 0) + 1);
  return new Map(rows.map((r) => [r, count.get(seen(r)) > 1
    ? `${short(r)}, ${r.e.mode} mode, ${r.e.path} path${r.e.splitHash ? `, split hash ${r.e.splitHash.slice(0, 12)}` : ""}${r.e.purpose ? `, ${r.e.purpose} purpose` : ""}`
    : short(r)]));
};
const groupLabel = (e, g) => [g.config, `${e.split} split`, ...(e.subset ? [`${e.subset} subset`] : []), `${e.mode} mode`, `${e.path} path`, rulesLabel(e), ...(e.splitHash ? [`split hash ${e.splitHash.slice(0, 12)}`] : []), ...(e.purpose ? [`${e.purpose} purpose`] : [])].join(", ");
// A Greptile or Martian row's repeat range: the mean, never the best repeat, with the lowest and highest.
const repeatRange = (e, g) => e.outside?.[SUITES[e.suite]?.board]?.range?.[boardConfigOf(g.config)];
export function rangeLine(e, g) {
  const r = repeatRange(e, g);
  if (!r) return null;
  const text = r.metric === "caught"
    ? `caught ${r.mean.toFixed(1)} of ${r.of} cases on average (${percent(r.mean / r.of)}), from ${r.min} to ${r.max}`
    : `F1 ${percent(r.mean)} on average, from ${percent(r.min)} to ${percent(r.max)}`;
  return `${runLink(e)}, ${g.config}: ${tuned(e, text)} across ${r.repeats} repeats. The range is the lowest and highest repeat, not a confidence interval.`;
}
const precisionRange = (s) => (s.precision.lower.of === 0 ? "not measured" : `${ratio(s.precision.lower)} to ${ratio(s.precision.upper)}`);

// The openqodex version a run reviewed with, and the day it ran.
const cliVersion = (e) => e.build?.cliVersion ?? "not recorded";
const runDate = (e) => e.date ?? "not recorded";

// Every entry and the accepted row of each group, after the index checks.
function acceptedRows(index) {
  const entries = listEntries(join(index, "runs")).map(({ entry }) => entry);
  const byId = new Map(entries.map((e) => [e.runId, e]));
  const pointer = JSON.parse(readFileSync(join(index, "accepted.json"), "utf8"));
  const problems = [...entries.flatMap(entryProblems), ...acceptedProblems(pointer, byId)];
  if (problems.length) throw new Error(problems.join("\n"));
  const rows = Object.entries(pointer.groups).sort(([a], [b]) => a.localeCompare(b)).map(([key, accepted]) => {
    const e = byId.get(accepted.runId);
    const g = groupKeys(e).find((g) => g.key === key);
    return { e, g, s: e.scores[g.config], accepted };
  });
  return { entries, rows };
}

// The run the README chart shows: among the accepted planted-bug reviews by
// Claude Code, the highest scoring rules version; on a tie, the latest accepted.
export function headlineRow(rows) {
  const candidates = rows.filter(({ e, g }) => e.suite === "planted" && e.mode === "review" && g.reviewer === "claude");
  candidates.sort((a, b) => (b.e.rulesVersion ?? -1) - (a.e.rulesVersion ?? -1) || b.accepted.acceptedAt.localeCompare(a.accepted.acceptedAt));
  if (candidates.length === 0) throw new Error("no accepted planted-bug review by Claude Code for the README chart");
  return candidates[0];
}

// The chart's four measures, each a share for its bar (a range for precision) and its text.
const share = (r) => (r && r.of > 0 ? r.hit / r.of : 0);
function chartBars({ s }) {
  return [
    { label: "Issue recall", from: 0, to: unruled(s) ? 0 : share(s.issueRecall.all), text: recall(s) },
    { label: "Location recall", from: 0, to: share(s.location?.recall), text: ratio(s.location?.recall) },
    { label: "Precision", from: share(s.precision.lower), to: share(s.precision.upper), text: precisionRange(s) },
    { label: "Clean rate", from: 0, to: share(s.controls), text: ratio(s.controls) },
  ];
}
const xml = (text) => String(text).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
// One skin per GitHub theme. The page shows the one that matches the reader's.
const SKINS = {
  light: { surface: "#ffffff", border: "#d0d7de", text: "#1f2328", muted: "#59636e", track: "#eaeef2", bar: "#0969da", range: "#9cc5f5" },
  dark: { surface: "#0d1117", border: "#3d444d", text: "#f0f6fc", muted: "#9198a1", track: "#262c36", bar: "#4493f8", range: "#1d4b8a" },
};
export function chartTitle(row) {
  const { e, g } = row;
  return `${suiteName(e.suite)}: ${reviewer(g)} review with ${modelName(e, g)}`;
}
export function chartSubtitle(row) {
  const { e } = row;
  return `openqodex ${cliVersion(e)}, run on ${runDate(e)}, ${rulesLabel(e)}, ${e.repeat} repeats of each case`;
}
export function chartAlt(row) {
  return `${chartTitle(row)}. ${chartBars(row).map((b) => `${b.label} ${b.text}`).join(", ")}.`;
}
export function renderChart(index, skin) {
  const c = SKINS[skin];
  if (!c) throw new Error(`unknown chart skin ${skin}`);
  const row = headlineRow(acceptedRows(index).rows);
  const [width, left, barX, barW, valueX, top, step] = [960, 32, 210, 400, 630, 112, 44];
  const bars = chartBars(row);
  const height = top + bars.length * step + 44;
  const font = `font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif"`;
  const body = bars.map((b, i) => {
    const y = top + i * step;
    const x0 = barX + barW * b.from;
    const solid = b.from > 0 ? `<rect x="${barX}" y="${y - 7}" width="${(barW * b.from).toFixed(1)}" height="14" rx="4" fill="${c.bar}"/>` : "";
    const span = b.to > b.from ? `<rect x="${x0.toFixed(1)}" y="${y - 7}" width="${(barW * (b.to - b.from)).toFixed(1)}" height="14" rx="4" fill="${b.from > 0 ? c.range : c.bar}"/>` : "";
    return [
      `<text x="${left}" y="${y + 5}" font-size="15" fill="${c.text}">${xml(b.label)}</text>`,
      `<rect x="${barX}" y="${y - 7}" width="${barW}" height="14" rx="4" fill="${c.track}"/>`,
      span, solid,
      `<text x="${valueX}" y="${y + 5}" font-size="15" fill="${c.text}">${xml(b.text)}</text>`,
    ].filter(Boolean).join("\n  ");
  });
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title" ${font}>`,
    `  <title id="title">${xml(chartAlt(row))}</title>`,
    `  <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="12" fill="${c.surface}" stroke="${c.border}"/>`,
    `  <text x="${left}" y="44" font-size="20" font-weight="600" fill="${c.text}">${xml(chartTitle(row))}</text>`,
    `  <text x="${left}" y="72" font-size="14" fill="${c.muted}">${xml(chartSubtitle(row))}</text>`,
    ...body.map((b) => `  ${b}`),
    `  <text x="${left}" y="${height - 22}" font-size="13" fill="${c.muted}">Precision: the bar is full colour up to the lower bound and pale up to the upper bound.</text>`,
    "</svg>",
    "",
  ].join("\n");
}

export function renderResults(index) {
  const { entries, rows } = acceptedRows(index);
  const page = ["# Benchmark results", "", "Generated by `node scripts/benchmark-results.mjs` from `benchmark/index`. Do not edit this page by hand.", "", "## How to read this", "",
    "- A group is one configuration on one set of cases under one version of the scoring rules. Each row is the run a person accepted for its group.",
    "- Library is the Node library's reviewChange function. It reviews with the model in the row, as a server would.",
    "- Planted bugs are small changes with bugs put in on purpose. The suite also has clean changes with no bug.",
    "- AACR-Bench is an outside benchmark of real pull requests. Its known issues are the review comments that the dataset marks as accepted.",
    "- Issue recall is the share of known issues that the reviews found. Each count adds up every repeat of the run.",
    "- The brackets give the 95% interval for issue recall. The true recall is likely inside that range.",
    "- On AACR-Bench, a finding counts toward issue recall only after a person rules it the same issue as a reference comment.",
    "- Not yet ruled means every finding of the run still waits for a person's ruling. Its issue recall is unknown until then.",
    "- Location recall is the share of known issues with a finding within one line, whatever the finding says.",
    "- Precision is the share of reported findings that are correct. An unresolved finding is one the case does not list and no person has ruled on.",
    "- The precision lower bound counts every unresolved finding as wrong. The upper bound counts every unresolved finding as correct.",
    "- Clean rate is the share of reviews of clean changes that report no finding.",
    "- Cost and time are the mean per review. Not measured means the run did not record that number.",
    "- An A/A twin runs the same build on the same cases a second time. Its noise is the difference in issues found between the two runs.",
    "- A gap between two rows that is smaller than the A/A noise can be chance.",
    "- Board numbers come from AACR-Bench's own evaluator. Line numbers match a finding to a reference comment by file and lines.",
    "- Semantic numbers also need the evaluator's judge to agree that the two say the same thing. F1 combines precision and recall in one number.",
    "- Noise rate is the share of findings that match no reference comment. Board numbers never decide whether a run is accepted.",
    "- A subset, such as dev-smoke, covers only the cases it names. Compare two rows only when they ran the same cases.",
    "- The README shows an AACR-Bench row only once it has board numbers or a ruled hit. This page shows every row.", ""];
  const suites = [...new Set(rows.map(({ e }) => e.suite))].sort();
  for (const suite of suites) {
    const selected = rows.filter(({ e }) => e.suite === suite);
    page.push(`## ${suiteName(suite)}`, "",
      table(["Reviewer", "Model", "Group", "Repeats", "Issue recall", "Location recall", "Precision lower bound", "Precision upper bound", "Clean rate", "Cost per review", "Time per review", "openqodex", "Run date", "Run", "Accepted date"], selected.map(({ e, g, s, accepted }) => [
        reviewer(g), modelName(e, g), groupLabel(e, g),
        e.repeat, tuned(e, recall(s, true)), ratio(s.location?.recall), ratio(s.precision.lower), ratio(s.precision.upper), ratio(s.controls), cost(s),
        typeof s.wallMsMean === "number" ? `${(s.wallMsMean / 1000).toFixed(1)} s` : "not measured", cliVersion(e), runDate(e), runLink(e), accepted.acceptedAt.slice(0, 10),
      ])), "");
    for (const { e, g, s } of selected) {
      // Published A/A twins use the parent's run id with the -aa suffix.
      const twins = entries.filter((t) => t.runId === `${e.runId}-aa` && t.build.bundleHash === e.build.bundleHash && t.caseSetHash === e.caseSetHash && t.rulesHash === e.rulesHash && t.repeat === e.repeat && groupKeys(t).some((k) => k.key === g.key));
      for (const twin of twins) {
        const other = twin.scores[g.config].issueRecall.all;
        if (other.of !== s.issueRecall.all.of) throw new Error(`A/A twin ${twin.runId} has a different issue population`);
        const noise = Math.abs(other.hit - s.issueRecall.all.hit);
        page.push(`A/A noise for ${g.config}: ${runLink(e)} found ${s.issueRecall.all.hit} issues, and its twin ${runLink(twin)} found ${other.hit}. ` +
          `The difference is ${noise} issues across ${e.repeat} repeats, or ${(noise / e.repeat).toFixed(2)} per repeat.`, "");
      }
    }
    const ranged = selected.map(({ e, g }) => rangeLine(e, g)).filter(Boolean);
    if (ranged.length > 0) page.push("### Board scores", "", ...ranged.flatMap((line) => [line, ""]));
    if (suite === "aacr") {
      page.push("### Board scores", "");
      for (const { e, g } of selected) {
        const numbers = board(e, g);
        page.push(`${runLink(e)}, ${g.config}${numbers ? ":" : ": not yet board-scored."}`, "");
        if (numbers) page.push(table(boardHead, [boardCells(numbers)]), "");
      }
    }
  }
  page.push("[Benchmark methods](benchmark.md)", "");
  // Rows with board numbers get their own table, so no row carries six cells it never measured.
  const shown = rows.filter(readable);
  const plain = shown.filter(({ e, g }) => !board(e, g));
  const boarded = shown.filter(({ e, g }) => board(e, g));
  const cases = casesCells(shown);
  const top = headlineRow(rows);
  const asset = (skin) => `https://raw.githubusercontent.com/openqodex/openqodex/main/.github/assets/benchmark-${skin}.svg`;
  const headline = [START, "## Benchmark", "",
    "<picture>",
    `  <source media="(prefers-color-scheme: dark)" srcset="${asset("dark")}">`,
    `  <img alt="${xml(chartAlt(top))}" src="${asset("light")}" width="960">`,
    "</picture>",
    "",
    `The chart shows one accepted run: ${reviewer(top.g)} with ${modelName(top.e, top.g)} on openqodex ${cliVersion(top.e)}, run on ${runDate(top.e)}. ` +
      `Each number adds up ${top.e.repeat} repeats of every case, and repeats of one case can give different results. ` +
      "The table gives every accepted run, each under the scoring rules version it was scored with.",
    "",
    ...(plain.length ? [table(["Reviewer", "Model", "Cases", "Issue recall", "Precision", "Clean rate", "Cost per review", "openqodex", "Run date"], plain.map((r) => [
      `${reviewer(r.g)} (${r.g.config})`, modelName(r.e, r.g), cases.get(r), tuned(r.e, recall(r.s)), precisionRange(r.s), ratio(r.s.controls), cost(r.s), cliVersion(r.e), runDate(r.e),
    ])), ""] : []),
    ...(boarded.length ? ["AACR-Bench is a set of real pull requests. Its own evaluator gives the board numbers below.", "", table(["Reviewer", "Model", "Cases", "Issue recall", ...boardHead, "Cost per review", "openqodex", "Run date"], boarded.map((r) => [
      `${reviewer(r.g)} (${r.g.config})`, modelName(r.e, r.g), cases.get(r), tuned(r.e, recall(r.s)), ...boardCells(board(r.e, r.g)), cost(r.s), cliVersion(r.e), runDate(r.e),
    ])), ""] : []),
    "[Full results and how to read them](https://github.com/openqodex/openqodex/blob/main/docs/benchmark-results.md)", END].join("\n");
  return { page: page.join("\n"), headline };
}

export function generateResults({ root = repo, check = false } = {}) {
  const index = join(root, "benchmark/index");
  const { page, headline } = renderResults(index);
  const readmePath = join(root, "README.md");
  const readme = readFileSync(readmePath, "utf8");
  const start = readme.indexOf(START);
  const end = readme.indexOf(END);
  if (start < 0 || end < start || readme.indexOf(START, start + START.length) !== -1 || readme.indexOf(END, end + END.length) !== -1) throw new Error("README.md needs one ordered pair of benchmark-results markers");
  const expectedReadme = readme.slice(0, start) + headline + readme.slice(end + END.length);
  let differs = false;
  const charts = ["light", "dark"].map((skin) => [`.github/assets/benchmark-${skin}.svg`, renderChart(index, skin)]);
  for (const [name, expected] of [["docs/benchmark-results.md", page], ["README.md", expectedReadme], ...charts]) {
    const path = join(root, name);
    if (!check) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, expected);
    }
    else {
      const actual = existsSync(path) ? readFileSync(path, "utf8") : "";
      if (actual === expected) continue;
      const a = actual.split("\n");
      const b = expected.split("\n");
      let line = 0;
      while (a[line] === b[line] && line < Math.max(a.length, b.length)) line++;
      console.error(`${name}:${line + 1}: differs from benchmark/index; expected ${JSON.stringify(b[line] ?? "<end of file>")}, found ${JSON.stringify(a[line] ?? "<end of file>")}`);
      differs = true;
    }
  }
  return differs ? 1 : 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    let root = repo;
    let check = false;
    const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--check") check = true;
      else if (args[i] === "--root" && args[i + 1]) root = resolve(args[++i]);
      else throw new Error(`unknown or incomplete argument ${args[i]}`);
    }
    process.exitCode = generateResults({ root, check });
  } catch (error) {
    console.error(`benchmark-results: ${error.message}`);
    process.exitCode = 1;
  }
}
