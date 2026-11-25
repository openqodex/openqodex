// The one depth-first pass over a parse tree: the core extractor's
// (extract.ts) and the framework plugins' fact readers' at once. Each used
// to walk the tree with its own cursor, and on a JavaScript repository the
// walks cost more than the readers' own work. Here the cursor moves once,
// each node's type is read once, and its field name and its ancestors are
// read once and handed to every reader. A node object is made only for a
// node whose type the core or a reader asked for, or that a reader reads as
// an ancestor: making one for every named node cost more than the readers'
// own work too.
//
// Ways it could fail, written before the code (shared-walk.test.ts):
// 1. A reader sees other nodes, or the same nodes in another order, than
//    its own walk showed it, so its facts change.
// 2. A reader that skips a node's children hides them from the others.
// 3. A reader that throws loses the facts of the others, or keeps being
//    called and throws again on every node.
// 4. A reader is told it left a node at another point than its own walk
//    told it, so a scope or a frame it keeps closes at the wrong node.
// 5. The core extractor sees other nodes than its own walk showed it, or
//    a reader riding on its walk sees other nodes than it sees alone: the
//    core skips the children of a node the readers still read (an import,
//    a type alias), and walks into a region the parser could not read,
//    which the readers never enter.
// 6. A reader that names its types is entered for another node, or not
//    for one of its types, or reads an ancestor the walk did not make as
//    null or as another node.
//
// The walk keeps no step back up the parents: a node's ancestors come from
// the path it keeps as it enters and leaves nodes, never from a node's
// `parent`, which tree-sitter finds by descending from the root again (a
// lookup per node would make a deeply nested file quadratic). The one
// exception is an ancestor a reader reads through `up` that the walk did
// not make (a type the reader did not name in `keep`): it is found from
// the nearest node made below it, once, and kept on the path.
import type { Language, Node, Tree } from "web-tree-sitter";
import { keyShaped } from "./frameworks/shared/kept.js";
import { MAX_FACT_STRING, MAX_UNREAD_NAMES } from "./types.js";
import type { UnreadRegion } from "./types.js";

// The node's ancestors: `up(1)` its parent, `up(2)` the one above.
export type Up = (k: number) => Node | null;
// The types of the same ancestors, read once when each was entered.
export type UpType = (k: number) => string | null;

export type TreeVisitor = {
  // A named node outside any region the parser could not read. `field()`
  // is the field its parent holds it in, read when asked and only during
  // this call; `depth` is the node's depth (the root is 0).
  // False: none of the node's descendants is shown to this reader.
  enter(node: Node, type: string, field: () => string | null, depth: number, up: Up, upType: UpType): boolean | void;
  // The walk leaves a node at `depth`, after its descendants: every node,
  // named or not, or, for a reader that names its `types`, each node it
  // was entered for.
  leave?(depth: number): void;
  // A region the parser could not read (an ERROR or a missing node) starts
  // at `line`. It is never entered: the language would not run such a
  // file, so nothing in it is a fact.
  broken?(line: number): void;
  // The named node types `enter` is called for; absent: every named node.
  types?: ReadonlySet<string>;
  // The types of the ancestors the reader reads as nodes through `up`: the
  // walk makes them as it passes them. Any other ancestor `up` gives is
  // found from the nearest node made below it: the same node, slower.
  keep?: ReadonlySet<string>;
};

// The core extractor's visit: called for every node whose type is in
// `interesting`, inside a region the parser could not read too, as the
// extractor has always read it. It returns false to skip the node's
// children, or a function to run when the walk leaves the node. A child the
// core skips is still walked for a reader that reads it. `wants`, when set,
// is asked first with the node's type, its field in its parent and the
// types above it, before the node is made: false passes the node by (its
// children are still walked), so a common node it has no use for costs
// no node.
export type CoreVisitor = {
  interesting: ReadonlySet<string>;
  wants?(type: string, field: () => string | null, upType: UpType): boolean;
  visit(node: Node, field: () => string | null, upType: UpType): (() => void) | false | void;
};

// What the walk does at a node of one type, worked out once per type id.
type Plan = {
  type: string;
  error: boolean; // an ERROR node: a region the parser could not read
  named: boolean;
  core: boolean; // the core visits it
  enters: boolean[]; // by reader: entered here
  keep: boolean; // some reader reads it as an ancestor
};

// Valid TypeScript the pinned grammar reads with one missing node and no
// other damage: the tree around the node has the shape the code has, so a
// reader reads it as it reads any other code (the core always has).
//  - A tagged template with type arguments, `sql<Row>`select``: a missing
//    `!` between the type arguments and the template. In the last branch
//    of a ternary or the right side of an operator, the template is put on
//    the whole expression; every call, member and name inside keeps its
//    own node.
//  - A cast to an import type with an array suffix, `x as
//    import('./t').Row[]`: the `[]` is read as a subscript whose index is
//    missing.
// A shape the grammar garbles further (`f<typeof import('./t')>()`, read
// as two comparisons) is still a region the parser could not read.
export function graceful(node: Node): boolean {
  if (!node.isMissing) return false;
  const parent = node.parent;
  if (node.type === "!") {
    if (parent?.type !== "non_null_expression" || parent.nextSibling?.type !== "template_string") return false;
    // The type arguments end where the missing node starts: the expression's
    // own, or those of its last branch or right side.
    let tagged = parent.firstChild;
    while (tagged && tagged.type !== "instantiation_expression" && tagged.endIndex === node.startIndex) tagged = tagged.lastChild;
    return tagged?.type === "instantiation_expression" && tagged.endIndex === node.startIndex;
  }
  if (node.type !== "identifier" || parent?.type !== "subscript_expression") return false;
  const open = node.previousSibling;
  const close = node.nextSibling;
  if (open?.type !== "[" || close?.type !== "]" || close.startIndex !== open.endIndex) return false;
  const cast = parent.childForFieldName("object");
  if (cast?.type !== "as_expression" && cast?.type !== "satisfies_expression") return false;
  let type = cast.lastNamedChild;
  while (type?.type === "member_expression") type = type.childForFieldName("object");
  return type?.type === "call_expression" && type.childForFieldName("function")?.type === "import";
}

// The regions of a tree the parser could not read, found once per tree:
// every ERROR node and every missing node that is not graceful. They never
// overlap (an ERROR node is not searched inside, a missing node is empty),
// so in order of their start they are in order of their end too.
type Regions = { starts: number[]; ends: number[] };
const regionsByTree = new WeakMap<Tree, Regions>();
function regionsOf(tree: Tree): Regions {
  let regions = regionsByTree.get(tree);
  if (regions) return regions;
  const found: [number, number][] = [];
  const stack: Node[] = [tree.rootNode];
  while (stack.length > 0) {
    const n = stack.pop() as Node;
    if (n.type === "ERROR" || (n.isMissing && !graceful(n))) found.push([n.startIndex, n.endIndex]);
    else for (const c of n.children) if (c?.hasError) stack.push(c);
  }
  found.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  regions = { starts: found.map((r) => r[0]), ends: found.map((r) => r[1]) };
  regionsByTree.set(tree, regions);
  return regions;
}

// What each region the parser could not read may hide (FileFacts.unread):
// its line and column, and every word written from its previous named
// sibling to its next one, but in a comment or the text of a string. A
// call there may be read as something else or not at all, and the
// parser's recovery may leave the callee in a neighbour (`F(` in Go leaves
// `F` a value before the region), so the neighbours' words count too. A
// call that names no word there goes through a value (a string's text
// names a function only to code that runs a name built at run time).
// Regions whose spans overlap are one. `names` is null past
// MAX_UNREAD_NAMES words: then the region may hide a call of anything.
//
// The facts are cached and feed the review packet, so no text that may be
// a key is kept (frameworks/shared/kept.ts): not a string's text, not a
// run shaped like a key (`sk_live_...`, `sk-live-...`), and nothing after
// a quote the parser could not match, since an unterminated string's text
// is read as code (`"sk_live_...` in Python is a quote, then a name). What
// is dropped may name a call, so such a region keeps no names (null): it
// may hide a call of anything.
const WORD = /[\p{L}_$][\p{L}\p{N}_$]*[?!]?/gu;
// A run of the characters a key is written with, read whole by keyShaped.
const RUN = /[\p{L}\p{N}_$?!-]+/gu;
const isComment = (n: Node) => n.type.includes("comment");
// A leaf that holds a literal's text, not code: a string's piece, a
// character, an escape (an interpolation's code is no leaf of this kind).
const isText = (n: Node) => /string|heredoc|character|rune|escape/.test(n.type);
// A leaf that opens a string (`"`, `'`, a backtick, `"""`, Python's
// `f"`), which the parser left unmatched when it stands in an ERROR node.
const QUOTE = /^[A-Za-z]{0,2}(?:"""|'''|["'`])$/;
export function unreadRegions(tree: Tree): UnreadRegion[] {
  if (!tree.rootNode.hasError) return [];
  const spans: { start: number; end: number; line: number; column: number; nodes: Node[] }[] = [];
  const stack: Node[] = [tree.rootNode];
  while (stack.length > 0) {
    const parent = stack.pop() as Node;
    const kids = parent.children.filter((c): c is Node => c !== null);
    kids.forEach((n, i) => {
      if (n.type === "ERROR" || (n.isMissing && !graceful(n))) {
        let from = i;
        for (let k = i - 1; k >= 0 && from === i; k--) if ((kids[k] as Node).isNamed && !isComment(kids[k] as Node)) from = k;
        let to = i;
        for (let k = i + 1; k < kids.length && to === i; k++) if ((kids[k] as Node).isNamed && !isComment(kids[k] as Node)) to = k;
        const nodes = kids.slice(from, to + 1);
        spans.push({ start: (nodes[0] as Node).startIndex, end: (nodes[nodes.length - 1] as Node).endIndex, line: n.startPosition.row + 1, column: n.startPosition.column, nodes });
      } else if (n.hasError) stack.push(n);
    });
  }
  // Outer spans first: a span inside one already walked is not walked
  // again, so nested regions cost one walk of what they cover.
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const out: UnreadRegion[] = [];
  let open: { end: number; walked: number; region: UnreadRegion; words: Set<string>; blind: boolean } | null = null;
  const close = () => {
    if (!open) return;
    open.region.names = open.blind || open.words.size > MAX_UNREAD_NAMES ? null : [...open.words];
    out.push(open.region);
  };
  for (const s of spans) {
    if (!open || s.start > open.end) {
      close();
      open = { end: s.end, walked: s.start, region: { line: s.line, column: s.column, names: [] }, words: new Set(), blind: false };
    } else open.end = Math.max(open.end, s.end);
    const region = open;
    // Past the cap, or blind, the region keeps no names: nothing more to read.
    if (region.blind || region.words.size > MAX_UNREAD_NAMES) continue;
    // The leaves in the order they are written, each with its parent.
    const below: [Node, Node | null][] = s.nodes.filter((n) => n.endIndex > region.walked).map((n): [Node, Node | null] => [n, null]).reverse();
    region.walked = Math.max(region.walked, s.end);
    while (below.length > 0) {
      const [n, parent] = below.pop() as [Node, Node | null];
      if (isComment(n)) continue;
      if (n.childCount > 0) {
        for (let i = n.childCount - 1; i >= 0; i--) {
          const c = n.child(i);
          if (c) below.push([c, n]);
        }
        continue;
      }
      // An unmatched quote (Python's `string_start` too, before it is read
      // as a string's piece): what follows it may be a string's text.
      if ((parent === null ? n.type === "ERROR" : parent.type === "ERROR") && QUOTE.test(n.text)) {
        region.blind = true;
        break;
      }
      if (isText(n)) continue;
      for (const run of n.text.match(RUN) ?? []) {
        if (keyShaped(run)) {
          region.blind = true;
          continue;
        }
        for (const w of run.match(WORD) ?? []) {
          if (w.length > MAX_FACT_STRING) continue;
          if (keyShaped(w)) {
            region.blind = true;
            continue;
          }
          region.words.add(w);
          // `save!` and `valid?` are Ruby names; the same word bare may be another.
          if (w.endsWith("?") || w.endsWith("!")) region.words.add(w.slice(0, -1));
        }
      }
      if (region.blind || region.words.size > MAX_UNREAD_NAMES) break;
    }
  }
  close();
  return out;
}

// Whether a node holds a region the parser could not read: `hasError`,
// less the graceful missing nodes. The readers test this, never `hasError`.
// The first region that starts inside the node is the one that ends first,
// so it alone decides; it is found by halving.
export function hasError(node: Node): boolean {
  if (!node.hasError) return false;
  const { starts, ends } = regionsOf(node.tree);
  let lo = 0;
  let hi = starts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((starts[mid] as number) < node.startIndex) lo = mid + 1;
    else hi = mid;
  }
  return lo < starts.length && (ends[lo] as number) <= node.endIndex;
}

// A node type's name and whether it is named, by type id, per grammar: both
// are properties of the type (the cursor's own `nodeType` is the name of
// its `nodeTypeId`), read from the grammar once rather than per node.
const ERROR_ID = 0xffff;
const namedByLanguage = new WeakMap<Language, boolean[]>();

export function walkTree(root: Node, visitors: readonly TreeVisitor[], core: CoreVisitor | null = null): void {
  const n = visitors.length;
  if (n === 0 && core === null) return;
  const language = root.tree.language;
  let namedById = namedByLanguage.get(language);
  if (!namedById) namedByLanguage.set(language, (namedById = []));
  const named = namedById;
  const typed = visitors.map((v) => v.types !== undefined);
  const plans: (Plan | undefined)[] = [];
  let errorPlan: Plan | null = null;
  const planOf = (id: number): Plan => {
    const type = id === ERROR_ID ? "ERROR" : language.types[id] || "ERROR";
    const error = type === "ERROR";
    let isNamed = false;
    if (!error) {
      const known = named[id];
      isNamed = known ?? (named[id] = language.nodeTypeIsNamed(id));
    }
    return {
      type,
      error,
      named: isNamed,
      core: core !== null && core.interesting.has(type),
      enters: visitors.map((v) => isNamed && (v.types === undefined || v.types.has(type))),
      keep: isNamed && visitors.some((v) => v.keep?.has(type) === true),
    };
  };
  // A tree with no error holds no missing node: no node needs the test.
  const missing = root.hasError;
  // The depth below which each reader skips the nodes, or -1.
  const skipBelow: number[] = Array.from({ length: n }, () => -1);
  // For a reader that names its types: the depths of the nodes it was
  // entered for and has not left.
  const entered: number[][] = visitors.map(() => []);
  // The depth below which the core skips the nodes, or -1.
  let coreSkip = -1;
  const leaves: { depth: number; fn: () => void }[] = [];
  // The current node's ancestors as made (null: not made), and their types.
  const path: (Node | null)[] = [];
  const types: string[] = [];
  let depth = 0;
  const cursor = root.walk();
  let node: Node | null = null;
  const make = (): Node => {
    if (node === null) {
      node = cursor.currentNode;
      path[depth] = node;
    }
    return node;
  };
  const up: Up = (k) => {
    const at = depth - k;
    if (at < 0) return null;
    const known = path[at];
    if (known) return known;
    // An ancestor not made: climb to it from the nearest node made below it.
    let below = at + 1;
    while (below < depth && !path[below]) below++;
    let cur: Node | null = below >= depth ? make() : (path[below] as Node);
    for (let d = below - 1; d >= at && cur; d--) {
      cur = cur.parent;
      path[d] = cur;
    }
    return path[at] ?? null;
  };
  const upType: UpType = (k) => (depth - k >= 0 ? (types[depth - k] ?? null) : null);
  const shown = (i: number): boolean => {
    const s = skipBelow[i] as number;
    return s < 0 || depth <= s;
  };
  // The current node's field, read from the cursor once, when a reader asks.
  let fieldRead = false;
  let fieldName: string | null = null;
  const field = (): string | null => {
    if (!fieldRead) {
      fieldName = cursor.currentFieldName;
      fieldRead = true;
    }
    return fieldName;
  };
  try {
    for (;;) {
      const id = cursor.nodeTypeId;
      let plan: Plan;
      if (id === ERROR_ID) plan = errorPlan ??= planOf(id);
      else plan = plans[id] ??= planOf(id);
      node = null;
      fieldRead = false;
      if (plan.named) types[depth] = plan.type;
      let descend = false;
      if (core !== null && coreSkip < 0) {
        descend = true;
        if (plan.core && (core.wants === undefined || core.wants(plan.type, field, upType))) {
          const result = core.visit(make(), field, upType);
          if (result === false) {
            coreSkip = depth;
            descend = false;
          } else if (typeof result === "function") leaves.push({ depth, fn: result });
        }
      }
      if (n > 0) {
        if (plan.error || (missing && cursor.nodeIsMissing)) {
          // A graceful missing node is empty: no reader is told of it or enters it.
          if (plan.error || !graceful(make())) {
            let line = 0;
            for (let i = 0; i < n; i++) {
              // Entering a node, a reader is shown it exactly when it skips nothing.
              if ((skipBelow[i] as number) >= 0) continue;
              line ||= cursor.startPosition.row + 1;
              visitors[i]?.broken?.(line);
              skipBelow[i] = depth;
            }
          }
        } else if (plan.named) {
          fieldRead = false;
          path[depth] = node;
          types[depth] = plan.type;
          if (plan.keep) make();
          for (let i = 0; i < n; i++) {
            if ((skipBelow[i] as number) >= 0) continue;
            if (!plan.enters[i]) {
              descend = true;
              continue;
            }
            if (typed[i]) (entered[i] as number[]).push(depth);
            if (visitors[i]?.enter(make(), plan.type, field, depth, up, upType) === false) skipBelow[i] = depth;
            else descend = true;
          }
        } else {
          // An unnamed node (a keyword or punctuation) is entered by no reader;
          // its children, if any, still are, as each reader's own walk did.
          for (let i = 0; i < n && !descend; i++) if ((skipBelow[i] as number) < 0) descend = true;
        }
      }
      if (descend && cursor.gotoFirstChild()) {
        depth++;
        continue;
      }
      for (;;) {
        while (leaves.length > 0 && (leaves[leaves.length - 1] as { depth: number }).depth === depth) (leaves.pop() as { fn: () => void }).fn();
        if (coreSkip === depth) coreSkip = -1;
        for (let i = 0; i < n; i++) {
          if (typed[i]) {
            const open = entered[i] as number[];
            if (open.length > 0 && open[open.length - 1] === depth) {
              open.pop();
              visitors[i]?.leave?.(depth);
            }
          } else if (shown(i)) visitors[i]?.leave?.(depth);
        }
        // Leaving the node a reader skipped below: it sees the nodes again.
        for (let i = 0; i < n; i++) if (skipBelow[i] === depth) skipBelow[i] = -1;
        if (cursor.gotoNextSibling()) break;
        if (!cursor.gotoParent()) return;
        depth--;
      }
    }
  } finally {
    cursor.delete();
  }
}

// One reader's facts when it walks the tree alone.
export function readAlone<F>(root: Node, reader: { visitor: TreeVisitor | null; finish(): F[] }): F[] {
  if (reader.visitor) walkTree(root, [reader.visitor]);
  return reader.finish();
}
