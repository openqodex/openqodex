// The Express plugin (PLAN.md 3.2.3, the Express row): applications made by
// `express()`, routers made by `express.Router()` or `Router()`, the routes
// registered on them with `get`, `post`, `put`, `patch`, `delete`,
// `options`, `head`, `all` and `route(...)`, the routers and middleware
// added with `use`, composed under their mount paths into the full
// pattern each application serves, and the supertest requests that may
// reach each route. See resolve.ts for the rules.
import type { CapabilityReport, FrameworkPlugin } from "../plugin.js";
import type { ExpressFact } from "./facts.js";
import { isExpressFact, readFacts, reader, wants } from "./facts.js";
import { analyse, PLUGIN, RULE_VERSION } from "./resolve.js";

// 5: every kept string follows the one rule of shared/kept.ts.
// 6: values and scopes kept only for a file whose values resolve can read.
// 7: a value kept only when resolve can read its name.
// 8: a router required with CommonJS keeps its mount, or the mount is an unknown.
// 9: an export written more than once is an unknown on the mount.
// 10: exports.n written after module.exports is replaced is an unknown on the mount.
// 11: an arrow function export is no router; a member of a require bound to a name is followed; a static method beside an exported member does not compete with it.
// 12: a handler written in place is bound to the definition the language extractor makes for it.
export const VERSION = 12;

const app = "express-app";

export const express: FrameworkPlugin<ExpressFact> = {
  id: PLUGIN,
  version: VERSION,
  supportedVersions: "Express 4 and 5",
  languages: ["javascript", "typescript", "tsx"],
  inputs: { paths: [], dependencies: { npm: ["express", "supertest"] } },
  wants: () => wants(),
  facts: (root) => readFacts(root),
  reader: (root) => reader(root),
  isFact: (v): v is ExpressFact => isExpressFact(v),
  detect: (index) => analyse(index).apps,
  resolve: (index) => analyse(index).output,
  capabilities: (): CapabilityReport => ({
    plugin: PLUGIN,
    version: VERSION,
    supportedVersions: "Express 4 and 5",
    rules: [
      {
        id: "express-route",
        version: RULE_VERSION,
        description: "A route registered with an HTTP method on an Express application or router, with its handler bound by the handler's own binding, kept when the handler is missing, wrapped, inline or computed.",
        emits: ["registration", "handles", "route_handler"],
        fixtures: { positive: [app], aliased: [app], unrelatedSameName: [app, "express-not-express"], dynamic: [app], metadataEdit: ["express-metadata-edit"] },
      },
      {
        id: "express-mount",
        version: RULE_VERSION,
        description: "A router added to an application or a router with use, under its mount path, composed into the full pattern of every route it holds.",
        emits: ["mounts"],
        fixtures: { positive: [app], aliased: [app], unrelatedSameName: ["express-not-express"], dynamic: [app], metadataEdit: ["express-metadata-edit"] },
      },
      {
        id: "express-middleware",
        version: RULE_VERSION,
        description: "Middleware in effect for a route, in order: the application's and the routers' own use calls before it, then the route's own arguments before its handler.",
        emits: ["applies_middleware", "middleware"],
        fixtures: { positive: [app], aliased: [app], unrelatedSameName: ["express-not-express"], dynamic: { none: "a middleware argument has no path of its own to compute; a computed middleware value is an unknown of cause dynamic, covered by the route rule's case" }, metadataEdit: ["express-metadata-edit"] },
      },
      {
        id: "express-test-request",
        version: RULE_VERSION,
        description: "A supertest request on an application whose literal method and path match a route of that same application.",
        emits: ["tests", "test"],
        fixtures: { positive: [app], aliased: { none: "the test agent is reached through its import; an aliased supertest import is the same import rule as the positive case" }, unrelatedSameName: [app], dynamic: { none: "a computed request path is an unknown of cause dynamic; no fixture plants one yet" }, metadataEdit: ["express-metadata-edit"] },
      },
    ],
    negativeControls: ["express-not-express"],
    sampleApps: ["packages/graph/src/frameworks/express/express.test.ts"],
  }),
};
