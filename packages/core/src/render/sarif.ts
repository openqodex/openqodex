// SARIF 2.1.0: one run per source, `openqodex` for the agent's findings and
// one per scanner, so a code scanning view groups them by tool. Only what
// counts toward the verdict is included: findings on changed lines and
// candidates the agent left unreviewed.
import type { Candidate, Report, ReportFinding, Severity } from "../types.js";

type SarifResult = {
  ruleId: string;
  level: "error" | "warning" | "note";
  message: { text: string };
  locations: {
    physicalLocation: {
      artifactLocation: { uri: string };
      region: { startLine: number; endLine: number };
    };
  }[];
  properties: Record<string, unknown>;
};

function level(s: Severity): SarifResult["level"] {
  if (s === "critical" || s === "major") return "error";
  if (s === "minor") return "warning";
  return "note";
}

function result(
  ruleId: string,
  severity: Severity,
  text: string,
  file: string,
  start: number,
  end: number,
  properties: Record<string, unknown>,
): SarifResult {
  return {
    ruleId,
    level: level(severity),
    message: { text },
    locations: [
      {
        physicalLocation: {
          artifactLocation: { uri: file.split("/").map(encodeURIComponent).join("/") },
          region: { startLine: start, endLine: Math.max(start, end) },
        },
      },
    ],
    properties: { severity, ...properties },
  };
}

function fromFinding(f: ReportFinding): SarifResult {
  // A scanner finding's title is its rule id; an agent finding's rule is its
  // citation, or its category when it cites nothing.
  const ruleId = f.origin === "scanner" ? f.title : (f.source ?? f.category);
  const text = f.description ? `${f.title}: ${f.description}` : f.title;
  return result(ruleId, f.severity, text, f.file_path, f.line_number, f.line_end, {
    category: f.category,
    ...(f.confidence !== null ? { confidence: f.confidence } : {}),
    ...(f.suggested_change ? { suggested_change: f.suggested_change } : {}),
    ...(f.found_by ? { found_by: f.found_by } : {}),
  });
}

function fromCandidate(c: Candidate): SarifResult {
  return result(c.ruleId, c.reviewSeverity, c.message, c.filePath, c.lineStart, c.lineEnd, {
    candidate: c.id,
    not_reviewed: true,
    ...(c.reference ? { reference: c.reference } : {}),
  });
}

function run(name: string, version: string | null, results: SarifResult[]) {
  const ruleIds = [...new Set(results.map((r) => r.ruleId))];
  return {
    tool: {
      driver: {
        name,
        ...(version ? { version } : {}),
        rules: ruleIds.map((id) => ({ id })),
      },
    },
    results,
  };
}

// A review run by `review` itself says whether it completed, so a code
// scanning view cannot read an incomplete review's empty results as clean:
// the run's invocation failed, a notification names what is missing, and the
// completion record rides along. A scan report has no completion record.
function completionOf(report: Report): Record<string, unknown> {
  const c = report.completion;
  if (c === undefined) return {};
  const complete = c.status === "complete" && report.verdict !== "incomplete";
  return {
    invocations: [
      {
        executionSuccessful: complete,
        toolExecutionNotifications: complete
          ? []
          : [{ level: "error", message: { text: `The review is incomplete, so it is not a clean result: ${c.missing.join("; ") || "no completion record"}` } }],
      },
    ],
    properties: { completion: c },
  };
}

// The scanner a token "<source>:<rule>" came from. A custom source holds a
// colon itself ("custom:trivy"), so the longest known scanner name wins.
function scannerOf(token: string, report: Report): string {
  const names = report.scanners.map((s) => s.scanner as string).filter((n) => token.startsWith(`${n}:`));
  return names.sort((a, b) => b.length - a.length)[0] ?? (token.slice(0, Math.max(0, token.indexOf(":"))) || "scanner");
}

export function renderSarif(report: Report): string {
  const agent: SarifResult[] = [];
  const byScanner = new Map<string, SarifResult[]>();
  const add = (source: string, r: SarifResult) => byScanner.set(source, [...(byScanner.get(source) ?? []), r]);

  for (const f of report.findings) {
    if (f.origin === "agent") agent.push(fromFinding(f));
    else add(scannerOf(f.source ?? "", report), fromFinding(f));
  }
  for (const c of report.not_reviewed) add(c.source, fromCandidate(c));

  const versions = new Map(report.scanners.map((s) => [s.scanner as string, s.version]));
  const completion = completionOf(report);
  const reviewed_by = report.reviewed_by ? { properties: { ...(completion.properties as Record<string, unknown> | undefined), reviewed_by: report.reviewed_by } } : {};
  const runs: Record<string, unknown>[] = [{ ...run("openqodex", null, agent), ...completion, ...reviewed_by }];
  for (const [source, results] of byScanner) runs.push(run(source, versions.get(source) ?? null, results));

  const sarif = {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs,
  };
  return `${JSON.stringify(sarif, null, 2)}\n`;
}
