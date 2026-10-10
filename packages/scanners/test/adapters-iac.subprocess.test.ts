// The infrastructure scanners through their real binaries on tiny planted
// repos: trivy config, checkov and tflint. Each case guards the scanner's
// invocation, its output parser, where its findings are anchored, the
// changed-line filter and tool resolution together; the proxy cases hold
// what each one sends, and the planted settings what each one never loads.
// Run by the end-to-end config (tests/e2e/adapters.test.ts).
//
// The tools are installed beforehand with `openqodex doctor --install` (the
// end-to-end setup does it); these cases never install one themselves, and
// a tool that is missing fails its case with the reason.
//
// Added after the code review of the library branch, one more way it could
// fail: a server run whose temporary folder is too long for TFLint's plugin
// socket falls back to /tmp, outside its scratch root, instead of refusing
// to start TFLint.
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseConfig, SETTINGS_RULE, SUPPRESSION_RULE } from "@openqodex/core";
import type { BuiltinScanner } from "@openqodex/core";
import { createToolResolver, runScanners } from "@openqodex/scanners";
import { withLoggingProxy } from "./subprocess-support.js";
import { removeTempDirs, tempDir } from "../../../tests/temp-dirs.mjs";

// An SSH port open to every address.
const SG = `resource "aws_security_group" "web" {
  name        = "web"
  description = "web access"

  ingress {
    description = "ssh"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
}
`;

// A privileged container.
const POD = `apiVersion: v1
kind: Pod
metadata:
  name: web
spec:
  containers:
    - name: web
      image: nginx:1.27
      securityContext:
        privileged: true
`;

// The same open SSH port, in CloudFormation.
const STACK = `AWSTemplateFormatVersion: "2010-09-09"
Resources:
  WebSG:
    Type: AWS::EC2::SecurityGroup
    Properties:
      GroupDescription: web
      SecurityGroupIngress:
        - IpProtocol: tcp
          FromPort: 22
          ToPort: 22
          CidrIp: 0.0.0.0/0
          Description: ssh
`;

// A variable nothing reads.
const UNUSED = `variable "region" {
  type = string
}
`;

// Modules from the registry and from git: what a scanner must not fetch.
const REMOTE = `module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "5.0.0"
}

module "sg" {
  source = "git::https://github.com/terraform-aws-modules/terraform-aws-security-group.git?ref=v5.1.0"
}

`;

// The planted files, with only `changed` lines counted as changed (every
// line of a file not named there), scanned by `scanner` and any `also` in
// one scan. The tools must already be installed.
async function scanLines(scanner: BuiltinScanner, files: Record<string, string>, changed: Record<string, number[]> = {}, also: BuiltinScanner[] = []) {
  const repo = tempDir(`oq-iac-${scanner}-`);
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, name)), { recursive: true });
    writeFileSync(join(repo, name), body);
  }
  const paths = Object.keys(files);
  const coverage = new Map(paths.map((p) => [p, new Set(changed[p] ?? readFileSync(join(repo, p), "utf8").split("\n").map((_, i) => i + 1))]));
  const result = await runScanners({ repoDir: repo, changedPaths: paths, coverage, config: parseConfig("").config, resolveTool: createToolResolver({ allowInstall: false, installBudgetMs: null }), only: [scanner, ...also] });
  const status = result.scan.scanners[0]!;
  return { repo, result, status };
}

type Result = Awaited<ReturnType<typeof scanLines>>["result"];
const rules = (result: Result, scanner: BuiltinScanner) =>
  result.scan.candidates.filter((c) => c.source === scanner && c.ruleId !== SETTINGS_RULE && c.ruleId !== SUPPRESSION_RULE).map((c) => [c.ruleId, c.filePath, c.lineStart, c.lineEnd]);
const added = (result: Result, scanner: BuiltinScanner) =>
  result.scan.candidates.filter((c) => c.source === scanner && c.ruleId === SUPPRESSION_RULE).map((c) => [c.filePath, c.lineStart]);

let ran = 0;
let skipped = 0;
afterAll(() => {
  process.stdout.write(`${ran} ran, ${skipped} skipped\n`);
  if (process.env.CI) expect(skipped, "an infrastructure scanner was skipped under CI").toBe(0);
});
// Removes the temp folders this file made. Registered after any other
// after-all hook, so it runs first and a failed check still cleans up.
afterAll(removeTempDirs);

const cases: [BuiltinScanner, string, Record<string, string>, string][] = [
  ["trivy", "AWS-0107", { "infra/main.tf": SG }, "infra/main.tf"],
  ["trivy", "KSV-0017", { "k8s/pod.yaml": POD }, "k8s/pod.yaml"],
  ["trivy", "AWS-0107", { "cfn/stack.yaml": STACK }, "cfn/stack.yaml"],
  ["checkov", "CKV_AWS_24", { "infra/main.tf": SG }, "infra/main.tf"],
  ["checkov", "CKV_K8S_16", { "k8s/pod.yaml": POD }, "k8s/pod.yaml"],
  ["checkov", "CKV_AWS_24", { "cfn/stack.yaml": STACK }, "cfn/stack.yaml"],
  ["tflint", "terraform_unused_declarations", { "infra/variables.tf": UNUSED }, "infra/variables.tf"],
];

describe("infrastructure scanner subprocesses", () => {
  for (const [scanner, rule, files, anchor] of cases) {
    it(`${scanner} reports ${rule} in ${anchor} on a changed line`, async () => {
      const { result, status } = await scanLines(scanner, files);
      if (status.status === "ran") ran++;
      else skipped++;
      expect(status.status, status.reason ?? "").toBe("ran");
      expect(result.scan.candidates).toContainEqual(expect.objectContaining({ source: scanner, ruleId: rule, filePath: anchor }));
    }, 300_000);
  }
});

describe("trivy config", () => {
  it("anchors a finding to its cause: a change to another attribute of the resource reports nothing, a change to the open CIDR reports it", async () => {
    const other = await scanLines("trivy", { "main.tf": SG }, { "main.tf": [2] });
    expect(other.status.status).toBe("ran");
    expect(rules(other.result, "trivy")).toEqual([]);
    const cidr = await scanLines("trivy", { "main.tf": SG }, { "main.tf": [10] });
    expect(rules(cidr.result, "trivy")).toContainEqual(["AWS-0107", "main.tf", 10, 10]);
  }, 300_000);

  it("anchors a cause that is a whole container to the container's first line", async () => {
    const { result } = await scanLines("trivy", { "pod.yaml": POD });
    expect(rules(result, "trivy")).toContainEqual(["KSV-0017", "pod.yaml", 7, 7]);
  }, 300_000);

  it("obeys #trivy:ignore, even in a string, and raises each added one as a candidate", async () => {
    const comment = SG.replace('    cidr_blocks = ["0.0.0.0/0"]', '    #trivy:ignore:AWS-0107\n    cidr_blocks = ["0.0.0.0/0"]');
    const inString = `locals { note = "see trivy:ignore:* here" }\n${SG}`;
    const { result } = await scanLines("trivy", { "a/main.tf": comment, "b/main.tf": inString, "c/main.tf": SG });
    expect(rules(result, "trivy").filter(([rule]) => rule === "AWS-0107")).toEqual([["AWS-0107", "c/main.tf", 10, 10]]);
    expect(added(result, "trivy")).toEqual([
      ["a/main.tf", 10],
      ["b/main.tf", 1],
    ]);
  }, 300_000);

  it("reads the repository's .trivyignore and raises a change to it; never loads its trivy.yaml", async () => {
    // A trivy.yaml that kept CRITICAL findings only would hide KSV-0017 (HIGH).
    const { result } = await scanLines("trivy", {
      "trivy.yaml": "severity:\n  - CRITICAL\n",
      ".trivyignore": "AWS-0107\n",
      "a/main.tf": SG,
      "k8s/pod.yaml": POD,
    });
    const found = result.scan.candidates.filter((c) => c.source === "trivy");
    expect(found.some((c) => c.ruleId === "AWS-0107")).toBe(false);
    expect(found).toContainEqual(expect.objectContaining({ ruleId: SETTINGS_RULE, filePath: ".trivyignore" }));
    expect(found).toContainEqual(expect.objectContaining({ ruleId: "KSV-0017" }));
  }, 300_000);

  it("is not handed a folder that names a module from outside the repository, opens no connection, and says so", async () => {
    const { result, hosts } = await withLoggingProxy(() => scanLines("trivy", { "infra/main.tf": `${REMOTE}${SG}` }));
    expect(result.status.status).toBe("disabled");
    expect(result.status.reason).toContain("not run on infra/: a module from outside the repository");
    expect(hosts).toEqual([]);
  }, 300_000);

  // trivy resolves a `../` module path against the staging copy, so enough
  // of them reach any folder on the machine: such a folder is held back
  // like one with a module to download, and trivy reads nothing outside.
  it("is not handed a folder whose local module path leaves the staging copy, and reads nothing there", async () => {
    const outside = tempDir("oq-trivy-outside-");
    writeFileSync(join(outside, "main.tf"), SG);
    const escape = `${"../".repeat(64)}${outside.slice(1)}`;
    const { status } = await scanLines("trivy", { "infra/main.tf": `module "outside" {\n  source = "${escape}"\n}\n\n${UNUSED}` });
    expect([status.status, status.rawCount]).toEqual(["disabled", 0]);
    expect(status.reason).toContain("not run on infra/: a module from outside the repository");
  }, 300_000);

  // A folder held back is a note, not a failure: the scanner ran on the rest.
  it("still ran, with the held folder named, when it held one folder back and found nothing in another", async () => {
    const { status } = await scanLines("trivy", { "infra/main.tf": `${REMOTE}${SG}`, "clean/main.tf": UNUSED });
    expect(status.status).toBe("ran");
    expect(status.reason).toContain("not run on infra/: a module from outside the repository");
  }, 300_000);

  it("opens no connection on a local module, Kubernetes and CloudFormation files", async () => {
    const files = {
      "infra/main.tf": `module "net" {\n  source = "./modules/net"\n}\n\n${SG}`,
      "infra/modules/net/main.tf": SG,
      "k8s/pod.yaml": POD,
      "cfn/stack.yaml": STACK,
    };
    const { result, hosts } = await withLoggingProxy(() => scanLines("trivy", files));
    expect(result.status.status).toBe("ran");
    expect(rules(result.result, "trivy")).toContainEqual(["AWS-0107", "infra/main.tf", 14, 14]);
    expect(hosts).toEqual([]);
  }, 300_000);
});

describe("checkov", () => {
  it("anchors a finding to the attributes it evaluated: a change to another attribute reports nothing, a change to the open CIDR reports it", async () => {
    const other = await scanLines("checkov", { "main.tf": SG }, { "main.tf": [2] });
    expect(other.status.status).toBe("ran");
    expect(rules(other.result, "checkov").filter(([rule]) => rule === "CKV_AWS_24")).toEqual([]);
    const cidr = await scanLines("checkov", { "main.tf": SG }, { "main.tf": [10] });
    // Checkov evaluated from_port, to_port and cidr_blocks; the span runs
    // over the ones the change touched.
    expect(rules(cidr.result, "checkov")).toContainEqual(["CKV_AWS_24", "main.tf", 10, 10]);
    const whole = await scanLines("checkov", { "main.tf": SG });
    expect(rules(whole.result, "checkov")).toContainEqual(["CKV_AWS_24", "main.tf", 7, 10]);
  }, 300_000);

  // The attributes Checkov evaluated are separate ranges: a change to an
  // attribute between two of them (a description) is not a change to what
  // it evaluated, and must not bring the finding back.
  it("keeps a finding only for a change to an attribute it evaluated, not one between them", async () => {
    const between = 'resource "aws_security_group" "web" {\n  name = "web"\n\n  ingress {\n    from_port   = 22\n    to_port     = 22\n    description = "ssh for the on-call team"\n    protocol    = "tcp"\n    cidr_blocks = ["0.0.0.0/0"]\n  }\n}\n';
    const description = await scanLines("checkov", { "main.tf": between }, { "main.tf": [7] });
    expect(description.status.status).toBe("ran");
    expect(rules(description.result, "checkov").filter(([rule]) => rule === "CKV_AWS_24")).toEqual([]);
    const cidr = await scanLines("checkov", { "main.tf": between }, { "main.tf": [9] });
    expect(rules(cidr.result, "checkov").map(([rule]) => rule)).toContain("CKV_AWS_24");
  }, 300_000);

  it("anchors a Kubernetes finding to the key it names", async () => {
    const { result } = await scanLines("checkov", { "pod.yaml": POD });
    expect(rules(result, "checkov")).toContainEqual(["CKV_K8S_16", "pod.yaml", 10, 10]);
  }, 300_000);

  it("obeys a skip comment in Terraform and a skip annotation in Kubernetes, and raises each added one", async () => {
    const tf = SG.replace('  description = "web access"', '  description = "web access"\n  # checkov:skip=CKV_AWS_24:the bastion');
    const pod = POD.replace("  name: web\n", "  name: web\n  annotations:\n    checkov.io/skip1: CKV_K8S_16=a debug pod\n");
    const { result } = await scanLines("checkov", { "main.tf": tf, "pod.yaml": pod });
    const found = rules(result, "checkov").map(([rule]) => rule);
    expect(found).not.toContain("CKV_AWS_24");
    expect(found).not.toContain("CKV_K8S_16");
    expect(added(result, "checkov")).toEqual([
      ["main.tf", 4],
      ["pod.yaml", 6],
    ]);
  }, 300_000);

  it("never loads a .checkov.yaml from the repository or the home, so their external Python checks never run", async () => {
    const marker = join(tempDir("oq-checkov-marker-"), "ran");
    const check = `open(${JSON.stringify(marker)}, "w").write("ran")\n`;
    const home = process.env.HOME!;
    mkdirSync(join(home, "checks"), { recursive: true });
    writeFileSync(join(home, "checks", "evil.py"), check);
    writeFileSync(join(home, ".checkov.yaml"), `external-checks-dir:\n  - ${join(home, "checks")}\n`);
    const repo = await scanLines("checkov", { "main.tf": SG, "checks/evil.py": check, ".checkov.yaml": "external-checks-dir:\n  - checks\n" });
    expect(repo.status.status).toBe("ran");
    expect(rules(repo.result, "checkov").map(([rule]) => rule)).toContain("CKV_AWS_24");
    expect(existsSync(marker)).toBe(false);
  }, 300_000);

  it("opens no connection: no module download, no platform, no update check", async () => {
    const files = { "infra/main.tf": `${REMOTE}${SG}`, "k8s/pod.yaml": POD, "cfn/stack.yaml": STACK };
    const { result, hosts } = await withLoggingProxy(() => scanLines("checkov", files));
    expect(result.status.status).toBe("ran");
    expect(rules(result.result, "checkov").map(([rule]) => rule)).toContain("CKV_AWS_24");
    expect(hosts).toEqual([]);
    process.stdout.write(`checkov ran in ${result.status.durationMs} ms\n`);
  }, 300_000);

  it("still ran, with the held folder named, when it held one folder back and found nothing in another", async () => {
    const { status } = await scanLines("checkov", { "infra/main.tf": `module "outside" {\n  source = "../../outside"\n}\n\n${SG}`, "clean/main.tf": UNUSED });
    expect(status.status).toBe("ran");
    expect(status.reason).toContain("not run on infra/: a module path that leaves the repository");
  }, 300_000);
});

// The module gate reads each Terraform file of a folder for its module
// sources before trivy or Checkov may read the folder. Each case writes a
// module call to a folder outside the repository in a form the gate must
// account for, as HCL reads it, or else withhold the folder: a source in a
// heredoc, with an escape or a template, a block on one line, comments
// between the parts of an attribute, a block left open, a heredoc that holds
// text shaped like a block, a `.tf.json` with the key twice, a shape it does
// not expect or no parse at all, a file over the size cap and a folder past
// the file count. The folder must be withheld, so neither scanner reads the
// module outside.
describe("the module gate withholds a folder it cannot read for certain", () => {
  const outside = tempDir("oq-iac-gate-outside-");
  writeFileSync(join(outside, "main.tf"), SG);
  const escape = `${"../".repeat(64)}${outside.slice(1)}`;
  const hclEscaped = escape.replaceAll(".", "\\u002e");
  const call = (source: string) => `module "outside" {\n  source = ${source}\n}\n`;
  const many: Record<string, string> = {};
  for (let k = 0; k < 501; k++) many[`infra/v${k}.tf`] = `variable "v${k}" {\n  type = string\n}\n`;
  const constructs: [string, Record<string, string>][] = [
    ["a source in a heredoc", { "infra/main.tf": call(`<<EOT\n${escape}\nEOT`) }],
    ["a source with escapes", { "infra/main.tf": call(`"${hclEscaped}"`) }],
    ["a source with a template", { "infra/main.tf": call(`"\${"../"}${escape.slice(3)}"`) }],
    ["a block on one line", { "infra/main.tf": `module "outside" { source = "${escape}" }\n` }],
    ["comments between the parts of the source", { "infra/main.tf": `module "outside" {\n  # where it lives\n  /* a */ source /* b */ = /* c */ "${escape}" // d\n}\n` }],
    ["a block left open", { "infra/main.tf": `module "outside" {\n  source = "${escape}"\n` }],
    ["a heredoc holding a block's text before the call", { "infra/main.tf": `locals {\n  doc = <<-EOT\n    module "x" {\n    }\n  EOT\n}\n\n${call(`"${escape}"`)}` }],
    ["a .tf.json with the module key twice", { "infra/main.tf.json": `{"module": {"outside": {"source": ${JSON.stringify(escape)}}}, "module": {"local": {"source": "./local"}}}` }],
    ["a .tf.json with a shape it does not expect", { "infra/main.tf.json": `{"module": {"outside": [{"source": ${JSON.stringify(escape)}}, 7]}}` }],
    ["a .tf.json that does not parse", { "infra/main.tf.json": `{"module": {"outside": {"source": ${JSON.stringify(escape)}}},}` }],
    ["a file over the size cap", { "infra/main.tf": `${call(`"${escape}"`)}${"# pad\n".repeat(800_000)}` }],
    ["a folder past the file count", { ...many, "infra/main.tf": call(`"${escape}"`) }],
  ];
  for (const scanner of ["trivy", "checkov"] as const) {
    for (const [what, files] of constructs) {
      it(`${scanner}: ${what}`, async () => {
        const { status } = await scanLines(scanner, files);
        expect([status.status, status.rawCount], status.reason ?? "").toEqual(["disabled", 0]);
        expect(status.reason).toContain("not run on infra/");
      }, 300_000);
    }
  }
});

// trivy and Checkov check many of the same settings. Where both report one
// missing setting on the same lines of a file, the report keeps one
// scanner's finding and names the other's beside it (same-problem.ts); each
// group there is held here. A group whose scanner stopped reporting its rule,
// or moved it to other lines, fails: every rule of the group must be named.
describe("trivy and Checkov on one missing setting", () => {
  const BUCKET_AND_DATABASE = `resource "aws_s3_bucket" "exports" {
  bucket = "orders-exports"
}

resource "aws_db_instance" "orders" {
  identifier          = "orders"
  engine              = "postgres"
  instance_class      = "db.t3.micro"
  allocated_storage   = 20
  username            = "app"
  publicly_accessible = true
}
`;
  const NO_RESOURCES = `apiVersion: v1
kind: Pod
metadata:
  name: worker
spec:
  containers:
    - name: worker
      image: busybox:1.36
`;
  const groups: [string, string[]][] = [
    ["main.tf", ["trivy:AWS-0086", "trivy:AWS-0087", "trivy:AWS-0091", "trivy:AWS-0093", "checkov:CKV2_AWS_6"]],
    ["main.tf", ["trivy:AWS-0090", "checkov:CKV_AWS_21"]],
    ["main.tf", ["trivy:AWS-0089", "checkov:CKV_AWS_18"]],
    ["main.tf", ["trivy:AWS-0180", "checkov:CKV_AWS_17"]],
    ["main.tf", ["trivy:AWS-0176", "checkov:CKV_AWS_161"]],
    ["pod.yaml", ["trivy:KSV-0011", "checkov:CKV_K8S_11"]],
    ["pod.yaml", ["trivy:KSV-0015", "checkov:CKV_K8S_10"]],
    ["pod.yaml", ["trivy:KSV-0016", "checkov:CKV_K8S_12"]],
    ["pod.yaml", ["trivy:KSV-0018", "checkov:CKV_K8S_13"]],
  ];

  it("keeps one scanner's finding for each setting both report, with the other scanner named", async () => {
    const { result } = await scanLines("trivy", { "main.tf": BUCKET_AND_DATABASE, "pod.yaml": NO_RESOURCES }, {}, ["checkov"]);
    expect(result.scan.scanners.map((s) => [s.scanner, s.status])).toEqual([
      ["trivy", "ran"],
      ["checkov", "ran"],
    ]);
    const seen = groups.map(([file, tokens]) => {
      const kept = result.scan.candidates.filter((c) => c.filePath === file && tokens.includes(c.token));
      return { file, sources: new Set(kept.map((c) => c.source)).size, named: kept.flatMap((c) => [c.token, ...(c.alsoReportedBy ?? [])]).sort() };
    });
    expect(seen).toEqual(groups.map(([file, tokens]) => ({ file, sources: 1, named: [...tokens].sort() })));
    // Two requirements that look alike stay apart: Checkov's CKV_AWS_145
    // wants KMS, which an AWS-managed key satisfies; trivy's AWS-0132 wants
    // a key the customer manages.
    const apart = result.scan.candidates.filter((c) => c.token === "trivy:AWS-0132" || c.token === "checkov:CKV_AWS_145");
    expect(apart.map((c) => [c.token, c.alsoReportedBy ?? []]).sort()).toEqual([
      ["checkov:CKV_AWS_145", []],
      ["trivy:AWS-0132", []],
    ]);
  }, 300_000);
});

// A Terraform file in the change can make a scanner that evaluates
// expressions read any file the user can read (file(), fileexists() and the
// like take an absolute path). Nothing of that file, and not its path, may
// reach a finding, an error or a status: they go into the brief and the
// report. Each scanner runs on the planted folder with one ordinary finding,
// which proves it ran.
describe("a file a Terraform expression reads never reaches the report", () => {
  const outside = tempDir("oq-iac-outside-");
  const secretPath = join(outside, "credentials");
  const sentence = "planted sentence 7f3a9c from outside the stage";
  writeFileSync(secretPath, `${sentence}\n`);
  const probe = {
    "infra/keys.tf": `locals {\n  m = {\n    (file(${JSON.stringify(secretPath)})) = 1\n    (file(${JSON.stringify(secretPath)})) = 2\n  }\n}\n\noutput "m" {\n  value = local.m\n}\n`,
    "infra/exists.tf": `locals {\n  seen = fileexists(${JSON.stringify(secretPath)})\n}\n\noutput "seen" {\n  value = local.seen\n}\n`,
  };
  const leaked = (result: Result) => {
    const text = JSON.stringify(result.scan);
    return [sentence, secretPath, outside].filter((s) => text.includes(s));
  };

  it("tflint puts no content or path of a file a Terraform expression reads into a finding or an error", async () => {
    const { result, status } = await scanLines("tflint", { ...probe, "infra/main.tf": 'module "vpc" {\n  source = "terraform-aws-modules/vpc/aws"\n}\n' });
    expect(status.status, status.reason ?? "").toBe("ran");
    expect(rules(result, "tflint").map(([rule]) => rule)).toContain("terraform_module_version");
    expect(leaked(result)).toEqual([]);
  }, 300_000);

  for (const [scanner, rule] of [
    ["trivy", "AWS-0107"],
    ["checkov", "CKV_AWS_24"],
  ] as const) {
    it(`${scanner} puts no content or path of a file a Terraform expression reads into a finding or an error`, async () => {
      const { result, status } = await scanLines(scanner, { ...probe, "infra/main.tf": SG });
      expect(status.status, status.reason ?? "").toBe("ran");
      expect(rules(result, scanner).map(([r]) => r)).toContain(rule);
      expect(leaked(result)).toEqual([]);
    }, 300_000);
  }
});

describe("tflint", () => {
  it("obeys a tflint-ignore comment and raises the added one", async () => {
    const { result } = await scanLines("tflint", { "a.tf": `# tflint-ignore: terraform_unused_declarations\n${UNUSED}`, "b.tf": UNUSED.replace("region", "zone") });
    expect(rules(result, "tflint").filter(([rule]) => rule === "terraform_unused_declarations")).toEqual([["terraform_unused_declarations", "b.tf", 1, 1]]);
    expect(added(result, "tflint")).toEqual([["a.tf", 1]]);
  }, 300_000);

  it("never loads the repository's .tflint.hcl or a plugin from the repository or the home", async () => {
    const marker = join(tempDir("oq-tflint-marker-"), "ran");
    const plugin = `#!/bin/sh\necho ran > ${JSON.stringify(marker)}\n`;
    const home = process.env.HOME!;
    mkdirSync(join(home, ".tflint.d", "plugins"), { recursive: true });
    writeFileSync(join(home, ".tflint.d", "plugins", "tflint-ruleset-terraform"), plugin);
    chmodSync(join(home, ".tflint.d", "plugins", "tflint-ruleset-terraform"), 0o755);
    const { result, status, repo } = await scanLines("tflint", {
      ".tflint.hcl": 'plugin "aws" {\n  enabled = true\n  version = "0.30.0"\n  source  = "github.com/terraform-linters/tflint-ruleset-aws"\n}\n',
      ".tflint.d/plugins/tflint-ruleset-terraform": plugin,
      "main.tf": UNUSED,
    });
    expect(status.status, status.reason ?? "").toBe("ran");
    expect(rules(result, "tflint").map(([rule]) => rule)).toContain("terraform_unused_declarations");
    expect(existsSync(marker), repo).toBe(false);
  }, 300_000);

  it("opens no connection, with modules from outside the repository", async () => {
    const { result, hosts } = await withLoggingProxy(() => scanLines("tflint", { "infra/main.tf": `${REMOTE}${UNUSED}` }));
    expect(result.status.status).toBe("ran");
    expect(rules(result.result, "tflint").map(([rule]) => rule)).toContain("terraform_unused_declarations");
    expect(hosts).toEqual([]);
  }, 300_000);

  it("in a server run whose temporary folder is too long for its socket, is refused before it starts, never moved to /tmp", async () => {
    const repo = tempDir("oq-iac-tflint-long-");
    writeFileSync(join(repo, "main.tf"), UNUSED);
    // A scratch root deep enough that <root>/tmp is over the socket limit.
    const scratchRoot = join(tempDir("oq-iac-tflint-scratch-"), "x".repeat(80));
    const result = await runScanners({
      repoDir: repo,
      changedPaths: ["main.tf"],
      coverage: new Map([["main.tf", new Set([1, 2, 3])]]),
      config: parseConfig("").config,
      resolveTool: createToolResolver({ allowInstall: false, installBudgetMs: null }),
      only: ["tflint"],
      scratchRoot,
    });
    const status = result.scan.scanners[0]!;
    expect(status).toMatchObject({ scanner: "tflint", status: "failed" });
    expect(status.reason).toMatch(/^the run's temporary folder is \d+ characters long, and TFLint's plugin socket needs one of 64 or fewer; give a shorter scratch root$/);
    // Nothing was staged: TFLint never started.
    expect(readdirSync(join(scratchRoot, "tmp"))).toEqual([]);
  }, 300_000);
});
