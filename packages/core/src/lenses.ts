// A lens is a named bug pattern the review brief hands to the agent when the
// change matches the lens's triggers. Each lens is a markdown file with YAML
// frontmatter in the package's `lenses/` folder, so adding a pattern is a
// file, not a prompt edit.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "yaml";
import { unquoteDiffPath } from "./diff.js";
import { matchesGlob, MAX_GLOB } from "./glob.js";
import type { Change, SelectedLens } from "./types.js";

export type LensTriggers = {
  // File globs (matchesGlob syntax: *, **, ?). When set, the lens fires only
  // if at least one changed file matches one of them. Unset means any file.
  files?: string[];
  // Regex run, case-insensitive, against the changed-line text of the diff
  // (the `+` and `-` lines, file headers stripped). Unset means any text.
  hunkRegex?: string;
  // Require adjacent removed and added lines in a matching file's hunk.
  replacedLines?: boolean;
};

// `coveredBy`: scanner rules ("<source>:<ruleId>") that check what the lens
// asks the reviewer to look for. When a scanner ran such a rule on every
// changed file the lens's file globs match, the lens stands down: a script
// does the deterministic work, the model does not repeat it. `security`:
// true for a lens about a security flaw (`security: true` in its
// frontmatter); absent otherwise.
export type Lens = SelectedLens & { triggers: LensTriggers; coveredBy?: string[]; security?: true };

// Whether a scanner rule ran on a file in this run.
export type RuleCoverage = (token: string, file: string) => boolean;

const DEFAULT_CONFIDENCE_FLOOR = 0.7;

// Most lenses the brief carries. Each one adds its whole body to what the
// agent reads, so a broad change that trips a dozen lenses keeps only the
// most specific ones.
const MAX_LENSES = 4;

// Parse one lens file: YAML frontmatter between the first two `---` lines,
// the body after. A file saved with Windows line ends (\r\n) parses the
// same. Throws on a missing field so a broken lens fails loudly.
export function parseLens(text: string): Lens {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text);
  if (!match) {
    throw new Error("lens file is missing YAML frontmatter delimited by `---` lines");
  }
  const fm: unknown = yaml.parse(match[1] ?? "");
  const body = (match[2] ?? "").trim();
  if (!fm || typeof fm !== "object") {
    throw new Error("lens frontmatter must be a YAML mapping");
  }
  const obj = fm as Record<string, unknown>;
  const name = typeof obj.name === "string" ? obj.name.trim() : "";
  if (!name) throw new Error("lens frontmatter missing `name`");
  const description = typeof obj.description === "string" ? obj.description.trim() : "";
  if (!description) {
    throw new Error(`lens ${name}: frontmatter missing \`description\``);
  }
  const triggersRaw =
    obj.triggers && typeof obj.triggers === "object"
      ? (obj.triggers as Record<string, unknown>)
      : {};
  const files = Array.isArray(triggersRaw.files)
    ? triggersRaw.files.filter((x): x is string => typeof x === "string")
    : undefined;
  for (const glob of files ?? []) {
    if (glob.length > MAX_GLOB) {
      throw new Error(`lens ${name}: trigger file glob exceeds ${MAX_GLOB} characters: ${JSON.stringify(glob)}`);
    }
  }
  const hunkRegex = typeof triggersRaw.hunk_regex === "string" ? triggersRaw.hunk_regex : undefined;
  if (triggersRaw.replaced_lines !== undefined && typeof triggersRaw.replaced_lines !== "boolean") {
    throw new Error(`lens ${name}: replaced_lines must be a boolean`);
  }
  const replacedLines = triggersRaw.replaced_lines as boolean | undefined;
  const confidenceFloor =
    typeof obj.confidence_floor === "number" && Number.isFinite(obj.confidence_floor)
      ? Math.max(0, Math.min(1, obj.confidence_floor))
      : DEFAULT_CONFIDENCE_FLOOR;
  if (hunkRegex) {
    try {
      new RegExp(hunkRegex, "i");
    } catch (err) {
      throw new Error(`lens ${name}: hunk_regex is not a valid regex: ${(err as Error).message}`);
    }
  }
  if (!body) throw new Error(`lens ${name}: body is empty`);
  const coveredBy = Array.isArray(obj.covered_by) ? obj.covered_by.filter((x): x is string => typeof x === "string") : undefined;
  return { name, description, triggers: { files, hunkRegex, replacedLines }, confidenceFloor, body, ...(coveredBy ? { coveredBy } : {}), ...(obj.security === true ? { security: true as const } : {}) };
}

// The first candidate that is a directory holding at least one `.md` file.
// The `.md` probe matters: the folder of the bundled CLI exists but holds
// JavaScript, not the lenses.
export function pickLensDirFromCandidates(candidates: string[]): string {
  for (const c of candidates) {
    try {
      if (existsSync(c) && statSync(c).isDirectory() && readdirSync(c).some((e) => e.endsWith(".md"))) {
        return c;
      }
    } catch {
      // try the next one
    }
  }
  throw new Error(`lens catalog directory not found; checked: ${candidates.join(", ")}`);
}

// Found from this module's own location, never the current directory:
// `<here>/lenses` when the lenses sit beside the code, `<here>/../lenses` for
// the package root in the workspace (core's src/ or dist/) and for the
// bundled CLI (packages/cli/dist/bin.js with the lenses copied beside dist/).
export function defaultLensDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return pickLensDirFromCandidates([join(here, "lenses"), join(here, "..", "lenses")]);
}

// Read and parse every `.md` file in a folder, sorted by name.
export function loadLensCatalog(dir?: string): Lens[] {
  const lensDir = dir ?? defaultLensDir();
  const lenses: Lens[] = [];
  for (const entry of readdirSync(lensDir)) {
    if (!entry.endsWith(".md")) continue;
    const raw = readFileSync(join(lensDir, entry), "utf8");
    try {
      lenses.push(parseLens(raw));
    } catch (err) {
      throw new Error(`failed to parse lens ${entry}: ${(err as Error).message}`);
    }
  }
  return lenses.sort((a, b) => a.name.localeCompare(b.name));
}

const catalogs = new Map<string, Lens[]>();

function cachedCatalog(dir?: string): Lens[] {
  const lensDir = dir ?? defaultLensDir();
  let catalog = catalogs.get(lensDir);
  if (!catalog) {
    catalog = loadLensCatalog(lensDir);
    catalogs.set(lensDir, catalog);
  }
  return catalog;
}

// The changed-line text of a unified diff: every `+` or `-` line except the
// `+++ ` and `--- ` file headers, one per row.
export function extractChangedLineText(diff: string): string {
  const out: string[] = [];
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ") || line.startsWith("--- ")) continue;
    if (line.startsWith("+") || line.startsWith("-")) out.push(line.slice(1));
  }
  return out.join("\n");
}

function fileTriggerMatches(files: string[], globs?: string[]): boolean {
  if (!globs || globs.length === 0) return true;
  return files.some((path) => globs.some((g) => matchesGlob(path, g)));
}

function hunkTriggerMatches(text: string, hunkRegex?: string): boolean {
  if (!hunkRegex) return true;
  return new RegExp(hunkRegex, "i").test(text);
}

// Files with adjacent removed and added lines in the same hunk. Headers,
// context and hunk boundaries cannot pair lines from separate edits.
function replacedLineFiles(diff: string): string[] {
  const files = new Set<string>();
  let file: string | null = null;
  let inHunk = false;
  let previous = "";
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      file = null;
      inHunk = false;
      previous = "";
    } else if (!inHunk && line.startsWith("+++ ")) {
      const target = unquoteDiffPath(line.slice(4).replace(/\t$/, ""));
      file = target === "/dev/null" ? null : target.startsWith("b/") ? target.slice(2) : target;
    } else if (line.startsWith("@@")) {
      inHunk = true;
      previous = "";
    } else if (inHunk && file) {
      if (line.startsWith("\\")) continue;
      const marker = line[0] ?? "";
      if ((marker === "+" && previous === "-") || (marker === "-" && previous === "+")) files.add(file);
      previous = marker === "+" || marker === "-" ? marker : "";
    }
  }
  return [...files];
}

// How targeted a lens is: one point for a content or replacement trigger,
// one for file globs.
function specificity(lens: Lens): number {
  let score = 0;
  if (lens.triggers.hunkRegex || lens.triggers.replacedLines) score += 1;
  if (lens.triggers.files && lens.triggers.files.length > 0) score += 1;
  return score;
}

// True when a scanner ran one of the lens's covering rules on every changed
// file the lens's globs match (every changed file, for a lens without globs).
function coveredByScanner(lens: Lens, files: string[], covered?: RuleCoverage): boolean {
  if (!covered || !lens.coveredBy || lens.coveredBy.length === 0) return false;
  const globs = lens.triggers.files;
  const mine = globs && globs.length > 0 ? files.filter((path) => globs.some((g) => matchesGlob(path, g))) : files;
  return mine.length > 0 && mine.every((file) => lens.coveredBy!.some((token) => covered(token, file)));
}

// The lenses whose triggers all match and that no scanner rule already
// covered, most specific first, then lower confidence floor first (a noisy
// lens raises its own floor), then by name, capped at four.
export function selectLensesForDiff(args: { diff: string; files: string[]; catalog: Lens[]; covered?: RuleCoverage }): SelectedLens[] {
  const text = extractChangedLineText(args.diff);
  const replacements = args.catalog.some((lens) => lens.triggers.replacedLines)
    ? replacedLineFiles(args.diff).filter((file) => args.files.includes(file))
    : [];
  const matched = args.catalog.filter(
    (lens) =>
      fileTriggerMatches(args.files, lens.triggers.files) &&
      hunkTriggerMatches(text, lens.triggers.hunkRegex) &&
      (!lens.triggers.replacedLines || (replacements.length > 0 && fileTriggerMatches(replacements, lens.triggers.files))) &&
      !coveredByScanner(lens, args.files, args.covered),
  );
  const ranked = [...matched].sort((a, b) => {
    const delta = specificity(b) - specificity(a);
    if (delta !== 0) return delta;
    if (a.confidenceFloor !== b.confidenceFloor) return a.confidenceFloor - b.confidenceFloor;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  return ranked.slice(0, MAX_LENSES).map((lens) => ({
    name: lens.name,
    description: lens.description,
    confidenceFloor: lens.confidenceFloor,
    body: lens.body,
  }));
}

export function selectLenses(change: Change, dir?: string, covered?: RuleCoverage): SelectedLens[] {
  return selectLensesForDiff({
    diff: change.diff,
    files: change.files.map((f) => f.path),
    catalog: cachedCatalog(dir),
    covered,
  });
}
