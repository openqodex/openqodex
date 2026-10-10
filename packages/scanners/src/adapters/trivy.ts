// trivy adapter (infrastructure misconfiguration). Runs `trivy config` on a
// staging copy of the change's infrastructure files (iac.ts): the folder of
// each changed Terraform file, and each changed Kubernetes object and
// CloudFormation template. Misconfiguration checks only, never trivy's
// vulnerability, secret or image scanning, and only its terraform,
// cloudformation and kubernetes checks: Dockerfiles are hadolint's, and a Helm
// template is not YAML until Helm renders it.
//
// trivy downloads every Terraform module that is not a local path, through
// the registry or by starting git, and has no switch to stop it (checked
// against the 0.75.0 source: the terraform parser allows downloads and
// `trivy config` never turns that off). So a folder whose Terraform names
// such a module is never handed to trivy (iac.ts, moduleVerdict); checkov and
// tflint still read it. trivy gets no PATH, so it can start no program, and a
// home, temporary folder, cache and module folder of its own that are removed
// after the run: no check bundle, no WebAssembly module and no setting of the
// developer's own trivy is loaded, and it uses the checks built into the
// pinned binary.
//
// All errors are captured into the result; the runner never throws on a
// scanner failure: static analysis is additive context, not a gate.

import path from "node:path";
import type { AdapterResult, ResolvedTool, ScannerSeverity, StaticFinding } from "@openqodex/core";
import { describeFailure, execTool, stderrTail } from "../exec.js";
import type { RepoFacts } from "../detect.js";
import type { Scratch } from "../scratch.js";
import type { Adapter } from "./index.js";
import { fileTexts, folderOf, folderVerdict, iacKind, indexFile, isTerraformPath, stagedPath, withStage } from "./iac.js";
import { repoFileOrReason } from "./read.js";
import { folderList, suchAs } from "./words.js";

const TRIVY_TIMEOUT_MS = 120_000;
const TRIVY_OUTPUT_MAX_BYTES = 32 * 1024 * 1024;

const trivyFiles = (changedPaths: string[], facts: RepoFacts): string[] => changedPaths.filter((p) => iacKind(p, facts) !== null);

export async function runTrivy(args: {
  repoDir: string;
  changedPaths: string[];
  tool: ResolvedTool | null;
  facts: RepoFacts;
  scratch: Scratch;
}): Promise<AdapterResult> {
  const files = trivyFiles(args.changedPaths, args.facts);
  if (files.length === 0) return { findings: [], error: null };
  if (!args.tool) return { findings: [], error: "not installed" };
  const tool = args.tool;

  const folders: string[] = [];
  const held: string[] = [];
  for (const folder of [...new Set(files.filter(isTerraformPath).map(folderOf))].sort()) {
    if ((await folderVerdict(args.repoDir, folder)).trivy) folders.push(folder);
    else held.push(folder);
  }
  const others = files.filter((p) => !isTerraformPath(p));
  const heldNote = held.length > 0 ? `not run on ${folderList(held)}: a module from outside the repository, which trivy would download or read, or a Terraform file not read for certain` : null;
  if (folders.length === 0 && others.length === 0) return { findings: [], error: null, skipped: heldNote };

  try {
    return await withStage(args.scratch.temp, args.repoDir, folders, others, async (stage) => {
      // The repository's own ignore list, at its root, as trivy reads it from
      // the folder it runs in: a list of check ids, nothing it can run.
      const ignore = await repoFileOrReason(args.repoDir, ".trivyignore", 1024 * 1024).catch(() => ({ reason: "absent" }));
      const cliArgs = [
        "config",
        "--format",
        "json",
        "--quiet",
        // An empty value: no trivy.yaml is loaded from anywhere.
        "--config",
        "",
        "--cache-dir",
        path.join(stage.root, "cache"),
        "--module-dir",
        path.join(stage.root, "modules"),
        "--ignorefile",
        "path" in ignore ? ignore.path : "",
        "--disable-telemetry",
        "--skip-version-check",
        "--skip-check-update",
        "--misconfig-scanners",
        "terraform,cloudformation,kubernetes",
        "--",
        stage.tree,
      ];
      const result = await execTool(tool.path, cliArgs, {
        cwd: stage.root,
        timeoutMs: TRIVY_TIMEOUT_MS,
        maxBytes: TRIVY_OUTPUT_MAX_BYTES,
        env: { ...tool.env, PATH: "", HOME: stage.home, TMPDIR: stage.tmp },
      });
      const failed = describeFailure("trivy", result, TRIVY_TIMEOUT_MS);
      if (failed) throw new Error(failed);
      if (result.exitCode !== 0) throw new Error(`trivy exit ${result.exitCode}: ${stderrTail(result)}`);
      let raw: StaticFinding[];
      try {
        raw = parseTrivyJson(result.stdout);
      } catch (err) {
        throw new Error(`parse: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`);
      }
      const findings = await anchorCauses(args.repoDir, raw);
      return { findings, error: null, note: heldNote };
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { findings: [], error: message.slice(0, 300) };
  }
}

// A cause that is a whole block (a resource with an attribute missing, a
// container) is anchored to the block's first line, so a change elsewhere in
// the block does not bring it back; a cause on one attribute keeps its lines.
async function anchorCauses(repoDir: string, findings: StaticFinding[]): Promise<StaticFinding[]> {
  const texts = fileTexts(repoDir);
  const indexes = new Map<string, ReturnType<typeof indexFile> | null>();
  const out: StaticFinding[] = [];
  for (const f of findings) {
    if (!indexes.has(f.filePath)) {
      const text = await texts(f.filePath);
      indexes.set(f.filePath, text === null ? null : indexFile(text, f.filePath));
    }
    const index = indexes.get(f.filePath);
    const [lineStart, lineEnd] = index ? index.blockCause(f.lineStart, f.lineEnd) : [f.lineStart, f.lineEnd];
    out.push({ ...f, lineStart, lineEnd });
  }
  return out;
}

export const trivy: Adapter = {
  source: "trivy",
  files: trivyFiles,
  why: (files) => `Terraform, Kubernetes or CloudFormation files, ${suchAs(files)}`,
  run: (args) => runTrivy(args),
};

type TrivyMisconfiguration = {
  ID?: unknown;
  Title?: unknown;
  Message?: unknown;
  Severity?: unknown;
  Status?: unknown;
  PrimaryURL?: unknown;
  CauseMetadata?: { StartLine?: unknown; EndLine?: unknown };
};

type TrivyResult = { Target?: unknown; Class?: unknown; Misconfigurations?: unknown };

// The failed checks of a `trivy config --format json` report, each on its
// cause's lines; a check with no line is on line 1 (the file as a whole).
export function parseTrivyJson(json: string): StaticFinding[] {
  if (!json.trim()) return [];
  const parsed = JSON.parse(json) as { Results?: unknown };
  if (!parsed || !Array.isArray(parsed.Results)) return [];
  const out: StaticFinding[] = [];
  for (const result of parsed.Results as TrivyResult[]) {
    if (!result || typeof result.Target !== "string" || !Array.isArray(result.Misconfigurations)) continue;
    const filePath = stagedPath(result.Target);
    for (const m of result.Misconfigurations as TrivyMisconfiguration[]) {
      if (!m || m.Status !== "FAIL" || typeof m.ID !== "string" || !m.ID) continue;
      const start = numberOrZero(m.CauseMetadata?.StartLine);
      const lineStart = start > 0 ? start : 1;
      const lineEnd = Math.max(lineStart, numberOrZero(m.CauseMetadata?.EndLine));
      const title = typeof m.Title === "string" ? m.Title.trim().replace(/\.$/, "") : "";
      const message = typeof m.Message === "string" ? m.Message.trim() : "";
      out.push({
        source: "trivy",
        ruleId: m.ID,
        filePath,
        lineStart,
        lineEnd,
        severity: severityOf(m.Severity),
        message: trimMessage(title && message ? `${title}: ${message}` : title || message || m.ID),
        reference: typeof m.PrimaryURL === "string" && m.PrimaryURL ? m.PrimaryURL : null,
      });
    }
  }
  return out;
}

function severityOf(raw: unknown): ScannerSeverity {
  switch (typeof raw === "string" ? raw.toUpperCase() : "") {
    case "CRITICAL":
      return "critical";
    case "HIGH":
      return "high";
    case "MEDIUM":
      return "medium";
    case "LOW":
      return "low";
    default:
      return "info";
  }
}

function numberOrZero(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : 0;
}

function trimMessage(m: string): string {
  const collapsed = m.replace(/\s+/g, " ").trim();
  return collapsed.length > 500 ? collapsed.slice(0, 497) + "..." : collapsed;
}
