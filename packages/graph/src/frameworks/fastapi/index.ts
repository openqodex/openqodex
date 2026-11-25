// The FastAPI plugin (PLAN.md 3.2.3, the FastAPI row): applications made by
// `FastAPI()`, routers made by `APIRouter()`, the routes registered on them
// with decorators (`@app.get`, `@router.post`, `api_route`, `websocket`)
// and with `add_api_route`, the routers included with `include_router`
// composed under their prefixes into the full pattern each application
// serves, the dependencies that run before each handler (`Depends` and
// `Security`), the classes that are Pydantic models, pytest tests, and the
// test client requests that may reach each route. See resolve.ts for the
// rules.
import type { CapabilityReport, FrameworkPlugin } from "../plugin.js";
import type { FastApiFact } from "./facts.js";
import { isFastApiFact, readFacts, wants } from "./facts.js";
import { analyse, PLUGIN, RULE_VERSION } from "./resolve.js";

// 5: every kept string follows the one rule of shared/kept.ts.
// 6: a test client keeps its base URL, and a request is joined to its path.
// 7: each dependency is a call from every route handler it runs for and
// from a dependency that declares it (fact "deps"), with evidence
// fastapi-depends.
// 8: an expression the reader cut at a cap says so, and a function whose
// only dependencies are past the parameter cap keeps its deps fact.
export const VERSION = 8;
const SUPPORTED = "FastAPI 0.100 and later";

const app = "fastapi-app";
const meta = "fastapi-metadata-edit";
const not = "fastapi-not-fastapi";
const depends = "fastapi-depends-calls";

export const fastapi: FrameworkPlugin<FastApiFact> = {
  id: PLUGIN,
  version: VERSION,
  supportedVersions: SUPPORTED,
  languages: ["python"],
  inputs: { paths: [], dependencies: { python: ["fastapi", "pydantic"] } },
  wants: () => wants(),
  facts: (root) => readFacts(root),
  isFact: (v): v is FastApiFact => isFastApiFact(v),
  detect: (index) => analyse(index).apps,
  resolve: (index) => analyse(index).output,
  capabilities: (): CapabilityReport => ({
    plugin: PLUGIN,
    version: VERSION,
    supportedVersions: SUPPORTED,
    rules: [
      {
        id: "fastapi-route",
        version: RULE_VERSION,
        description: "A route registered by a decorator or an add_api_route call on a FastAPI application or router, bound to the decorated function by its definition, with its path composed under every include and router prefix.",
        emits: ["registration", "handles", "route_handler"],
        fixtures: { positive: [app], aliased: [app], unrelatedSameName: [app, not], dynamic: [app], metadataEdit: [meta] },
      },
      {
        id: "fastapi-include",
        version: RULE_VERSION,
        description: "A router included in an application or a router with include_router, its include prefix and its own prefix joined as written before every path it holds.",
        emits: ["mounts"],
        fixtures: { positive: [app], aliased: [app], unrelatedSameName: [not], dynamic: { none: "a computed include prefix is an unknown of cause dynamic with the routes kept and their pattern null; no corpus case plants one yet" }, metadataEdit: [meta] },
      },
      {
        id: "fastapi-dependency",
        version: RULE_VERSION,
        description: "The dependencies that run before a route's handler, in order: the application's, each include's and router's own, the decorator's, then the handler's parameters declared with Depends or Security. Each is also a call from the handler, and a dependency's own Depends parameters are calls from it.",
        emits: ["applies_middleware", "middleware"],
        fixtures: { positive: [app, depends], aliased: { none: "Depends is matched by its qualified name through the same import rule as FastAPI and APIRouter, whose aliased case covers it" }, unrelatedSameName: [not, depends], dynamic: { none: "a dependency names a function, not a path; a computed one is an unknown of cause dynamic" }, metadataEdit: [meta] },
      },
      {
        id: "fastapi-pydantic-model",
        version: RULE_VERSION,
        description: "A class whose base is Pydantic's BaseModel, or a class of the repository that is a model, followed at most eight bases deep.",
        emits: ["model"],
        fixtures: { positive: [app], aliased: { none: "BaseModel is matched by its qualified name through the same import rule as FastAPI, whose aliased case covers it" }, unrelatedSameName: [not], dynamic: { none: "a base class is a declaration, never a computed value" }, metadataEdit: { none: "the model rule needs pydantic or fastapi declared; the metadata case declares neither in its base and has no model" } },
      },
      {
        id: "fastapi-test-request",
        version: RULE_VERSION,
        description: "A TestClient request whose literal method and path match a route of the application the client was given, and the test functions of a pytest module.",
        emits: ["tests", "test"],
        fixtures: { positive: [app], aliased: { none: "the test client is reached through its import; an aliased TestClient import is the same import rule as the positive case" }, unrelatedSameName: [app], dynamic: { none: "a computed request path is an unknown of cause dynamic; no corpus case plants one yet" }, metadataEdit: { none: "the metadata case has no test module" } },
      },
    ],
    negativeControls: [not],
    sampleApps: ["packages/graph/src/frameworks/fastapi/fastapi.test.ts"],
  }),
};
