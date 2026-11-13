// The Go net/http plugin on the sample application of the corpus
// (corpus/frameworks/go-http/go-http-app), built as a real git repository
// and run through the whole graph build: the questions a review asks of a
// handler change, answered from the framework layer. Then the facts of one
// file, read from real parse trees, and two crafted repositories that try
// to hang or exhaust the build.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildGraph, frameworkLayer } from "../../index.js";
import type { FrameworkLayer, Graph, Registration } from "../../index.js";
import { parserFor } from "../../parser.js";
import { cpuMs, expectLinear, growthTests, pluginCpuMs, readerCpuMs } from "../../test-timing.js";
import type { GoHttpFact } from "./facts.js";
import { MAX_SOURCE_BYTES, readFacts, wants } from "./facts.js";
import { matches, MAX_APPS, MAX_EDGES, MAX_MATCH_WORK, MAX_MIDDLEWARE_CHAIN, MAX_MOUNTS, MAX_REGISTRATIONS, MAX_ROLES, MAX_TEST_REQUESTS, MAX_UNKNOWNS } from "./resolve.js";

const git = (root: string, ...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8" });

function commitAll(root: string): void {
  git(root, "init", "-q");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "test");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
}

// A repository of generated files, committed.
function writeRepo(prefix: string, files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  commitAll(root);
  return root;
}

const goFacts = async (source: string): Promise<GoHttpFact[]> => {
  const parser = await parserFor("go");
  const tree = parser.parse(source);
  if (!tree) throw new Error("no tree");
  try {
    return readFacts(tree.rootNode);
  } finally {
    tree.delete();
  }
};

// ---------- the sample application ----------

const corpus = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "corpus", "frameworks");

const layer = (g: Graph): FrameworkLayer => {
  const l = frameworkLayer(g);
  if (!l) throw new Error("the graph has no framework layer");
  return l;
};

describe("the net/http plugin on a small real application", () => {
  let changed: Graph;
  let root: string;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "oq-go-http-"));
    cpSync(join(corpus, "go-http", "go-http-app", "base"), root, { recursive: true });
    commitAll(root);
    cpSync(join(corpus, "go-http", "go-http-app", "change"), root, { recursive: true, force: true });
    changed = await buildGraph({ repoRoot: root, store: null });
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("registers nothing from HandleFunc on a local value named http", () => {
    expect(layer(changed).registrations().filter((r) => r.site.file === "fake/fake.go")).toEqual([]);
    expect((changed.frameworks?.apps ?? []).filter((a) => a.site.file === "fake/fake.go")).toEqual([]);
  });
});

// ---------- the facts of one file ----------

describe("the net/http facts of one file", () => {
  it("reads no registration from a call written inside a string literal or a comment", async () => {
    const facts = await goFacts(['package main', "", 'import "net/http"', "", "func main() {", '\t// mux.HandleFunc("/x", h)', '\ts := "mux.HandleFunc(\\"/x\\", h)"', "\t/* http.HandleFunc(\"/y\", h) */", "\t_ = s", "}", ""].join("\n"));
    expect(facts.filter((f) => f.kind === "call")).toEqual([]);
  });

  it("reads no call inside a region with a syntax error, and records that the file has one", async () => {
    const facts = await goFacts(["package main", "", 'import "net/http"', "", "func main() {", '\thttp.HandleFunc("/ok", h)', "}", "", "func broken( {", '\thttp.HandleFunc("/broken", h', "}", ""].join("\n"));
    const patterns = facts.flatMap((f) => (f.kind === "call" && f.args[0]?.t === "str" ? [f.args[0].v] : []));
    expect(patterns).toEqual(["/ok"]);
    expect(facts.some((f) => f.kind === "parse-error")).toBe(true);
  });

  it("decodes a pattern's escape sequences from the tree by Go's rules, and takes a raw string as written", async () => {
    const facts = await goFacts(["package main", "", "func main() {", '\tmux.HandleFunc("/caf\\u00e9/\\x41\\101\\t", h)', "\tmux.HandleFunc(`/raw\\n{id}`, h)", '\tmux.HandleFunc("/caf\\xc3\\xa9", h)', "}", ""].join("\n"));
    const patterns = facts.flatMap((f) => (f.kind === "call" && f.args[0]?.t === "str" ? [f.args[0].v] : []));
    expect(patterns).toEqual(["/café/AA\t", "/raw\\n{id}", "/café"]);
  });

  it("treats a name as local only inside the block that declares it, and reads the outer name on the right of its own declaration", async () => {
    const facts = await goFacts(
      ["package main", "", 'import "net/http"', "", "func main() {", "\tif true {", "\t\thttp := fake{}", '\t\thttp.HandleFunc("/inner", h)', "\t}", '\thttp.HandleFunc("/outer", h)', "\thttp := http.NewServeMux()", '\thttp.HandleFunc("/after", h)', "}", ""].join("\n"),
    );
    const calls = facts.flatMap((f) => (f.kind === "call" && f.recv.t === "ref" && f.args[0]?.t === "str" ? [`${f.args[0].v} ${f.recv.local}`] : []));
    expect(calls).toEqual(["/inner true", "/outer false", "/after true"]);
    const callee = facts.flatMap((f) => (f.kind === "value" && f.name === "http" && f.value.t === "call" && f.value.fn.t === "ref" ? [`${f.value.fn.path.join(".")} ${f.value.fn.local}`] : []));
    expect(callee).toEqual(["http.NewServeMux false"]);
  });

  it("reads every Go file, since a package-level value another file uses needs no tell-tale text", () => {
    expect(wants("package util\n\nvar admin = AdminHandler{}\n")).toBe(true);
  });
});

describe("matching a request to a Go 1.22 pattern", () => {
  it("follows Go's rules: one segment per wildcard, the rest for a last wildcard with dots, the subtree under a trailing slash, the exact path for {$}, and the host", () => {
    expect(matches("/items/{id}", "/items/1")).toBe(true);
    expect(matches("/items/{id}", "/items/1/x")).toBe(false);
    expect(matches("/items/{id}", "/items/")).toBe(false);
    expect(matches("/files/{path...}", "/files/a/b/c")).toBe(true);
    expect(matches("/static/", "/static/css/a.css")).toBe(true);
    expect(matches("/static/", "/static")).toBe(false);
    expect(matches("/", "/anything/at/all")).toBe(true);
    expect(matches("/{$}", "/")).toBe(true);
    expect(matches("/{$}", "/x")).toBe(false);
    expect(matches("api.example.com/v1", "/v1")).toBe(false);
    expect(matches("example.com/v1", "/v1")).toBe(true);
  });
});

// ---------- crafted repositories ----------

const GO_HEAD = 'package main\n\nimport "net/http"\n\n';

function pad(source: string, bytes: number): string {
  const filler = "// padding to reach the size of a large generated route file\n";
  return source + filler.repeat(Math.max(0, Math.ceil((bytes - source.length) / filler.length)));
}

// A request path of 2000 segments, and a pattern of 300 wildcards.
const LONG_PATH = `/${"a/".repeat(2000)}b`;
const WILD = `/${Array.from({ length: 300 }, (_, i) => `{a${i}}`).join("/")}`;

describe("the net/http plugin on a crafted repository", () => {
  let root: string;
  let quarter: string;
  let graph: Graph;

  // The crafted repository at scale 4; at scale 1 the same shapes at a
  // quarter of the count, which the timing tests compare it with. The
  // wrappers, the wildcards and the file over the byte cap stay as they are.
  function crafted(scale: 1 | 4): Record<string, string> {
    const q = scale / 4;
    const files: Record<string, string> = {};
    files["go.mod"] = "module example.com/hostile\n\ngo 1.22\n";
    files["h.go"] = `${GO_HEAD}func h(w http.ResponseWriter, r *http.Request) {}\n\nfunc wrap(next http.Handler) http.Handler { return next }\n\nfunc main() {}\n`;
    // Three thousand muxes, each mounting the next; the last mounts the first again.
    const N = 3000 * q;
    const per = N / 4;
    for (let k = 0; k < 4; k++) {
      const lines = [GO_HEAD];
      for (let i = k * per; i < (k + 1) * per; i++) lines.push(`var c${i} = http.NewServeMux()`);
      lines.push("", "func init() {");
      for (let i = k * per; i < (k + 1) * per; i++) lines.push(i === N - 1 ? `\tc${i}.Handle("/loop/", c0)\n\tc${i}.HandleFunc("/end", h)` : `\tc${i}.Handle("/c/", c${i + 1})`);
      lines.push("}");
      files[`chain${k}.go`] = lines.join("\n");
    }
    // Twelve thousand registrations on one mux, over eight files.
    const big = 1500 * q;
    for (let k = 0; k < 8; k++) {
      const lines = [GO_HEAD, k === 0 ? "var Big = http.NewServeMux()\n" : "", `func init() {`];
      for (let i = 0; i < big; i++) lines.push(`\tBig.HandleFunc("/b${k * big + i}/{id}", h)`);
      lines.push("}");
      files[`zbig${k}.go`] = lines.join("\n");
    }
    // A pattern of hundreds of wildcards, and a handler inside 80 nested wrappers.
    files["wild.go"] = `${GO_HEAD}var W = http.NewServeMux()\n\nfunc init() {\n\tW.HandleFunc(${JSON.stringify(WILD)}, h)\n}\n`;
    files["deep.go"] = `${GO_HEAD}var D = http.NewServeMux()\n\nfunc init() {\n\tD.Handle("/deep", ${"wrap(".repeat(80)}http.HandlerFunc(h)${")".repeat(80)})\n}\n`;
    // Thousands of test requests against thousands of routes, one of them a path of 2000 segments.
    for (let k = 0; k < 3; k++) {
      const lines = ['package main\n\nimport (\n\t"net/http/httptest"\n\t"testing"\n)\n', `func TestR${k}(t *testing.T) {`, `\thttptest.NewRequest("GET", ${JSON.stringify(LONG_PATH)}, nil)`];
      for (let i = 0; i < 1000 * q; i++) lines.push(`\thttptest.NewRequest("GET", "/b${i}/7", nil)`);
      lines.push("}");
      files[`zreq${k}_test.go`] = lines.join("\n");
    }
    // Over the byte cap: not read, and said so.
    files["huge.go"] = pad(`${GO_HEAD}var H = http.NewServeMux()\n\nfunc init() {\n\tH.HandleFunc("/huge", h)\n}\n`, MAX_SOURCE_BYTES + 64 * 1024);
    return files;
  }
  const files = crafted(4);
  const build = (repoRoot: string) => () => buildGraph({ repoRoot, store: null, maxFileBytes: 2 * 1024 * 1024, budgetMs: 120_000 });
  // The sources the reader is timed on: the file over the byte cap is the same
  // at both scales and the plugin never reads it, so it is left out.
  const sources = (of: Record<string, string>) => Object.entries(of).filter(([path, content]) => path.endsWith(".go") && Buffer.byteLength(content) <= MAX_SOURCE_BYTES).map(([, content]) => content);

  beforeAll(async () => {
    const total = Object.values(files).reduce((n, s) => n + Buffer.byteLength(s), 0);
    expect(total).toBeGreaterThan(1024 * 1024);
    root = writeRepo("oq-go-hostile-", files);
    quarter = writeRepo("oq-go-hostile-", crafted(1));
    graph = await build(root)();
  }, 120_000);
  afterAll(() => {
    for (const dir of [root, quarter]) if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  const mine = () => ({
    unknowns: graph.frameworks?.unknowns.filter((u) => u.plugin === "go-http") ?? [],
    registrations: graph.frameworks?.entities.filter((e): e is Registration => e.kind === "registration" && e.plugin === "go-http") ?? [],
    edges: graph.frameworks?.edges.filter((e) => e.plugin === "go-http") ?? [],
  });

  growthTests("in time that grows with it", () => {
    it("a crafted repository cannot hang or exhaust the build: reading the facts of more than 1 MiB of route files takes time that grows with them and no faster", async () => {
      expectLinear("the net/http fact reader on the crafted files", await readerCpuMs("go", sources(crafted(1)), readFacts), await readerCpuMs("go", sources(files), readFacts));
    }, 300_000);

    it("a crafted repository cannot hang or exhaust the build: the plugin resolves it in time that grows with it and no faster", async () => {
      expectLinear("the net/http plugin on the crafted repository", await pluginCpuMs(build(quarter), "go-http"), await pluginCpuMs(build(root), "go-http"));
    }, 300_000);
  });

  it("a crafted repository cannot hang or exhaust the build: the plugin resolves it", () => {
    const run = graph.frameworks?.plugins.find((p) => p.id === "go-http");
    expect(run?.status).toBe("ok");
  });

  it("stops at the build's registration and mount caps, with one unknown each", () => {
    const { unknowns, registrations, edges } = mine();
    expect(registrations.length).toBeLessThanOrEqual(MAX_REGISTRATIONS);
    expect(edges.filter((e) => e.kind === "mounts").length).toBeLessThanOrEqual(MAX_MOUNTS);
    const capped = unknowns.filter((u) => u.cause === "fan-out-capped" && "build" in u.scope);
    expect(capped.filter((u) => u.note.includes(`registrations after ${MAX_REGISTRATIONS} `)).length).toBe(1);
    expect(capped.filter((u) => u.note.includes(`mounted muxes after ${MAX_MOUNTS} `)).length).toBe(1);
  });

  it("stops a mount chain that loops back on itself without repeating it", () => {
    const end = mine().registrations.filter((r) => r.site.file === "chain3.go");
    expect(new Set(end.map((r) => r.id)).size).toBe(end.length);
    for (const r of end) expect(r.mountedVia.length).toBeLessThanOrEqual(8);
  });

  it("caps the middleware chain of one route and says so", () => {
    const deep = mine().registrations.find((r) => r.site.file === "deep.go");
    const chain = mine().edges.filter((e) => e.kind === "applies_middleware" && e.from === deep?.id);
    expect(chain.length).toBe(MAX_MIDDLEWARE_CHAIN);
    expect(mine().unknowns.some((u) => u.cause === "fan-out-capped" && u.site?.file === "deep.go" && u.note.includes("middleware"))).toBe(true);
  });

  it("stops matching test requests at the build's match budget, with one unknown", () => {
    expect(mine().unknowns.filter((u) => u.cause === "budget" && u.note.includes(String(MAX_MATCH_WORK))).length).toBe(1);
  });

  it("does not read a file over the byte cap, and says so with an unknown", () => {
    const gap = mine().unknowns.find((u) => u.cause === "file-not-parsed" && u.site?.file === "huge.go");
    expect(gap?.note).toContain(String(MAX_SOURCE_BYTES));
    expect(mine().registrations.some((r) => r.site.file === "huge.go")).toBe(false);
  });

  it("matches a request against a pattern of hundreds of wildcards, with no regular expression", () => {
    expect(matches(WILD, LONG_PATH)).toBe(false);
    expect(matches(WILD, `/${"x/".repeat(299)}x`)).toBe(false);
    expect(matches("/{rest...}", LONG_PATH)).toBe(false);
  });

  growthTests("in linear time", () => {
    it("matches a request against a pattern of hundreds of wildcards in linear time", async () => {
      // The same three matches with every length a quarter, and in full.
      const wild = (n: number) => `/${Array.from({ length: n }, (_, i) => `{a${i}}`).join("/")}`;
      const long = (n: number) => `/${"a/".repeat(n)}b`;
      const all = (q: number) => () => matches(wild(300 * q), long(2000 * q)) || matches(wild(300 * q), `/${"x/".repeat(300 * q - 1)}x`) || matches("/{rest...}", long(2000 * q));
      expectLinear("matching with every length a quarter and in full", await cpuMs(all(0.25)), await cpuMs(all(1)));
    });
  });
});

// The same work split over hundreds of files, each with a small mux of its
// own: no single mux or file comes near a cap, and the build caps still stop it.
describe("the net/http plugin on work split over hundreds of small muxes", () => {
  let root: string;
  let quarter: string;
  let graph: Graph;

  // Scale 4: 400 muxes and 2,400 test requests; scale 1 a quarter of each,
  // for the timing test.
  function spread(scale: 1 | 4): Record<string, string> {
    const q = scale / 4;
    const files: Record<string, string> = {};
    files["go.mod"] = "module example.com/spread\n\ngo 1.22\n";
    const leaves = [GO_HEAD, "func h(w http.ResponseWriter, r *http.Request) {}\n", "func main() {}\n"];
    for (let j = 0; j < 20; j++) leaves.push(`var l${j} = http.NewServeMux()\n\nfunc init() { l${j}.HandleFunc("/leaf", h) }\n`);
    files["leaves.go"] = leaves.join("\n");
    // 400 muxes of 30 routes and 6 mounts each: 12000 routes and 2400 mounts in all.
    for (let i = 0; i < 400 * q; i++) {
      const lines = [GO_HEAD, `var m${i} = http.NewServeMux()\n`, "func init() {"];
      for (let r = 0; r < 30; r++) lines.push(`\tm${i}.HandleFunc("/r${r}/{id}", h)`);
      for (let s = 0; s < 6; s++) lines.push(`\tm${i}.Handle("/s${s}/", l${(i + s) % 20})`);
      lines.push("}");
      files[`m${String(i).padStart(3, "0")}.go`] = lines.join("\n");
    }
    // A second project with one route and 2400 test requests over 30 files.
    // Its folder sorts first: the caps count work in order across the whole
    // build, so a mux composed after the registration cap has no routes.
    files["areqs/go.mod"] = "module example.com/reqs\n\ngo 1.22\n";
    files["areqs/main.go"] = `${GO_HEAD}func ping(w http.ResponseWriter, r *http.Request) {}\n\nfunc main() {\n\tmux := http.NewServeMux()\n\tmux.HandleFunc("GET /ping", ping)\n\thttp.ListenAndServe(":8080", mux)\n}\n`;
    for (let k = 0; k < 30; k++) {
      const lines = ['package main\n\nimport (\n\t"net/http/httptest"\n\t"testing"\n)\n', `func TestPing${k}(t *testing.T) {`];
      for (let i = 0; i < 80 * q; i++) lines.push(`\thttptest.NewRequest("GET", "/ping", nil)`);
      lines.push("}");
      files[`areqs/r${String(k).padStart(2, "0")}_test.go`] = lines.join("\n");
    }
    return files;
  }
  const build = (repoRoot: string) => () => buildGraph({ repoRoot, store: null, budgetMs: 120_000 });

  beforeAll(async () => {
    root = writeRepo("oq-go-spread-", spread(4));
    quarter = writeRepo("oq-go-spread-", spread(1));
    graph = await build(root)();
  }, 120_000);
  afterAll(() => {
    for (const dir of [root, quarter]) if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  it("a crafted repository cannot hang or exhaust the build: work split over hundreds of muxes still stops at each build cap, with one unknown each", () => {
    const run = graph.frameworks?.plugins.find((p) => p.id === "go-http");
    expect(run?.status).toBe("ok");
    const regs =graph.frameworks?.entities.filter((e) => e.kind === "registration" && e.plugin === "go-http") ?? [];
    expect(regs.length).toBe(MAX_REGISTRATIONS);
    const mounts = graph.frameworks?.edges.filter((e) => e.plugin === "go-http" && e.kind === "mounts") ?? [];
    expect(mounts.length).toBe(MAX_MOUNTS);
    const requests = graph.frameworks?.edges.filter((e) => e.plugin === "go-http" && e.kind === "tests" && e.category === "route-request") ?? [];
    expect(new Set(requests.map((e) => `${e.evidence.site.file}:${e.evidence.site.line}`)).size).toBe(MAX_TEST_REQUESTS);
    const capped = (graph.frameworks?.unknowns ?? []).filter((u) => u.plugin === "go-http" && u.cause === "fan-out-capped");
    expect(capped.filter((u) => u.note.includes(`registrations after ${MAX_REGISTRATIONS} `)).length).toBe(1);
    expect(capped.filter((u) => u.note.includes(`mounted muxes after ${MAX_MOUNTS} `)).length).toBe(1);
    expect(capped.filter((u) => u.note.includes(`test requests after ${MAX_TEST_REQUESTS} `)).length).toBe(1);
  }, 300_000);

  growthTests("in time that grows with the work", () => {
    it("a crafted repository cannot hang or exhaust the build: work split over hundreds of muxes takes time that grows with the work and no faster", async () => {
      expectLinear("the net/http plugin on 100 and on 400 small muxes", await pluginCpuMs(build(quarter), "go-http"), await pluginCpuMs(build(root), "go-http"));
    }, 300_000);
  });
});

// ---------- small repositories, one rule each ----------

// The graph of a committed repository of these files; the folder is removed after.
async function graphOf(files: Record<string, string>): Promise<Graph> {
  const root = writeRepo("oq-go-small-", { "go.mod": "module example.com/small\n\ngo 1.22\n", ...files });
  try {
    return await buildGraph({ repoRoot: root, store: null });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
const goRegs = (g: Graph): Registration[] => (g.frameworks?.entities ?? []).filter((e): e is Registration => e.kind === "registration" && e.plugin === "go-http");

describe("the net/http plugin on small repositories", () => {
  it("never moves a registration to a mux declared in a block that has closed", async () => {
    const g = await graphOf({
      "main.go": `${GO_HEAD}func h(w http.ResponseWriter, r *http.Request) {}\n\nfunc main() {\n\tmux := http.NewServeMux()\n\tif true {\n\t\tmux := http.NewServeMux()\n\t\tmux.HandleFunc("/inner", h)\n\t}\n\tmux.HandleFunc("/outer", h)\n\thttp.ListenAndServe(":8080", mux)\n}\n`,
    });
    const apps = Object.fromEntries(goRegs(g).map((r) => [r.pattern, r.app]));
    expect(apps).toEqual({ "/inner": "fw:go-http:app:main.go:10", "/outer": "fw:go-http:app:main.go:8" });
    const served = (g.frameworks?.apps ?? []).filter((a) => a.plugin === "go-http" && a.data?.served).map((a) => a.id);
    expect(served).toEqual(["fw:go-http:app:main.go:8"]);
  });

  it("never takes a parameter, a block local or a local named httptest for the standard library", async () => {
    const g = await graphOf({
      "main.go": [
        GO_HEAD,
        "type fake struct{}\n",
        "func (fake) HandleFunc(p string, f func(http.ResponseWriter, *http.Request)) {}\n",
        "func h(w http.ResponseWriter, r *http.Request) {}\n",
        "func register(http fake) {\n\thttp.HandleFunc(\"/param\", h)\n}\n",
        "func blocks() {\n\tif true {\n\t\thttp := fake{}\n\t\thttp.HandleFunc(\"/blocked\", h)\n\t}\n\thttp.HandleFunc(\"/after\", h)\n}\n",
        'func main() {\n\tmux := http.NewServeMux()\n\tmux.HandleFunc("/real", h)\n\thttp.ListenAndServe(":8080", mux)\n}\n',
      ].join("\n"),
      "main_test.go": [
        'package main\n\nimport (\n\t"net/http/httptest"\n\t"testing"\n)\n',
        "type recorder struct{}\n",
        "func (recorder) NewRequest(m, p string, b any) {}\n",
        'func TestShadowed(t *testing.T) {\n\thttptest := recorder{}\n\thttptest.NewRequest("GET", "/real", nil)\n}\n',
        'func TestReal(t *testing.T) {\n\thttptest.NewRequest("GET", "/real", nil)\n}\n',
      ].join("\n"),
    });
    expect(goRegs(g).map((r) => r.pattern).sort()).toEqual(["/after", "/real"]);
    const from = (g.frameworks?.edges ?? []).filter((e) => e.plugin === "go-http" && e.kind === "tests" && e.category === "route-request").map((e) => g.nodes.get(e.from)?.name);
    expect(from).toEqual(["TestReal"]);
  });

  it("says when the matcher could not read a request or a route, instead of reporting no match", async () => {
    const long = `/${Array.from({ length: 70 }, (_, i) => `s${i}`).join("/")}`;
    const g = await graphOf({
      "main.go": `${GO_HEAD}func h(w http.ResponseWriter, r *http.Request) {}\n\nfunc main() {\n\tmux := http.NewServeMux()\n\tmux.HandleFunc(${JSON.stringify(long)}, h)\n\tmux.HandleFunc("GET items", h)\n\thttp.ListenAndServe(":8080", mux)\n}\n`,
      "main_test.go": `package main\n\nimport (\n\t"net/http/httptest"\n\t"testing"\n)\n\nfunc TestLong(t *testing.T) {\n\thttptest.NewRequest("GET", ${JSON.stringify(long)}, nil)\n}\n\nfunc TestShort(t *testing.T) {\n\thttptest.NewRequest("GET", "/x", nil)\n}\n`,
    });
    const at = (line: number) =>
      goUnknowns(g)
        .filter((u) => u.site?.file === "main_test.go" && u.site.line === line && u.affects.includes("tests"))
        .map((u) => u.cause)
        .sort();
    expect(at(9)).toEqual(["fan-out-capped"]);
    expect(at(13)).toEqual(["fan-out-capped", "unsupported-rule"]);
  });

  it("says a request target that is neither a path nor an absolute URL is unread, never blaming the segment cap", async () => {
    const g = await graphOf({
      "main.go": `${GO_HEAD}func h(w http.ResponseWriter, r *http.Request) {}\n\nfunc main() {\n\tmux := http.NewServeMux()\n\tmux.HandleFunc("/items", h)\n\thttp.ListenAndServe(":8080", mux)\n}\n`,
      "main_test.go": `package main\n\nimport (\n\t"net/http/httptest"\n\t"testing"\n)\n\nfunc TestBare(t *testing.T) {\n\thttptest.NewRequest("GET", "items", nil)\n}\n`,
    });
    const gaps = goUnknowns(g).filter((u) => u.site?.file === "main_test.go" && u.site.line === 9 && u.affects.includes("tests"));
    expect(gaps.map((u) => u.cause)).toEqual(["unsupported-rule"]);
    expect(gaps[0]?.note).not.toContain("segments");
  });

  it("never reads a list cut short by a read limit as complete: a long pattern, a long wrapper chain, a server whose handler lies past the budget", async () => {
    const longPath = `/${"x".repeat(2100)}`;
    const eater = `d(${Array.from({ length: 20 }, () => `d(${Array.from({ length: 20 }, (_, i) => i).join(", ")})`).join(", ")})`;
    const main = [
      "package main", // 1
      "", // 2
      'import "net/http"', // 3
      "", // 4
      "func h(w http.ResponseWriter, r *http.Request) {}", // 5
      "func wrap(next http.Handler) http.Handler { return next }", // 6
      "func d(xs ...int) int { return 0 }", // 7
      "func main() {", // 8
      "\tmux := http.NewServeMux()", // 9
      `\tmux.HandleFunc(${JSON.stringify(longPath)}, h)`, // 10
      `\tmux.Handle("/deep", ${"wrap(".repeat(80)}http.HandlerFunc(h)${")".repeat(80)})`, // 11
      `\tsrv := &http.Server{ReadTimeout: ${eater}, Handler: mux}`, // 12
      "\tsrv.ListenAndServe()", // 13
      "}", // 14
    ].join("\n");
    const test = `package main\n\nimport (\n\t"net/http/httptest"\n\t"testing"\n)\n\nfunc TestLong(t *testing.T) {\n\thttptest.NewRequest("GET", ${JSON.stringify(longPath)}, nil)\n}\n`;
    const g = await graphOf({ "main.go": main, "main_test.go": test });
    const at = (file: string, line: number) => goUnknowns(g).filter((u) => u.site?.file === file && u.site.line === line);
    expect(at("main.go", 10).map((u) => u.cause)).toEqual(["fan-out-capped"]);
    const chain = at("main.go", 11).filter((u) => u.cause === "fan-out-capped");
    expect(chain.map((u) => [u.count, u.exact])).toEqual([[16, true]]);
    expect(at("main.go", 12).map((u) => u.cause)).toEqual(["fan-out-capped"]);
    expect(at("main_test.go", 9).map((u) => u.cause)).toEqual(["fan-out-capped"]);
  });

  it("never lets a route vanish silently because its receiver or its wrapper cannot be bound", async () => {
    const main = [
      "package main", // 1
      "", // 2
      'import "net/http"', // 3
      "", // 4
      "type chiLike struct{}", // 5
      "func (c *chiLike) HandleFunc(p string, f func(http.ResponseWriter, *http.Request)) {}", // 6
      "type server struct {", // 7
      "\trouter *http.ServeMux", // 8
      "\tother  *chiLike", // 9
      "}", // 10
      "func h(w http.ResponseWriter, r *http.Request) {}", // 11
      "func newMux() *http.ServeMux { return http.NewServeMux() }", // 12
      "func wrapWith() func(http.Handler) http.Handler { return nil }", // 13
      "func (s *server) routes() {", // 14
      '\ts.router.HandleFunc("/field", h)', // 15
      '\ts.other.HandleFunc("/chi", h)', // 16
      '\tnewMux().HandleFunc("/made", h)', // 17
      "\tmw := wrapWith()", // 18
      '\ts.router.Handle("/mw", mw(http.HandlerFunc(h)))', // 19
      '\ts.router.Handle("/gone", missingWrap(http.HandlerFunc(h)))', // 20
      '\tmuxes[0].HandleFunc("/indexed", h)', // 21
      "}", // 22
      "var muxes []*http.ServeMux", // 23
    ].join("\n");
    const g = await graphOf({ "main.go": main });
    const at = (line: number) => goUnknowns(g).filter((u) => u.site?.file === "main.go" && u.site.line === line);
    // A receiver typed *http.ServeMux, a field or a call's declared result: listed with no application.
    for (const [pattern, line] of [["/field", 15], ["/made", 17]] as const) {
      const r = goRegs(g).find((x) => x.pattern === pattern);
      expect(r?.app).toBe(null);
      expect(r?.handler.status).toBe("bound");
      expect(at(line).map((u) => u.cause)).toEqual(["dynamic"]);
    }
    // A receiver of another type is no route, and needs no unknown.
    expect(goRegs(g).some((r) => r.pattern === "/chi")).toBe(false);
    expect(at(16)).toEqual([]);
    // A receiver the plugin cannot read is said.
    expect(at(21).map((u) => `${u.cause} ${u.affects.join(",")}`)).toEqual(["no-receiver-type handles"]);
    // A wrapper that cannot be bound hides middleware as well as the handler.
    for (const line of [19, 20]) expect(at(line).some((u) => u.affects.includes("handles") && u.affects.includes("applies_middleware"))).toBe(true);
  });
});

const goUnknowns = (g: Graph) => (g.frameworks?.unknowns ?? []).filter((u) => u.plugin === "go-http");

// A package of thousands of types used as handlers and thousands of test
// functions among tens of thousands of other functions: a lookup that scans
// a file's or a package's symbols once per item is quadratic here.
describe("the net/http plugin on a package of many symbols", () => {
  let graph: Graph;
  let root: string;
  let quarter: string;

  // Scale 4: 3,000 handler types and routes, 48,000 plain functions and
  // 3,600 tests; scale 1 a quarter of each, for the timing check.
  function many(scale: 1 | 4): Record<string, string> {
    const q = scale / 4;
    const files: Record<string, string> = { "go.mod": "module example.com/many\n\ngo 1.22\n" };
    for (let k = 0; k < 4; k++) {
      const lines = [GO_HEAD];
      for (let n = k * 750 * q; n < (k + 1) * 750 * q; n++) lines.push(`type T${n} struct{}\n\nfunc (T${n}) ServeHTTP(http.ResponseWriter, *http.Request) {}\n`);
      files[`types${k}.go`] = lines.join("\n");
    }
    for (let k = 0; k < 2; k++) {
      const lines = [GO_HEAD, k === 0 ? "var Mux = http.NewServeMux()\n" : "", "func init() {"];
      for (let n = k * 1500 * q; n < (k + 1) * 1500 * q; n++) lines.push(`\tMux.Handle("/t${n}", T${n}{})`);
      lines.push("}");
      files[`routes${k}.go`] = lines.join("\n");
    }
    for (let k = 0; k < 4; k++) {
      const lines = ['package main\n\nimport "testing"\n'];
      for (let n = 0; n < 12000 * q; n++) lines.push(`func a${k}x${n}() {}`);
      for (let n = 0; n < 900 * q; n++) lines.push(`func TestM${k}x${n}(t *testing.T) {}`);
      files[`many${k}_test.go`] = lines.join("\n");
    }
    return files;
  }
  const build = (repoRoot: string) => () => buildGraph({ repoRoot, store: null, budgetMs: 120_000 });

  beforeAll(async () => {
    root = writeRepo("oq-go-many-", many(4));
    quarter = writeRepo("oq-go-many-", many(1));
    graph = await build(root)();
  }, 180_000);
  afterAll(() => {
    for (const dir of [root, quarter]) if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  it("a crafted repository cannot hang or exhaust the build: every handler type and test function of a package of many symbols is found", () => {
    const run = graph.frameworks?.plugins.find((p) => p.id === "go-http");
    expect(run?.status).toBe("ok");
    expect(goRegs(graph).filter((r) => r.handler.status === "bound").length).toBe(3000);
    expect((graph.frameworks?.roles ?? []).filter((r) => r.plugin === "go-http" && r.role === "test").length).toBe(3600);
  }, 300_000);

  growthTests("in time that grows with the symbols", () => {
    it("a crafted repository cannot hang or exhaust the build: no lookup scans a file's or a package's symbols once per handler type or test function", async () => {
      expectLinear("the net/http plugin on a quarter of the symbols and on all of them", await pluginCpuMs(build(quarter), "go-http"), await pluginCpuMs(build(root), "go-http"));
    }, 300_000);
  });
});

// Every list the plugin returns grown past its cap by files a stranger
// writes: thousands of muxes, of test functions, of computed patterns, and
// a handler name defined in 60 files, so each route has 60 handles edges.
describe("the net/http plugin on lists grown past every cap", () => {
  let graph: Graph;

  beforeAll(async () => {
    const files: Record<string, string> = { "go.mod": "module example.com/lists\n\ngo 1.22\n" };
    for (let k = 0; k < 3; k++) {
      const lines = [GO_HEAD];
      for (let n = 0; n < 1700; n++) lines.push(`var m${k}x${n} = http.NewServeMux()`);
      files[`muxes${k}.go`] = lines.join("\n");
    }
    files["mux.go"] = `${GO_HEAD}var Mux = http.NewServeMux()\n\nvar v = "1"\n`;
    for (let k = 0; k < 6; k++) {
      const lines = [GO_HEAD, "func init() {"];
      for (let n = 0; n < 1750; n++) lines.push(`\tMux.HandleFunc("/v${k}x${n}/"+v, h)`);
      lines.push("}");
      files[`computed${k}.go`] = lines.join("\n");
    }
    for (let k = 0; k < 60; k++) files[`h${k}.go`] = `${GO_HEAD}func h(w http.ResponseWriter, r *http.Request) {}\n`;
    files["routes.go"] = [GO_HEAD, "func init() {", ...Array.from({ length: 1100 }, (_, n) => `\tMux.HandleFunc("/r${n}", h)`), "}"].join("\n");
    for (let k = 0; k < 6; k++) {
      const lines = ['package main\n\nimport "testing"\n'];
      for (let n = 0; n < 1750; n++) lines.push(`func TestL${k}x${n}(*testing.T) {}`);
      files[`lists${k}_test.go`] = lines.join("\n");
    }
    const root = writeRepo("oq-go-lists-", files);
    try {
      graph = await buildGraph({ repoRoot: root, store: null, budgetMs: 120_000 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 180_000);

  it("a crafted repository cannot hang or exhaust the build: every list the plugin returns stops at its cap, with one unknown each", () => {
    const data = graph.frameworks;
    const run = data?.plugins.find((p) => p.id === "go-http");
    expect(run?.status).toBe("ok");
    const apps = (data?.apps ?? []).filter((a) => a.plugin === "go-http");
    const roles = (data?.roles ?? []).filter((r) => r.plugin === "go-http");
    const edges = (data?.edges ?? []).filter((e) => e.plugin === "go-http");
    const unknowns = goUnknowns(graph);
    expect(apps.length).toBe(MAX_APPS);
    expect(roles.length).toBe(MAX_ROLES);
    expect(edges.length).toBeLessThanOrEqual(MAX_EDGES);
    expect(goRegs(graph).length).toBeLessThanOrEqual(MAX_REGISTRATIONS);
    const caps = unknowns.filter((u) => "build" in u.scope);
    expect(unknowns.length - caps.length).toBe(MAX_UNKNOWNS);
    for (const what of ["applications", "roles", "edges", "unknowns"]) expect(caps.filter((u) => u.note.includes(`stopped listing ${what} after`)).length).toBe(1);
  });
});
