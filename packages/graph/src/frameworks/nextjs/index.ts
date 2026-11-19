// The Next.js plugin (PLAN.md 3.2.3, the Next.js row): the routes of the
// app router and the pages router from the file tree, each bound to the
// export that handles it, the roles of the app router's conventions
// (layouts, templates, loading and error boundaries) and of client
// components, the middleware and the routes its matcher selects, and
// server actions. See resolve.ts for the rules.
import type { CapabilityReport, FrameworkPlugin } from "../plugin.js";
import type { NextFact } from "./facts.js";
import { isNextFact, readFacts, reader, wants } from "./facts.js";
import { analyse, PLUGIN, RULE_VERSION } from "./resolve.js";

// 4: every kept string follows the one rule of shared/kept.ts.
// 5: a tagged template with type arguments and a cast to an import type with an array suffix are read, not a region the parser could not read.
export const VERSION = 5;
const SUPPORTED = "Next.js 13.4 to 15";

const app = "nextjs-app";
const meta = "nextjs-metadata-edit";
const not = "nextjs-not-next";
const path = "a route comes from a file's path by the framework's rule, so there is no import to alias";

export const nextjs: FrameworkPlugin<NextFact> = {
  id: PLUGIN,
  version: VERSION,
  supportedVersions: SUPPORTED,
  languages: ["javascript", "typescript", "tsx"],
  // The route folders whose files decide the routes, whether or not a file is parsed.
  inputs: { paths: [/(^|\/)(src\/)?(app|pages)\//, /(^|\/)(src\/)?middleware\.[jt]s$/], dependencies: { npm: ["next"] } },
  wants: () => wants(),
  facts: (root) => readFacts(root),
  reader: (root) => reader(root),
  isFact: (v): v is NextFact => isNextFact(v),
  detect: (index) => analyse(index).apps,
  resolve: (index) => analyse(index).output,
  capabilities: (): CapabilityReport => ({
    plugin: PLUGIN,
    version: VERSION,
    supportedVersions: SUPPORTED,
    rules: [
      {
        id: "nextjs-app-route",
        version: RULE_VERSION,
        description: "An app router page.* or route.* file serves the URL its folders spell, with route groups dropped, private folders serving nothing, and dynamic segments kept as written; its default export, or its exported HTTP method functions, handle it.",
        emits: ["registration", "handles", "route_handler"],
        fixtures: { positive: [app], aliased: { none: path }, unrelatedSameName: [app, not], dynamic: [app], metadataEdit: [meta] },
      },
      {
        id: "nextjs-pages-route",
        version: RULE_VERSION,
        description: "A pages router file serves the URL its path spells (index is the folder itself), and a file under pages/api is an API route for every method; its default export handles it.",
        emits: ["registration", "handles", "route_handler"],
        fixtures: { positive: [app], aliased: { none: path }, unrelatedSameName: [not], dynamic: { none: "a pages route is a path; a dynamic segment is kept as written" }, metadataEdit: [meta] },
      },
      {
        id: "nextjs-conventions",
        version: RULE_VERSION,
        description: "The default exports of layout, template, loading, error, not-found and default files are components with that role; the exported components of a file that starts with \"use client\" are client components.",
        emits: ["component"],
        fixtures: { positive: [app], aliased: { none: path }, unrelatedSameName: [not], dynamic: { none: "a convention is a file name, never computed" }, metadataEdit: [meta] },
      },
      {
        id: "nextjs-middleware",
        version: RULE_VERSION,
        description: "The middleware file's function runs before every route its literal matcher selects, or before every route when it has none; a matcher the plugin cannot read makes the link possible.",
        emits: ["applies_middleware", "middleware"],
        fixtures: { positive: [app], aliased: { none: path }, unrelatedSameName: [not], dynamic: { none: "a computed matcher is an unknown of cause dynamic; no corpus case plants one yet" }, metadataEdit: [meta] },
      },
      {
        id: "nextjs-server-action",
        version: RULE_VERSION,
        description: "Every exported function of a file that starts with \"use server\", and every function whose own body starts with it, is a server action: a POST entry with no URL of its own.",
        emits: ["registration", "handles", "route_handler"],
        fixtures: { positive: [app], aliased: { none: "a directive is a string, never imported" }, unrelatedSameName: [not], dynamic: { none: "a directive is a literal" }, metadataEdit: [meta] },
      },
    ],
    negativeControls: [not],
    sampleApps: ["packages/graph/src/frameworks/nextjs/nextjs.test.ts"],
  }),
};
