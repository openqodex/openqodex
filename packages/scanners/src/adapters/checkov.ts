// Checkov adapter (infrastructure misconfiguration). Runs `checkov -d` on a
// staging copy of the change's infrastructure files (iac.ts), with its
// terraform, cloudformation and kubernetes frameworks only: helm and
// kustomize start external programs, and secrets, dependency and image
// scanning are other scanners' work.
//
// Checkov runs offline and alone, each switch checked against the 3.3.22
// source and a proxy that logs every host it opens:
// --skip-download: nothing is fetched from the Prisma Cloud platform (no API
// key is ever passed, so nothing is uploaded either, and
// --skip-results-upload says so again); --download-external-modules false:
// no Terraform module is fetched; CKV_SKIP_PACKAGE_UPDATE_CHECK=true: no
// version lookup on pypi.org, which checkov otherwise makes on every start.
// It gets a home and a temporary folder of its own, so neither the
// developer's ~/.checkov.yaml nor any cache of theirs is read, and the
// staging copy never holds a `.checkov.yaml` (iac.ts): a config file can name
// a folder or a git repository of Python checks, which checkov runs. Its PATH
// is its own environment's bin folder only, so it can start no other
// program. A Terraform folder whose module source leaves the repository is
// not handed to it, since checkov reads a local module from disk wherever it
// points.
//
// Without the platform, checkov gives no severity: every finding is medium.
// Each is anchored to the attributes its evaluated keys name (iac.ts).
//
// All errors are captured into the result; the runner never throws on a
// scanner failure: static analysis is additive context, not a gate.

import path from "node:path";
import type { AdapterResult, DiffCoverage, ResolvedTool, StaticFinding } from "@openqodex/core";
import { describeFailure, execTool, stderrTail } from "../exec.js";
import type { RepoFacts } from "../detect.js";
import type { Scratch } from "../scratch.js";
import type { Adapter } from "./index.js";
import { fileTexts, folderOf, folderVerdict, iacKind, indexFile, isTerraformPath, stagedPath, withStage } from "./iac.js";
import { folderList, suchAs } from "./words.js";

const CHECKOV_TIMEOUT_MS = 180_000;
const CHECKOV_OUTPUT_MAX_BYTES = 32 * 1024 * 1024;

const checkovFiles = (changedPaths: string[], facts: RepoFacts): string[] => changedPaths.filter((p) => iacKind(p, facts) !== null);

export async function runCheckov(args: {
  repoDir: string;
  changedPaths: string[];
  tool: ResolvedTool | null;
  facts: RepoFacts;
  coverage?: DiffCoverage;
  scratch: Scratch;
}): Promise<AdapterResult> {
  const files = checkovFiles(args.changedPaths, args.facts);
  if (files.length === 0) return { findings: [], error: null };
  if (!args.tool) return { findings: [], error: "not installed" };
  const tool = args.tool;

  const folders: string[] = [];
  const held: string[] = [];
  for (const folder of [...new Set(files.filter(isTerraformPath).map(folderOf))].sort()) {
    if ((await folderVerdict(args.repoDir, folder)).checkov) folders.push(folder);
    else held.push(folder);
  }
  const others = files.filter((p) => !isTerraformPath(p));
  const heldNote = held.length > 0 ? `not run on ${folderList(held)}: a module path that leaves the repository, which checkov would read, or a Terraform file not read for certain` : null;
  if (folders.length === 0 && others.length === 0) return { findings: [], error: null, skipped: heldNote };

  try {
    return await withStage(args.scratch.temp, args.repoDir, folders, others, async (stage) => {
      const cliArgs = [
        "-d",
        stage.tree,
        "--framework",
        "terraform,cloudformation,kubernetes",
        "--skip-download",
        "--skip-results-upload",
        "--download-external-modules",
        "false",
        "--output",
        "json",
        "--quiet",
        "--compact",
        "--soft-fail",
      ];
      const result = await execTool(tool.path, cliArgs, {
        cwd: stage.root,
        timeoutMs: CHECKOV_TIMEOUT_MS,
        maxBytes: CHECKOV_OUTPUT_MAX_BYTES,
        // CKV_IGNORE_HIDDEN_DIRECTORIES=false: checkov's Kubernetes runner
        // skips a file whose absolute path holds "/." anywhere, so a staging
        // folder under a hidden temporary folder (~/.cache/tmp) would hide
        // every manifest. The stage holds only the files chosen for it. The
        // scratch's variables first (none on the laptop): on a server run,
        // no bytecode written into the install root.
        env: {
          ...args.scratch.env,
          PATH: path.dirname(tool.path),
          HOME: stage.home,
          TMPDIR: stage.tmp,
          CKV_SKIP_PACKAGE_UPDATE_CHECK: "true",
          CKV_IGNORE_HIDDEN_DIRECTORIES: "false",
        },
      });
      const failed = describeFailure("checkov", result, CHECKOV_TIMEOUT_MS);
      if (failed) throw new Error(failed);
      if (result.exitCode !== 0) throw new Error(`checkov exit ${result.exitCode}: ${stderrTail(result)}`);
      let raw: CheckovFinding[];
      try {
        raw = parseCheckovJson(result.stdout, tool.version);
      } catch (err) {
        throw new Error(`parse: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`);
      }
      return { findings: await anchorKeys(args.repoDir, raw, args.coverage), error: null, note: heldNote };
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { findings: [], error: message.slice(0, 300) };
  }
}

// A finding on the resource's lines, with the keys checkov evaluated.
export type CheckovFinding = StaticFinding & { keys: string[] };

// Each finding on the attributes checkov evaluated, one range each. With the
// changed lines known, the span runs over the ranges a changed line touches,
// so a change to a line between two of them (an attribute checkov did not
// evaluate) keeps no finding; with none touched it is the first range, which
// the changed-line filter then drops. A whole-repository scan spans them all.
async function anchorKeys(repoDir: string, findings: CheckovFinding[], coverage?: DiffCoverage): Promise<StaticFinding[]> {
  const texts = fileTexts(repoDir);
  const indexes = new Map<string, ReturnType<typeof indexFile> | null>();
  const out: StaticFinding[] = [];
  for (const { keys, ...f } of findings) {
    if (!indexes.has(f.filePath)) {
      const text = await texts(f.filePath);
      indexes.set(f.filePath, text === null ? null : indexFile(text, f.filePath));
    }
    const index = indexes.get(f.filePath);
    const ranges = index ? index.anchorRanges(f.lineStart, f.lineEnd, keys) : [[f.lineStart, f.lineStart] as [number, number]];
    const changed = coverage?.get(f.filePath);
    let chosen = ranges;
    if (coverage !== undefined) {
      const touched = ranges.filter(([from, to]) => [...(changed ?? [])].some((line) => from <= line && line <= to));
      chosen = touched.length > 0 ? touched : ranges.slice(0, 1);
    }
    out.push({ ...f, lineStart: Math.min(...chosen.map((r) => r[0])), lineEnd: Math.max(...chosen.map((r) => r[1])) });
  }
  return out;
}

export const checkov: Adapter = {
  source: "checkov",
  files: checkovFiles,
  why: (files) => `Terraform, Kubernetes or CloudFormation files, ${suchAs(files)}`,
  run: (args) => runCheckov(args),
};

type CheckovCheck = {
  check_id?: unknown;
  check_name?: unknown;
  file_path?: unknown;
  file_line_range?: unknown;
  check_class?: unknown;
  guideline?: unknown;
  check_result?: { evaluated_keys?: unknown };
};

const POLICY_INDEX: Record<string, string> = {
  terraform: "https://www.checkov.io/5.Policy%20Index/terraform.html",
  cloudformation: "https://www.checkov.io/5.Policy%20Index/cloudformation.html",
  kubernetes: "https://www.checkov.io/5.Policy%20Index/kubernetes.html",
};

// The failed checks of a `checkov -o json` report (one report object, or a
// list of one per framework), each on the resource's lines, with the keys it
// evaluated. A check written in Python is referenced by its source at the
// pinned version; a graph check by checkov's policy index.
export function parseCheckovJson(json: string, version: string): CheckovFinding[] {
  if (!json.trim()) return [];
  const parsed: unknown = JSON.parse(json);
  const reports = Array.isArray(parsed) ? parsed : [parsed];
  const out: CheckovFinding[] = [];
  for (const report of reports as { check_type?: unknown; results?: { failed_checks?: unknown } }[]) {
    if (!report || typeof report !== "object" || !Array.isArray(report.results?.failed_checks)) continue;
    const framework = typeof report.check_type === "string" ? report.check_type : "";
    for (const c of report.results.failed_checks as CheckovCheck[]) {
      if (!c || typeof c.check_id !== "string" || !c.check_id || typeof c.file_path !== "string") continue;
      const range = Array.isArray(c.file_line_range) ? c.file_line_range : [];
      const start = typeof range[0] === "number" && range[0] > 0 ? Math.floor(range[0]) : 1;
      const end = typeof range[1] === "number" ? Math.max(start, Math.floor(range[1])) : start;
      const keys = Array.isArray(c.check_result?.evaluated_keys) ? (c.check_result.evaluated_keys as unknown[]).filter((k): k is string => typeof k === "string") : [];
      out.push({
        source: "checkov",
        ruleId: c.check_id,
        filePath: stagedPath(c.file_path),
        lineStart: start,
        lineEnd: end,
        severity: "medium",
        message: trimMessage(typeof c.check_name === "string" && c.check_name ? c.check_name : c.check_id),
        reference: referenceFor(c, framework, version),
        keys,
      });
    }
  }
  return out;
}

function referenceFor(c: CheckovCheck, framework: string, version: string): string | null {
  if (typeof c.guideline === "string" && c.guideline.startsWith("https://")) return c.guideline;
  const cls = typeof c.check_class === "string" ? c.check_class : "";
  // checkov.terraform.checks.resource.aws.SecurityGroupUnrestrictedIngress22
  if (/^checkov\.[a-z_]+\.checks\.[A-Za-z0-9_.]+$/.test(cls) && /^\d+\.\d+\.\d+$/.test(version)) {
    return `https://github.com/bridgecrewio/checkov/blob/${version}/${cls.split(".").join("/")}.py`;
  }
  return POLICY_INDEX[framework] ?? null;
}

function trimMessage(m: string): string {
  const collapsed = m.replace(/\s+/g, " ").trim();
  return collapsed.length > 500 ? collapsed.slice(0, 497) + "..." : collapsed;
}
