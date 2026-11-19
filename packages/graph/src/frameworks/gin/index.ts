// The gin plugin (github.com/gin-gonic/gin): engines made by `gin.Default()`
// and `gin.New()`, the routes registered on them and on their groups with
// GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD, Any and Handle, each group's
// prefix composed in, the middleware added with `Use` and given to a group
// or a route, and each route's handler (a function, a method value, or a
// function written in place). See resolve.ts for the rules.
import type { CapabilityReport, FrameworkPlugin } from "../plugin.js";
import { isGoHttpFact } from "../go-http/facts.js";
import type { GinFact } from "./facts.js";
import { readFacts } from "./facts.js";
import { analyse, MODULE, PLUGIN, RULE_VERSION } from "./resolve.js";

export const VERSION = 1;
const SUPPORTED = "gin v1";

const app = "gin-app";
const meta = "gin-metadata-edit";
const control = "gin-not-gin";

export const gin: FrameworkPlugin<GinFact> = {
  id: PLUGIN,
  version: VERSION,
  supportedVersions: SUPPORTED,
  languages: ["go"],
  inputs: { paths: [], dependencies: { go: [MODULE] } },
  // Every Go file is read: a package-level router another file registers on
  // needs no tell-tale text in the file that registers (see go-http/facts.ts).
  wants: () => true,
  facts: (root) => readFacts(root),
  isFact: (v): v is GinFact => isGoHttpFact(v),
  detect: (index) => analyse(index).apps,
  resolve: (index) => analyse(index).output,
  capabilities: (): CapabilityReport => ({
    plugin: PLUGIN,
    version: VERSION,
    supportedVersions: SUPPORTED,
    rules: [
      {
        id: "gin-route",
        version: RULE_VERSION,
        description: "A route registered on a gin engine or group with GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD, Any or Handle, with every group's prefix composed in, and its handler bound by the handler's own binding (a function, a method value of a declared type, or a function written in place), kept when the handler is missing, a call's result or computed.",
        emits: ["registration", "handles", "route_handler"],
        fixtures: { positive: [app], aliased: [app], unrelatedSameName: [app, control], dynamic: [app], metadataEdit: [meta] },
      },
      {
        id: "gin-middleware",
        version: RULE_VERSION,
        description: "A middleware added with Use, given to Group or written before a route's handler, applied to the routes registered after it on that router and its groups, in gin's order; a Use in another function than the route applies with tier possible.",
        emits: ["applies_middleware", "middleware"],
        fixtures: {
          positive: [app],
          aliased: [app],
          unrelatedSameName: [control],
          dynamic: { none: "a middleware is bound through the same lookup as a handler; a computed middleware is an unknown, covered by the route rule's dynamic case" },
          metadataEdit: { none: "a middleware binds through the same lookup as a handler; the route rule's metadata-edit case proves that lookup across a go.mod change" },
        },
      },
    ],
    negativeControls: [control],
    sampleApps: ["packages/graph/src/frameworks/gin/gin.test.ts"],
  }),
};
