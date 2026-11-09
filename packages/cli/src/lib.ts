// The library entry of the openqodex package: what a program gets from
// `import { ... } from "openqodex"`. The command is dist/bin.js; this file
// builds to dist/lib.js beside it, so the lenses, the toolchain table, the
// lock files and the grammars are found in the installed package exactly as
// the command finds them.
//
// Importing this file runs nothing: no command starts, nothing is printed,
// no environment variable is written, no signal handler is added and no
// update check starts. Every function does its work only when called.
import { createToolResolver, isFixturePath, loadToolchain, preinstallScanners, ruleClassFor, runScanners, toolchainHash } from "@openqodex/scanners";
import {
  assemble,
  buildGraph,
  deserializeModel,
  detectImpact,
  extractFacts,
  floorReasons,
  graphOf,
  hotSymbols,
  INDEX_FORMAT,
  isTestPath,
  OPERATIONS,
  PacketCollision,
  PacketLeak,
  parseTarget,
  prepareIndexes,
  query,
  querySliced,
  readIndex,
  readIndexFrom,
  resolveTarget,
  serializeModel,
  SLICE_CHECKS,
  writeIndex,
  writePacket,
} from "@openqodex/graph";
import {
  defaultLensDir,
  loadConfig,
  loadLensCatalog,
  parseConfig,
  renderJson,
  renderMarkdown,
  renderReview,
  renderSarif,
  selectLenses,
  selectLensesForDiff,
} from "@openqodex/core";
import { reviewChange as reviewChangeAt, reviewerContract } from "@openqodex/review";
import type { ReviewChangeInput, ReviewChangeOptions, Reviewer, ReviewResult } from "@openqodex/review";

// Reviews one change in a host's clone with the host's model reviewer, in
// the server profile: the same brain as `openqodex review` (scanners, graph,
// lenses, brief, checked answer, completion record). The run's manifest
// names this package's version.
export function reviewChange(input: ReviewChangeInput, reviewer: Reviewer, options: ReviewChangeOptions): Promise<ReviewResult> {
  return reviewChangeAt(input, reviewer, options, __OPENQODEX_VERSION__);
}

export {
  // scanners
  runScanners,
  createToolResolver,
  loadToolchain,
  toolchainHash,
  preinstallScanners,
  isFixturePath,
  ruleClassFor,
  // the code graph
  buildGraph,
  detectImpact,
  extractFacts,
  writePacket,
  PacketCollision,
  PacketLeak,
  // the graph's questions
  query,
  querySliced,
  OPERATIONS,
  SLICE_CHECKS,
  parseTarget,
  resolveTarget,
  prepareIndexes,
  // a graph as files, and back
  writeIndex,
  readIndex,
  readIndexFrom,
  assemble,
  INDEX_FORMAT,
  serializeModel,
  deserializeModel,
  // a kept build, and what a change's blast radius rests on
  graphOf,
  floorReasons,
  hotSymbols,
  isTestPath,
  // the lenses
  loadLensCatalog,
  selectLenses,
  selectLensesForDiff,
  defaultLensDir,
  // the config parser
  parseConfig,
  loadConfig,
  // the renderers
  renderMarkdown,
  renderSarif,
  renderJson,
  renderReview,
  // the reviewer contract's version
  reviewerContract,
};

// The same functions grouped by what they belong to.
export const scanners = { runScanners, createToolResolver, loadToolchain, toolchainHash, preinstallScanners, isFixturePath, ruleClassFor };
export const graph = {
  buildGraph,
  detectImpact,
  extractFacts,
  writePacket,
  PacketCollision,
  PacketLeak,
  query,
  querySliced,
  OPERATIONS,
  SLICE_CHECKS,
  parseTarget,
  resolveTarget,
  prepareIndexes,
  writeIndex,
  readIndex,
  readIndexFrom,
  assemble,
  INDEX_FORMAT,
  serializeModel,
  deserializeModel,
  graphOf,
  floorReasons,
  hotSymbols,
  isTestPath,
};
export const lenses = { loadLensCatalog, selectLenses, selectLensesForDiff, defaultLensDir };
export const render = { renderMarkdown, renderSarif, renderJson, renderReview };

export type {
  // the finding, report and completion types
  Report,
  RunTimings,
  ReportFinding,
  Verdict,
  CompletionRecord,
  ModelCompletionRecord,
  AnyCompletionRecord,
  ModelToolEntry,
  ModelAttempt,
  ModelCallUsage,
  ReviewerRecord,
  StaticFinding,
  Candidate,
  Severity,
  Category,
  // what the scanners take and return
  ScannerSource,
  ScannerRunSummary,
  ScanResult,
  ResolveTool,
  ToolResolution,
  DiffCoverage,
  Change,
  ChangedFile,
  // the config
  Config,
  LoadedConfig,
  ParseOptions,
  // the lenses
  Lens,
  SelectedLens,
  // the graph's view of a change
  ImpactSummary,
  // what a host gives a review besides the change, and two reviewers' disagreements
  ContextItem,
  ContextKind,
  Disagreement,
} from "@openqodex/core";
export type { RunScannersResult, Recipe, Toolchain, PreinstallOptions, PreinstallResult, PreinstallTool } from "@openqodex/scanners";
export type {
  // the build
  BuildArgs,
  FileFacts,
  Graph,
  Lang,
  // the questions
  Session,
  Request,
  Answer,
  Operation,
  Target,
  Item,
  Extra,
  ErrorCode,
  // the evidence behind an edge and an unknown
  Tier,
  Evidence,
  Unknown,
  Cause,
  // a kept build and its files
  GenerationManifest,
  OpenGeneration,
  GraphStore,
  ProjectModel,
  ReadIndexFile,
} from "@openqodex/graph";
export type {
  // the reviewer contract
  Reviewer,
  AgentReviewer,
  ModelReviewer,
  ModelRequest,
  ModelResponse,
  ModelUsage,
  Message,
  ToolCallRequest,
  ToolDefinition,
  ToolParameter,
  // the budget
  Budget,
  AuthorizeRequest,
  // reviewChange's input, options and result
  ReviewChangeInput,
  ReviewChangeOptions,
  ReviewResult,
  ReviewScope,
  ReviewStatus,
  ResultFinding,
  Disposition,
  CorrectionRound,
  // usage and the brain's evidence
  CallRecord,
  UsageTotals,
  ModelPurpose,
  ReviewerRole,
  ToolLogEntry,
  ModelReviewEvidence,
} from "@openqodex/review";
