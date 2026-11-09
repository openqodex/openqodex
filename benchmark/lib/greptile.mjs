// W8-2 failure cases are in benchmark/test/greptile-failures.md.
// Read the page's literal data without executing its JavaScript.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function arrayAt(text, start) {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === "[") depth++;
    else if (ch === "]" && --depth === 0) return text.slice(start, i + 1);
  }
  throw new Error("Greptile's page asset has an unfinished data array");
}

function literalJson(text) {
  // Only JSON strings, punctuation, numbers and unquoted object keys.
  const tokens = text.match(/"(?:[^"\\]|\\.)*"|[A-Za-z_][A-Za-z_0-9]*|\d+|[\s\S]/g);
  return JSON.parse(tokens.map((t) => /^[A-Za-z_]/.test(t) ? JSON.stringify(t) : t).join(""));
}

export const GREPTILE_REPOS = {
  sentry: { file: "sentry.json", upstream: "getsentry/sentry", language: "Python" },
  calcom: { file: "cal_dot_com.json", upstream: "calcom/cal.com", language: "TypeScript" },
  grafana: { file: "grafana.json", upstream: "grafana/grafana", language: "Go" },
  keycloak: { file: "keycloak.json", upstream: "keycloak/keycloak", language: "Java" },
  discourse: { file: "discourse.json", upstream: "discourse/discourse", language: "Ruby" },
};

export function greptileRows(text) {
  const rows = [];
  for (const [id, repo] of Object.entries(GREPTILE_REPOS)) {
    const start = text.indexOf(`{id:"${id}",label:`);
    if (start < 0) throw new Error(`Greptile's page asset has no ${id} dataset`);
    const bugsAt = text.indexOf("bugs:[", start) + "bugs:".length;
    const bugs = literalJson(arrayAt(text, bugsAt));
    const toolsAt = text.indexOf("toolResults:[", bugsAt);
    const tools = arrayAt(text, toolsAt + "toolResults:".length);
    const href = /name:"Greptile",href:"(https:\/\/github\.com\/ai-code-review-evaluation\/[^"/]+\/pulls)"/.exec(tools)?.[1];
    if (!href || bugs.length !== 10) throw new Error(`${id}: expected ten Greptile bugs and a public review fork`);
    for (const bug of bugs) {
      if (!Number.isInteger(bug.prNumber) || !bug.prTitle || !bug.bugDescription || !bug.severity) throw new Error(`${id}: incomplete original Greptile label`);
      rows.push({ ...bug, dataset: id, ...repo, prUrl: `${href.slice(0, -1)}/${bug.prNumber}` });
    }
  }
  if (rows.length !== 50 || new Set(rows.map((r) => r.prUrl)).size !== 50) throw new Error("Greptile's source does not name fifty distinct reconstructed pull requests");
  return rows;
}

export function greptileEntryProblems(entry, expected = entry.change) {
  const out = [];
  const link = /^https:\/\/github\.com\/(ai-code-review-evaluation\/[^/]+-greptile)\/pull\/(\d+)$/.exec(expected?.prUrl ?? "");
  if (expected?.kind !== "defect-bearing" || !link || entry.prUrl !== expected.prUrl || entry.repo !== link[1] || entry.cloneUrl !== `https://github.com/${link[1]}.git` || entry.prRef !== `refs/pull/${link[2]}/head` || entry.baseSha !== expected.baseSha || entry.headSha !== expected.headSha || entry.baseSha === entry.headSha) out.push("the change is not the pinned defect-bearing reconstructed pull request; an upstream fix is refused");
  if (!/^[0-9a-f]{40}$/.test(expected?.baseSha ?? "") || !/^[0-9a-f]{40}$/.test(expected?.headSha ?? "")) out.push("the defect-bearing change has no pinned base and head commits");
  if (!expected?.source?.file || !/^[0-9a-f]{64}$/.test(expected.source.sha256 ?? "") || expected.source.revision !== expected.headSha || expected.source.url !== expected.prUrl || !/^\d{4}-\d{2}-\d{2}$/.test(expected.source.readDate ?? "")) out.push("the defect-bearing change has no pinned metadata source");
  const sets = entry.truthSets;
  if (!sets || Object.keys(sets).sort().join(",") !== "augment,greptile") out.push("both truth sets must be recorded apart as greptile and augment");
  for (const name of ["greptile", "augment"]) {
    const set = sets?.[name];
    if (set?.kind !== "prose" || !Number.isInteger(set.items) || set.items < 1 || !/^[0-9a-f]{64}$/.test(set.hash ?? "") || !set.source?.url || !set.source?.revision || !/^\d{4}-\d{2}-\d{2}$/.test(set.source?.readDate ?? "") || !set.file || !/^[0-9a-f]{64}$/.test(set.sha256 ?? "")) out.push(`${name}: both truth sets need their own count, hash and pinned source`);
  }
  if (sets?.greptile?.items !== 1 || sets?.greptile?.file === sets?.augment?.file || sets?.greptile?.source?.url === sets?.augment?.source?.url) out.push("the original and corrected truth sets are not kept apart");
  return out;
}

// Verify the commits against the independently pinned GitHub response,
// before a clone is fetched. Changing both the entry and its change record
// must not turn an upstream fix into a defect-bearing case.
export function checkGreptileChange(c, cache) {
  const pin = c.change.source;
  const bytes = readFileSync(join(cache, "raw", "greptile", pin.file));
  if (createHash("sha256").update(bytes).digest("hex") !== pin.sha256) throw new Error(`${c.id}: fork metadata differs from its pin`);
  const rows = JSON.parse(bytes);
  const matches = rows.filter((p) => p.html_url === c.source.prUrl);
  if (matches.length !== 1 || matches[0].base.sha !== c.materialise.baseSha || matches[0].head.sha !== c.materialise.headSha) throw new Error(`${c.id}: the change is not the pinned defect-bearing reconstructed pull request; an upstream fix is refused`);
}
