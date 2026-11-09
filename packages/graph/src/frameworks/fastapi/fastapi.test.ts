// The FastAPI plugin on the sample application of the corpus
// (corpus/frameworks/fastapi/fastapi-app), built as a real git repository
// and run through the whole graph build: the questions a review asks of a
// handler change, answered from the framework layer. Then the same plugin
// on Python a stranger wrote to fool or stall it: routes written inside a
// string or a comment, computed paths, a broken file, and more than 1 MiB of
// crafted routers, includes, dependencies and patterns.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildGraph, frameworkLayer } from "../../index.js";
import type { FrameworkLayer, Graph, Registration } from "../../index.js";
import { cpuMs, expectLinear, growthTests, pluginCpuMs, readerCpuMs } from "../../test-timing.js";
import { MAX_SOURCE_BYTES, readFacts } from "./facts.js";
import { matches, MAX_APPS, MAX_MIDDLEWARE_CHAIN, MAX_MOUNTS, MAX_REGISTRATIONS, MAX_ROLES } from "./resolve.js";

const git = (root: string, ...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8" });
function commitAll(root: string): void {
  git(root, "init", "-q");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "test");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
}
function writeTree(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

// The id of the one symbol `name` in `file`.
function sym(graph: Graph, file: string, name: string): string {
  const hits = (graph.defsByFile.get(file) ?? []).filter((n) => n.name === name);
  if (hits.length !== 1) throw new Error(`${hits.length} symbols named ${name} in ${file}`);
  return (hits[0] as { id: string }).id;
}
const layer = (g: Graph): FrameworkLayer => {
  const l = frameworkLayer(g);
  if (!l) throw new Error("the graph has no framework layer");
  return l;
};
const fastapiRegs = (g: Graph): Registration[] =>
  layer(g)
    .registrations()
    .filter((r) => r.plugin === "fastapi");

describe("the FastAPI plugin on a small real application", () => {
  let changed: Graph;
  let root: string;

  beforeAll(async () => {
    const corpus = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "corpus", "frameworks", "fastapi", "fastapi-app");
    root = mkdtempSync(join(tmpdir(), "oq-fastapi-"));
    cpSync(join(corpus, "base"), root, { recursive: true });
    commitAll(root);
    cpSync(join(corpus, "change"), root, { recursive: true, force: true });
    changed = await buildGraph({ repoRoot: root, store: null });
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("marks the Pydantic models by their base, and nothing else in the repository", () => {
    const models = (changed.frameworks?.roles ?? []).filter((r) => r.plugin === "fastapi" && r.role === "model").map((r) => changed.nodes.get(r.target)?.name);
    expect(models.sort()).toEqual(["Item", "ItemIn"]);
  });

  it("makes no route of a decorator on a registry of the repository's own, though it is called app and its method get", () => {
    expect(layer(changed).registrationsIn("app/cache.py")).toEqual([]);
    expect(layer(changed).routesReaching(sym(changed, "app/cache.py", "cached")).routes).toEqual([]);
  });
});

describe("the FastAPI plugin on routes a stranger wrote to fool it", () => {
  let root: string;
  let graph: Graph;
  const MAIN = [
    "from fastapi import FastAPI",
    "",
    'VERSION = "v2"',
    "app = FastAPI()",
    "",
    'DOC = """',
    '@app.get("/in-string")',
    "def in_string():",
    "    pass",
    '"""',
    "",
    '# @app.get("/in-comment")',
    "# def in_comment():",
    "#     pass",
    "",
    "",
    '@app.get(f"/items/{VERSION}")',
    "def fstring_route():",
    "    return 1",
    "",
    "",
    '@app.get("/tab\\tescaped\\x41\\u0042")',
    "def escaped():",
    "    return 2",
    "",
    "",
    '@app.get("/joined" "/parts")',
    "def joined():",
    "    return 3",
    "",
    "",
    '@app.get(r"/raw\\d")',
    "def raw():",
    "    return 4",
    "",
    "",
    'PREFIX = "/old"',
    'PREFIX += "/new"',
    "",
    "",
    '@app.get(PREFIX + "/x")',
    "def reassigned():",
    "    return 5",
    "",
  ].join("\n");
  const BROKEN = ["from fastapi import FastAPI", "", "app = FastAPI()", "", "", '@app.get("/fine")', "def fine():", "    return 1", "", "", '@app.get("/broken"', "def broken(:", "    pass", ""].join("\n");
  // Names FastAPI uses, shadowed by a parameter, a local assignment, a
  // nested class, or rebound at module level; and one imported inside a
  // factory function, which is FastAPI's own.
  const SHADOW = `from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient
from pydantic import BaseModel


def helper():
    return 1


def build(FastAPI):
    app = FastAPI()

    @app.get("/param-shadow")
    def param_shadow():
        return 1

    return app


def local():
    FastAPI = dict
    app = FastAPI()

    @app.get("/local-shadow")
    def local_shadow():
        return 2

    return app


def factory():
    from fastapi import FastAPI as Real

    app = Real()

    @app.get("/scoped-import")
    def scoped_import():
        return 3

    return app


real = FastAPI()


def register(real):
    @real.get("/param-receiver")
    def param_receiver():
        return 4


@real.get("/kept", dependencies=[Depends(helper)])
def kept():
    return 5


def deps_shadow(Depends):
    @real.get("/deps-shadow", dependencies=[Depends(helper)])
    def deps_shadow_route():
        return 6


def models():
    class BaseModel:
        pass

    class Local(BaseModel):
        pass

    return Local


def shadowed_client(TestClient):
    client = TestClient(real)
    client.get("/kept")
`;
  // A route over another decorator registers what that decorator returns;
  // route decorators stacked on one function each register it.
  const WRAPPED = `from fastapi import Depends, FastAPI

app = FastAPI()


def wrap(fn):
    return fn


def helper():
    return 1


@app.get("/wrapped")
@wrap
def wrapped(dep=Depends(helper)):
    return 1


@app.get("/a")
@app.get("/b")
def stacked():
    return 2


@wrap
@app.get("/outer-wrap")
def outer_wrapped():
    return 3
`;
  // Calls with more arguments than the plugin reads, the keyword that
  // matters written last.
  const filler = Array.from({ length: 30 }, (_, i) => `a${i}=${i}`).join(", ");
  const TRUNCATED = `from fastapi import APIRouter, Depends, FastAPI

app = FastAPI()


def helper():
    return 1


router = APIRouter(${filler}, prefix="/hidden")
app.include_router(router)


@router.get("/r")
def r():
    return 1


@app.api_route("/m", ${filler}, methods=["POST"])
def m():
    return 2


@app.get("/d", ${filler}, dependencies=[Depends(helper)])
def d():
    return 3
`;
  // Dependencies and an include the plugin cannot bind.
  const UNBOUND = `from fastapi import Depends, FastAPI
import secrets

app = FastAPI()


def helper():
    return 1


@app.get("/plain", dependencies=[helper])
def plain():
    return 1


@app.get("/ext", dependencies=[Depends(secrets.token_hex)])
def ext():
    return 2


app.include_router(secrets.router)
`;
  // include_router copies the routes a router has at that moment.
  const ORDER_ROUTES = `from fastapi import APIRouter

router = APIRouter()


@router.get("/early")
def early():
    return 1
`;
  const ORDER_MAIN = `from fastapi import APIRouter, FastAPI

from app.order.routes import router

app = FastAPI()
local = APIRouter()


@local.get("/before")
def before():
    return 1


app.include_router(local)
app.include_router(router)


@local.get("/after")
def after():
    return 2


@router.get("/main-late")
def main_late():
    return 3
`;
  const ORDER_EXTRA = `from app.order.routes import router


@router.get("/third")
def third():
    return 4
`;
  // A literal route and request longer than the matcher reads, and a
  // pattern it cannot read, each requested by a test.
  const LONG = `/${"s/".repeat(69)}s`;
  const MATCHER = `from fastapi import FastAPI
from fastapi.testclient import TestClient

app = FastAPI()
client = TestClient(app)


@app.get("${LONG}")
def long_route():
    return 1


@app.get("/files/{p:path}.txt")
def odd_route():
    return 2


def test_long():
    client.get("${LONG}")


def test_odd():
    client.get("/files/a.txt")


@app.get("/relative")
def relative_route():
    return 3


def test_relative():
    client.get("relative")
`;
  // A route path and a request path named by a module constant that a
  // parameter or a local of the function around the use shadows.
  const SCOPED_PATH = `from fastapi import FastAPI
from fastapi.testclient import TestClient

app = FastAPI()
client = TestClient(app)
PATH = "/module-path"


def by_param(PATH):
    @app.get(PATH)
    def param_path():
        return 1


def by_local():
    PATH = make_path()

    @app.get(PATH)
    def local_path():
        return 2


@app.get(PATH)
def module_path():
    return 3


def test_local_request():
    PATH = "/elsewhere"
    client.get(PATH)


def test_module_request():
    client.get(PATH)
`;
  const REBOUND = `from fastapi import FastAPI

app = FastAPI()


@app.get("/rebound")
def rebound():
    return 1


FastAPI = object
`;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "oq-fastapi-fool-"));
    writeTree(root, { "pyproject.toml": '[project]\nname = "fool"\nversion = "0.1.0"\ndependencies = ["fastapi>=0.115"]\n', "app/__init__.py": "", "app/main.py": MAIN, "app/broken.py": BROKEN, "app/shadow.py": SHADOW, "app/rebound.py": REBOUND, "app/wrapped.py": WRAPPED, "app/truncated.py": TRUNCATED, "app/unbound.py": UNBOUND, "app/order/__init__.py": "", "app/order/routes.py": ORDER_ROUTES, "app/order/main.py": ORDER_MAIN, "app/order/extra.py": ORDER_EXTRA, "app/test_matcher.py": MATCHER, "app/scoped_path.py": SCOPED_PATH });
    commitAll(root);
    graph = await buildGraph({ repoRoot: root, store: null });
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("registers nothing for a decorator written inside a string literal or a comment", () => {
    const written = fastapiRegs(graph).map((r) => r.written);
    expect(written).not.toContain("/in-string");
    expect(written).not.toContain("/in-comment");
  });

  it("decodes route paths by Python's string rules: escapes, adjacent literals and raw strings", () => {
    const main = fastapiRegs(graph)
      .filter((r) => r.site.file === "app/main.py")
      .map((r) => r.pattern);
    expect(main.sort()).toEqual(["/joined/parts", "/raw\\d", "/tab\tescapedAB"]);
  });

  it("treats an f-string path with a replacement field as computed: an unknown naming the handler, never a registration", () => {
    expect(fastapiRegs(graph).some((r) => r.site.line === 17)).toBe(false);
    const gap = graph.frameworks?.unknowns.find((u) => u.plugin === "fastapi" && u.site?.file === "app/main.py" && u.site.line === 17);
    expect(gap?.cause).toBe("dynamic");
    expect(gap?.name).toBe("fstring_route");
  });

  it("treats a module name assigned more than once as no constant, so a path built from it is an unknown, never a stale pattern", () => {
    expect(fastapiRegs(graph).some((r) => r.handler.written === "reassigned")).toBe(false);
    const gap = graph.frameworks?.unknowns.find((u) => u.plugin === "fastapi" && u.name === "reassigned");
    expect(gap?.cause).toBe("dynamic");
  });

  it("takes no application from FastAPI or a receiver shadowed by a parameter, a local assignment or a module-level rebinding, and keeps FastAPI imported inside a factory", () => {
    const written = fastapiRegs(graph).map((r) => r.written);
    for (const shadowed of ["/param-shadow", "/local-shadow", "/param-receiver", "/rebound"]) expect(written).not.toContain(shadowed);
    expect(written).toContain("/kept");
    expect(written).toContain("/scoped-import");
    expect((graph.frameworks?.apps ?? []).filter((a) => a.plugin === "fastapi" && a.site.file === "app/rebound.py")).toEqual([]);
  });

  it("takes no dependency from Depends, no model from BaseModel and no test client from TestClient when a parameter or a nested class shadows the name", () => {
    const deps = (graph.frameworks?.edges ?? []).filter((e) => e.plugin === "fastapi" && e.kind === "applies_middleware");
    const from = (written: string) => fastapiRegs(graph).find((r) => r.written === written)?.id;
    expect(deps.some((e) => e.from === from("/kept"))).toBe(true);
    expect(deps.some((e) => e.from === from("/deps-shadow"))).toBe(false);
    const models = (graph.frameworks?.roles ?? []).filter((r) => r.plugin === "fastapi" && r.role === "model").map((r) => graph.nodes.get(r.target)?.name);
    expect(models).not.toContain("Local");
    const requests = (graph.frameworks?.edges ?? []).filter((e) => e.plugin === "fastapi" && e.kind === "tests" && e.evidence.site.file === "app/shadow.py");
    expect(requests).toEqual([]);
  });

  it("takes no path from a module constant that a parameter or a local of the function around the use shadows: the route or request is a dynamic unknown", () => {
    const regs = fastapiRegs(graph).filter((r) => r.site.file === "app/scoped_path.py");
    expect(regs.map((r) => `${r.handler.written} ${r.pattern}`)).toEqual(["module_path /module-path"]);
    const gaps = (graph.frameworks?.unknowns ?? []).filter((u) => u.plugin === "fastapi" && u.site?.file === "app/scoped_path.py");
    for (const fn of ["param_path", "local_path"]) expect(gaps.find((u) => u.name === fn)?.cause).toBe("dynamic");
    const tests = (graph.frameworks?.edges ?? []).filter((e) => e.plugin === "fastapi" && e.kind === "tests" && e.evidence.site.file === "app/scoped_path.py");
    expect(tests.map((e) => graph.nodes.get(e.from)?.name)).toEqual(["test_module_request"]);
    expect(gaps.some((u) => u.cause === "dynamic" && u.affects.includes("tests") && u.site?.line === 30)).toBe(true);
  });

  it("binds no handler when another decorator wraps the function before the route decorator registers it, and names the wrapper in an unknown", () => {
    const regs = fastapiRegs(graph).filter((r) => r.site.file === "app/wrapped.py");
    const by = (w: string) => regs.find((r) => r.written === w) as Registration;
    const wrapped = by("/wrapped");
    expect(wrapped.handler.status).toBe("unresolved");
    expect(layer(graph).edgesFrom(wrapped.id).filter((e) => e.kind === "handles" || e.kind === "applies_middleware")).toEqual([]);
    const gap = graph.frameworks?.unknowns.find((u) => u.plugin === "fastapi" && u.site?.file === "app/wrapped.py" && u.site.line === wrapped.site.line && u.cause === "unsupported-rule");
    expect(gap?.name).toBe("wrap");
    for (const kept of ["/a", "/b", "/outer-wrap"]) expect(by(kept).handler.status).toBe("bound");
  });

  it("draws no prefix, methods or dependencies from a call with more arguments than it reads, and says so", () => {
    const regs = fastapiRegs(graph).filter((r) => r.site.file === "app/truncated.py");
    const by = (w: string) => regs.find((r) => r.written === w) as Registration;
    expect(by("/r").pattern).toBeNull();
    expect(by("/m").methods).toEqual(["*"]);
    const gaps = (graph.frameworks?.unknowns ?? []).filter((u) => u.plugin === "fastapi" && u.site?.file === "app/truncated.py");
    expect(gaps.some((u) => u.affects.includes("mounts") && u.site?.line === 10)).toBe(true);
    expect(gaps.some((u) => u.affects.includes("handles") && u.site?.line === by("/m").site.line)).toBe(true);
    expect(gaps.some((u) => u.affects.includes("applies_middleware") && u.site?.line === by("/d").site.line)).toBe(true);
  });

  it("never drops a dependency or an include it cannot bind without an unknown: a list entry not written as Depends, an external dependency, an external router", () => {
    const gaps = (graph.frameworks?.unknowns ?? []).filter((u) => u.plugin === "fastapi" && u.site?.file === "app/unbound.py");
    const line = (w: string) => fastapiRegs(graph).find((r) => r.site.file === "app/unbound.py" && r.written === w)?.site.line;
    expect(gaps.some((u) => u.affects.includes("applies_middleware") && u.site?.line === line("/plain") && u.name === "helper")).toBe(true);
    expect(gaps.some((u) => u.affects.includes("applies_middleware") && u.site?.line === line("/ext") && u.cause === "external")).toBe(true);
    expect(gaps.some((u) => u.affects.includes("mounts") && u.site?.line === 21 && u.cause === "external")).toBe(true);
  });

  it("serves only the routes a router holds when it is included, keeps a later one apart from the application, and says when the order is not known", () => {
    const app = "fw:fastapi:app:app/order/main.py:5";
    const under = (w: string) =>
      fastapiRegs(graph)
        .filter((r) => r.written === w)
        .map((r) => r.app);
    expect(under("/before")).toEqual([app]);
    expect(under("/early")).toEqual([app]);
    expect(under("/after")).toEqual([null]);
    expect(under("/main-late")).toEqual([null]);
    expect(under("/third")).toEqual([app]);
    const third = fastapiRegs(graph).find((r) => r.written === "/third") as Registration;
    expect(graph.frameworks?.unknowns.some((u) => u.plugin === "fastapi" && u.site?.file === "app/order/extra.py" && u.site.line === third.site.line && u.note.includes("order"))).toBe(true);
  });

  it("says when a test request could not be matched because the path or the pattern is past what the matcher reads, rather than reporting no link", () => {
    const gaps = (graph.frameworks?.unknowns ?? []).filter((u) => u.plugin === "fastapi" && u.site?.file === "app/test_matcher.py" && u.affects.includes("tests"));
    expect(gaps.filter((u) => u.site?.line === 19).map((u) => u.cause)).toEqual(["fan-out-capped"]);
    expect(gaps.filter((u) => u.site?.line === 23).map((u) => u.cause)).toEqual(["unsupported-rule"]);
  });

  it("links a request whose path has no leading slash to the route the test client sends it to, under its base URL", () => {
    const relative = fastapiRegs(graph).find((r) => r.written === "/relative") as Registration;
    const from = (graph.frameworks?.edges ?? []).filter((e) => e.plugin === "fastapi" && e.kind === "tests" && e.to === relative.id).map((e) => graph.nodes.get(e.from)?.name);
    expect(from).toEqual(["test_relative"]);
  });

  it("reads no decorator inside a broken region of a file, keeps the routes before it, and says the file has a syntax error", () => {
    expect(
      fastapiRegs(graph)
        .filter((r) => r.site.file === "app/broken.py")
        .map((r) => r.pattern),
    ).toEqual(["/fine"]);
    expect(graph.frameworks?.unknowns.some((u) => u.plugin === "fastapi" && u.cause === "file-not-parsed" && u.site?.file === "app/broken.py")).toBe(true);
  });

  it("still matches the request paths FastAPI serves: a parameter, a path parameter, a converter and a trailing slash", () => {
    expect(matches("/items/v1/{item_id}", "/items/v1/1")).toBe(true);
    expect(matches("/items/v1/{item_id}", "/items/v1/1/x")).toBe(false);
    expect(matches("/files/{file_path:path}", "/files/a/b/c.txt")).toBe(true);
    expect(matches("/files/{file_path:path}/edit", "/files/a/b/edit")).toBe(true);
    expect(matches("/n/{id:int}", "/n/12")).toBe(true);
    expect(matches("/n/{id:int}", "/n/ab")).toBe(false);
    expect(matches("/items/v1/", "/items/v1")).toBe(true);
    expect(matches("/report/{name}.csv", "/report/june.csv")).toBe(true);
  });
});

// A repository written to attack the plugin: the plugin reads Python files a
// stranger controls. More than 1 MiB of it: chains of routers each including
// the next, one looping back on itself, a diamond of includes, thousands of
// routes on one router, a dependency list hundreds long, a pattern of
// hundreds of path parameters, hundreds of small applications that together
// pass every build cap, and a file over the byte cap.
describe("the FastAPI plugin on a hostile repository", () => {
  const params = (n: number) => `/${Array.from({ length: n }, (_, i) => (i % 2 === 0 ? `{p${i}:path}` : `{q${i}}`)).join("/")}`;
  const longPath = (n: number) => `/${"a/".repeat(n)}b`;
  const HOSTILE_PATTERN = params(300);
  const LONG_PATH = longPath(3000);
  let root: string;
  let quarter: string;
  let graph: Graph;

  const HEAD = "from fastapi import APIRouter, Depends, FastAPI\nfrom fastapi.testclient import TestClient\n\nfrom hostile.h import h\n\n";

  // A chain of routers each including the next, the last including the
  // first. include_router copies what a router holds at that moment, so the
  // includes run from the deepest up, as code that nests routers must.
  function chain(n: number): string {
    const lines = [HEAD, "capp = FastAPI()"];
    for (let i = 0; i < n; i++) lines.push(`c${i} = APIRouter(prefix="/c")`);
    lines.push(`@c${n - 1}.get("/end")`, "def end():", "    return 1", `c${n - 1}.include_router(c0)`);
    for (let i = n - 1; i > 0; i--) lines.push(`c${i - 1}.include_router(c${i})`);
    lines.push("capp.include_router(c0)");
    return lines.join("\n");
  }
  // A diamond: every router includes the next one twice, so routes double per level.
  function diamond(levels: number): string {
    const lines = [HEAD, "dapp = FastAPI()"];
    for (let i = 0; i <= levels; i++) lines.push(`d${i} = APIRouter()`);
    for (let i = 0; i < 20; i++) lines.push(`@d${levels}.get("/r${i}")`, `def r${i}():`, "    return 1");
    for (let i = levels - 1; i >= 0; i--) lines.push(`d${i}.include_router(d${i + 1}, prefix="/p")`, `d${i}.include_router(d${i + 1}, prefix="/q")`);
    lines.push("dapp.include_router(d0)");
    return lines.join("\n");
  }
  // Thousands of routes on one router, in two files, included twice, and a dependency list hundreds long.
  function wide(from: number, n: number, own: boolean): string {
    const lines = [HEAD];
    if (own) lines.push("wapp = FastAPI()", `w = APIRouter(dependencies=[${Array.from({ length: 300 }, () => "Depends(h)").join(", ")}])`);
    else lines.push("from hostile.wide import w");
    for (let i = from; i < from + n; i++) lines.push(`@w.get("/w${i}/{id}")`, `def w${i}(id):`, "    return 1");
    if (own) lines.push('wapp.include_router(w, prefix="/a")', 'wapp.include_router(w, prefix="/b")');
    return lines.join("\n");
  }
  // A pattern of hundreds of path parameters, and a test that requests a long path.
  function wildcard(): string {
    return [HEAD, "sapp = FastAPI()", `@sapp.get(${JSON.stringify(HOSTILE_PATTERN)})`, "def wild():", "    return 1", "", "client = TestClient(sapp)", "", "def test_wild():", `    client.get(${JSON.stringify(LONG_PATH)})`].join("\n");
  }
  // One small application with its own routes, or its own includes.
  function smallRoutes(k: number): string {
    const lines = ["from fastapi import FastAPI", "", "app = FastAPI()"];
    for (let i = 0; i < 40; i++) lines.push(`@app.get("/s${k}/r${i}")`, `def r${i}():`, "    return 1");
    return lines.join("\n");
  }
  function smallIncludes(): string {
    const lines = ["from fastapi import APIRouter, FastAPI", "", "app = FastAPI()", "r = APIRouter()"];
    for (let i = 0; i < 8; i++) lines.push(`app.include_router(r, prefix="/p${i}")`);
    return lines.join("\n");
  }
  // Padded with statements, not comments: tree-sitter-python parses a long
  // run of comment lines slowly enough that the core's parse cap stops it,
  // and then no plugin ever sees the file.
  function pad(source: string, bytes: number): string {
    const filler = "\n_padding_to_reach_the_size_of_a_large_generated_route_module = 0\n";
    return source + filler.repeat(Math.max(0, Math.ceil((bytes - source.length) / filler.length)));
  }

  // The hostile repository at scale 4; at scale 1 the same shapes at a
  // quarter of the count, which the timing test compares it with. The
  // diamond keeps its depth (its routes double at every level, so the caps
  // stop it at either scale) and the file over the byte cap stays over it.
  function hostile(scale: 1 | 4): Record<string, string> {
    const q = scale / 4;
    const files: Record<string, string> = {};
    files["pyproject.toml"] = '[project]\nname = "hostile"\nversion = "0.1.0"\ndependencies = ["fastapi>=0.115", "pytest>=8"]\n';
    files["hostile/__init__.py"] = "";
    files["hostile/h.py"] = "def h():\n    return 1\n";
    files["hostile/chain_a.py"] = chain(990 * q);
    files["hostile/chain_b.py"] = chain(990 * q).replaceAll("capp", "capp2");
    files["hostile/diamond.py"] = diamond(30);
    files["hostile/wide.py"] = wide(0, 1900 * q, true);
    files["hostile/wide_more.py"] = wide(1900 * q, 1900 * q, false);
    files["hostile/test_wild.py"] = wildcard();
    files["split/__init__.py"] = "";
    for (let k = 0; k < 300 * q; k++) files[`split/routes_${String(k).padStart(3, "0")}.py`] = smallRoutes(k);
    for (let k = 0; k < 300 * q; k++) files[`split/includes_${String(k).padStart(3, "0")}.py`] = smallIncludes();
    // Over the byte cap: the plugin must not read it, and must say so.
    files["hostile/huge.py"] = pad(wide(5000, 100, false), MAX_SOURCE_BYTES + 64 * 1024);
    return files;
  }
  const files = hostile(4);
  const build = (repoRoot: string) => () => buildGraph({ repoRoot, store: null, maxFileBytes: 2 * 1024 * 1024, budgetMs: 120_000 });
  // The sources the reader is timed on: the file over the byte cap is the same
  // at both scales and the plugin never reads it, so it is left out.
  const sources = (of: Record<string, string>) => Object.entries(of).filter(([path, content]) => path.endsWith(".py") && Buffer.byteLength(content) <= MAX_SOURCE_BYTES).map(([, content]) => content);

  beforeAll(async () => {
    const total = Object.values(files).reduce((n, s) => n + Buffer.byteLength(s), 0);
    expect(total).toBeGreaterThan(1024 * 1024);
    for (const [path, content] of Object.entries(files)) if (path !== "hostile/huge.py") expect(Buffer.byteLength(content)).toBeLessThan(MAX_SOURCE_BYTES);

    root = mkdtempSync(join(tmpdir(), "oq-fastapi-hostile-"));
    writeTree(root, files);
    commitAll(root);
    quarter = mkdtempSync(join(tmpdir(), "oq-fastapi-hostile-"));
    writeTree(quarter, hostile(1));
    commitAll(quarter);
    graph = await build(root)();
  }, 180_000);
  afterAll(() => {
    for (const dir of [root, quarter]) if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  const mine = () => ({
    regs: (graph.frameworks?.entities ?? []).filter((e): e is Registration => e.kind === "registration" && e.plugin === "fastapi"),
    edges: (graph.frameworks?.edges ?? []).filter((e) => e.plugin === "fastapi"),
    unknowns: (graph.frameworks?.unknowns ?? []).filter((u) => u.plugin === "fastapi"),
  });

  it("a crafted repository cannot hang or exhaust the build: the plugin resolves it", () => {
    const run = graph.frameworks?.plugins.find((p) => p.id === "fastapi");
    expect(run?.status, run?.reason ?? "").toBe("ok");
  }, 300_000);

  growthTests("in time that grows with it", () => {
    it("a crafted repository cannot hang or exhaust the build: reading the facts of more than 1 MiB and resolving them take time that grows with the repository and no faster", async () => {
      expectLinear("the FastAPI fact reader on the hostile files", await readerCpuMs("python", sources(hostile(1)), readFacts), await readerCpuMs("python", sources(files), readFacts));
      expectLinear("the FastAPI plugin on the hostile repository", await pluginCpuMs(build(quarter), "fastapi"), await pluginCpuMs(build(root), "fastapi"));
    }, 300_000);
  });

  it("does not read a file over the byte cap, and says so with an unknown", () => {
    const gap = mine().unknowns.find((u) => u.cause === "file-not-parsed" && u.site?.file === "hostile/huge.py");
    expect(gap?.note).toContain(String(MAX_SOURCE_BYTES));
    expect(mine().regs.some((r) => r.site.file === "hostile/huge.py")).toBe(false);
  });

  it("stops at the build's registration and include caps though the work is split over hundreds of small applications, and says so once each", () => {
    const { regs, edges, unknowns } = mine();
    expect(regs.length).toBeLessThanOrEqual(MAX_REGISTRATIONS);
    expect(edges.filter((e) => e.kind === "mounts").length).toBeLessThanOrEqual(MAX_MOUNTS);
    const regCap = unknowns.filter((u) => u.cause === "fan-out-capped" && u.note.includes(`${MAX_REGISTRATIONS} registrations`));
    const mountCap = unknowns.filter((u) => u.cause === "fan-out-capped" && u.note.includes(`${MAX_MOUNTS} router includes`));
    expect(regCap.length).toBe(1);
    expect(mountCap.length).toBe(1);
    expect(regCap[0]?.count ?? 0).toBeGreaterThan(0);
  });

  it("caps the dependency chain of a route and says how many were left out", () => {
    const perReg = new Map<string, number>();
    for (const e of mine().edges) if (e.kind === "applies_middleware") perReg.set(e.from, (perReg.get(e.from) ?? 0) + 1);
    expect(perReg.size).toBeGreaterThan(0);
    for (const n of perReg.values()) expect(n).toBeLessThanOrEqual(MAX_MIDDLEWARE_CHAIN);
    expect(mine().unknowns.some((u) => u.cause === "fan-out-capped" && u.note.includes("dependency chain") && (u.count ?? 0) > 0)).toBe(true);
  });

  it("stops an include chain that loops back on itself without repeating it, and says where the depth cap cut it", () => {
    const end = mine().regs.filter((r) => r.site.file === "hostile/chain_a.py");
    expect(end.length).toBeLessThanOrEqual(1);
    expect(mine().unknowns.some((u) => u.cause === "fan-out-capped" && u.note.includes("levels deep"))).toBe(true);
  });

  it("matches a request path against a pattern of hundreds of path parameters, with no regular expression", () => {
    expect(matches(HOSTILE_PATTERN, LONG_PATH)).toBe(false);
    expect(matches(`/${"{a:path}/".repeat(60)}x`, `/${"a/".repeat(60)}x`)).toBe(true);
    expect(matches(`/${"{a}".repeat(200)}`, `/${"a".repeat(250)}`)).toBe(false);
  });

  growthTests("in linear time", () => {
    it("matches a request path against a pattern of hundreds of path parameters in linear time", async () => {
      // The same three matches with every length a quarter, and in full.
      const all = (q: number) => () =>
        matches(params(300 * q), longPath(3000 * q)) || matches(`/${"{a:path}/".repeat(60 * q)}x`, `/${"a/".repeat(60 * q)}x`) || matches(`/${"{a}".repeat(200 * q)}`, `/${"a".repeat(248 * q)}`);
      expectLinear("matching with every length a quarter and in full", await cpuMs(all(0.25)), await cpuMs(all(1)));
    });
  });
});

// A repository of tens of thousands of classes: a chain where each class
// subclasses the one before, starting from Pydantic's BaseModel; more
// direct models than the build keeps roles for; and more applications than
// the build keeps.
describe("the FastAPI plugin on a repository of many model classes", () => {
  let root: string;
  let quarter: string;
  let graph: Graph;

  // Scale 4: a chain of 30,000 classes, 21,000 direct models and 2,100
  // applications; scale 1 a quarter of each, for the timing test.
  function models(scale: 1 | 4): Record<string, string> {
    const q = scale / 4;
    const chain = ["from pydantic import BaseModel", "", "", "class C0(BaseModel):", "    pass"];
    for (let i = 1; i < 30_000 * q; i++) chain.push("", "", `class C${i}(C${i - 1}):`, "    pass");
    const files: Record<string, string> = { "pyproject.toml": '[project]\nname = "models"\nversion = "0.1.0"\ndependencies = ["fastapi>=0.115"]\n', "models/__init__.py": "", "models/chain.py": `${chain.join("\n")}\n`, "apps/__init__.py": "" };
    for (const part of ["a", "b", "c"]) {
      const direct = ["from pydantic import BaseModel", ""];
      for (let i = 0; i < 7000 * q; i++) direct.push(`class D${part}${i}(BaseModel):`, "    pass", "");
      files[`models/direct_${part}.py`] = direct.join("\n");
      const many = ["from fastapi import FastAPI", ""];
      for (let i = 0; i < 700 * q; i++) many.push(`a${i} = FastAPI()`);
      files[`apps/many_${part}.py`] = many.join("\n");
    }
    return files;
  }
  const build = (repoRoot: string) => () => buildGraph({ repoRoot, store: null, maxFileBytes: 4 * 1024 * 1024, budgetMs: 120_000 });

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "oq-fastapi-models-"));
    writeTree(root, models(4));
    commitAll(root);
    quarter = mkdtempSync(join(tmpdir(), "oq-fastapi-models-"));
    writeTree(quarter, models(1));
    commitAll(quarter);
    graph = await build(root)();
  }, 180_000);
  afterAll(() => {
    for (const dir of [root, quarter]) if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  it("finds the models among thirty thousand classes", () => {
    const run = graph.frameworks?.plugins.find((p) => p.id === "fastapi");
    expect(run?.status, run?.reason ?? "").toBe("ok");
  }, 300_000);

  growthTests("in time that grows with the classes", () => {
    it("finds the models among thirty thousand classes in time that grows with the classes and no faster, reading each file's classes once rather than once per base", async () => {
      expectLinear("the FastAPI plugin on 7,500 and on 30,000 chained classes", await pluginCpuMs(build(quarter), "fastapi"), await pluginCpuMs(build(root), "fastapi"));
    }, 300_000);
  });

  it("marks only the classes at most eight bases from BaseModel, whatever order the classes are read in", () => {
    const models = (graph.frameworks?.roles ?? []).filter((r) => r.plugin === "fastapi" && r.role === "model").map((r) => graph.nodes.get(r.target)?.name ?? "");
    expect(models.filter((n) => n.startsWith("C")).sort()).toEqual(["C0", "C1", "C2", "C3", "C4", "C5", "C6", "C7"]);
  });

  it("keeps at most MAX_ROLES roles and MAX_APPS applications in one build, so its lists never overflow the stage, and says so once each", () => {
    const roles = (graph.frameworks?.roles ?? []).filter((r) => r.plugin === "fastapi");
    const apps = (graph.frameworks?.apps ?? []).filter((a) => a.plugin === "fastapi");
    expect(roles.length).toBe(MAX_ROLES);
    expect(apps.length).toBe(MAX_APPS);
    const capped = (graph.frameworks?.unknowns ?? []).filter((u) => u.plugin === "fastapi" && u.cause === "fan-out-capped");
    expect(capped.filter((u) => u.note.includes(`${MAX_ROLES} roles`)).map((u) => u.count)).toEqual([21_008 - MAX_ROLES]);
    expect(capped.filter((u) => u.note.includes(`${MAX_APPS} applications`)).map((u) => u.count)).toEqual([2100 - MAX_APPS]);
  });
});
