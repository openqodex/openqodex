// The Nest plugin: applications made by `NestFactory.create`, the modules
// their root module reaches through `imports`, the controllers those
// modules declare, and the routes the controllers' methods register with
// `@Get`, `@Post` and the other route decorators of @nestjs/common, each
// with its full path composed the way Nest composes it (URI version,
// RouterModule path, controller path, method path, global prefix and its
// exclusions), its controller method, and the guards and interceptors that
// run before it. See resolve.ts for the rules.
import type { CapabilityReport, FrameworkPlugin } from "../plugin.js";
import type { NestFact } from "./facts.js";
import { isNestFact, readFacts, wants } from "./facts.js";
import { analyse, PLUGIN, RULE_VERSION } from "./resolve.js";

export const VERSION = 5;
const SUPPORTED = "Nest 8 to 11";

const app = "nest-app";
const modules = "nest-modules";
const meta = "nest-metadata-edit";
const not = "nest-not-nest";
const repro = "nest-repro";

export const nest: FrameworkPlugin<NestFact> = {
  id: PLUGIN,
  version: VERSION,
  supportedVersions: SUPPORTED,
  languages: ["javascript", "typescript", "tsx"],
  inputs: { paths: [], dependencies: { npm: ["@nestjs/common", "@nestjs/core"] } },
  wants: (source) => wants(source),
  facts: (root) => readFacts(root),
  isFact: (v): v is NestFact => isNestFact(v),
  detect: (index) => analyse(index).apps,
  resolve: (index) => analyse(index).output,
  capabilities: (): CapabilityReport => ({
    plugin: PLUGIN,
    version: VERSION,
    supportedVersions: SUPPORTED,
    rules: [
      {
        id: "nest-route",
        version: RULE_VERSION,
        description: "A route a controller method registers with a route decorator of @nestjs/common, bound to that method, with its full path composed under the controller's path, its module's RouterModule path, its URI version and the application's global prefix.",
        emits: ["registration", "handles", "route_handler"],
        fixtures: { positive: [app, modules, repro], aliased: [app], unrelatedSameName: [app, not], dynamic: [app], metadataEdit: [meta] },
      },
      {
        id: "nest-module",
        version: RULE_VERSION,
        description: "A controller an application serves: declared by a module its root module reaches through imports, forwardRef and dynamic modules of the repository.",
        emits: ["mounts"],
        fixtures: { positive: [app, modules], aliased: { none: "a module is reached through the class names its imports list; the Module decorator's own aliased import is the route rule's aliased case" }, unrelatedSameName: [not], dynamic: [repro], metadataEdit: [meta] },
      },
      {
        id: "nest-middleware",
        version: RULE_VERSION,
        description: "The guards and interceptors that run before a route's handler, in the order Nest runs them: the controller's guards, the method's guards, then the controller's and the method's interceptors.",
        emits: ["applies_middleware", "middleware"],
        fixtures: { positive: [app], aliased: { none: "UseGuards is matched through the same import rule as Controller and Get, whose aliased case covers it" }, unrelatedSameName: [not], dynamic: { none: "a guard made at run time (a call such as AuthGuard('jwt')) is an unknown of cause dynamic or external; no corpus case plants one yet" }, metadataEdit: { none: "the metadata case has no guard" } },
      },
    ],
    negativeControls: [not],
    sampleApps: ["packages/graph/src/frameworks/nest/nest.test.ts"],
  }),
};
