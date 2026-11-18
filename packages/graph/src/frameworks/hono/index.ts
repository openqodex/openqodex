// The Hono plugin: applications and routers made by `new Hono()`, `new
// OpenAPIHono()` of @hono/zod-openapi or a hono/factory `createApp()`, the
// routes registered on them with `get`, `post`, `put`, `patch`, `delete`,
// `options`, `all` and `on`, the OpenAPI routes registered with
// `openapi(route, handler)` from `createRoute({ method, path })` definitions
// in any file, the routers mounted with `route(prefix, router)` (a router a
// factory function returns included, through wrappers that mount what they
// are given), `basePath` prefixes, and the middleware added with `use`, all
// composed into the full path each application serves. See resolve.ts for
// the rules.
import type { CapabilityReport, FrameworkPlugin } from "../plugin.js";
import type { HonoFact } from "./facts.js";
import { isHonoFact, readFacts, reader, wants } from "./facts.js";
import { analyse, PLUGIN, RULE_VERSION } from "./resolve.js";

export const VERSION = 2;

const SUPPORTED = "Hono 4 and @hono/zod-openapi";
const app = "hono-app";
const openapi = "hono-openapi";

export const hono: FrameworkPlugin<HonoFact> = {
  id: PLUGIN,
  version: VERSION,
  supportedVersions: SUPPORTED,
  languages: ["javascript", "typescript", "tsx"],
  inputs: { paths: [], dependencies: { npm: ["hono", "@hono/zod-openapi"] } },
  wants: () => wants(),
  facts: (root) => readFacts(root),
  reader: (root) => reader(root),
  isFact: (v): v is HonoFact => isHonoFact(v),
  detect: (index) => analyse(index).apps,
  resolve: (index) => analyse(index).output,
  capabilities: (): CapabilityReport => ({
    plugin: PLUGIN,
    version: VERSION,
    supportedVersions: SUPPORTED,
    rules: [
      {
        id: "hono-route",
        version: RULE_VERSION,
        description: "A route registered with an HTTP method, all or on on a Hono application or router, with its handler bound by the handler's own binding, kept when the handler is missing, wrapped, inline or computed.",
        emits: ["registration", "handles", "route_handler"],
        fixtures: { positive: [app, "hono-repro", "hono-react-repro"], aliased: [app], unrelatedSameName: [app, "hono-not-hono"], dynamic: [app], metadataEdit: ["hono-metadata-edit"] },
      },
      {
        id: "hono-openapi",
        version: RULE_VERSION,
        description: "An OpenAPI route registered with openapi(route, handler), its method and path read from the createRoute definition the route names, in its own file or another, with each {name} path parameter served as :name.",
        emits: ["registration", "handles", "route_handler"],
        fixtures: { positive: [openapi, "honoz-repro"], aliased: [openapi], unrelatedSameName: [openapi, "hono-not-hono"], dynamic: [openapi], metadataEdit: ["hono-metadata-edit"] },
      },
      {
        id: "hono-mount",
        version: RULE_VERSION,
        description: "A router mounted with route(prefix, router), where the router is a value, a basePath of one, or what a function returns when it has one return the plugin reads, composed into the full pattern of every route it holds.",
        emits: ["mounts"],
        fixtures: { positive: [app, openapi], aliased: [app], unrelatedSameName: [app, "hono-not-hono"], dynamic: [app, openapi], metadataEdit: ["hono-metadata-edit"] },
      },
      {
        id: "hono-middleware",
        version: RULE_VERSION,
        description: "Middleware in effect for a route, in order: the use calls of its application and routers before it whose path covers the route, then the route's own arguments before its handler.",
        emits: ["applies_middleware", "middleware"],
        fixtures: { positive: [app, openapi], aliased: [app], unrelatedSameName: ["hono-not-hono"], dynamic: { none: "a middleware argument has no path of its own to compute; a computed middleware path is an unknown of cause dynamic, and a computed middleware value is covered by the route rule's case" }, metadataEdit: ["hono-metadata-edit"] },
      },
    ],
    negativeControls: ["hono-not-hono"],
    sampleApps: ["packages/graph/src/frameworks/hono/hono.test.ts"],
  }),
};
