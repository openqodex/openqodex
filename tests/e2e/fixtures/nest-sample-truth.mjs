// The routes the Nest sample applications serve, read with the TypeScript
// compiler's own parser: the truth list tests/e2e/graph-nest-routes.test.ts
// compares the graph's Nest reader with. It shares no code with the reader
// (which walks tree-sitter trees) and follows Nest's runtime rules for the
// shapes the samples use: an application is `NestFactory.create(Module)`
// with NestFactory imported from @nestjs/core; it serves the controllers of
// every module its root module reaches through `imports` (a class, a
// `forwardRef(() => X)`, or `X.method(...)` of a module of the sample); a
// route is a method decorated with an HTTP method decorator of
// @nestjs/common (Get, Post, Put, Delete, Patch, Options, Head, All,
// Search, Sse); its path is the controller's path and the method's path
// joined. A shape the script does not model (a global prefix, versioning,
// RouterModule, @RequestMapping, a path that is not a string literal) stops it with an error,
// so the truth list is never quietly wrong.
//
// Usage: node tests/e2e/fixtures/nest-sample-truth.mjs <folder holding the samples>
// Prints the list as JSON: { app, method, path, handler } sorted.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import ts from "typescript";

const METHODS = { Get: "GET", Post: "POST", Put: "PUT", Delete: "DELETE", Patch: "PATCH", Options: "OPTIONS", Head: "HEAD", All: "*", Search: "SEARCH", Sse: "GET" };
const SKIP_DIRS = new Set(["node_modules", "dist", ".git"]);

export function truth(root) {
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        if (!SKIP_DIRS.has(name)) walk(path);
      } else if (/\.(ts|js|mts|mjs)$/.test(name) && !name.endsWith(".d.ts")) files.push(path);
    }
  };
  walk(root);

  const parsed = new Map();
  const parse = (path) => {
    if (parsed.has(path)) return parsed.get(path);
    const text = readFileSync(path, "utf8");
    const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, path.endsWith(".js") || path.endsWith(".mjs") ? ts.ScriptKind.JS : ts.ScriptKind.TS);
    const imports = new Map(); // local name -> { spec, name }
    const classes = new Map(); // name -> ClassDeclaration
    for (const st of sf.statements) {
      if (ts.isImportDeclaration(st) && st.importClause && ts.isStringLiteral(st.moduleSpecifier)) {
        const spec = st.moduleSpecifier.text;
        const b = st.importClause.namedBindings;
        if (b && ts.isNamedImports(b)) for (const el of b.elements) imports.set(el.name.text, { spec, name: (el.propertyName ?? el.name).text });
        if (st.importClause.name) imports.set(st.importClause.name.text, { spec, name: "default" });
      }
      if (ts.isClassDeclaration(st) && st.name) classes.set(st.name.text, st);
    }
    const info = { path, sf, imports, classes };
    parsed.set(path, info);
    return info;
  };
  const rel = (p) => relative(root, p).split("\\").join("/");
  const resolveSpec = (from, spec) => {
    if (!spec.startsWith(".")) return null;
    const base = join(dirname(from), spec).replace(/\.(js|mjs)$/, "");
    for (const c of [`${base}.ts`, `${base}.js`, `${base}.mts`, `${base}.mjs`, join(base, "index.ts"), join(base, "index.js")]) if (existsSync(c)) return c;
    throw new Error(`cannot resolve ${spec} from ${rel(from)}`);
  };
  // The class a name means in a file: its own, or the one an import names.
  const classOf = (file, name) => {
    const f = parse(file);
    if (f.classes.has(name)) return { file, node: f.classes.get(name) };
    const imp = f.imports.get(name);
    if (!imp) throw new Error(`${name} is not defined in ${rel(file)}`);
    const target = resolveSpec(file, imp.spec);
    if (!target) return null; // a package's class
    return classOf(target, imp.name);
  };
  const fromCommon = (file, name) => parse(file).imports.get(name)?.spec === "@nestjs/common";
  const decorators = (node) => ts.getDecorators?.(node) ?? node.decorators ?? [];
  const decoCall = (file, d) => {
    const e = d.expression;
    if (!ts.isCallExpression(e) || !ts.isIdentifier(e.expression)) return null;
    const imp = parse(file).imports.get(e.expression.text);
    if (!imp || imp.spec !== "@nestjs/common") return null;
    return { name: imp.name, args: e.arguments };
  };
  const literal = (file, node, what) => {
    if (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) return node.text;
    throw new Error(`${what} in ${rel(file)} is not a string literal; the truth script does not model it`);
  };
  const paths = (file, node, what) => {
    if (!node) return ["/"];
    if (ts.isArrayLiteralExpression(node)) return node.elements.map((e) => literal(file, e, what));
    return [literal(file, node, what)];
  };
  const join2 = (...parts) => `/${parts.flatMap((p) => p.split("/")).filter((s) => s !== "").join("/")}`;

  const out = [];
  const prefixCalls = new Set();
  for (const file of files) {
    const f = parse(file);
    const visit = (node) => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "create" && ts.isIdentifier(node.expression.expression)) {
        const imp = f.imports.get(node.expression.expression.text);
        if (imp && imp.spec === "@nestjs/core" && imp.name === "NestFactory") app(file, node);
      }
      // A test file's call configures the application its test makes, not
      // the server; a literal prefix set on the application in its own
      // bootstrap block is read by app() below.
      if (!/\.(spec|e2e-spec|test)\.[mc]?[jt]s$/.test(file) && !prefixCalls.has(node) && ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ["setGlobalPrefix", "enableVersioning"].includes(node.expression.name.text)) throw new Error(`${rel(file)} calls ${node.expression.name.text}; the truth script does not model it`);
      ts.forEachChild(node, visit);
    };
    visit(f.sf);
  }

  function app(file, call) {
    const first = call.arguments[0];
    if (!first || !ts.isIdentifier(first)) throw new Error(`the root module in ${rel(file)} is not a name`);
    // `const app = await NestFactory.create(M); app.setGlobalPrefix("x");` in one block.
    let globalPrefix = "";
    let decl = call.parent;
    while (decl && ts.isAwaitExpression(decl)) decl = decl.parent;
    if (decl && ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name) && ts.isBlock(decl.parent?.parent?.parent)) {
      const name = decl.name.text;
      for (const st of decl.parent.parent.parent.statements) {
        if (!ts.isExpressionStatement(st) || !ts.isCallExpression(st.expression)) continue;
        const e = st.expression;
        if (!ts.isPropertyAccessExpression(e.expression) || !ts.isIdentifier(e.expression.expression) || e.expression.expression.text !== name || e.expression.name.text !== "setGlobalPrefix") continue;
        if (e.arguments.length !== 1) throw new Error(`the global prefix in ${rel(file)} has options; the truth script does not model them`);
        globalPrefix = literal(file, e.arguments[0], "the global prefix");
        prefixCalls.add(e);
      }
    }
    const rootCls = classOf(file, first.text);
    const queue = [rootCls];
    const seen = new Set([`${rootCls.file}#${rootCls.node.name.text}`]);
    const controllers = new Map();
    while (queue.length > 0) {
      const m = queue.shift();
      const deco = decorators(m.node).map((d) => decoCall(m.file, d)).find((d) => d && d.name === "Module");
      if (!deco) throw new Error(`${m.node.name.text} in ${rel(m.file)} is not a module`);
      const meta = deco.args[0];
      if (!meta) continue;
      if (!ts.isObjectLiteralExpression(meta)) throw new Error(`the metadata of ${m.node.name.text} is not an object literal`);
      for (const p of meta.properties) {
        // Only the two lists that decide which controllers an application serves
        // must be readable; every other property (providers, exports) is not modelled.
        const listed = p.name && ts.isIdentifier(p.name) && (p.name.text === "controllers" || p.name.text === "imports");
        if (listed && (!ts.isPropertyAssignment(p) || !ts.isArrayLiteralExpression(p.initializer))) {
          throw new Error(`${p.name.text} of ${m.node.name.text} in ${rel(m.file)} is not an array literal; the truth script does not model it`);
        }
        if (!ts.isPropertyAssignment(p) || !ts.isIdentifier(p.name)) continue;
        if (!ts.isArrayLiteralExpression(p.initializer)) continue;
        if (p.name.text === "controllers") {
          for (const e of p.initializer.elements) {
            if (!ts.isIdentifier(e)) throw new Error(`a controller of ${m.node.name.text} is not a name`);
            const c = classOf(m.file, e.text);
            if (c) controllers.set(`${c.file}#${c.node.name.text}`, c);
          }
        }
        if (p.name.text === "imports") {
          for (const e of p.initializer.elements) {
            let name = null;
            if (ts.isIdentifier(e)) name = e.text;
            else if (ts.isCallExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === "forwardRef" && fromCommon(m.file, "forwardRef")) {
              const fn = e.arguments[0];
              if (fn && ts.isArrowFunction(fn) && ts.isIdentifier(fn.body)) name = fn.body.text;
            } else if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && ts.isIdentifier(e.expression.expression)) {
              const head = e.expression.expression.text;
              if (head === "RouterModule") throw new Error(`${rel(m.file)} uses RouterModule; the truth script does not model it`);
              name = head;
            }
            if (name === null) throw new Error(`an import of ${m.node.name.text} in ${rel(m.file)} is not modelled`);
            const target = classOf(m.file, name);
            if (!target) continue; // a package's module: it serves no controller of the sample
            const key = `${target.file}#${target.node.name.text}`;
            if (!seen.has(key)) {
              seen.add(key);
              queue.push(target);
            }
          }
        }
      }
    }
    for (const c of controllers.values()) {
      const ctl = decorators(c.node).map((d) => decoCall(c.file, d)).find((d) => d && d.name === "Controller");
      if (!ctl) throw new Error(`${c.node.name.text} is listed as a controller but has no @Controller`);
      const arg = ctl.args[0];
      if (arg && ts.isObjectLiteralExpression(arg)) throw new Error(`${c.node.name.text} has controller options; the truth script does not model them`);
      const prefixes = paths(c.file, arg, `the path of ${c.node.name.text}`);
      if (c.node.heritageClauses?.some((h) => h.token === ts.SyntaxKind.ExtendsKeyword)) throw new Error(`${c.node.name.text} extends a class; the truth script does not model inherited routes`);
      for (const member of c.node.members) {
        if (!ts.isMethodDeclaration(member) || !member.name || !ts.isIdentifier(member.name)) continue;
        if (decorators(member).map((d) => decoCall(c.file, d)).some((d) => d && d.name === "RequestMapping")) throw new Error(`${c.node.name.text}.${member.name.text} has @RequestMapping; the truth script does not model it`);
        const route = decorators(member).map((d) => decoCall(c.file, d)).find((d) => d && d.name in METHODS);
        if (!route) continue;
        if (decorators(member).map((d) => decoCall(c.file, d)).some((d) => d && d.name === "Version")) throw new Error(`${c.node.name.text}.${member.name.text} has @Version; the truth script does not model it`);
        for (const prefix of prefixes) {
          for (const path of paths(c.file, route.args[0], `the path of ${c.node.name.text}.${member.name.text}`)) {
            out.push({ app: rel(file), method: METHODS[route.name], path: join2(globalPrefix, prefix, path), handler: `${rel(c.file)}#${c.node.name.text}.${member.name.text}` });
          }
        }
      }
    }
  }
  const key = (r) => `${r.app} ${r.method} ${r.path} ${r.handler}`;
  return [...new Map(out.map((r) => [key(r), r])).values()].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const root = process.argv[2];
  if (!root) {
    console.error("usage: node tests/e2e/fixtures/nest-sample-truth.mjs <folder holding the samples>");
    process.exit(2);
  }
  process.stdout.write(`${JSON.stringify(truth(root), null, 2)}\n`);
}
