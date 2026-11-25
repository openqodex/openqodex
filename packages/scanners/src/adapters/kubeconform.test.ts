// kubeconform reports an object and a field path, never a line, and keeps
// all but the first level of an object's errors in its message text. These
// tests read its real output (test/fixtures/kubeconform/report.txt says how
// it was made).
//
// Failure list, written before the code:
//   1. Only the first level of an object's errors is reported: a wrong
//      containerPort under /spec/template/spec is lost.
//   2. A schema error lands on a line other than its field's; an extra field
//      lands on its parent rather than on itself; a key with a slash
//      (app.kubernetes.io/version, ~1 in the path) is not found.
//   3. An error goes to the wrong object of a multi-document file (a
//      Deployment and a Service both named api).
//   4. A file that does not parse as YAML reports nothing.
//   5. A schema that could not be downloaded reads as a clean file instead
//      of a failed scan.
//   6. Empty output, or a report with no resources, is read as a failure.
//   7. The schema location floats (the default master URL) instead of the
//      commit and Kubernetes version the table pins.
//   8. A change to another field of an object with a schema error reports it.
import { makeLineSet } from "../../../../tests/line-set.mjs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { filterToChangedLines } from "../filter.js";
import { loadToolchain } from "../toolchain/table.js";
import { kubeconformArgs, parseKubeconformJson } from "./kubeconform.js";

const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`../../test/fixtures/kubeconform/${name}`, import.meta.url)), "utf8");
const texts = new Map([
  ["k8s/app.yaml", fixture("app.yaml")],
  ["k8s/broken.yaml", fixture("broken.yaml")],
]);
const parse = (json: string) => parseKubeconformJson(json, { text: (rel) => texts.get(rel) ?? null });
const spans = (json: string) => parse(json).findings.map((f) => [f.filePath, f.ruleId, f.lineStart, f.lineEnd]);

describe("parseKubeconformJson", () => {
  it("every error of an object is reported, each on the line of its field, in its own object (1, 2, 3)", () => {
    expect(spans(fixture("report.json")).sort()).toEqual(
      [
        ["k8s/app.yaml", "type", 8, 8],
        ["k8s/app.yaml", "type", 10, 10],
        ["k8s/app.yaml", "type", 24, 24],
        ["k8s/app.yaml", "additional-properties", 19, 19],
        ["k8s/app.yaml", "additional-properties", 39, 39],
        ["k8s/broken.yaml", "invalid-yaml", 1, 15],
      ].sort(),
    );
    const { findings, failed } = parse(fixture("report.json"));
    expect(failed).toBeNull();
    const port = findings.find((f) => f.lineStart === 24)!;
    expect(port).toMatchObject({ source: "kubeconform", severity: "high" });
    expect(port.message).toContain("Deployment api");
    expect(port.message).toContain("/spec/template/spec/containers/0/ports/0/containerPort");
    expect(port.message).toContain("got string, want integer");
    expect(findings.find((f) => f.lineStart === 39)!.message).toContain("Service api");
  });

  it("a file that does not parse is one finding over the whole file (4)", () => {
    const broken = parse(fixture("report.json")).findings.find((f) => f.ruleId === "invalid-yaml")!;
    expect(broken).toMatchObject({ filePath: "k8s/broken.yaml", lineStart: 1, lineEnd: 15, severity: "high" });
    expect(broken.message).toContain("did not find expected '-' indicator");
  });

  it("a schema that could not be downloaded fails the scan instead of reading clean (5)", () => {
    const { findings, failed } = parse(fixture("unreachable.json"));
    expect(findings).toEqual([]);
    expect(failed).toMatch(/^failed downloading schema at https:\/\/127\.0\.0\.1:9\//);
  });

  it("empty output and a report with no resources yield nothing, not an error (6)", () => {
    expect(parse("")).toEqual({ findings: [], failed: null });
    expect(parse(JSON.stringify({ resources: [] }))).toEqual({ findings: [], failed: null });
  });

  it("a change to another field of an object with a schema error reports nothing (8)", () => {
    const { findings } = parse(fixture("report.json"));
    // The change bumps the image tag on line 22.
    expect(filterToChangedLines(findings, new Map([["k8s/app.yaml", makeLineSet([22])]]))).toEqual([]);
    // The change sets replicas.
    expect(filterToChangedLines(findings, new Map([["k8s/app.yaml", makeLineSet([10])]])).map((f) => f.lineStart)).toEqual([10]);
  });
});

describe("kubeconformArgs", () => {
  it("names the schema commit and Kubernetes version the table pins, never the floating default (7)", () => {
    const recipe = loadToolchain().tools.kubeconform!;
    expect(recipe.method).toBe("github-release");
    const pin = recipe.method === "github-release" ? recipe.schemas! : null;
    expect(pin!.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(pin!.kubernetes).toMatch(/^\d+\.\d+\.\d+$/);
    const args = kubeconformArgs(pin!, "/cache", ["k8s/app.yaml"]);
    const location = args[args.indexOf("-schema-location") + 1]!;
    expect(location).toBe(`https://raw.githubusercontent.com/${pin!.repo}/${pin!.commit}/{{ .NormalizedKubernetesVersion }}-standalone{{ .StrictSuffix }}/{{ .ResourceKind }}{{ .KindSuffix }}.json`);
    expect(args[args.indexOf("-kubernetes-version") + 1]).toBe(pin!.kubernetes);
    expect(args.slice(-2)).toEqual(["--", "k8s/app.yaml"]);
    expect(args).not.toContain("default");
  });
});
