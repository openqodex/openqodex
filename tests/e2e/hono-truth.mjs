// The routes a Hono application serves, read with the TypeScript compiler
// API, as an independent truth for the Hono plugin's acceptance test
// (hono-trueforge.test.ts). It shares no code with the plugin: names are
// bound by the TypeScript checker's own symbols, functions are followed by
// their declarations, and a router's calls are found by the symbol of the
// variable it is bound to.
//
// From one root application (a variable bound to `new OpenAPIHono()` or
// `new Hono()` inside a named function), it follows every `route(prefix,
// router)` into the router: a variable, a parameter (through the argument
// the call gave it) or the single return of a called function. It reads
// `get`, `post`, `put`, `patch`, `delete`, `options` and `all` with a
// literal path, and `openapi(route, handler)` with a `createRoute({ method,
// path })` constant, and joins the prefixes segment by segment, each
// `/{name}` of an OpenAPI path served as `/:name`. A call chained on the
// router's own calls (`app.get(...).post(...)`) is a call on the router.
// Anything else it meets on
// the way is listed under `unread` with its site, never guessed.
//
// Usage: node tests/e2e/hono-truth.mjs <repo> [<src folder> <root file> <root function>]
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const METHODS = new Set(["get", "post", "put", "patch", "delete", "options", "all"]);
// The calls that return the router they are called on, so a call chained on one is on the router.
const SELF = new Set([...METHODS, "openapi", "route", "use"]);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts") && !p.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

const segs = (p) => p.split("/").filter((s) => s !== "");
const join2 = (a, b) => `/${[...segs(a), ...segs(b)].join("/")}`;
const served = (p) => p.replace(/\/\{([^}]+)\}/g, "/:$1");

export function honoTruth(repo, srcDir = "packages/trueforge/src", rootFile = "packages/trueforge/src/app.ts", rootFn = "createServerApp") {
  const files = walk(join(repo, srcDir));
  const program = ts.createProgram(files, { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, noEmit: true, skipLibCheck: true, types: [] });
  const checker = program.getTypeChecker();
  const rel = (node) => relative(repo, node.getSourceFile().fileName);
  const line = (node) => node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1;
  const site = (node) => `${rel(node)}:${line(node)}`;
  const strip = (e) => {
    while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isNonNullExpression(e) || ts.isAwaitExpression(e)) e = e.expression;
    return e;
  };
  const declOf = (node) => {
    let sym = checker.getSymbolAtLocation(node);
    if (!sym) return null;
    if (sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
    return { sym, decl: sym.declarations?.[0] ?? null };
  };
  // The module a name is imported from in its own file, by the import declaration that binds it.
  const importedFrom = (id) => {
    const sym = checker.getSymbolAtLocation(id);
    const d = sym?.declarations?.[0];
    if (!d || !ts.isImportSpecifier(d)) return null;
    return { module: d.parent.parent.parent.moduleSpecifier.text, name: (d.propertyName ?? d.name).text };
  };
  const isHonoNew = (e) => {
    if (!ts.isNewExpression(e) || !ts.isIdentifier(e.expression)) return false;
    const from = importedFrom(e.expression);
    return from !== null && ((from.module === "hono" && from.name === "Hono") || (from.module === "@hono/zod-openapi" && from.name === "OpenAPIHono"));
  };
  // The return statements of a function body, not those of functions inside it.
  const returnsOf = (fn) => {
    const out = [];
    const visit = (n) => {
      if (n !== fn.body && (ts.isFunctionLike(n) || ts.isClassLike(n))) return;
      if (ts.isReturnStatement(n)) out.push(n);
      ts.forEachChild(n, visit);
    };
    if (fn.body && !ts.isBlock(fn.body)) return [{ expression: fn.body }];
    if (fn.body) visit(fn.body);
    return out;
  };

  const unread = [];
  // A router: the `new` that made it, the symbol of the variable it is bound to, and the parameters' arguments.
  const routerOf = (expr, env, depth = 0) => {
    const e = strip(expr);
    if (depth > 20) throw new Error(`too deep at ${site(e)}`);
    if (isHonoNew(e)) {
      // The variable it is bound to, past the wrappers strip removed (`new Hono() as Hono`).
      let holder = e.parent;
      while (holder && (ts.isParenthesizedExpression(holder) || ts.isAsExpression(holder) || ts.isSatisfiesExpression(holder) || ts.isNonNullExpression(holder) || ts.isAwaitExpression(holder))) holder = holder.parent;
      const sym = holder && ts.isVariableDeclaration(holder) ? checker.getSymbolAtLocation(holder.name) : null;
      if (!sym) unread.push({ site: site(e), why: "a Hono value bound to no variable, so the calls made on it are not found" });
      return { made: e, sym, env };
    }
    if (ts.isIdentifier(e)) {
      const d = declOf(e);
      if (!d?.decl) return null;
      if (ts.isParameter(d.decl)) {
        const arg = env.get(d.sym);
        return arg ? routerOf(arg.expr, arg.env, depth + 1) : null;
      }
      if (ts.isVariableDeclaration(d.decl) && d.decl.initializer) return routerOf(d.decl.initializer, env, depth + 1);
      return null;
    }
    if (ts.isCallExpression(e) && ts.isIdentifier(e.expression)) {
      const d = declOf(e.expression);
      let fn = d?.decl ?? null;
      if (fn && ts.isVariableDeclaration(fn)) fn = fn.initializer ?? null;
      if (!fn || !(ts.isFunctionDeclaration(fn) || ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) return null;
      const rets = returnsOf(fn);
      if (rets.length !== 1 || !rets[0].expression) return null;
      const inner = new Map();
      fn.parameters.forEach((p, i) => {
        if (ts.isIdentifier(p.name) && e.arguments[i]) inner.set(checker.getSymbolAtLocation(p.name), { expr: e.arguments[i], env });
      });
      return routerOf(rets[0].expression, inner, depth + 1);
    }
    return null;
  };
  // The calls made on a router's variable, in source order, a call chained
  // on another (`app.get(...).post(...)`) included when every call under it
  // returns the router itself; a call chained on any other (`basePath`) is unread.
  const callsOn = (router) => {
    if (!router.sym) return [];
    const out = [];
    const sf = router.made.getSourceFile();
    const visit = (n) => {
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
        let recv = strip(n.expression.expression);
        const under = [];
        while (ts.isCallExpression(recv) && ts.isPropertyAccessExpression(recv.expression)) {
          under.push(recv.expression.name.text);
          recv = strip(recv.expression.expression);
        }
        if (ts.isIdentifier(recv) && checker.getSymbolAtLocation(recv) === router.sym) {
          const other = under.find((m) => !SELF.has(m));
          if (other === undefined) out.push(n);
          else unread.push({ site: site(n), why: `a call chained on ${other}, which the truth does not read` });
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    return out.sort((a, b) => a.getStart() - b.getStart() || a.getEnd() - b.getEnd());
  };
  const handlerOf = (expr, env) => {
    const e = strip(expr);
    if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) return "inline";
    if (ts.isCallExpression(e)) return "call";
    if (ts.isIdentifier(e)) {
      const d = declOf(e);
      if (!d?.decl) return "unknown";
      if (ts.isParameter(d.decl)) {
        const arg = env.get(d.sym);
        return arg ? handlerOf(arg.expr, arg.env) : "parameter";
      }
      if ((ts.isVariableDeclaration(d.decl) || ts.isFunctionDeclaration(d.decl)) && d.decl.name) return site(d.decl.name);
      return "unknown";
    }
    return "computed";
  };
  const routeDef = (expr) => {
    const e = strip(expr);
    const d = ts.isIdentifier(e) ? declOf(e) : null;
    const init = d?.decl && ts.isVariableDeclaration(d.decl) ? d.decl.initializer : ts.isCallExpression(e) ? e : null;
    if (!init || !ts.isCallExpression(init) || !ts.isIdentifier(init.expression)) return null;
    const from = importedFrom(init.expression);
    if (!from || from.module !== "@hono/zod-openapi" || from.name !== "createRoute") return null;
    const obj = init.arguments[0];
    if (!obj || !ts.isObjectLiteralExpression(obj)) return null;
    const prop = (k) => obj.properties.find((p) => ts.isPropertyAssignment(p) && p.name.getText() === k)?.initializer;
    const m = prop("method");
    const p = prop("path");
    if (!m || !p || !ts.isStringLiteralLike(m) || !ts.isStringLiteralLike(p)) return null;
    return { method: m.text.toUpperCase(), path: p.text };
  };

  const routes = [];
  const compose = (router, prefix, app, stack) => {
    if (stack.includes(router.made)) return;
    for (const call of callsOn(router)) {
      const m = call.expression.name.text;
      const args = call.arguments;
      if (METHODS.has(m)) {
        const p = args[0];
        if (!p || !ts.isStringLiteralLike(p) || args.length < 2) {
          unread.push({ site: site(call), why: `${m} without a literal path` });
          continue;
        }
        routes.push({ site: site(call), method: m === "all" ? "*" : m.toUpperCase(), path: join2(prefix, p.text), written: p.text, handler: handlerOf(args[args.length - 1], router.env), app });
      } else if (m === "openapi") {
        const def = args[0] ? routeDef(args[0]) : null;
        if (!def || !args[1]) {
          unread.push({ site: site(call), why: "openapi without a createRoute constant" });
          continue;
        }
        routes.push({ site: site(call), method: def.method, path: join2(prefix, served(def.path)), written: def.path, handler: handlerOf(args[1], router.env), app });
      } else if (m === "route") {
        const p = args[0];
        const target = args[1] ? routerOf(args[1], router.env) : null;
        if (!p || !ts.isStringLiteralLike(p) || !target) {
          unread.push({ site: site(call), why: "route with a prefix or router the truth does not follow" });
          continue;
        }
        compose(target, join2(prefix, p.text), app, [...stack, router.made]);
      } else if (m !== "use" && m !== "notFound" && m !== "onError" && m !== "doc" && m !== "doc31" && m !== "openAPIRegistry") {
        unread.push({ site: site(call), why: `a call of ${m} the truth does not read` });
      }
    }
  };

  const sf = program.getSourceFile(join(repo, rootFile));
  if (!sf) throw new Error(`${rootFile} is not in the program`);
  let root = null;
  const find = (n) => {
    if (ts.isFunctionDeclaration(n) && n.name?.text === rootFn) {
      const visit = (m) => {
        if (!root && ts.isVariableDeclaration(m) && m.initializer && isHonoNew(strip(m.initializer))) root = routerOf(m.initializer, new Map());
        ts.forEachChild(m, visit);
      };
      visit(n);
    }
    ts.forEachChild(n, find);
  };
  find(sf);
  if (!root) throw new Error(`no Hono application in ${rootFn} of ${rootFile}`);
  const app = site(root.made);
  compose(root, "", app, []);
  routes.sort((a, b) => (a.site < b.site ? -1 : a.site > b.site ? 1 : a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { app, routes, unread };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [repo, ...rest] = process.argv.slice(2);
  process.stdout.write(`${JSON.stringify(honoTruth(repo, ...rest), null, 2)}\n`);
}
