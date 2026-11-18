// `openqodex graph routes` on real Nest applications: the sample folder of
// the official nestjs/nest repository at a pinned commit (37 sample
// applications by the framework's own authors, with REST controllers,
// feature modules, a dynamic module, a global prefix, a Babel-compiled
// JavaScript app, server-sent events, and apps with no HTTP routes at all).
// The failure this file guards against: the Nest reader lists a route at a
// path the server does not answer, binds it to the wrong method, misses a
// route an application serves, or calls a route served that no application
// reaches. The truth is built apart from the reader, by
// tests/e2e/fixtures/nest-sample-truth.mjs with the TypeScript compiler's own
// parser, and kept in tests/e2e/fixtures/nest-sample-routes.json; the test
// rebuilds it from the clone, so the kept list cannot drift from the code.
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { git, root, run } from "./support.js";
import { cacheFolder, removeTempDirs, tempDir } from "../temp-dirs.mjs";
// @ts-expect-error: a plain JavaScript script with no type declarations.
import { truth } from "./fixtures/nest-sample-truth.mjs";

afterAll(removeTempDirs);

const NEST = { url: "https://github.com/nestjs/nest.git", sha: "35142c3eca8edaaf6abc5984d915da2fbd458aa2" };
type Route = { app: string; method: string; path: string; handler: string };

// A shallow clone of exactly the pinned commit, shared with graph.test.ts.
function clone(): string {
  const dir = join(cacheFolder("openqodex-graph-acceptance"), "nest");
  if (existsSync(join(dir, ".git")) && git(dir, "rev-parse", "HEAD").trim() === NEST.sha) return dir;
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  git(dir, "fetch", "-q", "--depth", "1", NEST.url, NEST.sha);
  git(dir, "checkout", "-q", "--force", NEST.sha);
  return dir;
}

// The truth script stops on a route shape it does not model, so its list is never quietly short.
describe("the Nest truth script", () => {
  const sample = (decorator: string) => {
    const dir = tempDir("oq-e2e-nest-truth-");
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src/main.ts"), 'import { NestFactory } from "@nestjs/core";\nimport { AppModule } from "./app.module";\n\nasync function bootstrap() {\n  const app = await NestFactory.create(AppModule);\n  await app.listen(3000);\n}\nvoid bootstrap();\n');
    writeFileSync(join(dir, "src/app.module.ts"), 'import { Module } from "@nestjs/common";\nimport { CatsController } from "./cats.controller";\n\n@Module({ controllers: [CatsController] })\nexport class AppModule {}\n');
    writeFileSync(join(dir, "src/cats.controller.ts"), `import { Controller, Get, RequestMapping, RequestMethod } from "@nestjs/common";\n\n@Controller("cats")\nexport class CatsController {\n  @Get()\n  list(): void {}\n\n  ${decorator}\n  feed(): void {}\n}\n`);
    return dir;
  };

  it("stops with an error on a @RequestMapping route instead of leaving it out", () => {
    expect(() => truth(sample('@RequestMapping({ path: "feed", method: RequestMethod.PUT })'))).toThrow(/RequestMapping/);
    // The negative control: the same controller with a modelled decorator reads both routes.
    expect((truth(sample('@Get("feed")')) as Route[]).map((r) => `${r.method} ${r.path} ${r.handler}`)).toEqual(["GET /cats src/cats.controller.ts#CatsController.list", "GET /cats/feed src/cats.controller.ts#CatsController.feed"]);
  });
});

describe.skipIf(process.env.OPENQODEX_E2E_OFFLINE === "1")("graph routes on the Nest sample applications", () => {
  it(`nestjs/nest ${NEST.sha.slice(0, 12)} sample/: every served route, its full path, its controller method and its application, and nothing else served`, () => {
    // The sample folder as a repository of its own: each sample is a project with its own manifest.
    const dir = join(tempDir("oq-e2e-nest-"), "samples");
    cpSync(join(clone(), "sample"), dir, { recursive: true });
    writeFileSync(join(dir, ".openqodex.yaml"), "graph:\n  budget_ms: 120000\n");
    git(dir, "init", "-q");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "samples");

    const expected = (truth(dir) as Route[]).map((r) => `${r.app} ${r.method} ${r.path} ${r.handler}`);
    const kept = (JSON.parse(readFileSync(join(root, "tests/e2e/fixtures/nest-sample-routes.json"), "utf8")) as Route[]).map((r) => `${r.app} ${r.method} ${r.path} ${r.handler}`);
    expect(expected, "the kept truth list is what the truth script reads from this commit").toEqual(kept);
    expect(expected.length).toBeGreaterThan(50);

    const r = run("graph-nest-routes", dir, ["graph", "routes", "--json", "--limit", "1000"]);
    expect(r.status, r.stderr).toBe(0);
    const answer = JSON.parse(r.stdout) as { items: { plugin: string; app: string | null; methods: string[]; pattern: string | null; mounted: boolean; handler: { written: string; status: string; targets: string[] } }[]; truncated: unknown };
    const items = answer.items.filter((i) => i.plugin === "nest");
    // An application id is fw:nest:app:<file>:<line>; a handler id is <file>#<Class.method>@<line>:<column>.
    const appFile = (id: string) => id.replace(/^fw:nest:app:/, "").replace(/:\d+$/, "");
    const served = items.filter((i) => i.app !== null && i.app.startsWith("fw:nest:app:"));
    const got = served.map((i) => `${appFile(i.app as string)} ${i.methods.join(",")} ${i.pattern ?? "(no pattern)"} ${(i.handler.targets[0] ?? "(unbound)").replace(/@\d+:\d+$/, "")}`).sort();
    const missed = expected.filter((x) => !got.includes(x));
    const extra = got.filter((x) => !expected.includes(x));
    console.log(`nest samples: ${expected.length} served routes in the truth list, ${got.length} listed served, ${missed.length} missed, ${extra.length} not in the truth list, ${items.length - served.length} listed as not served`);
    expect(missed, "served routes the reader missed or listed wrong").toEqual([]);
    expect(extra, "routes the reader lists as served that no application serves").toEqual([]);
    // A route listed as not served is one no application reaches: its handler is in no served route.
    const servedHandlers = new Set(expected.map((x) => x.split(" ")[3]));
    for (const i of items.filter((x) => x.app === null)) expect(servedHandlers.has((i.handler.targets[0] ?? "").replace(/@\d+:\d+$/, "")), i.handler.written).toBe(false);
  });
});
