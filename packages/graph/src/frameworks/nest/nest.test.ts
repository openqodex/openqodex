// The Nest plugin on the sample application of the corpus
// (corpus/frameworks/nest/nest-app), built as a real git repository and
// asked `graph routes` through the query layer; then each rule on a small
// repository of its own, and the plugin on code written to fool or stall
// it. Ways it could fail, written before the code:
//  1. A route is listed at a path the server does not answer: the global
//     prefix, a version, a RouterModule path or an exclusion is left out,
//     or one the plugin cannot read is taken as absent.
//  2. A decorator or a factory named like Nest's but not Nest's makes a route.
//  3. A route is bound to the wrong method, or an inherited route is listed
//     although the subclass overrides its method.
//  4. A string the plugin never reads (a tag, a role, a local) is copied
//     into the cached facts.
//  5. A crafted repository (module cycles, base class cycles, path fan-out)
//     stalls the build or passes a cap without saying so.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildGraph } from "../../index.js";
import type { Graph, Registration } from "../../index.js";
import { parserFor } from "../../parser.js";
import { query } from "../../query/engine.js";
import { expectLinear, growthTests, onCpuClock, readerCpuMs } from "../../test-timing.js";
import { MAX_SOURCE_BYTES, readFacts } from "./facts.js";
import { composePaths, excludes, MAX_PATHS_PER_ROUTE, MAX_REGISTRATIONS } from "./resolve.js";

// Every repository a test makes, removed when the file ends.
const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});
function makeRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "oq-nest-"));
  made.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}
function commitAll(root: string): void {
  const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
}

const PKG = JSON.stringify({ name: "n", private: true, dependencies: { "@nestjs/common": "^10.4.0", "@nestjs/core": "^10.4.0" } });
const build = async (files: Record<string, string>): Promise<Graph> => {
  const root = makeRepo({ "package.json": PKG, ...files });
  commitAll(root);
  return buildGraph({ repoRoot: root, store: null });
};
const regs = (g: Graph): Registration[] => (g.frameworks?.entities ?? []).filter((e): e is Registration => e.kind === "registration" && e.plugin === "nest");
// "METHOD pattern-or-partial handler" for every registration, sorted.
const lines = (g: Graph, app?: string | null): string[] =>
  regs(g)
    .filter((r) => app === undefined || r.app === app)
    .map((r) => `${r.methods.join(",")} ${r.pattern ?? `(${r.partial ?? "?"})`} ${r.handler.written}`)
    .sort();
const gaps = (g: Graph) => (g.frameworks?.unknowns ?? []).filter((u) => u.plugin === "nest");
const BOOT = (root: string, extra = "") => `import { NestFactory } from "@nestjs/core";\nimport { ${root} } from "./app.module";\n\nasync function bootstrap() {\n  const app = await NestFactory.create(${root});\n${extra}  await app.listen(3000);\n}\nvoid bootstrap();\n`;
const MODULE = (controllers: string[], from: Record<string, string>) =>
  `import { Module } from "@nestjs/common";\n${Object.entries(from)
    .map(([name, file]) => `import { ${name} } from "${file}";`)
    .join("\n")}\n\n@Module({ controllers: [${controllers.join(", ")}] })\nexport class AppModule {}\n`;

describe("the Nest plugin on a small real application", () => {
  let graph: Graph;
  beforeAll(async () => {
    const corpus = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "corpus", "frameworks", "nest", "nest-app");
    const root = makeRepo(readTree(join(corpus, "base")));
    commitAll(root);
    graph = await buildGraph({ repoRoot: root, store: null });
  }, 120_000);

  it("answers `graph routes` with each route's method, full path, controller method and application (1)", () => {
    const answer = query({ graph, generation: "test", treeSha: null, builtAt: null, laterEditsKnown: false }, { apiVersion: 1, kind: "routes", limit: 100 });
    expect(answer.error).toBeNull();
    const items = answer.items as { methods: string[]; pattern: string | null; app: string | null; handler: { written: string; status: string; targets: string[] } }[];
    expect(items.map((r) => `${r.methods.join(",")} ${r.pattern} ${r.handler.written} ${r.handler.status} ${r.app}`).sort()).toEqual(
      [
        "DELETE /api/users/:id UsersController.remove bound fw:nest:app:src/main.ts:5",
        "GET /api/health HealthController.check bound fw:nest:app:src/main.ts:5",
        "GET /api/users UsersController.list bound fw:nest:app:src/main.ts:5",
        "GET /api/users/:id UsersController.getUser bound fw:nest:app:src/main.ts:5",
        "GET /api/users/me UsersController.me bound fw:nest:app:src/main.ts:5",
        "POST /api/users UsersController.create bound fw:nest:app:src/main.ts:5",
      ].sort(),
    );
    expect(items.find((r) => r.handler.written === "UsersController.getUser")?.handler.targets).toEqual([expect.stringContaining("src/users/users.controller.ts#UsersController.getUser@")]);
    // The route whose path is read from the environment is a gap of the answer, not a route.
    expect(answer.unknown.floor).toBe(true);
    expect(answer.unknown.reasons.join("\n")).toContain("UsersController.extra");
  });

  it("makes no route of a decorator of the repository's own named Get (2)", () => {
    expect(regs(graph).filter((r) => r.site.file === "src/cache.ts")).toEqual([]);
  });
});

// Every file under a folder, by its path relative to it.
function readTree(dir: string, at = "", out: Record<string, string> = {}): Record<string, string> {
  for (const e of readdirSync(join(dir, at), { withFileTypes: true })) {
    const rel = at ? `${at}/${e.name}` : e.name;
    if (e.isDirectory()) readTree(dir, rel, out);
    else out[rel] = readFileSync(join(dir, rel), "utf8");
  }
  return out;
}

describe("the Nest plugin's rules, one repository each", () => {
  it("leaves a computed global prefix's routes with no pattern and their known part, and says why (1)", async () => {
    const g = await build({
      "src/main.ts": BOOT("AppModule", "  app.setGlobalPrefix(process.env.PREFIX ?? \"api\");\n"),
      "src/app.module.ts": MODULE(["CatsController"], { CatsController: "./cats.controller" }),
      "src/cats.controller.ts": 'import { Controller, Get } from "@nestjs/common";\n\n@Controller("cats")\nexport class CatsController {\n  @Get(":id")\n  find(): string {\n    return "cat";\n  }\n}\n',
    });
    expect(lines(g)).toEqual(["GET (/{computed}/cats/:id) CatsController.find"]);
    expect(gaps(g).some((u) => u.cause === "dynamic" && u.site?.file === "src/main.ts" && u.affects.includes("handles"))).toBe(true);
  }, 60_000);

  it("never applies a prefix set inside a condition, or on a value it cannot tie to the application, as if it were certain (1)", async () => {
    const ctl = 'import { Controller, Get } from "@nestjs/common";\n\n@Controller("cats")\nexport class CatsController {\n  @Get()\n  list(): string[] {\n    return [];\n  }\n}\n';
    const conditional = await build({
      "src/main.ts": BOOT("AppModule", '  if (process.env.API) {\n    app.setGlobalPrefix("api");\n  }\n'),
      "src/app.module.ts": MODULE(["CatsController"], { CatsController: "./cats.controller" }),
      "src/cats.controller.ts": ctl,
    });
    expect(lines(conditional)).toEqual(["GET (/{computed}/cats) CatsController.list"]);
    const helper = await build({
      "src/main.ts": BOOT("AppModule", "  configure(app);\n").replace('import { AppModule } from "./app.module";', 'import { AppModule } from "./app.module";\nimport { configure } from "./configure";'),
      "src/configure.ts": 'import type { INestApplication } from "@nestjs/common";\n\nexport function configure(app: INestApplication): void {\n  app.setGlobalPrefix("api");\n}\n',
      "src/app.module.ts": MODULE(["CatsController"], { CatsController: "./cats.controller" }),
      "src/cats.controller.ts": ctl,
    });
    expect(lines(helper)).toEqual(["GET (/{computed}/cats) CatsController.list"]);
    expect(gaps(helper).some((u) => u.site?.file === "src/configure.ts" && u.cause === "dynamic")).toBe(true);
    // The same call in a test file configures the test's own application.
    const tested = await build({
      "src/main.ts": BOOT("AppModule", '  app.setGlobalPrefix("api");\n'),
      "src/app.module.ts": MODULE(["CatsController"], { CatsController: "./cats.controller" }),
      "src/cats.controller.ts": ctl,
      "test/cats.e2e-spec.ts": 'export async function setup(app: { setGlobalPrefix(p: string): void }): Promise<void> {\n  app.setGlobalPrefix("other");\n}\n',
      "test/cats.spec.ts": 'export function setup(app: { setGlobalPrefix(p: string): void }): void {\n  app.setGlobalPrefix("other");\n}\n',
    });
    expect(lines(tested)).toEqual(["GET /api/cats CatsController.list"]);
  }, 120_000);

  it("reads a prefix kept in a constant of the bootstrap function, and a computed one there as computed (1)", async () => {
    const g = await build({
      "src/main.ts": BOOT("AppModule", '  const globalPrefix = "api";\n  app.setGlobalPrefix(globalPrefix);\n'),
      "src/app.module.ts": MODULE(["CatsController"], { CatsController: "./cats.controller" }),
      "src/cats.controller.ts": 'import { Controller, Get } from "@nestjs/common";\n\n@Controller("cats")\nexport class CatsController {\n  @Get()\n  list(): string[] {\n    return [];\n  }\n}\n',
    });
    expect(lines(g)).toEqual(["GET /api/cats CatsController.list"]);
    const shadow = await build({
      "src/main.ts": 'import { NestFactory } from "@nestjs/core";\nimport { AppModule } from "./app.module";\n\nconst PREFIX = "api";\n\nexport async function bootstrap(PREFIX: string) {\n  const app = await NestFactory.create(AppModule);\n  app.setGlobalPrefix(PREFIX);\n  await app.listen(3000);\n}\n',
      "src/app.module.ts": MODULE(["CatsController"], { CatsController: "./cats.controller" }),
      "src/cats.controller.ts": 'import { Controller, Get } from "@nestjs/common";\n\n@Controller("cats")\nexport class CatsController {\n  @Get()\n  list(): string[] {\n    return [];\n  }\n}\n',
    });
    expect(lines(shadow)).toEqual(["GET (/{computed}/cats) CatsController.list"]);
  }, 120_000);

  it("lists a route once per controller path, reads RequestMapping and Sse, and binds each to its method (3)", async () => {
    const g = await build({
      "src/main.ts": BOOT("AppModule"),
      "src/app.module.ts": MODULE(["CatsController"], { CatsController: "./cats.controller" }),
      "src/cats.controller.ts":
        'import { Controller, Get, RequestMapping, RequestMethod, Sse } from "@nestjs/common";\n\n@Controller(["cats", "kittens"])\nexport class CatsController {\n  @Get()\n  list(): string[] {\n    return [];\n  }\n\n  @RequestMapping({ path: "feed", method: RequestMethod.PUT })\n  feed(): void {}\n\n  @Sse("events")\n  events(): void {}\n\n  static helper(): void {}\n}\n',
    });
    expect(lines(g)).toEqual(["GET /cats CatsController.list", "GET /cats/events CatsController.events", "GET /kittens CatsController.list", "GET /kittens/events CatsController.events", "PUT /cats/feed CatsController.feed", "PUT /kittens/feed CatsController.feed"]);
    expect(regs(g).every((r) => r.handler.status === "bound" && r.mounted)).toBe(true);
  }, 60_000);

  it("lists the routes a controller inherits from a base class of the repository, but not one its own undecorated method overrides (3)", async () => {
    const g = await build({
      "src/main.ts": BOOT("AppModule"),
      "src/app.module.ts": MODULE(["CatsController"], { CatsController: "./cats.controller" }),
      "src/base.controller.ts": 'import { Delete, Get } from "@nestjs/common";\n\nexport abstract class BaseController {\n  @Get()\n  list(): string[] {\n    return [];\n  }\n\n  @Delete(":id")\n  remove(): void {}\n}\n',
      "src/cats.controller.ts": 'import { Controller, Get } from "@nestjs/common";\nimport { BaseController } from "./base.controller";\n\n@Controller("cats")\nexport class CatsController extends BaseController {\n  @Get(":id")\n  find(): string {\n    return "cat";\n  }\n\n  remove(): void {}\n}\n',
    });
    expect(lines(g)).toEqual(["GET /cats BaseController.list", "GET /cats/:id CatsController.find"]);
    expect(regs(g).find((r) => r.handler.written === "BaseController.list")?.handler.targets).toEqual([expect.stringContaining("src/base.controller.ts#BaseController.list@")]);
  }, 60_000);

  it("matches the global prefix's exclusions with a parameter, and leaves a route an exclusion it cannot match may cover with no pattern (1)", async () => {
    const ctl = 'import { Controller, Get } from "@nestjs/common";\n\n@Controller("files")\nexport class FilesController {\n  @Get(":id")\n  one(): string {\n    return "f";\n  }\n\n  @Get("list/all")\n  all(): string[] {\n    return [];\n  }\n}\n';
    const g = await build({
      "src/main.ts": BOOT("AppModule", '  app.setGlobalPrefix("api", { exclude: ["FILES/:name"] });\n'),
      "src/app.module.ts": MODULE(["FilesController"], { FilesController: "./files.controller" }),
      "src/files.controller.ts": ctl,
    });
    expect(lines(g)).toEqual(["GET /api/files/list/all FilesController.all", "GET /files/:id FilesController.one"]);
    const wild = await build({
      "src/main.ts": BOOT("AppModule", '  app.setGlobalPrefix("api", { exclude: ["files/{*rest}"] });\n'),
      "src/app.module.ts": MODULE(["FilesController"], { FilesController: "./files.controller" }),
      "src/files.controller.ts": ctl,
    });
    expect(lines(wild)).toEqual(["GET (/{computed}/files/:id) FilesController.one", "GET (/{computed}/files/list/all) FilesController.all"]);
  }, 120_000);

  it("reads a JavaScript controller whose decorators Babel compiles (3)", async () => {
    const g = await build({
      "src/main.js": 'import { NestFactory } from "@nestjs/core";\nimport { AppModule } from "./app.module";\n\nasync function bootstrap() {\n  const app = await NestFactory.create(AppModule);\n  await app.listen(3000);\n}\nbootstrap();\n',
      "src/app.module.js": 'import { Module } from "@nestjs/common";\nimport { CatsController } from "./cats.controller";\n\n@Module({ controllers: [CatsController] })\nexport class AppModule {}\n',
      "src/cats.controller.js": 'import { Bind, Controller, Get, Param } from "@nestjs/common";\n\n@Controller("cats")\nexport class CatsController {\n  @Get(":id")\n  @Bind(Param("id"))\n  findOne(id) {\n    return id;\n  }\n}\n',
    });
    expect(lines(g)).toEqual(["GET /cats/:id CatsController.findOne"]);
    expect(regs(g)[0]?.handler.status).toBe("bound");
  }, 60_000);

  it("makes no route of a class written inside a function whose parameter is named Controller (2)", async () => {
    const g = await build({
      "src/make.ts": 'import { Controller, Get } from "@nestjs/common";\n\nexport function make(Controller: (p: string) => ClassDecorator) {\n  @Controller("made")\n  class Made {\n    @Get()\n    list(): string[] {\n      return [];\n    }\n  }\n  return Made;\n}\n\nexport const real = Controller;\n',
    });
    expect(lines(g)).toEqual([]);
  }, 60_000);

  it("says a module's computed controllers and imports may hide routes, and still lists what it can read", async () => {
    const g = await build({
      "src/main.ts": BOOT("AppModule"),
      "src/app.module.ts": 'import { Module } from "@nestjs/common";\nimport { CatsController } from "./cats.controller";\n\nconst extra: never[] = [];\n\n@Module({ imports: [...extra], controllers: [CatsController, ...extra] })\nexport class AppModule {}\n',
      "src/cats.controller.ts": 'import { Controller, Get } from "@nestjs/common";\n\n@Controller("cats")\nexport class CatsController {\n  @Get()\n  list(): string[] {\n    return [];\n  }\n}\n',
    });
    expect(lines(g)).toEqual(["GET /cats CatsController.list"]);
    expect(gaps(g).filter((u) => u.site?.file === "src/app.module.ts" && u.cause === "dynamic").length).toBeGreaterThanOrEqual(2);
  }, 60_000);

  it("keeps no string it does not read in its cached facts: a tag, a role, a local of another function, an exported sentence (4)", async () => {
    const secret = ["hunter2", "open", "sesame"].join("-");
    const source = [
      'import { Controller, Get, SetMetadata } from "@nestjs/common";',
      `const Roles = (r: string) => SetMetadata("roles", r);`,
      `export const GREETING = "say ${secret} now";`,
      `const UNREAD = "${secret}";`,
      `export function local(): string {`,
      `  const PATH = "${secret}";`,
      "  return PATH;",
      "}",
      '@Controller("cats")',
      "export class CatsController {",
      `  @Roles("${secret}")`,
      '  @Get(":id")',
      "  find(): string {",
      `    return "${secret}" + UNREAD;`,
      "  }",
      "}",
    ].join("\n");
    const parser = await parserFor("typescript");
    const tree = parser.parse(source);
    if (!tree) throw new Error("no tree");
    try {
      const facts = JSON.stringify(readFacts(tree.rootNode));
      expect(facts).toContain(":id");
      expect(facts).not.toContain(secret);
    } finally {
      tree.delete();
    }
  });
});

describe("the Nest plugin on what a review found", () => {
  const ctl = 'import { Controller, Get } from "@nestjs/common";\n\n@Controller("cats")\nexport class CatsController {\n  @Get()\n  list(): string[] {\n    return [];\n  }\n}\n';
  const cats = { "src/app.module.ts": MODULE(["CatsController"], { CatsController: "./cats.controller" }), "src/cats.controller.ts": ctl };

  it("never applies a prefix set under a condition written without braces, or behind && (1)", async () => {
    const bare = await build({ "src/main.ts": BOOT("AppModule", '  if (process.env.API) app.setGlobalPrefix("api");\n'), ...cats });
    expect(lines(bare)).toEqual(["GET (/{computed}/cats) CatsController.list"]);
    const loop = await build({ "src/main.ts": BOOT("AppModule", '  for (const p of ["api"]) app.setGlobalPrefix(p);\n'), ...cats });
    expect(lines(loop)).toEqual(["GET (/{computed}/cats) CatsController.list"]);
    const and = await build({ "src/main.ts": BOOT("AppModule", '  process.env.API && app.setGlobalPrefix("api");\n'), ...cats });
    expect(lines(and)).toEqual(["GET (/{computed}/cats) CatsController.list"]);
  }, 120_000);

  it("marks the RouterModule table incomplete when its entries pass the cap at a top-level entry (1)", async () => {
    const z = Array.from({ length: 63 }, () => "ZModule").join(", ");
    const filler = Array.from({ length: 4 }, (_, i) => `{ path: "z${i}", module: ZModule, children: [${z}] }`).join(", ");
    const g = await build({
      "src/main.ts": BOOT("AppModule"),
      "src/z.module.ts": 'import { Module } from "@nestjs/common";\n\n@Module({})\nexport class ZModule {}\n',
      "src/users.module.ts": 'import { Controller, Get, Module } from "@nestjs/common";\n\n@Controller("users")\nexport class UsersController {\n  @Get()\n  list(): string[] {\n    return [];\n  }\n}\n\n@Module({ controllers: [UsersController] })\nexport class UsersModule {}\n',
      "src/app.module.ts": `import { Module } from "@nestjs/common";\nimport { RouterModule } from "@nestjs/core";\nimport { UsersModule } from "./users.module";\nimport { ZModule } from "./z.module";\n\n@Module({ imports: [UsersModule, ZModule, RouterModule.register([${filler}, { path: "admin", module: UsersModule }])] })\nexport class AppModule {}\n`,
    });
    expect(lines(g)).toEqual(["GET (/{computed}/users) UsersController.list"]);
  }, 60_000);

  it("keeps no URL credential or query value of a route path in its facts, and lists no route at a shortened path (4)", async () => {
    const secret = ["my", "Pass", "word"].join("");
    const source = [
      'import { Controller, Get } from "@nestjs/common";',
      '@Controller("cats")',
      "export class CatsController {",
      `  @Get("https://alice:${secret}@example.test/items")`,
      "  a(): void {}",
      `  @Get("/items?token=${secret}")`,
      "  b(): void {}",
      '  @Get(":id?")',
      "  c(): void {}",
      "}",
    ].join("\n");
    const parser = await parserFor("typescript");
    const tree = parser.parse(source);
    if (!tree) throw new Error("no tree");
    try {
      const facts = JSON.stringify(readFacts(tree.rootNode));
      expect(facts).not.toContain(secret);
      // An optional parameter's "?" is the route's own, and is kept.
      expect(facts).toContain(":id?");
    } finally {
      tree.delete();
    }
    const g = await build({ "src/main.ts": BOOT("AppModule"), "src/app.module.ts": MODULE(["CatsController"], { CatsController: "./cats.controller" }), "src/cats.controller.ts": source });
    expect(lines(g)).toEqual(["GET /cats/:id? CatsController.c"]);
  }, 60_000);

  it("decodes a path's JavaScript escapes as the language does, and reads a path with an escape it rejects as computed (5)", async () => {
    const g = await build({
      "src/main.ts": BOOT("AppModule"),
      "src/app.module.ts": MODULE(["CatsController"], { CatsController: "./cats.controller" }),
      "src/cats.controller.ts": 'import { Controller, Get } from "@nestjs/common";\n\n@Controller("cats")\nexport class CatsController {\n  @Get("a\\u002fb")\n  a(): void {}\n\n  @Get("\\x63\\u{64}")\n  b(): void {}\n\n  @Get("e\\/f")\n  c(): void {}\n\n  @Get("g\\1")\n  d(): void {}\n}\n',
    });
    expect(lines(g)).toEqual(["GET /cats/a/b CatsController.a", "GET /cats/cd CatsController.b", "GET /cats/e/f CatsController.c"]);
    expect(gaps(g).some((u) => u.site?.file === "src/cats.controller.ts" && u.site.line === 14 && u.cause === "dynamic")).toBe(true);
  }, 60_000);

  it("makes no application of a NestFactory a parameter shadows (2)", async () => {
    const g = await build({
      "src/main.ts": 'import { NestFactory } from "@nestjs/core";\nimport { AppModule } from "./app.module";\n\nexport async function bootstrap(NestFactory: { create(m: unknown): Promise<{ listen(p: number): Promise<void> }> }) {\n  const app = await NestFactory.create(AppModule);\n  await app.listen(3000);\n}\nexport const real = NestFactory;\n',
      ...cats,
    });
    expect(regs(g).filter((r) => r.app !== null)).toEqual([]);
    // The negative control: the same file with the import in use makes one.
    const real = await build({ "src/main.ts": BOOT("AppModule"), ...cats });
    expect(regs(real).filter((r) => r.app !== null).length).toBe(1);
  }, 120_000);
});

describe("Nest's own path rules", () => {
  it("composes paths exactly as Nest's RoutePathFactory does, with each piece's slashes (1)", () => {
    const p = (o: Partial<Parameters<typeof composePaths>[0]>) => composePaths({ versioning: undefined, version: undefined, module: undefined, ctrl: "/", method: "/", prefix: undefined, exclude: [], requestMethod: "GET", ...o }).map((x) => x.pattern ?? `(${x.partial})`);
    expect(p({})).toEqual(["/"]);
    expect(p({ ctrl: "users/", method: ":id" })).toEqual(["/users/:id"]);
    expect(p({ ctrl: "/", method: "" })).toEqual(["/"]);
    expect(p({ prefix: "/api/", ctrl: "users", method: "/" })).toEqual(["/api/users"]);
    expect(p({ prefix: "api", ctrl: "/", method: "/" })).toEqual(["/api"]);
    expect(p({ versioning: { uri: true, prefix: "v", def: undefined }, version: [{ v: "1" }, { neutral: true }], ctrl: "cats" })).toEqual(["/v1/cats", "/cats"]);
    expect(p({ versioning: { uri: true, prefix: "", def: [{ v: "2" }] }, ctrl: "cats" })).toEqual(["/2/cats"]);
    expect(p({ versioning: { uri: false, prefix: "v", def: [{ v: "2" }] }, ctrl: "cats" })).toEqual(["/cats"]);
    expect(p({ versioning: { uri: true, prefix: "v", def: [{ v: "1" }] }, prefix: "api", exclude: [{ path: "/health", method: "*" }], ctrl: "health" })).toEqual(["/v1/health"]);
    expect(p({ prefix: "api", exclude: [{ path: "health", method: "POST" }], ctrl: "health" })).toEqual(["/api/health"]);
    expect(p({ module: "/pets", ctrl: "cats", method: ":id" })).toEqual(["/pets/cats/:id"]);
    expect(p({ module: null, ctrl: "cats" })).toEqual(["(/{computed}/cats)"]);
    expect(p({ versioning: null, ctrl: "cats" })).toEqual(["(/{computed}/cats)"]);
  });

  it("matches an exclusion as path-to-regexp would on the route's written path: literal parts ignoring case, a parameter any one part, anything else unknown", () => {
    expect(excludes("health", "/health")).toBe("yes");
    expect(excludes("/Health/", "/health")).toBe("yes");
    expect(excludes("users/me", "/users/:id")).toBe("no");
    expect(excludes("users/:id", "/users/me")).toBe("yes");
    expect(excludes("users/:id", "/users")).toBe("no");
    expect(excludes("users/(.*)", "/users/x")).toBe("maybe");
    expect(excludes("users/{*rest}", "/users/x")).toBe("maybe");
  });
});

// ---------- a repository written to stall the plugin ----------
function pad(source: string, bytes: number): string {
  const filler = "\n// padding to reach the size of a large generated file\n";
  return source + filler.repeat(Math.max(0, Math.ceil((bytes - source.length) / filler.length)));
}
const HEAD = 'import { Controller, Get, Module, Version, UseGuards, forwardRef } from "@nestjs/common";\nimport { RouterModule } from "@nestjs/core";\n';
function hostile(scale: 1 | 4): Record<string, string> {
  const q = scale / 4;
  const kib = (n: number) => n * q * 1024;
  const files: Record<string, string> = { "package.json": PKG };
  // A chain of modules that loops back to its start, each declaring a controller of many routes.
  const chain = [HEAD];
  const n = Math.floor(400 * q);
  for (let i = 0; i < n; i++) {
    chain.push(`@UseGuards(G${i % 7})\n@Controller("c${i}")\nexport class C${i} {`);
    for (let j = 0; j < 4; j++) chain.push(`  @Get(":p${j}")\n  m${j}(): void {}`);
    chain.push("}");
    chain.push(`export class G${i} {}`);
    chain.push(`@Module({ imports: [forwardRef(() => M${(i + 1) % n}), M${i}], controllers: [C${i}, C${(i * 7) % n}] })\nexport class M${i} {}`);
  }
  files["src/aa-chain.ts"] = pad(chain.join("\n"), kib(250));
  // Path fan-out: every controller path, method path and version as a list.
  const list = (prefix: string) => `[${Array.from({ length: 60 }, (_, i) => `"${prefix}${i}"`).join(", ")}]`;
  files["src/fan.ts"] = pad(`${HEAD}@Controller({ path: ${list("c")}, version: ${list("")} })\nexport class Fan {\n  @Version(${list("")})\n  @Get(${list("m")})\n  all(): void {}\n}\n@Module({ controllers: [Fan] })\nexport class FanModule {}\n`, kib(150));
  // Base classes that extend each other in a loop.
  files["src/bases.ts"] = pad(`${HEAD}export class A extends B {\n  @Get("a")\n  a(): void {}\n}\nexport class B extends A {\n  @Get("b")\n  b(): void {}\n}\n@Controller("loop")\nexport class Loop extends A {}\n@Module({ controllers: [Loop] })\nexport class LoopModule {}\n`, kib(150));
  // A RouterModule table nested deep and wide.
  let table = "{ path: \"t\", module: M0 }";
  for (let d = 0; d < 12; d++) table = `{ path: "d${d}", module: M${d % n}, children: [${Array.from({ length: 6 }, () => table).slice(0, d < 4 ? 6 : 1).join(", ")}] }`;
  files["src/table.ts"] = pad(`${HEAD}import { M0, M1, M2, M3, M4, M5, M6, M7, M8, M9, M10, M11 } from "./aa-chain";\n@Module({ imports: [M0, RouterModule.register([${table}])] })\nexport class TableModule {}\n`, kib(240));
  files["src/main.ts"] = 'import { NestFactory } from "@nestjs/core";\nimport { M0 } from "./aa-chain";\nimport { FanModule } from "./fan";\nimport { LoopModule } from "./bases";\nimport { TableModule } from "./table";\n\nasync function bootstrap() {\n  for (const m of [M0, FanModule, LoopModule, TableModule]) {\n    const app = await NestFactory.create(m);\n    await app.listen(0);\n  }\n  const a = await NestFactory.create(M0);\n  const b = await NestFactory.create(FanModule);\n  const c = await NestFactory.create(LoopModule);\n  const d = await NestFactory.create(TableModule);\n  void [a, b, c, d];\n}\nvoid bootstrap();\n';
  // Over the byte cap: not read, and said.
  files["src/huge.ts"] = pad(`${HEAD}@Controller("huge")\nexport class Huge {\n  @Get()\n  h(): void {}\n}\n`, MAX_SOURCE_BYTES + 64 * 1024);
  return files;
}

describe("the Nest plugin on a repository written to stall it (5)", () => {
  const files = hostile(4);
  let graph: Graph;
  let root: string;
  let quarter: string;
  beforeAll(async () => {
    const total = Object.values(files).reduce((s, x) => s + Buffer.byteLength(x), 0);
    expect(total).toBeGreaterThan(1024 * 1024);
    root = makeRepo(files);
    commitAll(root);
    quarter = makeRepo(hostile(1));
    commitAll(quarter);
    graph = await onCpuClock(() => buildGraph({ repoRoot: root, store: null, maxFileBytes: 2 * 1024 * 1024, budgetMs: 120_000 }));
  }, 600_000);

  it("finishes, stays within its caps, and says where it stopped", () => {
    const run = graph.frameworks?.plugins.find((p) => p.id === "nest");
    expect(run?.status).toBe("ok");
    const all = regs(graph);
    expect(all.length).toBeGreaterThan(1000);
    expect(all.length).toBeLessThanOrEqual(MAX_REGISTRATIONS);
    const fan = all.filter((r) => r.site.file === "src/fan.ts");
    // Two applications reach the fan-out controller; each keeps at most the cap.
    expect(fan.length).toBeLessThanOrEqual(2 * MAX_PATHS_PER_ROUTE);
    expect(gaps(graph).some((u) => u.site?.file === "src/fan.ts" && u.cause === "fan-out-capped")).toBe(true);
    expect(gaps(graph).some((u) => u.site?.file === "src/huge.ts" && u.cause === "file-not-parsed")).toBe(true);
    expect(all.some((r) => r.site.file === "src/huge.ts")).toBe(false);
    // The loop of base classes ends: both inherited routes, once each per application.
    expect(lines(graph).filter((l) => l.includes("/loop")).length).toBeGreaterThan(0);
  });

  it("reads and resolves more than 1 MiB of crafted Nest code in under a second of CPU each", async () => {
    const sources = Object.entries(files)
      .filter(([p, c]) => p.endsWith(".ts") && Buffer.byteLength(c) <= MAX_SOURCE_BYTES)
      .map(([, c]) => c);
    expect(await readerCpuMs("typescript", sources, readFacts)).toBeLessThan(1000);
    expect(graph.frameworks?.plugins.find((p) => p.id === "nest")?.ms ?? Number.POSITIVE_INFINITY).toBeLessThan(1000);
  }, 120_000);

  growthTests("in time that grows with it", () => {
    it("reads and resolves the crafted repository in time that grows with its size and no faster", async () => {
      const src = (of: Record<string, string>) =>
        Object.entries(of)
          .filter(([p, c]) => p.endsWith(".ts") && Buffer.byteLength(c) <= MAX_SOURCE_BYTES)
          .map(([, c]) => c);
      expectLinear("the Nest fact reader on the crafted files", await readerCpuMs("typescript", src(hostile(1)), readFacts), await readerCpuMs("typescript", src(files), readFacts));
      const ms = async (r: string) => (await onCpuClock(() => buildGraph({ repoRoot: r, store: null, maxFileBytes: 2 * 1024 * 1024, budgetMs: 120_000 }))).frameworks?.plugins.find((p) => p.id === "nest")?.ms ?? Number.POSITIVE_INFINITY;
      expectLinear("the Nest plugin on the crafted repository", await ms(quarter), await ms(root));
    }, 300_000);
  });
});
