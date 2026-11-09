// The correctness corpus (packages/graph/corpus, PLAN.md 3.6): each case is a
// real two-commit repository, built in a temp folder and reviewed through
// getChange, buildGraph and detectImpact, then scored against its
// expected.json. One test per case, named for the real failure it guards;
// a case the graph fails today is marked `knownFailure` in its expected.json
// and runs as `it.fails`, so fixing the graph turns it red until the marker
// goes. The last test holds the gate: certain precision, evidence validity,
// gap disclosure, cut disclosure, recall and the negative controls all 1.
// The framework plugins' cases (corpus/frameworks/) run in
// frameworks-corpus.test.ts, one group per plugin, with the same gate.
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { findCases } from "../corpus/score.js";
import { defineCorpus } from "./corpus-runner.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "corpus");
const dirs = findCases(root).filter((dir) => !relative(root, dir).startsWith("frameworks/"));

defineCorpus("the correctness corpus", root, dirs, 300_000);
