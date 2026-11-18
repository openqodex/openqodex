// Compiler truth for TypeScript callers, and the graph scored against it,
// call site by call site. The TypeScript checker names the declaration each
// call resolves to; the graph's edges and unknowns at the same site are
// sorted into one outcome. Used by graph-truth.test.ts; nothing here reads
// what the graph says before truth is fixed, so the truth cannot bend to it.
import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";
import type { Graph, GraphNode } from "../../packages/graph/src/index.js";

// What stands before the dot of the call, as the checker sees it.
export const SHAPES = [
  "interface member",
  "type alias member",
  "in-place object type",
  "destructured",
  "this.field",
  "parameter typed by class",
  "parameter typed by interface",
  "call result",
  "chained result",
  "non-null !",
  "optional chaining",
  "generic",
  // Not in the owner's list; kept apart so `other` stays small.
  "callback parameter",
  "loop variable",
  "bare call",
  "this or super",
  "local annotated or new",
  "static or module",
  "other",
] as const;
export type ShapeName = (typeof SHAPES)[number];

export const OUTCOMES = ["certain-correct", "likely-correct", "possible-correct", "wrong-target", "unbound", "absent"] as const;
export type Outcome = (typeof OUTCOMES)[number];

// The declaration a call resolves to. `method`: of a class, or a class
// property whose type is a function; `interface member`: a method or a
// function-typed property of an interface or an object type; `function`: a
// function declaration or a variable holding a function expression;
// `callable property`: any other value of function type (a parameter, a
// variable, a getter), which is no declaration of a function.
export type TargetKind = "function" | "method" | "interface member" | "object literal member" | "callable property";
export type Target = { file: string; line: number; name: string; owner: string | null; kind: TargetKind };

export type TruthCall = {
  file: string;
  line: number;
  column: number; // 1-based, of the called name
  name: string;
  test: boolean;
  shape: ShapeName;
  // Repo declarations the call resolves to (several for a union receiver);
  // empty when it resolves outside the repo or not at all.
  targets: Target[];
  resolved: "repo" | "external" | "none";
};

export type TruthOptions = {
  root: string;
  scope: string[]; // folders relative to root whose .ts and .tsx files are compiled and measured
  paths?: Record<string, string[]>; // relative to root
};

const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".git", ".openqodex", "coverage"]);

export function isTestFile(file: string): boolean {
  return /(^|\/)(tests?|__tests__|__mocks__|e2e)\//.test(file) || /\.(test|spec)\.[cm]?tsx?$/.test(file);
}

function sourceFiles(dir: string, out: string[]): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) sourceFiles(p, out);
    else if (/\.[cm]?tsx?$/.test(e.name) && !/\.d\.[cm]?ts$/.test(e.name)) out.push(p);
  }
}

export type Truth = { calls: TruthCall[]; files: string[]; unresolvedImports: number; ms: number };

export function compilerTruth(o: TruthOptions): Truth {
  const started = performance.now();
  const files: string[] = [];
  for (const s of o.scope) sourceFiles(join(o.root, s), files);
  const program = ts.createProgram(files, {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ["lib.esnext.d.ts"],
    types: [],
    strict: true,
    skipLibCheck: true,
    noEmit: true,
    esModuleInterop: true,
    resolveJsonModule: true,
    jsx: ts.JsxEmit.Preserve,
    baseUrl: o.root,
    paths: o.paths ?? {},
  });
  const checker = program.getTypeChecker();
  const rel = (f: string) => relative(o.root, f).split(sep).join("/");
  const inRepo = (f: string) => !f.includes("/node_modules/") && f.startsWith(o.root + sep);
  const measured = new Set(files);
  let unresolvedImports = 0;
  const calls: TruthCall[] = [];

  const symbolOf = (n: ts.Node): ts.Symbol | undefined => {
    let s = checker.getSymbolAtLocation(n);
    if (s && s.flags & ts.SymbolFlags.Alias) s = checker.getAliasedSymbol(s);
    return s;
  };
  const declOf = (n: ts.Node): ts.Declaration | undefined => symbolOf(n)?.declarations?.[0];
  const ownerName = (n: ts.Node | undefined): string | null => {
    for (let p = n; p; p = p.parent) {
      if ((ts.isClassLike(p) || ts.isInterfaceDeclaration(p) || ts.isTypeAliasDeclaration(p)) && p.name) return p.name.text;
      if (ts.isFunctionDeclaration(p) && p.name) return p.name.text;
    }
    return null;
  };
  const lineOf = (n: ts.Node) => n.getSourceFile().getLineAndCharacterOfPosition(n.getStart()).line + 1;

  // The repo declaration a resolved symbol stands for, or null when it is
  // not a function or a method.
  const targetOf = (d: ts.Declaration): Target | null => {
    const sf = d.getSourceFile();
    if (!inRepo(sf.fileName)) return null;
    const named = (name: ts.Node | undefined, kind: TargetKind): Target | null =>
      name && (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteral(name))
        ? { file: rel(sf.fileName), line: lineOf(name), name: name.text, owner: ownerName(d.parent), kind }
        : null;
    const fnInit = (e: ts.Expression | undefined) => !!e && (ts.isArrowFunction(e) || ts.isFunctionExpression(e));
    if (ts.isFunctionDeclaration(d)) return named(d.name, "function");
    if (ts.isVariableDeclaration(d)) return fnInit(d.initializer) ? named(d.name, "function") : named(d.name, "callable property");
    if (ts.isMethodDeclaration(d)) return named(d.name, ts.isObjectLiteralExpression(d.parent) ? "object literal member" : "method");
    if (ts.isMethodSignature(d)) return named(d.name, "interface member");
    // A member whose type is a function, however the type is spelled
    // (`f: () => T`, `f: NamedFnType`, `f: Pick<...>['g']`), is a member to call.
    const callable = () => checker.getTypeAtLocation(d).getCallSignatures().length > 0;
    if (ts.isPropertySignature(d)) return named(d.name, callable() ? "interface member" : "callable property");
    if (ts.isPropertyDeclaration(d)) return named(d.name, fnInit(d.initializer) || callable() ? "method" : "callable property");
    if (ts.isPropertyAssignment(d) || ts.isShorthandPropertyAssignment(d)) return named(d.name, "object literal member");
    if (ts.isGetAccessor(d) || ts.isParameter(d) || ts.isBindingElement(d)) return named(d.name, "callable property");
    return null;
  };

  const strip = (e: ts.Expression): ts.Expression => {
    while (ts.isParenthesizedExpression(e) || ts.isAwaitExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isTypeAssertionExpression(e)) e = e.expression;
    return e;
  };
  const typeDeclKind = (t: ts.TypeNode): "class" | "interface" | "literal" | "generic" | "other" => {
    if (ts.isTypeLiteralNode(t)) return "literal";
    if (!ts.isTypeReferenceNode(t)) return "other";
    const s = symbolOf(t.typeName);
    const d = s?.declarations?.[0];
    if (!d) return "other";
    if (ts.isClassDeclaration(d)) return "class";
    if (ts.isInterfaceDeclaration(d) || ts.isTypeAliasDeclaration(d)) return "interface";
    if (ts.isTypeParameterDeclaration(d)) return "generic";
    return "other";
  };

  const shapeOf = (call: ts.CallExpression): ShapeName => {
    const callee = call.expression;
    if (ts.isIdentifier(callee)) return "bare call";
    if (!ts.isPropertyAccessExpression(callee)) return "other";
    if (call.questionDotToken || callee.questionDotToken) return "optional chaining";
    if (ts.isNonNullExpression(callee.expression)) return "non-null !";
    const r = strip(callee.expression);
    if (r.kind === ts.SyntaxKind.ThisKeyword || r.kind === ts.SyntaxKind.SuperKeyword) return "this or super";
    if (ts.isCallExpression(r)) return "chained result";
    if (ts.isPropertyAccessExpression(r)) {
      if (r.expression.kind === ts.SyntaxKind.ThisKeyword) return "this.field";
      const d = declOf(r.name);
      if (d && ts.isPropertySignature(d)) {
        if (ts.isInterfaceDeclaration(d.parent)) return "interface member";
        if (ts.isTypeLiteralNode(d.parent)) return ts.isTypeAliasDeclaration(d.parent.parent) ? "type alias member" : "in-place object type";
      }
      if (d && (ts.isClassDeclaration(d) || ts.isModuleDeclaration(d) || ts.isFunctionDeclaration(d))) return "static or module";
      return "other";
    }
    if (!ts.isIdentifier(r)) return "other";
    const t = checker.getTypeAtLocation(r);
    if (t.flags & ts.TypeFlags.TypeParameter) return "generic";
    const d = declOf(r);
    if (!d) return "other";
    if (ts.isBindingElement(d)) return "destructured";
    if (ts.isParameter(d)) {
      // `xs.map((x) => x.m())`: typed by the call it is passed to.
      if (!d.type) return (ts.isArrowFunction(d.parent) || ts.isFunctionExpression(d.parent)) && ts.isCallExpression(d.parent.parent) ? "callback parameter" : "other";
      const k = typeDeclKind(d.type);
      if (k === "class") return "parameter typed by class";
      if (k === "interface") return "parameter typed by interface";
      if (k === "literal") return "in-place object type";
      if (k === "generic") return "generic";
      return "other";
    }
    if (ts.isVariableDeclaration(d)) {
      if (ts.isForOfStatement(d.parent.parent) || ts.isForInStatement(d.parent.parent)) return "loop variable";
      const init = d.initializer ? strip(d.initializer) : undefined;
      if (d.type || (init && ts.isNewExpression(init))) return "local annotated or new";
      if (init && ts.isCallExpression(init)) return "call result";
      return "other";
    }
    if (ts.isClassDeclaration(d) || ts.isFunctionDeclaration(d) || ts.isModuleDeclaration(d) || ts.isImportSpecifier(d) || ts.isImportClause(d) || ts.isNamespaceImport(d) || ts.isSourceFile(d)) return "static or module";
    return "other";
  };

  for (const sf of program.getSourceFiles()) {
    if (!measured.has(sf.fileName)) continue;
    for (const st of sf.statements) {
      if ((ts.isImportDeclaration(st) || ts.isExportDeclaration(st)) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier) && st.moduleSpecifier.text.startsWith(".")) {
        if (!symbolOf(st.moduleSpecifier)) unresolvedImports++;
      }
    }
    const file = rel(sf.fileName);
    const test = isTestFile(file);
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && n.expression.kind !== ts.SyntaxKind.SuperKeyword && n.expression.kind !== ts.SyntaxKind.ImportKeyword) {
        const callee = n.expression;
        const nameNode = ts.isIdentifier(callee) ? callee : ts.isPropertyAccessExpression(callee) ? callee.name : undefined;
        if (nameNode) {
          const pos = sf.getLineAndCharacterOfPosition(nameNode.getStart());
          // The declaration the checker picked; a union receiver names one per member type.
          const sig = checker.getResolvedSignature(n);
          const symbol = symbolOf(nameNode);
          let decls: ts.Declaration[] = [];
          const sd = sig?.declaration;
          if (sd && !ts.isJSDocSignature(sd)) {
            const holder = (ts.isArrowFunction(sd) || ts.isFunctionExpression(sd) || ts.isFunctionTypeNode(sd) ? sd.parent : sd) as ts.Declaration;
            // An overload resolves to its signature; the definition that runs
            // is the implementation, the one declaration of the symbol with a body.
            const impl = symbol?.declarations?.find((d) => (ts.isFunctionDeclaration(d) || ts.isMethodDeclaration(d)) && d.body);
            if (impl && symbol?.declarations?.includes(holder)) decls = [impl];
            else decls = symbol?.declarations?.includes(holder) ? [holder] : (symbol?.declarations ?? [holder]);
          } else decls = symbol?.declarations ?? [];
          // A union receiver (`Cat | Dog`) names one declaration per member
          // type and the call may run any of them: every one is a target, each
          // member keeping its overload rule (the implementation, not the signatures).
          if (ts.isPropertyAccessExpression(callee)) {
            const receiver = checker.getNonNullableType(checker.getTypeAtLocation(callee.expression));
            if (receiver.isUnion()) {
              const members = receiver.types.map((t) => t.getProperty(callee.name.text)?.declarations ?? []).filter((ds) => ds.length > 0);
              if (members.length > 1) decls = members.map((ds) => ds.find((d) => (ts.isFunctionDeclaration(d) || ts.isMethodDeclaration(d)) && d.body) ?? ds[0]);
            }
          }
          const targets: Target[] = [];
          const seen = new Set<string>();
          let external = false;
          for (const d of decls) {
            if (!inRepo(d.getSourceFile().fileName)) {
              external = true;
              continue;
            }
            const t = targetOf(d);
            if (!t) continue;
            const key = `${t.file}:${t.owner}:${t.name}`;
            if (seen.has(key)) continue;
            seen.add(key);
            targets.push(t);
          }
          calls.push({
            file,
            line: pos.line + 1,
            column: pos.character + 1,
            name: nameNode.text,
            test,
            shape: shapeOf(n),
            targets,
            resolved: targets.length > 0 ? "repo" : external || decls.length > 0 ? "external" : "none",
          });
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return { calls, files: files.map(rel), unresolvedImports, ms: Math.round(performance.now() - started) };
}

// ---------- the graph against the truth ----------

type SiteEdge = { to: GraphNode; kind: string; tier: string; column: number; name: string };

// The records of one call among those on its line: the ones at its column
// (the graph counts bytes, the checker UTF-16 units; equal on an ASCII
// line), else the ones of its name. A call through an import alias names
// the alias at the site and the definition in the edge, so the column
// comes first.
function atCall<T extends { column: number; name: string }>(xs: T[], c: { column: number; name: string }): T[] {
  const col = xs.filter((x) => x.column === c.column);
  return col.length > 0 ? col : xs.filter((x) => x.name === c.name);
}

export type Scored = TruthCall & {
  outcome: Outcome;
  inGraph: boolean; // the truth target is a node of the graph
  cause: string | null; // the unknown's cause, when one is recorded at the site
  note: string | null;
  wrongCertain: string[]; // certain edges at the site into something truth does not name
  burden: number; // possible edges at the site into something truth does not name
};

// A graph node per truth target: same file and name, its span holding the
// declaration's line, the innermost one.
function nodeOf(graph: Graph, t: Target): GraphNode | null {
  let best: GraphNode | null = null;
  for (const n of graph.defsByFile.get(t.file) ?? []) {
    if (n.name !== t.name || n.startLine > t.line || n.endLine < t.line) continue;
    if (!best || n.endLine - n.startLine < best.endLine - best.startLine) best = n;
  }
  return best;
}

export function score(graph: Graph, truth: Truth): Scored[] {
  const at = new Map<string, SiteEdge[]>();
  for (const e of graph.edges) {
    if (e.kind !== "calls" && e.kind !== "dispatches_to") continue;
    const to = graph.nodes.get(e.to);
    if (!to) continue;
    for (const s of e.sites) {
      const k = `${s.file}:${s.line}`;
      const list = at.get(k) ?? [];
      list.push({ to, kind: e.kind, tier: s.tier, column: s.column, name: to.name });
      at.set(k, list);
    }
  }
  const unknownAt = new Map<string, { cause: string; note: string | null; column: number; name: string }[]>();
  for (const u of graph.unknowns) {
    const k = `${u.file}:${u.line}`;
    const list = unknownAt.get(k) ?? [];
    list.push({ cause: u.cause, note: u.note ?? null, column: u.column, name: u.name });
    unknownAt.set(k, list);
  }
  return truth.calls.map((c) => {
    const k = `${c.file}:${c.line}`;
    const edges = atCall(at.get(k) ?? [], c);
    const unknowns = atCall(unknownAt.get(k) ?? [], c);
    const ids = new Set(c.targets.map((t) => nodeOf(graph, t)?.id).filter((x): x is string => !!x));
    const hit = edges.filter((e) => ids.has(e.to.id));
    const miss = edges.filter((e) => !ids.has(e.to.id));
    let outcome: Outcome;
    if (hit.some((e) => e.kind === "calls" && e.tier === "certain")) outcome = "certain-correct";
    else if (hit.some((e) => e.tier === "likely")) outcome = "likely-correct";
    else if (hit.length > 0) outcome = "possible-correct";
    else if (edges.length > 0) outcome = "wrong-target";
    else if (unknowns.length > 0) outcome = "unbound";
    else outcome = "absent";
    return {
      ...c,
      outcome,
      inGraph: ids.size > 0,
      cause: unknowns[0]?.cause ?? null,
      note: unknowns[0]?.note ?? null,
      wrongCertain: miss.filter((e) => e.tier === "certain").map((e) => e.to.id),
      burden: miss.filter((e) => e.tier === "possible").length,
    };
  });
}

// Every certain call edge of the graph in the measured TypeScript files, checked
// against the checker: `agree`, `wrong` (truth names another repo
// declaration, or one outside the repo), `unverifiable` (the checker could
// not resolve the call), `no-call` (the checker sees no call of that name there).
export type CertainCheck = { site: string; to: string; verdict: "agree" | "wrong" | "unverifiable" | "no-call" };

export function checkCertain(graph: Graph, truth: Truth): CertainCheck[] {
  const byLine = new Map<string, TruthCall[]>();
  for (const c of truth.calls) {
    const k = `${c.file}:${c.line}`;
    byLine.set(k, [...(byLine.get(k) ?? []), c]);
  }
  const measured = new Set(truth.files);
  const out: CertainCheck[] = [];
  for (const e of graph.edges) {
    if (e.kind !== "calls") continue;
    const to = graph.nodes.get(e.to);
    if (!to || to.kind === "class") continue;
    for (const s of e.sites) {
      if (s.tier !== "certain" || !measured.has(s.file)) continue;
      const here = atCall(byLine.get(`${s.file}:${s.line}`) ?? [], { column: s.column, name: to.name });
      let verdict: CertainCheck["verdict"];
      if (here.length === 0) verdict = "no-call";
      else if (here.some((c) => c.targets.some((t) => nodeOf(graph, t)?.id === to.id))) verdict = "agree";
      else if (here.every((c) => c.resolved === "none")) verdict = "unverifiable";
      else verdict = "wrong";
      out.push({ site: `${s.file}:${s.line}:${s.column}`, to: to.id, verdict });
    }
  }
  return out;
}
