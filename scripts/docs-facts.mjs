// Holds the facts in the README and the agent-facing docs to the code, where
// a script can read the code's answer. It reads the built packages: run it
// after the build. It writes nothing; it fails when a page and the code
// disagree, and names each place.
//
// It checks:
//  1. every "<number> built-in scanners" in the pages equals the adapter list;
//  2. the table in docs/scanners.md names each built-in scanner once, with
//     its version from packages/scanners/toolchain.json, and the README's
//     category counts equal that table's; every other version on that page
//     (each scanner's section, the other tables, prose) is a pin of its tool
//     in toolchain.json (scripts/scanner-page-versions.mjs);
//  3. every sentence that says what `--offline` skips names exactly the
//     scanners whose adapters skip themselves when offline;
//  4. every command in a code example is one the CLI's own help knows, and
//     every flag in it is in that command's own flag list;
//  5. every pinned `openqodex@x.y.z` names the package version;
//  6. every README link is absolute, so it works on the npm page; every
//     link into this repository names a file that exists, at main or at a
//     tag that GitHub already has;
//  7. AGENTS.md states where CI runs each tier as ci.yml runs it: the events
//     that get the fast tier, the four cases of the full condition, macOS
//     and the benchmark only under it, and the required check names; no
//     sentence in AGENTS.md or CONTRIBUTING.md says less; and the gate
//     action's steps equal scripts/gate.sh's, one for one.
// It cannot check what a sentence means, a measured time or a privacy
// promise. Those are in the manual claims ledger.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { DISPLAY, pinsOf, scannerPageVersionProblems } from "./scanner-page-versions.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (rel) => readFileSync(join(root, rel), "utf8");
const errors = [];
const fail = (where, message) => errors.push(`${where}: ${message}`);

const { ADAPTERS, IN_PROCESS } = await import(join(root, "packages/scanners/dist/index.js"));
const toolchain = JSON.parse(read("packages/scanners/toolchain.json")).tools;
const version = JSON.parse(read("packages/cli/package.json")).version;
const BIN = join(root, "packages/cli/dist/bin.js");

const README = "README.md";
const dependencySentence = "Every supported lockfile in the repository is checked against osv.dev at every review and scan of a change.";
for (const page of [README, "docs/scanners.md"]) {
  if (!read(page).includes(dependencySentence)) fail(page, "must state the repository lockfile check");
}
if (ADAPTERS.find((a) => a.source === "osv-scanner")?.tree !== true) fail(README, "the every supported lockfile claim needs a tree adapter");
const AGENT_PAGES = [README, "docs/for-agents.md", "docs/quickstart.md", "skills/openqodex/SKILL.md"];

// The names the pages use for a scanner (DISPLAY, from scanner-page-versions.mjs).
const display = (source) => DISPLAY[source] ?? source;
const sources = ADAPTERS.map((a) => a.source);
const sourceOf = new Map(sources.map((s) => [display(s).toLowerCase(), s]));

// Code spans and fenced blocks are left out of prose checks, and are the
// only text the command check reads.
function splitCode(text) {
  const code = [];
  const prose = text.replace(/```[\s\S]*?```|`[^`\n]+`/g, (m) => {
    code.push(m.replace(/^`+|`+$/g, ""));
    return " ";
  });
  return { code, prose };
}

// 1. The count of built-in scanners.
const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = { twenty: 20, thirty: 30, forty: 40 };
function numberOf(word) {
  if (/^\d+$/.test(word)) return Number(word);
  const w = word.toLowerCase();
  if (WORDS.includes(w)) return WORDS.indexOf(w);
  const [tens, unit] = w.split("-");
  if (tens in TENS) return TENS[tens] + (unit === undefined ? 0 : WORDS.indexOf(unit));
  return null;
}
for (const rel of [README, "docs/index.md", "docs/scanners.md", "docs/for-agents.md"]) {
  const matches = [...read(rel).matchAll(/\b([A-Za-z]+(?:-[a-z]+)?|\d+) built-in scanners\b/g)];
  const counts = matches.map((m) => [m[1], numberOf(m[1])]).filter(([, n]) => n !== null);
  if (counts.length === 0) fail(rel, `says nowhere how many built-in scanners there are (${ADAPTERS.length})`);
  for (const [word, n] of counts) if (n !== ADAPTERS.length) fail(rel, `says "${word} built-in scanners"; the adapter list has ${ADAPTERS.length}`);
}

// 2. The scanner table and the README's category counts.
// Outer pipes are optional in Markdown, so each is cut only when present.
function tableRows(text, start, end) {
  let from = text.indexOf(start);
  if (from === -1) return null;
  from = text.lastIndexOf("\n", from) + 1;
  const to = text.indexOf(end, from + 1);
  if (to === -1) return null;
  return text
    .slice(from, to)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.includes("|") && !/^\|?\s*:?-+/.test(l))
    .slice(1)
    .map((l) => l.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim()));
}
const SCANNERS_PAGE = "docs/scanners.md";
const rows = tableRows(read(SCANNERS_PAGE), "<!-- scanner-table:start -->", "<!-- scanner-table:end -->");
const perCategory = new Map();
if (rows === null) fail(SCANNERS_PAGE, "has no table between <!-- scanner-table:start --> and <!-- scanner-table:end -->");
else {
  const seen = new Set();
  for (const [category, name, listed] of rows) {
    const source = sourceOf.get((name ?? "").toLowerCase());
    if (source === undefined) {
      fail(SCANNERS_PAGE, `the table names "${name}", which is not a built-in scanner`);
      continue;
    }
    if (seen.has(source)) fail(SCANNERS_PAGE, `the table names ${name} twice`);
    seen.add(source);
    const pinned = IN_PROCESS.has(source) ? "built in" : toolchain[source]?.version;
    if (listed !== pinned) fail(SCANNERS_PAGE, `${name} is listed at ${listed}; toolchain.json pins ${pinned}`);
    perCategory.set(category, (perCategory.get(category) ?? 0) + 1);
  }
  for (const source of sources) if (!seen.has(source)) fail(SCANNERS_PAGE, `the table leaves out ${display(source)}`);
}
for (const problem of scannerPageVersionProblems(read(SCANNERS_PAGE), pinsOf(toolchain))) fail(SCANNERS_PAGE, problem);
const readmeText = read(README);
const section = readmeText.slice(readmeText.indexOf("## Built-in scanners"));
const readmeRows = tableRows(section, "What it checks", "\n\n");
if (readmeRows === null || readmeRows.length === 0) fail(README, `has no category table under "## Built-in scanners"`);
else {
  let sum = 0;
  for (const [category, count] of readmeRows) {
    sum += Number(count);
    if (perCategory.get(category) !== Number(count)) fail(README, `counts ${count} for "${category}"; ${SCANNERS_PAGE} lists ${perCategory.get(category) ?? 0}`);
  }
  if (sum !== ADAPTERS.length) fail(README, `its category counts add up to ${sum}; the adapter list has ${ADAPTERS.length}`);
  for (const category of perCategory.keys()) if (!readmeRows.some(([c]) => c === category)) fail(README, `leaves out the category "${category}"`);
}

// 3. What --offline skips: the adapters that refuse to run when offline.
process.env.OPENQODEX_OFFLINE = "1";
const offline = new Set(ADAPTERS.filter((a) => typeof a.skip === "function" && a.skip() !== null).map((a) => a.source));
// Each claim is the list right after "`--offline` skips": names joined by
// commas and one "and". Every item must be a built-in scanner, and the list
// must be exactly the set above. Lines are joined first, so wrapping a
// sentence changes nothing.
for (const rel of [README, "docs/for-agents.md", "skills/openqodex/SKILL.md", "docs/privacy.md", "docs/security.md"]) {
  const text = read(rel).replace(/\s*\n\s*/g, " ");
  const claims = [...text.matchAll(/`--offline` (?:also )?skips ((?:[\w-]+, )*[\w-]+(?: and [\w-]+)?)/g)];
  if (claims.length === 0) fail(rel, "never says what `--offline` skips");
  for (const [, list] of claims) {
    const items = list.split(/, | and /);
    const unknown = items.filter((i) => !sourceOf.has(i.toLowerCase()));
    const named = new Set(items.map((i) => sourceOf.get(i.toLowerCase())).filter(Boolean));
    const missing = [...offline].filter((s) => !named.has(s));
    const extra = [...named].filter((s) => !offline.has(s));
    if (unknown.length) fail(rel, `"\`--offline\` skips ${list}" names ${unknown.join(", ")}, which is not a built-in scanner`);
    if (missing.length) fail(rel, `"\`--offline\` skips ${list}" leaves out ${missing.join(", ")}`);
    if (extra.length) fail(rel, `"\`--offline\` skips ${list}" names ${extra.join(", ")}, which run offline`);
  }
}

// 4. Commands and flags in code examples.
const helpCache = new Map();
function known(command) {
  if (!helpCache.has(command)) {
    let out = "";
    try {
      out = execFileSync(process.execPath, [BIN, command, "--help"], { encoding: "utf8", env: { ...process.env, CI: "1", OPENQODEX_AUTO_UPDATE: "0" } });
    } catch (error) {
      out = String(error.stdout ?? "");
    }
    helpCache.set(command, out.startsWith(`Usage: openqodex ${command}`));
  }
  return helpCache.get(command);
}
// A command's flags: the flag strings in its own file; the shared global
// flags when it uses the shared parser, or only the globals it names; the
// flag constants it imports from flags.ts; and Commander's --help. The own
// file can hold flag strings for other programs (git's in hook.ts), so this
// can accept a flag the command refuses; it never refuses one it takes.
const flagsTs = read("packages/cli/src/flags.ts");
const listOf = (name) => [...(flagsTs.match(new RegExp(`const ${name} = \\[([^\\]]*)\\]`))?.[1] ?? "").matchAll(/"(--[a-z-]+)"/g)].map((m) => m[1]);
const GLOBALS = [...listOf("GLOBAL_VALUES"), ...listOf("GLOBAL_BOOLS")];
const CONSTANTS = [...flagsTs.matchAll(/export const (\w+) = "(--[a-z-]+)"/g)].map((m) => [m[1], m[2]]);
function flagsOf(command) {
  const path = join(root, "packages/cli/src/commands", `${command}.ts`);
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  const flags = new Set(["--help", ...[...text.matchAll(/"(--[a-z][a-z-]*)"/g)].map((m) => m[1])]);
  const shared = /import \{([^}]*)\} from "\.\.\/flags\.js"/.exec(text)?.[1] ?? "";
  if (/\bparseFlags\b/.test(shared) && !/globals:\s*\[/.test(text)) for (const g of GLOBALS) flags.add(g);
  for (const [name, flag] of CONSTANTS) if (new RegExp(`\\b${name}\\b`).test(shared)) flags.add(flag);
  return flags;
}
// Each command in a code example: commands joined by &&, ||, | or ; and
// continued lines are taken apart first.
const PIN = String.raw`openqodex(?:@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)?`;
const INVOCATION = new RegExp(String.raw`(?:^|[\s(])(?:npx (?:-y )?)?(?:~\/\.openqodex\/bin\/)?${PIN} ([a-z][a-z-]*)(.*)$`);
function invocations(code) {
  return code
    .replace(/\\\n\s*/g, " ")
    .split(/&&|\|\||[|;\n]/)
    .map((segment) => INVOCATION.exec(segment))
    .filter(Boolean)
    .map((m) => [m[1], m[2]]);
}
for (const rel of [README, "docs/for-agents.md"]) {
  for (const code of splitCode(read(rel)).code) {
    for (const [command, args] of invocations(code)) {
      if (!known(command)) {
        fail(rel, `\`openqodex ${command}\` is not a command the CLI's help knows`);
        continue;
      }
      const flags = flagsOf(command);
      for (const flag of args.match(/(?<![\w-])--[a-z][a-z-]*/g) ?? []) {
        if (!flags.has(flag)) fail(rel, `\`openqodex ${command}\` has no flag ${flag}`);
      }
    }
  }
}

// 5. Version pins.
for (const rel of AGENT_PAGES) {
  for (const pin of new Set(read(rel).match(/openqodex@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/g) ?? [])) {
    if (pin !== `openqodex@${version}`) fail(rel, `pins ${pin}; the package is ${version}`);
  }
}

// 6. Links.
const REPO = "https://github.com/openqodex/openqodex/blob/";
// A link into the repository at a ref other than main must name a tag that
// GitHub already has: a link to a release not yet tagged fails for every
// reader. git asks GitHub; without the network, the check fails and says so.
const tagCache = new Map();
function publishedTag(ref) {
  if (!tagCache.has(ref)) {
    let out = "";
    try {
      out = execFileSync("git", ["ls-remote", "--tags", "https://github.com/openqodex/openqodex.git", `refs/tags/${ref}`], { encoding: "utf8", timeout: 30_000 });
    } catch {
      out = "";
    }
    tagCache.set(ref, out.trim() !== "");
  }
  return tagCache.get(ref);
}

// Every destination: inline links and images, a badge's outer link, and
// reference definitions.
function links(text) {
  const prose = splitCode(text).prose;
  return [...prose.matchAll(/\]\(([^)\s]+)\)/g), ...prose.matchAll(/^\s*\[[^\]]+\]:\s*(\S+)/gm)].map((m) => m[1]);
}
for (const href of links(readmeText)) {
  if (!href.startsWith("https://")) fail(README, `links ${href}, which does not work on the npm page; use an absolute https link`);
}
const docsPages = readdirSync(join(root, "docs")).filter((f) => f.endsWith(".md")).map((f) => `docs/${f}`);
for (const rel of [README, ...docsPages]) {
  for (const href of links(read(rel))) {
    const path = href.split(/[?#]/)[0];
    if (href.startsWith(REPO)) {
      const [ref, ...rest] = path.slice(REPO.length).split("/");
      const inRepo = rest.join("/");
      if (inRepo && !existsSync(join(root, inRepo))) fail(rel, `links ${href}, but ${inRepo} is not in the repository`);
      if (ref !== "main" && !publishedTag(ref)) fail(rel, `links ${href}, but the tag ${ref} is not published on GitHub`);
    } else if (path && !/^[a-z]+:/.test(path) && !existsSync(join(root, normalize(join(dirname(rel), path))))) {
      fail(rel, `links ${href}, which does not exist`);
    }
  }
}

// 7. Where CI runs each tier. The YAML parser is core's own dependency.
const YAML = createRequire(join(root, "packages/core/package.json"))("yaml");
const CI = ".github/workflows/ci.yml";
const ACTION = ".github/actions/gate/action.yml";
const AGENTS = "AGENTS.md";
const CONTRIBUTING = "CONTRIBUTING.md";
const ci = YAML.parse(read(CI));
const action = YAML.parse(read(ACTION));
const expression = (value) => /^\$\{\{\s*([\s\S]*?)\s*\}\}$/.exec(String(value ?? ""))?.[1] ?? null;
const jobs = ci.jobs ?? {};
const full = expression(jobs.gate?.steps?.find((s) => s.uses === "./.github/actions/gate")?.with?.full);
// The full condition, taken apart into its four cases and put back together:
// any other shape is a change this check and AGENTS.md do not know yet.
const queue = /contains\(github\.event\.merge_group\.head_commit\.message, '([^']+)'\)/.exec(full ?? "")?.[1];
const branch = /github\.head_ref == '([^']+)'/.exec(full ?? "")?.[1];
const label = /contains\(github\.event\.pull_request\.labels\.\*\.name, '([^']+)'\)/.exec(full ?? "")?.[1];
const pushBranches = ci.on?.push?.branches ?? [];
const shape = `github.event_name == 'push' || (github.event_name == 'merge_group' && contains(github.event.merge_group.head_commit.message, '${queue}')) || (github.event_name == 'pull_request' && ((github.head_ref == '${branch}' && github.event.pull_request.head.repo.full_name == github.repository) || contains(github.event.pull_request.labels.*.name, '${label}')))`;
const events = Object.keys(ci.on ?? {}).sort().join(", ");
if (full === null) fail(CI, "the Gate job's action step has no full condition");
else if (full !== shape) fail(CI, "the full condition is not push, the queue run naming the version branch, the version branch's pull request and the label; update AGENTS.md and this check");
if (events !== "merge_group, pull_request, push") fail(CI, `runs on ${events}; AGENTS.md describes merge_group, pull_request and push`);
if (pushBranches.join(", ") !== "main") fail(CI, `a push to ${pushBranches.join(", ")} runs it; AGENTS.md says a push to main`);
if (queue !== `/${branch}`) fail(CI, `the queue case names ${queue}, not the version branch /${branch}`);
// The Linux gate runs on every event, fast or full; the other two jobs run
// only under the full condition, and macOS runs the action's full default.
if (jobs.gate?.if !== undefined) fail(CI, "the Linux gate has a condition; AGENTS.md says it runs on every event");
for (const [id, job] of Object.entries(jobs)) {
  if (id !== "gate" && expression(job.if) !== full) fail(CI, `${job.name ?? id} runs under a condition other than the full condition; AGENTS.md says only under it`);
}
const macStep = jobs["gate-macos"]?.steps?.find((s) => s.uses === "./.github/actions/gate");
if (macStep?.with?.full !== undefined || action.inputs?.full?.default !== "true") fail(CI, "the macOS gate does not run the full gate by default");
// The sentences AGENTS.md must hold, made from ci.yml's values.
const required = [
  "In CI, an ordinary pull request and its merge queue run get the fast tier, on Linux only.",
  `CI runs the real-programs tier in four cases: a push to \`${pushBranches[0]}\`; a merge queue run whose merge commit message names \`${queue}\`; a pull request from the branch \`${branch}\` of this repository; a pull request with the label \`${label}\`.`,
  "The macOS gate and the scanner-only benchmark run only in those four cases.",
];
const agentsText = read(AGENTS);
const flat = (text) => text.replace(/\s*\n\s*(?:- )?/g, " ");
for (const sentence of required) if (!flat(agentsText).includes(sentence)) fail(AGENTS, `must say "${sentence}" (from ${CI})`);
// The required check names: each named check is a job, and every job is named.
const names = Object.values(jobs).map((j) => j.name);
const checks = /The (\w+) required checks are ([^.]+)\./.exec(flat(agentsText));
if (checks === null) fail(AGENTS, "never names the required checks");
else {
  const listed = [...checks[2].matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  if (numberOf(checks[1]) !== listed.length) fail(AGENTS, `says ${checks[1]} required checks and names ${listed.length}`);
  for (const name of listed) if (!names.includes(name)) fail(AGENTS, `names the required check \`${name}\`, which is not a job in ${CI}`);
  for (const name of names) if (!listed.includes(name)) fail(AGENTS, `leaves out the check \`${name}\` (${CI})`);
}
// No sentence in either page says less than ci.yml: a sentence that says
// where the full tier runs names all four cases, and no sentence gives every
// pull request the fast tier (only an ordinary one gets it).
const CASES = [
  ["a push to main", new RegExp(String.raw`\bpush(?:es)? to ${pushBranches[0]}\b`)],
  ["the merge queue run", /\bmerge queue\b|\bqueue run\b/],
  ["the version pull request", new RegExp(String.raw`version pull request|${branch}`)],
  [`the label ${label}`, new RegExp(String.raw`\b${label}\b`)],
];
for (const rel of [AGENTS, CONTRIBUTING]) {
  const sentences = flat(read(rel)).replace(/`/g, "").split(/(?<=[.:])\s+(?=[A-Z#])/);
  for (const sentence of sentences) {
    const s = sentence.toLowerCase();
    if (/\b(?:full gate|full tier|real-programs tier) runs\b/.test(s)) {
      const missing = CASES.filter(([, test]) => !test.test(s)).map(([what]) => what);
      if (missing.length) fail(rel, `"${sentence.slice(0, 80)}..." says where the full tier runs and leaves out ${missing.join(", ")}`);
    }
    if (/\bfast (?:gate|tier)\b/.test(s) && /\b(?:a|every|each|any) pull request(?: and its merge queue run)? (?:gets?|runs?)\b/.test(s)) {
      fail(rel, `"${sentence.slice(0, 80)}..." gives a pull request the fast tier; a pull request from ${branch} or with the label ${label} gets the full one`);
    }
  }
}
if (!read(CONTRIBUTING).includes("AGENTS.md")) fail(CONTRIBUTING, "must point at AGENTS.md for the gate and test rules");
// The action's named steps and scripts/gate.sh's steps, in order.
const actionSteps = (action.runs?.steps ?? []).filter((s) => s.name !== undefined && s.run !== undefined).map((s) => s.run.trim());
const gateSteps = [...read("scripts/gate.sh").matchAll(/^step "[^"]+" (.+)$/gm)].map((m) => m[1].trim());
for (let i = 0; i < Math.max(actionSteps.length, gateSteps.length); i++) {
  if (actionSteps[i] !== gateSteps[i]) {
    fail(ACTION, `step ${i + 1} runs ${actionSteps[i] ?? "nothing"}; scripts/gate.sh step ${i + 1} runs ${gateSteps[i] ?? "nothing"}`);
    break;
  }
}

// 8. Staged payload and brief budgets are named with their code values.
const { MAX_UNIT_DIFF_BYTES, MAX_BRIEF_BYTES, DELIVER_LINES } = await import(join(root, "packages/review/dist/index.js"));
for (const [name, value, label] of [
  ["MAX_UNIT_DIFF_BYTES", MAX_UNIT_DIFF_BYTES, "120 KB"],
  ["DELIVER_LINES", DELIVER_LINES, "4,000"],
  ["MAX_BRIEF_BYTES", MAX_BRIEF_BYTES, "256 KB"],
]) {
  if (value !== ({ MAX_UNIT_DIFF_BYTES: 120 * 1024, DELIVER_LINES: 4000, MAX_BRIEF_BYTES: 256 * 1024 })[name]) fail("docs/claude-code-review.md", `${name} changed; update the documented budget`);
  if (!read("docs/claude-code-review.md").includes(`\`${name}\``) || !read("docs/claude-code-review.md").includes(label)) fail("docs/claude-code-review.md", `must name ${name} and ${label}`);
}

if (errors.length) {
  for (const error of errors) console.error(`docs-facts: ${error}`);
  process.exit(1);
}
console.log(`ok: docs facts (${ADAPTERS.length} scanners, ${offline.size} skipped offline, version ${version})`);
