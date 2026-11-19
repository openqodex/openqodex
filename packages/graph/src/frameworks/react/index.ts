// The React plugin (PLAN.md 3.2.3, the React row): components (functions
// that return JSX, classes on React's Component), hooks (functions named
// use... that call a hook), which component renders which through bound
// JSX elements, and which tests render a component through a testing
// library. See resolve.ts for the rules.
import type { CapabilityReport, FrameworkPlugin } from "../plugin.js";
import type { ReactFact } from "./facts.js";
import { isReactFact, readFacts, reader, wants } from "./facts.js";
import { analyse, PLUGIN, RULE_VERSION } from "./resolve.js";

// 4: a cap counted across the build is a gap of the whole build.
// 5: a tagged template with type arguments and a cast to an import type with an array suffix are read, not a region the parser could not read.
export const VERSION = 5;
const SUPPORTED = "React 16.8 to 19";

const app = "react-app";
const meta = "react-metadata-edit";
const not = "react-not-react";

export const react: FrameworkPlugin<ReactFact> = {
  id: PLUGIN,
  version: VERSION,
  supportedVersions: SUPPORTED,
  languages: ["javascript", "typescript", "tsx"],
  inputs: { paths: [], dependencies: { npm: ["react"] } },
  wants: () => wants(),
  facts: (root) => readFacts(root),
  reader: (root) => reader(root),
  isFact: (v): v is ReactFact => isReactFact(v),
  detect: (index) => analyse(index).apps,
  resolve: (index) => analyse(index).output,
  capabilities: (): CapabilityReport => ({
    plugin: PLUGIN,
    version: VERSION,
    supportedVersions: SUPPORTED,
    rules: [
      {
        id: "react-component",
        version: RULE_VERSION,
        description: "A top-level function with a capitalised name whose own body returns JSX, or a class whose base binds to React's Component or PureComponent or to a component class of the repository.",
        emits: ["component"],
        fixtures: { positive: [app], aliased: [app], unrelatedSameName: [app, not], dynamic: { none: "a component is a declaration; a computed one is an element's unknown, covered by the renders rule" }, metadataEdit: [meta] },
      },
      {
        id: "react-hook",
        version: RULE_VERSION,
        description: "A function named use... that calls a hook of the react module, bound through its import, or a hook of the repository; the name alone is never enough.",
        emits: ["hook"],
        fixtures: { positive: [app], aliased: { none: "a hook is bound by the same import rule as a component class, whose aliased case covers it" }, unrelatedSameName: [app], dynamic: { none: "a hook call names a function; a computed callee is no hook call" }, metadataEdit: [meta] },
      },
      {
        id: "react-renders",
        version: RULE_VERSION,
        description: "A JSX element whose name binds to a definition renders it; an element whose name is a local value is an unknown of cause dynamic, and one from a dependency is external.",
        emits: ["renders"],
        fixtures: { positive: [app], aliased: [app], unrelatedSameName: [app], dynamic: [app], metadataEdit: [meta] },
      },
      {
        id: "react-test-render",
        version: RULE_VERSION,
        description: "An element given to a testing library's render function, bound by import, links the test to the component it renders.",
        emits: ["tests", "test"],
        fixtures: { positive: [app], aliased: { none: "the render function is bound by the same import rule as the positive case" }, unrelatedSameName: [not], dynamic: { none: "a computed element in a test is the renders rule's dynamic unknown" }, metadataEdit: { none: "the metadata case has no test" } },
      },
    ],
    negativeControls: [not],
    sampleApps: ["packages/graph/src/frameworks/react/react.test.ts"],
  }),
};
