import type { FrameworkPlugin } from "../plugin.js";
import type { JunitFact } from "./facts.js";
import { isJunitFact, readFacts, reader } from "./facts.js";
import { analyse, PLUGIN, RULE } from "./resolve.js";

const VERSION = 1;
const SUPPORTED = "JUnit 4 and JUnit 5";

export const junit: FrameworkPlugin<JunitFact> = {
  id: PLUGIN,
  version: VERSION,
  supportedVersions: SUPPORTED,
  languages: ["java"],
  inputs: { paths: [], dependencies: {} },
  wants: (source, lang) => lang === "java" && source.includes("@"),
  facts: (root) => readFacts(root),
  reader: (root) => reader(root),
  isFact: isJunitFact,
  detect: (index) => analyse(index).apps,
  resolve: (index) => analyse(index).output,
  capabilities: () => ({
    plugin: PLUGIN,
    version: VERSION,
    supportedVersions: SUPPORTED,
    rules: [
      {
        ...RULE,
        description: "Exact JUnit annotations classify test and fixture methods. Direct test calls keep their call tiers.",
        emits: ["test", "fixture", "tests"],
        fixtures: {
          positive: ["junit-jupiter", "junit4", "junit-single-star", "junit-explicit-import-wins", "junit-qualified-no-import-alias", "junit-literal-annotations", "junit-static-assertions", "junit-sibling-package", "junit-platform-stars", "junit-competing-stars"],
          aliased: { none: "Java has no import aliases. The qualified annotation case proves identity without an import." },
          unrelatedSameName: ["junit-testng", "junit-repository-test", "junit-nested-shadowing", "junit-competing-stars", "junit-sibling-shadow"],
          dynamic: { none: "Java annotation names are literal. The literal annotation case excludes strings, comments, and unsupported annotation names." },
          metadataEdit: ["junit-metadata-edit"],
        },
      },
    ],
    negativeControls: ["junit-testng", "junit-repository-test", "junit-manifest-only", "junit-nested-shadowing", "junit-sibling-shadow"],
    sampleApps: ["packages/graph/src/frameworks/junit/junit.test.ts"],
  }),
};
