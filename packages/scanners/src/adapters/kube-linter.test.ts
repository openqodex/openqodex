// kube-linter reports an object and a message, never a line. These tests read
// its real output (test/fixtures/kube-linter/report.txt says how it was
// made) and check where each finding lands.
//
// Failure list, written before the code:
//   1. A finding lands on a line other than the field its check names, or
//      in the wrong object of a multi-document file.
//   2. A finding about a field the object lacks lands anywhere but its
//      nearest ancestor the object has.
//   3. A value the message names (a port, a variable, a host path, a
//      sysctl, a wildcard) is not used to find its line.
//   4. The absolute path kube-linter prints is not made repo-relative, so
//      the changed-line filter drops every finding.
//   5. A check a newer kube-linter adds breaks the parser or is dropped.
//   6. Empty output, or a report with no findings, is read as a failure.
//   7. A change to another field of an object that has a finding reports
//      it; a change to the field the finding names does not.
//   8. The rule id is not the check name, or the reference is not its page.
import { makeLineSet } from "../../../../tests/line-set.mjs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { filterToChangedLines } from "../filter.js";
import { KUBE_LINTER_CHECKS, parseKubeLinterJson } from "./kube-linter.js";

const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`../../test/fixtures/kube-linter/${name}`, import.meta.url)), "utf8");
const REPORT = fixture("report.json");
const MANIFEST = fixture("workloads.yaml");
const REL = "k8s/workloads.yaml";
const parse = (json = REPORT, text = MANIFEST) => parseKubeLinterJson(json, { repoDir: "/repo", text: (rel) => (rel === REL ? text : null) });
const at = (check: string) =>
  parse()
    .filter((f) => f.ruleId === check)
    .map((f) => f.lineStart);

describe("parseKubeLinterJson", () => {
  it("each finding lands on the line of the field its check names, in its own object (1, 4, 8)", () => {
    const findings = parse();
    expect(findings).toHaveLength(33);
    expect(findings.every((f) => f.filePath === REL && f.lineStart === f.lineEnd)).toBe(true);
    expect(at("privileged-container")).toEqual([35]);
    expect(at("privilege-escalation-container")).toEqual([36]);
    expect(at("unsafe-proc-mount")).toEqual([37]);
    expect(at("host-network")).toEqual([16]);
    expect(at("host-pid")).toEqual([17]);
    expect(at("host-ipc")).toEqual([18]);
    expect(at("deprecated-service-account-field")).toEqual([19]);
    expect(at("latest-tag")).toEqual([26]);
    expect(at("no-anti-affinity")).toEqual([7]);
    expect(at("pdb-min-available")).toEqual([68]);
    expect(at("cluster-admin-role-binding")).toEqual([101]);
    expect(at("no-extensions-v1beta")).toEqual([107]);
    const privileged = findings.find((f) => f.ruleId === "privileged-container")!;
    expect(privileged).toMatchObject({ source: "kube-linter", severity: "high", reference: "https://docs.kubelinter.io/#/generated/checks?id=privileged-container" });
    expect(privileged.message).toContain('container "app" is privileged');
    expect(privileged.message).toContain("Do not run your container as privileged");
  });

  it("a finding about a field the object lacks lands on its nearest ancestor (2)", () => {
    // The Deployment's container has a securityContext without
    // readOnlyRootFilesystem or runAsNonRoot, and no resources.
    expect(at("no-read-only-root-fs")).toEqual([34, 82]);
    expect(at("run-as-non-root")).toEqual([34, 82]);
    expect(at("unset-cpu-requirements")).toEqual([25, 82]);
    expect(at("unset-memory-requirements")).toEqual([25, 82]);
    expect(at("job-ttl-seconds-after-finished")).toEqual([77]);
    expect(at("pdb-unhealthy-pod-eviction-policy")).toEqual([67]);
  });

  it("the value a message names picks its line (3)", () => {
    expect(at("ssh-port")).toEqual([28]);
    expect(at("duplicate-env-var")).toEqual([32]);
    expect(at("docker-sock")).toEqual([50]);
    // The container's mount of the volume (no readOnly), not the volume.
    expect(at("writable-host-mount")).toEqual([45]);
    expect(at("unsafe-sysctls")).toEqual([22]);
    expect(at("liveness-port")).toEqual([40]);
    expect(at("readiness-port")).toEqual([43]);
    expect(at("invalid-target-ports")).toEqual([61, 61]);
    expect(at("wildcard-in-rules").sort()).toEqual([91, 92]);
  });

  it("a path under the other spelling of a linked repo root is made repo-relative (4)", () => {
    const json = REPORT.replaceAll("/repo/k8s/", "/private/repo/k8s/");
    const findings = parseKubeLinterJson(json, { repoDir: "/repo", realRepoDir: "/private/repo", text: (rel) => (rel === REL ? MANIFEST : null) });
    expect(new Set(findings.map((f) => f.filePath))).toEqual(new Set([REL]));
  });

  it("a check the table does not know lands on its object's first line, as a medium finding (5)", () => {
    const report = JSON.parse(REPORT) as { Reports: { Check: string }[] };
    report.Reports = report.Reports.filter((r) => r.Check === "host-network").map((r) => ({ ...r, Check: "a-check-from-a-newer-release" }));
    const [finding] = parse(JSON.stringify(report));
    expect(finding).toMatchObject({ ruleId: "a-check-from-a-newer-release", lineStart: 1, severity: "medium" });
    expect(KUBE_LINTER_CHECKS).not.toContain("a-check-from-a-newer-release");
  });

  it("empty output and a report with no findings yield nothing, not an error (6)", () => {
    expect(parse("")).toEqual([]);
    const clean = JSON.parse(REPORT) as { Reports: unknown };
    clean.Reports = null;
    expect(parse(JSON.stringify(clean))).toEqual([]);
  });

  it("a change to another field of an object with a finding reports nothing; a change to the field reports it (7)", () => {
    const findings = parse();
    // The change bumps the image of the Deployment's container: only
    // latest-tag is about that line.
    const imageOnly = filterToChangedLines(findings, new Map([[REL, makeLineSet([26])]]));
    expect(imageOnly.map((f) => f.ruleId)).toEqual(["latest-tag"]);
    // The change sets privileged: true.
    const privileged = filterToChangedLines(findings, new Map([[REL, makeLineSet([35])]]));
    expect(privileged.map((f) => f.ruleId)).toEqual(["privileged-container"]);
    // A change to the Service's selector touches no finding.
    expect(filterToChangedLines(findings, new Map([[REL, makeLineSet([58])]]))).toEqual([]);
  });

  it("a report on a file that cannot be read lands on line 1 of that file", () => {
    const findings = parseKubeLinterJson(REPORT, { repoDir: "/repo", text: () => null });
    expect(new Set(findings.map((f) => f.lineStart))).toEqual(new Set([1]));
  });
});
