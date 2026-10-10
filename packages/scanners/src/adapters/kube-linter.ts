// kube-linter adapter (Kubernetes object checks): privileged containers,
// containers run as root, host namespaces and mounts, missing resource
// limits, wildcard RBAC rules. Runs
// `kube-linter lint --config <owned config> --format json -- <files>` on the
// changed YAML files whose content is a Kubernetes object (detect.ts: a
// top-level apiVersion and kind, not a Helm template), from the repository
// root.
//
// The checks come from a config OpenQodex writes, never the repo's
// .kube-linter.yaml: a custom check there can use kube-linter's kubeconform
// template, whose schemaLocations fetch from any URL the repo names and
// whose cache folder is created and written wherever the repo says. The set
// is kube-linter 0.8.3's default set less the two checks that need other
// objects of the same folder (dangling-service, non-existent-service-account:
// OpenQodex passes only the changed files, so a Service or a service account
// in an unchanged file reads as missing), plus four security checks off by
// default that report only what they name (wildcard-in-rules,
// cluster-admin-role-binding, writable-host-mount, unsafe-proc-mount).
// `--add-all-built-in` is not used: on five public manifests (argo-cd,
// cert-manager, ingress-nginx, microservices-demo, guestbook) it added 881
// sorted-keys reports and organisation rules such as required-label-owner.
// Its schema-validation check would download schemas; kubeconform does that,
// pinned.
//
// kube-linter reports an object and a message, never a line. Each finding is
// anchored to the line of the field its check is about (kube-yaml.ts), so it
// is kept only when the change touched that field. kube-linter writes
// nothing and opens no connection with this config. All errors are captured
// into the result; the runner never throws on a scanner failure.

import fs from "node:fs";
import path from "node:path";
import type { AdapterResult, ResolvedTool, ScannerSeverity, StaticFinding } from "@openqodex/core";
import type { RepoFacts } from "../detect.js";
import { describeFailure, execTool, runInChunks, stderrTail } from "../exec.js";
import { safeFileArgs } from "../safe-args.js";
import type { Adapter } from "./index.js";
import { anchorLine, findDocument, kubeDocuments, type Anchor, type KubeDoc } from "./kube-yaml.js";
import { withOwnedConfig } from "./owned-config.js";
import type { Scratch } from "../scratch.js";
import { readRepoFile } from "./read.js";
import { suchAs } from "./words.js";

const KUBE_LINTER_TIMEOUT_MS = 60_000;
const KUBE_LINTER_OUTPUT_MAX_BYTES = 16 * 1024 * 1024;
// A manifest bigger than this is not read for anchoring; its findings land
// on line 1.
const MANIFEST_MAX_BYTES = 16 * 1024 * 1024;

const container = (...paths: string[][]): ((m: string) => Anchor) => () => ({ base: "container", paths });
const pod = (...paths: string[][]): ((m: string) => Anchor) => () => ({ base: "pod", paths });
const object = (...paths: string[][]): ((m: string) => Anchor) => () => ({ base: "object", paths });
// The anchor, with the value the message names looked for in the field.
const named =
  (base: Anchor["base"], paths: string[][], pattern: RegExp, key?: string, last?: true): ((m: string) => Anchor) =>
  (message) => {
    const text = pattern.exec(message)?.[1];
    return text === undefined ? { base, paths } : { base, paths, value: { text, ...(key ? { key } : {}), ...(last ? { last } : {}) } };
  };

// Each check OpenQodex runs: its severity and where its finding is anchored.
// A field the object lacks (no securityContext, no resources) anchors on the
// nearest ancestor it has: the container's `- name:` line, its
// securityContext, or the object's spec.
const CHECKS: Record<string, { severity: ScannerSeverity; anchor: (message: string) => Anchor }> = {
  "privileged-container": { severity: "high", anchor: container(["securityContext", "privileged"]) },
  "privilege-escalation-container": { severity: "high", anchor: container(["securityContext", "allowPrivilegeEscalation"], ["securityContext", "privileged"]) },
  "unsafe-proc-mount": { severity: "high", anchor: container(["securityContext", "procMount"]) },
  "host-network": { severity: "high", anchor: pod(["hostNetwork"]) },
  "host-pid": { severity: "high", anchor: pod(["hostPID"]) },
  "host-ipc": { severity: "high", anchor: pod(["hostIPC"]) },
  "docker-sock": { severity: "high", anchor: named("pod", [["volumes"]], /directory "([^"]+)"/, "path") },
  "sensitive-host-mounts": { severity: "high", anchor: named("pod", [["volumes"]], /directory "([^"]+)"/, "path") },
  // Writable through the container's mount: anchored there (kube-yaml.ts,
  // writableMountLine), else on the volume's host path.
  "writable-host-mount": {
    severity: "high",
    anchor: (message) => {
      const mount = /mounts path (\S+) on the host/.exec(message)?.[1];
      const volume = named("pod", [["volumes"]], /mounts path (\S+) on the host/, "path")(message);
      return mount === undefined ? volume : { ...volume, mount };
    },
  },
  "unsafe-sysctls": { severity: "high", anchor: named("pod", [["securityContext", "sysctls"]], /sysctl "([^"]+)"/, "name") },
  "cluster-admin-role-binding": { severity: "high", anchor: object(["roleRef", "name"]) },
  "wildcard-in-rules": {
    severity: "high",
    anchor: (message) => {
      const field = /in (resource|verb|apiGroup|resourceName)s? specification/.exec(message)?.[1];
      return { base: "object", paths: [["rules"]], value: { text: "*", ...(field ? { key: `${field}s` } : {}) } };
    },
  },
  "run-as-non-root": { severity: "medium", anchor: container(["securityContext", "runAsNonRoot"], ["securityContext", "runAsUser"]) },
  "no-read-only-root-fs": { severity: "medium", anchor: container(["securityContext", "readOnlyRootFilesystem"]) },
  "drop-net-raw-capability": { severity: "medium", anchor: container(["securityContext", "capabilities"]) },
  "env-var-secret": { severity: "medium", anchor: named("container", [["env"]], /variable (\S+) in container/, "name") },
  "latest-tag": { severity: "medium", anchor: container(["image"]) },
  "ssh-port": { severity: "medium", anchor: named("container", [["ports"]], /port (\d+) and protocol/) },
  "liveness-port": { severity: "medium", anchor: named("container", [["livenessProbe"]], /port (\S+) for/) },
  "readiness-port": { severity: "medium", anchor: named("container", [["readinessProbe"]], /port (\S+) for/) },
  "startup-port": { severity: "medium", anchor: named("container", [["startupProbe"]], /port (\S+) for/) },
  "duplicate-env-var": { severity: "medium", anchor: named("container", [["env"]], /variable (\S+) in container/, "name", true) },
  "mismatching-selector": { severity: "medium", anchor: object(["spec", "selector"]) },
  "invalid-target-ports": {
    severity: "medium",
    anchor: (message) => {
      const text = /"([^"]+)"/.exec(message)?.[1];
      const value = text === undefined ? {} : { value: { text } };
      return /\bin container\b/.test(message) ? { base: "container", paths: [["ports"]], ...value } : { base: "object", paths: [["spec", "ports"]], ...value };
    },
  },
  "no-extensions-v1beta": { severity: "medium", anchor: object(["apiVersion"]) },
  "unset-cpu-requirements": { severity: "low", anchor: container(["resources", "requests", "cpu"], ["resources", "limits", "cpu"]) },
  "unset-memory-requirements": { severity: "low", anchor: container(["resources", "limits", "memory"], ["resources", "requests", "memory"]) },
  "no-anti-affinity": { severity: "low", anchor: object(["spec", "replicas"]) },
  "job-ttl-seconds-after-finished": { severity: "low", anchor: object(["spec", "ttlSecondsAfterFinished"], ["spec", "jobTemplate", "spec", "ttlSecondsAfterFinished"]) },
  "pdb-max-unavailable": { severity: "low", anchor: object(["spec", "maxUnavailable"]) },
  "pdb-min-available": { severity: "low", anchor: object(["spec", "minAvailable"]) },
  "pdb-unhealthy-pod-eviction-policy": { severity: "low", anchor: object(["spec", "unhealthyPodEvictionPolicy"]) },
  "deprecated-service-account-field": { severity: "low", anchor: pod(["serviceAccount"]) },
};

export const KUBE_LINTER_CHECKS: readonly string[] = Object.keys(CHECKS).sort();

// The config OpenQodex hands kube-linter: exactly the checks above, none
// added by a newer release on its own.
export const KUBE_LINTER_CONFIG = `checks:\n  doNotAutoAddDefaults: true\n  include:\n${KUBE_LINTER_CHECKS.map((c) => `    - ${c}\n`).join("")}`;

export function kubernetesFiles(changedPaths: string[], facts: RepoFacts): string[] {
  return changedPaths.filter((p) => facts.content(p) === "kubernetes");
}

// The file texts the anchors are read from, by repo-relative path.
export async function readManifests(repoDir: string, files: string[]): Promise<Map<string, string>> {
  const texts = new Map<string, string>();
  for (const rel of files) {
    try {
      texts.set(path.normalize(rel), await readRepoFile(repoDir, rel, MANIFEST_MAX_BYTES));
    } catch {
      // Unreadable: its findings land on line 1.
    }
  }
  return texts;
}

export async function runKubeLinter(args: {
  repoDir: string;
  changedPaths: string[];
  tool: ResolvedTool | null;
  facts: RepoFacts;
  scratch: Scratch;
}): Promise<AdapterResult> {
  const files = kubernetesFiles(args.changedPaths, args.facts);
  if (files.length === 0) return { findings: [], error: null };
  if (!args.tool) return { findings: [], error: "not installed" };
  const tool = args.tool;
  const texts = await readManifests(args.repoDir, files);
  let realRepoDir: string | undefined;
  try {
    realRepoDir = fs.realpathSync(args.repoDir);
  } catch {
    // The plain spelling is enough.
  }
  try {
    const findings = await withOwnedConfig(args.scratch.temp, "kube-linter.yaml", KUBE_LINTER_CONFIG, (configPath) =>
      runInChunks("kube-linter", safeFileArgs(files), KUBE_LINTER_TIMEOUT_MS, async (chunk, left) => {
        // --config: the owned config, so the repo's .kube-linter.yaml is
        // never looked for. -- ends the flags before the file names.
        const run = await execTool(tool.path, ["lint", "--config", configPath, "--format", "json", "--", ...chunk], {
          cwd: args.repoDir,
          timeoutMs: left,
          maxBytes: KUBE_LINTER_OUTPUT_MAX_BYTES,
          env: tool.env,
        });
        const failed = describeFailure("kube-linter", run, KUBE_LINTER_TIMEOUT_MS);
        if (failed) throw new Error(failed);
        // Exit 1 with a report: findings. Exit 0 with nothing printed: no
        // object it could read (a warning on stderr). Anything else failed.
        if (!run.stdout.trim()) {
          if (run.exitCode === 0) return [];
          throw new Error(`kube-linter exit ${run.exitCode}: ${stderrTail(run)}`);
        }
        try {
          return parseKubeLinterJson(run.stdout, { repoDir: args.repoDir, realRepoDir, text: (rel) => texts.get(rel) ?? null });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          throw new Error(`parse: exit ${run.exitCode}, ${message.slice(0, 200)}`);
        }
      }),
    );
    return { findings, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { findings: [], error: message.slice(0, 300) };
  }
}

export const kubeLinter: Adapter = {
  source: "kube-linter",
  files: (changedPaths, facts) => safeFileArgs(kubernetesFiles(changedPaths, facts)),
  why: (files) => `Kubernetes manifests, ${suchAs(files)}`,
  run: (args) => runKubeLinter(args),
};

// A path the scanner printed, made repo-relative when it lies inside the
// repo under either spelling of its root; left as it is otherwise.
export function repoRelative(file: string, repoDir: string, realRepoDir?: string): string {
  if (!path.isAbsolute(file)) return path.normalize(file);
  for (const root of [repoDir, realRepoDir]) {
    if (root === undefined) continue;
    const rel = path.relative(root, file);
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return rel;
  }
  return file;
}

type KubeLinterReport = {
  Diagnostic?: { Message?: unknown };
  Check?: unknown;
  Remediation?: unknown;
  Object?: {
    Metadata?: { FilePath?: unknown };
    K8sObject?: { Namespace?: unknown; Name?: unknown; GroupVersionKind?: { Kind?: unknown } };
  };
};

const str = (v: unknown): string => (typeof v === "string" ? v : "");

export function parseKubeLinterJson(
  json: string,
  opts: { repoDir: string; realRepoDir?: string; text: (rel: string) => string | null },
): StaticFinding[] {
  if (!json.trim()) return [];
  const parsed = JSON.parse(json) as { Reports?: unknown };
  if (!parsed || !Array.isArray(parsed.Reports)) return [];
  const docs = new Map<string, KubeDoc[] | null>();
  const docsOf = (rel: string): KubeDoc[] | null => {
    if (!docs.has(rel)) {
      const text = opts.text(rel);
      docs.set(rel, text === null ? null : kubeDocuments(text));
    }
    return docs.get(rel)!;
  };
  const out: StaticFinding[] = [];
  for (const raw of parsed.Reports as KubeLinterReport[]) {
    if (!raw || typeof raw !== "object") continue;
    const check = str(raw.Check);
    const file = str(raw.Object?.Metadata?.FilePath);
    if (!check || !file) continue;
    const message = str(raw.Diagnostic?.Message);
    const rel = repoRelative(file, opts.repoDir, opts.realRepoDir);
    const known = CHECKS[check];
    let line = 1;
    const fileDocs = docsOf(rel);
    const k8s = raw.Object?.K8sObject;
    const doc = fileDocs === null ? null : findDocument(fileDocs, { kind: str(k8s?.GroupVersionKind?.Kind), name: str(k8s?.Name), namespace: str(k8s?.Namespace) });
    if (doc !== null) {
      const containerName = /\bcontainer "([^"]+)"/.exec(message)?.[1] ?? /\bcontainer ([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(message)?.[1] ?? null;
      line = known ? anchorLine(doc, known.anchor(message), containerName).line : doc.first;
    }
    const remediation = str(raw.Remediation).trim();
    const text = message.trim().replace(/\.?$/, ".");
    out.push({
      source: "kube-linter",
      ruleId: check,
      filePath: rel,
      lineStart: line,
      lineEnd: line,
      severity: known?.severity ?? "medium",
      message: trimMessage(remediation ? `${text} ${remediation}` : text),
      reference: `https://docs.kubelinter.io/#/generated/checks?id=${encodeURIComponent(check)}`,
    });
  }
  return out;
}

function trimMessage(m: string): string {
  const collapsed = m.replace(/\s+/g, " ").trim();
  return collapsed.length > 500 ? collapsed.slice(0, 497) + "..." : collapsed;
}
