// search_code's matcher. The reviewer's pattern is a regular expression in
// JavaScript's syntax, but it never reaches JavaScript's engine, which
// backtracks: it is compiled here to a small automaton and run over each
// line by simulating every state at once (a Thompson simulation), so the
// time is bounded by the line's length times the automaton's size, whatever
// the pattern. What only a backtracking engine can do (a backreference, a
// lookaround) is refused with the reason, and so is an automaton over
// MAX_PROGRAM steps. No flag is taken: matching is case sensitive, and `^`
// and `$` are the start and end of the line.

type Test = (c: number) => boolean;
type Assertion = "start" | "end" | "word" | "notword";
type Inst = { op: "char"; test: Test } | { op: "split"; a: number; b: number } | { op: "jmp"; to: number } | { op: "assert"; kind: Assertion } | { op: "match" };
// `code`: the one character a single-character test accepts, so it can
// start or end a range in a class.
type Node =
  | { t: "char"; test: Test; code?: number }
  | { t: "assert"; kind: Assertion }
  | { t: "seq"; items: Node[] }
  | { t: "alt"; options: Node[] }
  | { t: "rep"; node: Node; min: number; max: number };

export type Program = Inst[];

// The most steps one pattern's automaton may have, and the largest count a
// `{n,m}` may name.
export const MAX_PROGRAM = 4000;
const MAX_COUNT = 1000;

class Refused extends Error {}

const DIGIT: Test = (c) => c >= 48 && c <= 57;
const WORD: Test = (c) => DIGIT(c) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
const SPACE: Test = (c) => /\s/.test(String.fromCharCode(c));
const LINE_END: Test = (c) => c === 10 || c === 13 || c === 0x2028 || c === 0x2029;
const not = (t: Test): Test => (c) => !t(c);
const exactly = (code: number): Test => (c) => c === code;
const one = (code: number): Node => ({ t: "char", test: exactly(code), code });

const BACKTRACKING = "it needs a backreference or a lookaround, which only a backtracking matcher can run; search_code does not backtrack, so ask without it";

function parse(src: string): Node {
  let i = 0;
  const peek = () => src[i];
  const invalid = (why: string): never => {
    throw new Refused(`the pattern is not a valid regular expression: ${why}`);
  };
  // `{n}`, `{n,}` or `{n,m}` at i, or null when the text there is not one
  // (JavaScript then reads the brace as itself).
  const count = (): { min: number; max: number; end: number } | null => {
    const m = /^\{(\d+)(,(\d*))?\}/.exec(src.slice(i));
    if (!m) return null;
    const min = Number(m[1]);
    const max = m[2] === undefined ? min : m[3] === "" ? Infinity : Number(m[3]);
    if (min > MAX_COUNT || (max !== Infinity && max > MAX_COUNT)) throw new Refused(`a count over ${MAX_COUNT} makes the pattern too large`);
    if (max < min) invalid("numbers out of order in a {} quantifier");
    return { min, max, end: i + m[0].length };
  };
  const hex = (n: number): number => {
    const h = src.slice(i, i + n);
    if (!new RegExp(`^[0-9a-fA-F]{${n}}$`).test(h)) return -1;
    i += n;
    return parseInt(h, 16);
  };
  // One escape after the backslash, as a character test or an assertion.
  const escape = (inClass: boolean): Node => {
    const d = src[i++];
    if (d === undefined) return invalid("a backslash at the end of the pattern");
    if (d === "d") return { t: "char", test: DIGIT };
    if (d === "D") return { t: "char", test: not(DIGIT) };
    if (d === "w") return { t: "char", test: WORD };
    if (d === "W") return { t: "char", test: not(WORD) };
    if (d === "s") return { t: "char", test: SPACE };
    if (d === "S") return { t: "char", test: not(SPACE) };
    if (d === "b") return inClass ? one(8) : { t: "assert", kind: "word" };
    if (d === "B" && !inClass) return { t: "assert", kind: "notword" };
    if (/[1-9]/.test(d)) throw new Refused(BACKTRACKING);
    if (d === "k" && peek() === "<") throw new Refused(BACKTRACKING);
    if (d === "0" && !/[0-9]/.test(peek() ?? "")) return one(0);
    const simple: Record<string, number> = { t: 9, n: 10, v: 11, f: 12, r: 13 };
    if (simple[d] !== undefined) return one(simple[d]!);
    if (d === "x" || d === "u") {
      const code = hex(d === "x" ? 2 : 4);
      return one(code === -1 ? d.charCodeAt(0) : code);
    }
    if (d === "c" && /[A-Za-z]/.test(peek() ?? "")) return one(src.charCodeAt(i++) % 32);
    if (/[0-9]/.test(d)) invalid("an octal escape");
    return one(d.charCodeAt(0));
  };
  // A bracket class, from after its `[` to after its `]`.
  const klass = (): Node => {
    const negate = peek() === "^";
    if (negate) i++;
    const parts: Test[] = [];
    const item = (): { test: Test; code: number | null } => {
      if (src[i] === "\\") {
        i++;
        const e = escape(true);
        if (e.t !== "char") return invalid("an assertion inside a class");
        return { test: e.test, code: e.code ?? null };
      }
      const code = src.charCodeAt(i++);
      return { test: exactly(code), code };
    };
    for (;;) {
      if (i >= src.length) invalid("a class with no closing ]");
      if (peek() === "]") {
        i++;
        break;
      }
      const from = item();
      if (peek() === "-" && src[i + 1] !== "]" && i + 1 < src.length) {
        i++;
        const to = item();
        if (from.code === null || to.code === null) {
          parts.push(from.test, exactly(45), to.test);
          continue;
        }
        if (to.code < from.code) invalid("a range out of order in a class");
        const [a, b] = [from.code, to.code];
        parts.push((c) => c >= a && c <= b);
        continue;
      }
      parts.push(from.test);
    }
    const any: Test = (c) => parts.some((p) => p(c));
    return { t: "char", test: negate ? not(any) : any };
  };
  const atom = (): Node => {
    const c = src[i]!;
    if (c === "(") {
      i++;
      if (src.startsWith("?=", i) || src.startsWith("?!", i) || src.startsWith("?<=", i) || src.startsWith("?<!", i)) throw new Refused(BACKTRACKING);
      if (src.startsWith("?:", i)) i += 2;
      else if (src.startsWith("?<", i)) {
        const close = src.indexOf(">", i);
        if (close === -1 || !/^\?<[A-Za-z_$][\w$]*>$/.test(src.slice(i, close + 1))) invalid("a group name");
        i = close + 1;
      } else if (peek() === "?") invalid("an unknown group");
      const inner = alternation();
      if (peek() !== ")") invalid("a group with no closing )");
      i++;
      return inner;
    }
    if (c === ")") invalid("an unmatched )");
    if (c === "*" || c === "+" || c === "?") invalid("nothing to repeat");
    if (c === "{" && count() !== null) invalid("nothing to repeat");
    i++;
    if (c === "[") return klass();
    if (c === ".") return { t: "char", test: not(LINE_END) };
    if (c === "^") return { t: "assert", kind: "start" };
    if (c === "$") return { t: "assert", kind: "end" };
    if (c === "\\") return escape(false);
    return one(c.charCodeAt(0));
  };
  const quantified = (): Node => {
    const node = atom();
    let q: { min: number; max: number } | null = null;
    const c = peek();
    if (c === "*") q = { min: 0, max: Infinity };
    else if (c === "+") q = { min: 1, max: Infinity };
    else if (c === "?") q = { min: 0, max: 1 };
    if (q !== null) i++;
    else if (c === "{") {
      const n = count();
      if (n !== null) {
        q = n;
        i = n.end;
      }
    }
    if (q === null) return node;
    if (node.t === "assert") invalid("nothing to repeat");
    // A lazy quantifier matches the same lines.
    if (peek() === "?") i++;
    if (peek() === "*" || peek() === "+" || peek() === "?") invalid("nothing to repeat");
    return { t: "rep", node, min: q.min, max: q.max };
  };
  const sequence = (): Node => {
    const items: Node[] = [];
    while (i < src.length && peek() !== "|" && peek() !== ")") items.push(quantified());
    return { t: "seq", items };
  };
  const alternation = (): Node => {
    const options = [sequence()];
    while (peek() === "|") {
      i++;
      options.push(sequence());
    }
    return options.length === 1 ? options[0]! : { t: "alt", options };
  };
  const root = alternation();
  if (i < src.length) invalid("an unmatched )");
  return root;
}

function compile(root: Node): Program {
  const prog: Inst[] = [];
  const push = (inst: Inst): number => {
    if (prog.length >= MAX_PROGRAM) throw new Refused(`the pattern is too large: its matcher would pass ${MAX_PROGRAM} steps`);
    prog.push(inst);
    return prog.length - 1;
  };
  const emit = (n: Node): void => {
    if (n.t === "char") push({ op: "char", test: n.test });
    else if (n.t === "assert") push({ op: "assert", kind: n.kind });
    else if (n.t === "seq") for (const item of n.items) emit(item);
    else if (n.t === "alt") {
      const exits: number[] = [];
      n.options.forEach((option, k) => {
        if (k === n.options.length - 1) return emit(option);
        const split = push({ op: "split", a: prog.length + 1, b: -1 });
        emit(option);
        exits.push(push({ op: "jmp", to: -1 }));
        (prog[split] as { b: number }).b = prog.length;
      });
      for (const e of exits) (prog[e] as { to: number }).to = prog.length;
    } else {
      for (let k = 0; k < n.min; k++) emit(n.node);
      if (n.max === Infinity) {
        const loop = push({ op: "split", a: prog.length + 1, b: -1 });
        emit(n.node);
        push({ op: "jmp", to: loop });
        (prog[loop] as { b: number }).b = prog.length;
      } else {
        const skips: number[] = [];
        for (let k = n.min; k < n.max; k++) {
          skips.push(push({ op: "split", a: prog.length + 1, b: -1 }));
          emit(n.node);
        }
        for (const s of skips) (prog[s] as { b: number }).b = prog.length;
      }
    }
  };
  emit(root);
  push({ op: "match" });
  return prog;
}

// The pattern compiled, or the plain reason it is refused.
export function compilePattern(src: string): { program: Program } | { refused: string } {
  try {
    return { program: compile(parse(src)) };
  } catch (error) {
    if (error instanceof Refused) return { refused: error.message };
    throw error;
  }
}

// Whether the pattern matches anywhere in `line`, by stepping every live
// state of the automaton one character at a time. `budget.steps` is the work
// left for the caller's whole search: each state visited takes one, and the
// answer is null once it runs out.
export function matchesLine(prog: Program, line: string, budget?: { steps: number }): boolean | null {
  const n = prog.length;
  const mark = new Uint32Array(n);
  let gen = 1;
  let matched = false;
  const word = (pos: number) => pos >= 0 && pos < line.length && WORD(line.charCodeAt(pos));
  const holds = (kind: Assertion, pos: number): boolean => {
    if (kind === "start") return pos === 0;
    if (kind === "end") return pos === line.length;
    const edge = word(pos - 1) !== word(pos);
    return kind === "word" ? edge : !edge;
  };
  // Adds the thread at `pc`, following jumps, splits and assertions at
  // position `pos`; each step is added once per position.
  const add = (list: number[], start: number, pos: number): void => {
    const stack = [start];
    while (stack.length > 0) {
      const pc = stack.pop()!;
      work++;
      if (mark[pc] === gen) continue;
      mark[pc] = gen;
      const inst = prog[pc]!;
      if (inst.op === "jmp") stack.push(inst.to);
      else if (inst.op === "split") stack.push(inst.b, inst.a);
      else if (inst.op === "assert") {
        if (holds(inst.kind, pos)) stack.push(pc + 1);
      } else if (inst.op === "match") matched = true;
      else list.push(pc);
    }
  };
  let work = 0;
  let current: number[] = [];
  add(current, 0, 0);
  for (let i = 0; ; i++) {
    if (budget) {
      budget.steps -= work + current.length;
      work = 0;
      if (budget.steps < 0) return null;
    }
    if (matched) return true;
    if (i === line.length) return false;
    const c = line.charCodeAt(i);
    gen++;
    const next: number[] = [];
    for (const pc of current) {
      const inst = prog[pc] as { op: "char"; test: Test };
      if (inst.test(c)) add(next, pc + 1, i + 1);
    }
    // Unanchored: a match may also start at the next position.
    add(next, 0, i + 1);
    current = next;
  }
}

// A file glob as a matcher over whole paths: `*` any characters but `/`,
// `**` any characters, `?` one character but `/`, everything else itself
// (the meaning core's matchesGlob gives a glob). Brace lists are refused:
// they multiply what one glob asks for.
export function compileGlob(glob: string): { program: Program } | { refused: string } {
  if (/[{}]/.test(glob)) return { refused: "a glob with a brace list ({a,b}) is not supported; ask with one glob per call" };
  let src = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*") {
      src += "[\\s\\S]*";
      i++;
    } else if (c === "*") src += "[^/]*";
    else if (c === "?") src += "[^/]";
    else src += c.replace(/[\\^$.|?*+()[\]{}]/g, "\\$&");
  }
  return compilePattern(`${src}$`);
}
