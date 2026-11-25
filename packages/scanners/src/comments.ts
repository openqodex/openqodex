// Where the comments are in a source file, so a suppression marker counts
// only where its scanner reads it: `# nosec` in a Python comment silences
// bandit, the same text inside a string does not. One small tokenizer per
// comment family, never a parser: each skips the strings of its languages
// (one-line, multi-line and heredoc bodies) and returns every comment with
// its offset.
//
// Three rules keep a reader from hiding a marker it should see:
// - An opener left open at the end of the file (a string, a heredoc, a
//   template, a raw string, a block comment) is read as code, so whatever
//   follows it is still read. A false candidate costs a reviewer one drop;
//   a missed one hides a finding.
// - Each kind of closer is searched for to the end of the file at most once:
//   when it is not found from one point, no later opener of that kind is
//   searched for again (`Reader.open`). This keeps every reader linear.
// - Nesting deeper than MAX_DEPTH ($( ) in $( ), f-string fields, Ruby #{ })
//   is read as plain code instead of recursing.

export type Family = "python" | "shell" | "dockerfile" | "ruby" | "js" | "go" | "yaml" | "sql" | "hcl";

// `start` is the offset of the comment's opener in the file; `text` runs from
// the opener to the end of the comment (the line end for a line comment,
// without a carriage return).
export type Comment = { start: number; text: string };

export function comments(text: string, family: Family): Comment[] {
  return read(text, family).out;
}

// How many characters the searches for closers covered while reading `text`:
// each search from its opener to its closer, or to the end of the file when
// there is none. The second rule above keeps it in proportion to the file;
// a reader that searched again from every later opener of a kind left open
// would cover the rest of the file once per opener. For the tests.
export function closerSearchSpan(text: string, family: Family): number {
  return read(text, family).searched;
}

function read(text: string, family: Family): Reader {
  const r = new Reader(text);
  switch (family) {
    case "python":
      pythonComments(r);
      break;
    case "shell":
      shellCode(r, 0, null, 0);
      break;
    case "dockerfile":
      dockerfileComments(r);
      break;
    case "ruby":
      rubyComments(r);
      break;
    case "js":
    case "go":
      slashComments(r, family);
      break;
    case "yaml":
      yamlComments(r);
      break;
    case "sql":
      sqlComments(r);
      break;
    case "hcl":
      hclCode(r, 0, false, 0);
      break;
  }
  return r;
}

const MAX_DEPTH = 64;

// The length recorded for a line whose key is longer than MAX_WORD.
const NO_KEY = 0xffff;

// A 32-bit FNV-1a hash of s[from, to), by UTF-16 code unit.
function keyHash(s: string, from: number, to: number): number {
  let h = 0x811c9dc5;
  for (let i = from; i < to; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h;
}

// The longest heredoc end word looked up. A longer word is never found, so
// its heredoc is read as code.
const MAX_WORD = 1024;

class Reader {
  readonly out: Comment[] = [];
  // The characters every search for a closer covered (closerSearchSpan).
  searched = 0;
  // For each kind of closer, the earliest offset from which a search for it
  // reached the end of the file.
  private readonly unclosed = new Map<string, number>();
  // The offset of every line start, built once.
  private starts: number[] | null = null;
  // For each heredoc end rule (indent, trailing blanks): each line's key,
  // its text read by that rule, as its offset and length by line number
  // (typed arrays, a length past MAX_WORD as NO_KEY), and an index from a
  // 32-bit hash of the key to the line's number, or to the numbers in file
  // order when several lines share the hash. Small numbers, not the lines'
  // text, key the map and fill it: a map of hundreds of thousands of
  // distinct strings, or of numbers too large to store inline, costs more
  // per line as it grows, and a file of distinct heredoc words made one.
  private readonly lines = new Map<string, { index: Map<number, number | number[]>; keyFrom: Uint32Array; keyLength: Uint16Array }>();
  // For each list of starts that share a hash, the words looked up in it:
  // the list index a lookup started from, and the index of the first line
  // at or after it that is the word (-1: none to the end). The reader moves
  // forward, so each line of a list is compared with a word once.
  private readonly scanned = new Map<number[], { word: string; from: number; match: number }[]>();
  constructor(readonly s: string) {}

  private lineStarts(): number[] {
    if (this.starts === null) {
      this.starts = [0];
      for (let i = this.s.indexOf("\n"); i >= 0; i = this.s.indexOf("\n", i + 1)) this.starts.push(i + 1);
    }
    return this.starts;
  }

  // The index in `starts` of the first line start at or after `i`.
  private firstAtOrAfter(starts: number[], i: number): number {
    let lo = 0;
    let hi = starts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((starts[mid] as number) < i) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  // The offset of the line end (the newline, or the end of the file) of the
  // line holding `i`, by lookup.
  eol(i: number): number {
    const starts = this.lineStarts();
    const next = this.firstAtOrAfter(starts, i + 1);
    return next < starts.length ? (starts[next] as number) - 1 : this.s.length;
  }

  // The key of the line that starts at `start` by a heredoc end rule: the
  // line without its `\r`, its indent (tabs, or tabs and blanks) and, with
  // `trailing`, its trailing blanks, as [from, to).
  private keyOf(start: number, indent: Heredoc["indent"], trailing: boolean): [number, number] {
    const s = this.s;
    let end = s.indexOf("\n", start);
    if (end < 0) end = s.length;
    if (end > start && s.charCodeAt(end - 1) === 13) end--;
    let from = start;
    if (indent === "tabs") while (from < end && s.charCodeAt(from) === 9) from++;
    else if (indent === "blanks") while (from < end && (s.charCodeAt(from) === 9 || s.charCodeAt(from) === 32)) from++;
    let to = end;
    if (trailing) while (to > from && (s.charCodeAt(to - 1) === 9 || s.charCodeAt(to - 1) === 32)) to--;
    return [from, to];
  }

  // The offset past the first line at or after `from` that reads `word` once
  // `h.indent` is removed (and, with `h.trailing`, trailing blanks), or -1
  // with none. The lines are indexed once per rule, by the hash of their
  // key. A line found by the hash is the end only when, in this order, its
  // key's length is the word's (one number read by line number) and its
  // text is the word (a compare of at most the word's length); a line whose
  // key only shares the hash is passed over, however many there are, as the
  // scanner passes over them. Each line that shares a hash is checked
  // against a given word once in a forward read (scanned), so a file of
  // lines crafted to share one hash costs time in proportion to its size.
  closer(h: Heredoc, from: number): number {
    const word = h.word;
    if (word.length > MAX_WORD) return -1;
    const rule = `${h.indent}\0${h.trailing}`;
    const starts = this.lineStarts();
    let built = this.lines.get(rule);
    if (built === undefined) {
      const index = new Map<number, number | number[]>();
      const keyFrom = new Uint32Array(starts.length);
      const keyLength = new Uint16Array(starts.length);
      for (let line = 0; line < starts.length; line++) {
        const [a, b] = this.keyOf(starts[line] as number, h.indent, h.trailing);
        keyFrom[line] = a;
        if (b - a > MAX_WORD) {
          keyLength[line] = NO_KEY;
          continue;
        }
        keyLength[line] = b - a;
        const key = keyHash(this.s, a, b);
        const at = index.get(key);
        if (at === undefined) index.set(key, line);
        else if (typeof at === "number") index.set(key, [at, line]);
        else at.push(line);
      }
      built = { index, keyFrom, keyLength };
      this.lines.set(rule, built);
    }
    const { keyFrom, keyLength } = built;
    const found = built.index.get(keyHash(word, 0, word.length));
    if (found === undefined) return -1;
    // The length first, then the text.
    const isWord = (line: number): boolean => keyLength[line] === word.length && this.s.startsWith(word, keyFrom[line] as number);
    const end = (line: number): number => this.eol(starts[line] as number) + 1;
    // The first line that starts at or after `from`.
    const first = this.firstAtOrAfter(starts, from);
    if (typeof found === "number") return found >= first && isWord(found) ? end(found) : -1;
    const k = this.firstAtOrAfter(found, first);
    let memos = this.scanned.get(found);
    if (memos === undefined) {
      memos = [];
      this.scanned.set(found, memos);
    }
    let memo = memos.find((m) => m.word === word);
    // What an earlier lookup from no later a line already knows: no line of
    // the word in [memo.from, memo.match), and the word at memo.match.
    if (memo !== undefined && memo.from <= k && (memo.match < 0 || memo.match >= k)) {
      memo.from = k;
      return memo.match < 0 ? -1 : end(found[memo.match] as number);
    }
    let match = -1;
    for (let j = k; j < found.length; j++) {
      if (isWord(found[j] as number)) {
        match = j;
        break;
      }
    }
    if (memo === undefined) {
      memo = { word, from: k, match };
      memos.push(memo);
    } else {
      memo.from = k;
      memo.match = match;
    }
    return match < 0 ? -1 : end(found[match] as number);
  }

  // Runs `find` (a search for a closer from `from`, returning the offset past
  // it or -1 at the end of the file) unless a search of the same `kind`
  // already failed from an earlier offset. -1 means the opener is left open:
  // the caller reads it as code. A memo that is wrong only ever makes an
  // opener read as code, which can add a candidate, never hide one.
  open(kind: string, from: number, find: () => number): number {
    const failed = this.unclosed.get(kind);
    if (failed !== undefined && from >= failed) return -1;
    const end = find();
    this.searched += (end < 0 ? this.s.length : end) - from;
    if (end < 0 && (failed === undefined || from < failed)) this.unclosed.set(kind, from);
    return end;
  }

  // A line comment from the first `opener` in [from, to), when there is one:
  // for text the reader skipped but may have read wrongly.
  commentIn(from: number, to: number, opener: string): void {
    const at = this.s.slice(from, to + opener.length - 1).indexOf(opener);
    if (at >= 0) this.lineComment(from + at);
  }

  lineComment(i: number): number {
    const end = lineEnd(this.s, i);
    const text = this.s.slice(i, end);
    this.out.push({ start: i, text: text.endsWith("\r") ? text.slice(0, -1) : text });
    return end;
  }
}

function lineEnd(s: string, i: number): number {
  const n = s.indexOf("\n", i);
  return n < 0 ? s.length : n;
}

// The offset just past the closing `close` of a string whose body starts at
// `i`. `escapes`: a backslash hides the next character. A one-line string
// (not `multiline`) ends at the line end, as the languages' lexers end it. A
// multi-line one with no closer returns -1.
function skipString(s: string, i: number, close: string, escapes: boolean, multiline: boolean): number {
  while (i < s.length) {
    const c = s[i];
    if (escapes && c === "\\") {
      i += 2;
      continue;
    }
    if (!multiline && c === "\n") return i;
    if (s.startsWith(close, i)) return i + close.length;
    i++;
  }
  return multiline ? -1 : s.length;
}

// Python: `#` comments; '...' and "..." strings, and their triple-quoted
// forms, which span lines. A prefix (r, b, u) is just letters before them.
// An f-string (or t-string) holds code in its `{...}` fields, and from
// Python 3.12 a field may span lines and hold a comment, which ruff and a
// bandit on 3.12 read.
function pythonComments(r: Reader): void {
  const s = r.s;
  let i = 0;
  while (i < s.length) {
    const c = s[i] as string;
    if (c === "#") {
      i = r.lineComment(i);
    } else if (c === '"' || c === "'") {
      const close = s.startsWith(c.repeat(3), i) ? c.repeat(3) : c;
      const prefix = /(?:^|[^\w])([A-Za-z]{1,2})$/.exec(s.slice(Math.max(0, i - 3), i))?.[1] ?? "";
      const body = i + close.length;
      const fstring = /^[rRbBuU]?[fFtT][rR]?$/.test(prefix);
      const end = r.open(`${fstring ? "f" : ""}${close}`, i, () => (fstring ? skipFString(r, body, close, 0) : skipString(s, body, close, true, close.length === 3)));
      i = end < 0 ? i + 1 : end;
    } else if (c === "\\") {
      i += 2;
    } else {
      i++;
    }
  }
}

// The offset past an f-string whose body starts at `i`, or -1 when a
// triple-quoted one, or any field, has no closer before the end of the
// file. Comments in its fields go to the reader.
function skipFString(r: Reader, i: number, close: string, depth: number): number {
  const s = r.s;
  while (i < s.length) {
    const c = s[i];
    if (c === "\\") {
      i += 2;
    } else if (close.length === 1 && c === "\n") {
      return i;
    } else if (s.startsWith(close, i)) {
      return i + close.length;
    } else if (c === "{" && s[i + 1] === "{") {
      i += 2;
    } else if (c === "{" && depth < MAX_DEPTH) {
      i = skipField(r, i + 1, depth + 1);
      if (i < 0) return -1;
    } else {
      i++;
    }
  }
  return close.length === 1 ? s.length : -1;
}

// The offset past an f-string field whose code starts at `i`: the
// expression, where `#` opens a comment, then the conversion and format
// spec after a top-level `!` or `:`, where `#` is text (`{n:#x}`). -1 when
// the field has no `}` before the end of the file, so the caller reads the
// f-string as code and a format spec never swallows the rest of the file.
function skipField(r: Reader, i: number, depth: number): number {
  const s = r.s;
  let nesting = 0;
  let spec = false;
  while (i < s.length) {
    const c = s[i] as string;
    if (c === "}" && nesting === 0) return i + 1;
    if (spec) {
      i = c === "{" && depth < MAX_DEPTH ? skipField(r, i + 1, depth + 1) : i + 1;
      if (i < 0) return -1;
    } else if (c === "#") {
      i = r.lineComment(i);
    } else if (c === '"' || c === "'") {
      const close = s.startsWith(c.repeat(3), i) ? c.repeat(3) : c;
      const end = r.open(close, i, () => skipString(s, i + close.length, close, true, close.length === 3));
      i = end < 0 ? i + 1 : end;
    } else {
      if ("([{".includes(c)) nesting++;
      else if (")]}".includes(c)) nesting--;
      else if (nesting === 0 && (c === ":" || (c === "!" && s[i + 1] !== "="))) spec = true;
      i++;
    }
  }
  return -1;
}

// `indent`: what may come before the closing word on its line (shell and
// Dockerfile `<<-`: tabs; Ruby `<<~` and `<<-`: any blanks). `trailing`:
// blanks may follow it (shellcheck accepts them). `expands`: a shell heredoc
// whose word is not quoted runs the $( ) and backticks in its body.
type Heredoc = { word: string; indent: "none" | "tabs" | "blanks"; trailing: boolean; expands: boolean };

// The offset after the bodies of the heredocs opened on the line that ended
// just before `i`, read in order: each runs to a line that is exactly its
// word. -1 when one has no such line: the caller reads the bodies as code.
// `body` reads the body of an expanding heredoc and returns how far it read;
// when its code ran past the body's end line, the caller continues from
// there, so no later level reads that text again.
function skipHeredocs(r: Reader, i: number, pending: Heredoc[], body?: (from: number, to: number) => number): number {
  for (const h of pending) {
    const end = r.closer(h, i);
    if (end < 0) return -1;
    if (h.expands && body) {
      const reached = body(i, end);
      if (reached > end) return Math.min(reached, r.s.length);
    }
    i = end;
  }
  return Math.min(i, r.s.length);
}

// The end word of a shell heredoc at `j`, after `<<` or `<<-` and its
// blanks, as shellcheck reads it (its `unquote`): the word runs to an
// unquoted blank or operator, never past the line end `eol`, with `\"`,
// `\\`, `\$` and a backslashed backtick escaped inside double quotes. A word
// wrapped in one pair of matching quotes gives its inner text as written,
// escapes kept (`"E\"OF"` ends at `E\"OF`); any other word with a backslash
// loses every backslash; the rest is taken as written (`E"O"F`). A quoted
// word turns off expansion in the body. Null for an empty word, an unclosed
// quote or a word longer than MAX_WORD.
function shellWord(s: string, j: number, eol: number): { word: string; quoted: boolean; next: number } | null {
  const start = j;
  while (j < eol && !/[\s;&|()<>]/.test(s[j] as string)) {
    const c = s[j] as string;
    if (c === "\\") {
      j += 2;
    } else if (c === "'") {
      const close = s.slice(j + 1, eol).indexOf("'");
      if (close < 0) return null;
      j += close + 2;
    } else if (c === '"') {
      j++;
      while (j < eol && s[j] !== '"') j += s[j] === "\\" && /["\\$`]/.test(s[j + 1] ?? "") ? 2 : 1;
      if (j >= eol) return null;
      j++;
    } else {
      j++;
    }
    if (j - start > MAX_WORD + 2) return null;
  }
  const raw = s.slice(start, Math.min(j, eol));
  if (raw === "") return null;
  const first = raw[0] as string;
  if (raw.length >= 2 && (first === '"' || first === "'") && raw.endsWith(first)) return { word: raw.slice(1, -1), quoted: true, next: j };
  if (raw.includes("\\")) return { word: raw.replace(/\\/g, ""), quoted: true, next: j };
  return { word: raw, quoted: false, next: j };
}

// The heredoc a `<<` at `i` opens in shell, or null for `<<<` or no word.
function shellHeredoc(r: Reader, i: number): { heredoc: Heredoc; next: number } | null {
  const s = r.s;
  if (!s.startsWith("<<", i) || s[i + 2] === "<") return null;
  let j = i + 2;
  const dash = s[j] === "-";
  if (dash) j++;
  while (s[j] === " " || s[j] === "\t") j++;
  // A word that starts with a digit is far more often a shift in $(( ))
  // than a heredoc; reading it as code can only add a candidate.
  if (!/[A-Za-z_'"\\]/.test(s[j] ?? "")) return null;
  const w = shellWord(s, j, r.eol(j));
  if (!w) return null;
  return { heredoc: { word: w.word, indent: dash ? "tabs" : "none", trailing: true, expands: !w.quoted }, next: w.next };
}

// Shell code from `i`: a `#` that starts a word (at a line start, after a
// blank or an operator) opens a comment; `$#`, `${#x}` and `a#b` do not.
// Single quotes have no escapes; double quotes and $'...' do; all three span
// lines. Code inside $( ) and backticks is code again, also inside double
// quotes and in the body of a heredoc whose word is not quoted; shellcheck
// reads its comments. The rest of a heredoc body is data. With `close`, the
// code of a $( ) or of backticks: returns the offset past its closing `)` or
// backtick, or the end of the file.
function shellCode(r: Reader, i: number, close: ")" | "`" | null, depth: number): number {
  const s = r.s;
  let pending: Heredoc[] = [];
  let nesting = 0;
  while (i < s.length) {
    const c = s[i] as string;
    if (c === close && nesting === 0) return i + 1;
    if (c === "\n") {
      i++;
      if (pending.length > 0) {
        const end = skipHeredocs(r, i, pending, (from, to) => shellExpansions(r, from, to, depth));
        if (end >= 0) i = end;
        pending = [];
      }
    } else if (c === "#" && (i === 0 || /[\s;&|()<>`]/.test(s[i - 1] as string))) {
      i = r.lineComment(i);
    } else if (c === "\\") {
      i += 2;
    } else if (c === "'") {
      const end = r.open("'", i, () => skipString(s, i + 1, "'", false, true));
      i = end < 0 ? i + 1 : end;
    } else if (c === "$" && s[i + 1] === "'") {
      const end = r.open("$'", i, () => skipString(s, i + 2, "'", true, true));
      i = end < 0 ? i + 2 : end;
    } else if (c === "$" && s[i + 1] === "(" && depth < MAX_DEPTH) {
      i = shellCode(r, i + 2, ")", depth + 1);
    } else if (c === "`" && close !== "`" && depth < MAX_DEPTH) {
      i = shellCode(r, i + 1, "`", depth + 1);
    } else if (c === '"') {
      const end = r.open('"', i, () => shellDouble(r, i + 1, depth));
      i = end < 0 ? i + 1 : end;
    } else if (c === "<" && s[i + 1] === "<") {
      const h = shellHeredoc(r, i);
      if (h) pending.push(h.heredoc);
      i = h ? h.next : i + 2;
    } else {
      if (close === ")" && c === "(") nesting++;
      if (close === ")" && c === ")") nesting--;
      i++;
    }
  }
  return i;
}

// The offset past a double-quoted shell string whose body starts at `i`, or
// -1 with no closing quote. When a $( ) or backticks inside it run to the
// end of the file, that code has already read the rest of the file, so the
// string ends there instead of being read again.
function shellDouble(r: Reader, i: number, depth: number): number {
  const s = r.s;
  while (i < s.length) {
    const c = s[i];
    if (c === "\\") {
      i += 2;
    } else if (c === '"') {
      return i + 1;
    } else if ((c === "$" && s[i + 1] === "(") || c === "`") {
      if (depth >= MAX_DEPTH) {
        i++;
        continue;
      }
      i = c === "`" ? shellCode(r, i + 1, "`", depth + 1) : shellCode(r, i + 2, ")", depth + 1);
      if (i >= s.length) return s.length;
    } else {
      i++;
    }
  }
  return -1;
}

// Reads the $( ) and backticks in the body of an expanding heredoc, from
// `from` to `to`; the rest of the body is data. Returns how far it read,
// which is past `to` when a $( ) or backticks ran past the body.
function shellExpansions(r: Reader, from: number, to: number, depth: number): number {
  const s = r.s;
  let j = from;
  while (j < to) {
    if (s[j] === "\\") j += 2;
    else if (s[j] === "$" && s[j + 1] === "(" && depth < MAX_DEPTH) j = shellCode(r, j + 2, ")", depth + 1);
    else if (s[j] === "`" && depth < MAX_DEPTH) j = shellCode(r, j + 1, "`", depth + 1);
    else j++;
  }
  return j;
}

// The Dockerfile instructions that take a heredoc (BuildKit).
const HEREDOC_INSTRUCTIONS = new Set(["RUN", "COPY", "ADD"]);

// Dockerfile: a comment is a line whose first character that is not a blank
// is `#`; a `#` later in an instruction belongs to the instruction. A heredoc
// opens only in RUN, COPY and ADD, in a word that starts with `<<` (after an
// optional file number), as BuildKit reads it; its body starts after the
// instruction's last continued line and is data.
function dockerfileComments(r: Reader): void {
  const s = r.s;
  let keyword = "";
  let continued = false;
  let pending: Heredoc[] = [];
  let i = 0;
  while (i < s.length) {
    const start = i;
    const end = lineEnd(s, i);
    const line = s.slice(i, end).replace(/\r$/, "");
    const indent = line.length - line.trimStart().length;
    i = end + 1;
    if (line[indent] === "#") {
      r.lineComment(start + indent);
      continue;
    }
    if (line.trim() === "") continue;
    if (!continued) keyword = (/^\s*([A-Za-z]+)/.exec(line)?.[1] ?? "").toUpperCase();
    continued = /\\\s*$/.test(line);
    if (HEREDOC_INSTRUCTIONS.has(keyword) && !/^\s*[A-Za-z]+\s+\[/.test(line)) {
      for (const m of line.matchAll(/(?:^|\s)\d*<<(-?)(\S+)/g)) {
        if ((m[2] as string).startsWith("<")) continue;
        const word = (m[2] as string).replace(/["'\\]/g, "");
        if (word !== "") pending.push({ word, indent: m[1] === "-" ? "tabs" : "none", trailing: false, expands: false });
      }
    }
    if (!continued && pending.length > 0) {
      const after = skipHeredocs(r, i, pending);
      if (after >= 0) i = after;
      pending = [];
    }
  }
}

// Words after which a `/` starts a regular expression.
const JS_REGEX_WORDS = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"]);
const RUBY_REGEX_WORDS = new Set(["return", "if", "elsif", "unless", "when", "while", "until", "and", "or", "not", "then", "do", "else"]);

// A `/` starts a regular expression, not a division, after an operator, an
// opening bracket, one of `words` such as `return`, or at the start of the file.
function regexMayStart(prev: string, word: string, words: ReadonlySet<string>): boolean {
  if (word !== "") return words.has(word);
  return prev === "" || "(,=:[!&|?{};+-*%<>~^".includes(prev);
}

// The offset past a regular expression literal whose body starts at `i`, on
// one line; a `/` inside a character class does not end it.
function skipRegex(s: string, i: number): number {
  let inClass = false;
  while (i < s.length && s[i] !== "\n") {
    const c = s[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) return i + 1;
    i++;
  }
  return i;
}

// After a template literal's text from `i`: the offset past the closing
// backtick (`opened` false) or past a `${` (`opened` true), or -1 with
// neither before the end of the file.
function skipTemplate(s: string, i: number): { next: number; opened: boolean } {
  while (i < s.length) {
    const c = s[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "`") return { next: i + 1, opened: false };
    if (c === "$" && s[i + 1] === "{") return { next: i + 2, opened: true };
    i++;
  }
  return { next: -1, opened: false };
}

// Words whose `( ... )` ends a statement head, so a `/` after it starts a
// regular expression: `if (a) /x/.test(b)`.
const JS_HEAD_WORDS = new Set(["if", "while", "for", "with"]);

// JavaScript, TypeScript and Go: `//` and `/* */` comments. Both have
// one-line '...' and "..." strings (a rune in Go). A backtick opens a raw
// string in Go and a template literal in JavaScript, whose `${...}` holds
// code again (with its own strings and comments). JavaScript also has
// regular expression literals.
function slashComments(r: Reader, dialect: "js" | "go"): void {
  const s = r.s;
  // The brace depth inside each open `${...}` of a template literal.
  const templates: number[] = [];
  // For each open `(`: whether it follows if, while, for or with.
  const parens: boolean[] = [];
  let prev = "";
  let word = "";
  // A `#!` line at the very start is not code.
  let i = s.startsWith("#!") ? lineEnd(s, 0) : 0;
  // Reads a template's text from `from`; with no end, the backtick or `}`
  // before `from` is read as code.
  const template = (from: number) => {
    let opened = false;
    const end = r.open("`", from, () => {
      const t = skipTemplate(s, from);
      opened = t.opened;
      return t.next;
    });
    if (end >= 0 && opened) templates.push(0);
    i = end < 0 ? from : end;
    prev = end >= 0 && opened ? "{" : "a";
    word = "";
  };
  while (i < s.length) {
    const c = s[i] as string;
    if (/\s/.test(c)) {
      i++;
    } else if (s.startsWith("//", i)) {
      i = r.lineComment(i);
    } else if (s.startsWith("/*", i)) {
      const end = r.open("*/", i, () => {
        const close = s.indexOf("*/", i + 2);
        return close < 0 ? -1 : close + 2;
      });
      if (end < 0) {
        i += 2;
      } else {
        r.out.push({ start: i, text: s.slice(i, end) });
        i = end;
      }
    } else if (c === '"' || c === "'") {
      i = skipString(s, i + 1, c, true, false);
      prev = "a";
      word = "";
    } else if (c === "`") {
      if (dialect === "go") {
        const end = r.open("`", i, () => skipString(s, i + 1, "`", false, true));
        i = end < 0 ? i + 1 : end;
        prev = "a";
        word = "";
      } else {
        template(i + 1);
      }
    } else if (c === "/" && dialect === "js" && regexMayStart(prev, word, JS_REGEX_WORDS)) {
      const end = skipRegex(s, i + 1);
      // After a `}` the slash may be a division (`} / 2`), so a `//` in the
      // skipped text is also read as a comment.
      if (prev === "}") r.commentIn(i + 1, end, "//");
      i = end;
      prev = "a";
      word = "";
    } else if (/[\w$]/.test(c)) {
      const m = /^[\w$]+/.exec(s.slice(i, i + 256)) as RegExpExecArray;
      word = /^\d/.test(m[0]) ? "" : m[0];
      prev = "a";
      i += m[0].length;
    } else if (c === "}" && templates.length > 0 && templates[templates.length - 1] === 0) {
      templates.pop();
      template(i + 1);
    } else if ((c === "+" || c === "-") && s[i + 1] === c) {
      // A postfix ++ or -- ends an operand (`a++ / b`); a prefix one does not.
      prev = prev === "a" || prev === ")" || prev === "]" ? "a" : c;
      word = "";
      i += 2;
    } else {
      const top = templates.length - 1;
      if (top >= 0 && (c === "{" || c === "}")) templates[top] = (templates[top] ?? 0) + (c === "{" ? 1 : -1);
      if (c === "(") parens.push(JS_HEAD_WORDS.has(word));
      // The `)` closing an if, while, for or with head is followed by a statement.
      prev = c === ")" && parens.pop() === true ? "(" : c;
      word = "";
      i++;
    }
  }
}

const PAIRS: Record<string, string> = { "(": ")", "[": "]", "{": "}", "<": ">" };

// The offset past a %-literal (%q(...), %w[...], %r{...}) whose delimiter is
// at `i`, counting nested brackets of the same kind; -1 with no closer.
function skipPercent(s: string, i: number): number {
  const open = s[i] as string;
  const close = PAIRS[open] ?? open;
  let nesting = 0;
  for (let j = i + 1; j < s.length; j++) {
    const c = s[j];
    if (c === "\\") {
      j++;
    } else if (c === close && open !== close && nesting > 0) {
      nesting--;
    } else if (c === close) {
      return j + 1;
    } else if (c === open && open !== close) {
      nesting++;
    }
  }
  return -1;
}

// The offset past a Ruby double-quoted or backtick string whose body starts
// at `i`, or -1 with no closer. Its `#{...}` holds code, which may hold its
// own strings.
function skipRubyString(r: Reader, i: number, close: string, depth: number): number {
  const s = r.s;
  while (i < s.length) {
    const c = s[i];
    if (c === "\\") {
      i += 2;
    } else if (c === close) {
      return i + 1;
    } else if (c === "#" && s[i + 1] === "{") {
      let nesting = 1;
      i += 2;
      while (i < s.length && nesting > 0) {
        const d = s[i] as string;
        if ((d === '"' || d === "`") && depth < MAX_DEPTH) {
          const end = skipRubyString(r, i + 1, d, depth + 1);
          i = end < 0 ? s.length : end;
        } else if (d === "'") {
          const end = skipString(s, i + 1, "'", true, true);
          i = end < 0 ? s.length : end;
        } else {
          if (d === "{") nesting++;
          else if (d === "}") nesting--;
          i++;
        }
      }
    } else {
      i++;
    }
  }
  return -1;
}

const RUBY_HEREDOC = /^<<([~-]?)(?:(["'`])([^"'`\n]+)\2|([A-Za-z_]\w*))/;

// The offset past the `=end` line of an =begin block whose line starts at
// `i`, or -1 with none.
function skipEmbedded(s: string, i: number): number {
  for (let j = s.indexOf("\n=end", i); j >= 0; j = s.indexOf("\n=end", j + 1)) {
    const next = s[j + 5];
    if (next === undefined || /\s/.test(next)) return lineEnd(s, j + 1);
  }
  return -1;
}

// Ruby: `#` comments and =begin/=end blocks. Strings: '...', "..." and
// backticks (with #{...}), %-literals, heredocs (<<~ID, <<-ID, <<ID with an
// upper-case or quoted ID; their bodies are data), ?x character literals and
// regular expression literals where an operand may start.
function rubyComments(r: Reader): void {
  const s = r.s;
  let pending: Heredoc[] = [];
  let prev = "";
  let word = "";
  let i = 0;
  const literal = (end: number, opener: number) => {
    i = end < 0 ? opener : end;
    prev = "a";
    word = "";
  };
  while (i < s.length) {
    const c = s[i] as string;
    const lineStart = i === 0 || s[i - 1] === "\n";
    if (c === "\n") {
      i++;
      if (pending.length > 0) {
        const end = skipHeredocs(r, i, pending);
        if (end >= 0) i = end;
        pending = [];
      }
    } else if (lineStart && /^=begin(\s|$)/.test(s.slice(i, i + 7))) {
      const end = r.open("=end", i, () => skipEmbedded(s, i));
      if (end < 0) {
        i = r.lineComment(i);
      } else {
        r.out.push({ start: i, text: s.slice(i, end) });
        i = end;
      }
    } else if (/\s/.test(c)) {
      i++;
    } else if (c === "#") {
      i = r.lineComment(i);
    } else if (c === "\\") {
      i += 2;
    } else if (c === "'") {
      literal(r.open("'", i, () => skipString(s, i + 1, "'", true, true)), i + 1);
    } else if (c === '"' || c === "`") {
      literal(r.open(c, i, () => skipRubyString(r, i + 1, c, 0)), i + 1);
    } else if (c === "$" && /["'`]/.test(s[i + 1] ?? "")) {
      literal(i + 2, i + 2);
    } else if (c === "?" && prev !== "a" && /\S/.test(s[i + 1] ?? " ") && !/\w/.test(s[i + 2] ?? "")) {
      literal(i + 2, i + 2);
    } else if (c === "%" && /^%[qQwWiIrsx]?[^\w\s]/.test(s.slice(i, i + 3)) && (prev !== "a" || /[qQwWiIrsx]/.test(s[i + 1] as string))) {
      const at = /[qQwWiIrsx]/.test(s[i + 1] as string) ? i + 2 : i + 1;
      literal(r.open(`%${s[at]}`, i, () => skipPercent(s, at)), i + 1);
    } else if (c === "<" && RUBY_HEREDOC.test(s.slice(i, i + 200))) {
      const m = RUBY_HEREDOC.exec(s.slice(i, i + 200)) as RegExpExecArray;
      const flag = m[1] as string;
      const id = (m[3] ?? m[4]) as string;
      if (flag === "" && m[2] === undefined && !/^[A-Z]/.test(id)) {
        prev = "<";
        i += 2;
      } else {
        pending.push({ word: id, indent: flag === "" ? "none" : "blanks", trailing: false, expands: false });
        i += m[0].length;
        prev = "a";
      }
      word = "";
    } else if (c === "/" && regexMayStart(prev, word, RUBY_REGEX_WORDS)) {
      literal(skipRegex(s, i + 1), i + 1);
    } else if (c === "/" && word !== "" && /\s/.test(s[i - 1] ?? "") && !/[\s=]/.test(s[i + 1] ?? " ")) {
      // A method name, a blank, then `/` and no blank (`split /,/`) starts a
      // regular expression argument, as Ruby reads it. When the name is a
      // local variable it is a division (`total /2`), so a `#` in the
      // skipped text is also read as a comment.
      const end = skipRegex(s, i + 1);
      r.commentIn(i + 1, end, "#");
      literal(end, i + 1);
    } else if (/\w/.test(c)) {
      const m = /^\w+[?!]?/.exec(s.slice(i, i + 256)) as RegExpExecArray;
      word = /^\d/.test(m[0]) ? "" : m[0];
      prev = "a";
      i += m[0].length;
    } else {
      prev = c;
      word = "";
      i++;
    }
  }
}

// YAML: `#` opens a comment at a line start or after a blank, outside a
// quoted scalar and a block scalar's body. A quote opens a quoted scalar
// only where a scalar starts: after the indentation and any `- `, `? ` or
// `--- `, after a `: ` (or a colon at the line end), after an anchor or a
// tag, and after `[`, `{` or `,` in a flow collection. Anywhere else it is
// text of a plain scalar (`run: echo it's`). '...' doubles a quote to
// escape it, "..." takes backslash escapes, and both may span lines. A
// block scalar (`|` or `>` with its chomping and indentation indicators,
// where a scalar starts) holds every following line that is blank or
// indented deeper than the key or `-` that holds it.
function yamlComments(r: Reader): void {
  const s = r.s;
  const blankOrEnd = (k: number): boolean => k >= s.length || s[k] === " " || s[k] === "\t" || s[k] === "\n" || s[k] === "\r";
  const comment = (k: number): number => r.lineComment(k);
  let flow = 0;
  let i = 0;
  while (i < s.length) {
    // `i` is at a line start.
    let j = i;
    while (s[j] === " ") j++;
    // The column of the `-` that holds this line's value, when a sequence
    // entry starts here, and of the key that follows it.
    let entry = -1;
    if (flow === 0) {
      if (j === i && (s.startsWith("---", j) || s.startsWith("...", j)) && blankOrEnd(j + 3)) {
        j += 3;
        while (s[j] === " " || s[j] === "\t") j++;
      }
      while ((s[j] === "-" || s[j] === "?") && blankOrEnd(j + 1) && s[j + 1] !== "\n" && s[j + 1] !== "\r" && j + 1 < s.length) {
        entry = j - i;
        j++;
        while (s[j] === " " || s[j] === "\t") j++;
      }
    }
    const keyColumn = j - i;
    let keyed = false;
    let start = true;
    let next = -1;
    i = j;
    while (i < s.length && s[i] !== "\n") {
      const c = s[i] as string;
      if (c === "#" && (i === 0 || s[i - 1] === " " || s[i - 1] === "\t" || s[i - 1] === "\n")) {
        i = comment(i);
        break;
      }
      if (c === " " || c === "\t" || c === "\r") {
        i++;
      } else if (start && (c === "'" || c === '"')) {
        const from = i;
        const end = r.open(c, i, () => (c === "'" ? skipSingleQuoted(s, from + 1) : skipString(s, from + 1, '"', true, true)));
        start = false;
        if (end < 0) {
          i++;
          continue;
        }
        i = end;
      } else if (start && flow === 0 && (c === "|" || c === ">")) {
        const header = blockHeader(s, i);
        if (header < 0) {
          start = false;
          i++;
          continue;
        }
        let k = header;
        while (s[k] === " " || s[k] === "\t") k++;
        if (s[k] === "#") k = comment(k);
        const parent = keyed ? keyColumn : entry;
        next = skipBlockBody(s, lineEnd(s, k) + 1, parent);
        break;
      } else if (start && (c === "&" || c === "!")) {
        // An anchor or a tag: the scalar starts after it.
        while (i < s.length && !blankOrEnd(i)) i++;
      } else if (start && (c === "[" || c === "{")) {
        flow++;
        i++;
      } else if (flow > 0 && (c === "]" || c === "}")) {
        flow--;
        start = false;
        i++;
      } else if (flow > 0 && c === ",") {
        start = true;
        i++;
      } else if (c === ":" && (blankOrEnd(i + 1) || (flow > 0 && ",]}".includes(s[i + 1] as string)))) {
        start = true;
        keyed = true;
        i++;
      } else {
        start = false;
        i++;
      }
    }
    i = next >= 0 ? next : i + 1;
  }
}

// The offset past a single-quoted YAML scalar whose body starts at `i` (a
// doubled quote is a quote), or -1 with no closer before the end of the file.
function skipSingleQuoted(s: string, i: number): number {
  for (;;) {
    const k = s.indexOf("'", i);
    if (k < 0) return -1;
    if (s[k + 1] !== "'") return k + 1;
    i = k + 2;
  }
}

// The offset past a block scalar's indicators at `i` (`|` or `>`, then a
// chomping indicator and an indentation digit in either order), or -1 when
// what follows on the line is neither blanks nor a comment, so the `|` or
// `>` is text.
function blockHeader(s: string, i: number): number {
  let k = i + 1;
  const chomp = (c: string | undefined) => c === "+" || c === "-";
  const digit = (c: string | undefined) => c !== undefined && c >= "1" && c <= "9";
  if (chomp(s[k])) {
    k++;
    if (digit(s[k])) k++;
  } else if (digit(s[k])) {
    k++;
    if (chomp(s[k])) k++;
  }
  let m = k;
  while (s[m] === " " || s[m] === "\t") m++;
  if (m >= s.length || s[m] === "\n" || s[m] === "\r") return k;
  return s[m] === "#" && m > k ? k : -1;
}

// The offset of the first line at or after `i` that is not blank and is
// indented no deeper than `parent` columns: the line after a block scalar's
// body. Each line is looked at once.
function skipBlockBody(s: string, i: number, parent: number): number {
  while (i < s.length) {
    let q = i;
    while (s[q] === " ") q++;
    const end = lineEnd(s, i);
    let blank = true;
    for (let t = q; t < end; t++) {
      if (s[t] !== " " && s[t] !== "\t" && s[t] !== "\r") {
        blank = false;
        break;
      }
    }
    if (!blank && q - i <= parent) return i;
    i = end + 1;
  }
  return s.length;
}

// A character of a SQL identifier after its first: a letter, a digit, `_`,
// `$` or any character past ASCII (Postgres scan.l, ident_cont).
const SQL_IDENT_CONT = /[A-Za-z0-9_$\u0080-￿]/;
const SQL_IDENT_START = /[A-Za-z_\u0080-￿]/;
const sqlIdentCont = (c: string | undefined): boolean => c !== undefined && SQL_IDENT_CONT.test(c);

// The `$tag$` (or `$$`) that opens a dollar quote at `i`, or null. The tag is
// a word that does not start with a digit and holds no `$` ($1 is a
// parameter). The scan stops at the next `$`, so the scans from all `$`
// signs of a file cover it once.
function sqlDollarTag(s: string, i: number): string | null {
  if (s[i + 1] === "$") return "$$";
  if (!SQL_IDENT_START.test(s[i + 1] ?? "")) return null;
  let k = i + 2;
  while (k < s.length && s[k] !== "$" && k - i <= MAX_WORD) {
    if (!SQL_IDENT_CONT.test(s[k] as string)) return null;
    k++;
  }
  return s[k] === "$" ? s.slice(i, k + 1) : null;
}

// The offset past a SQL string or quoted identifier whose body starts at `i`
// and ends with `close`: a doubled `close` stands for one, and with
// `backslash` a backslash hides the next character. -1 with no closer.
function skipSqlQuoted(s: string, i: number, close: string, backslash: boolean): number {
  while (i < s.length) {
    const c = s[i];
    if (backslash && c === "\\") {
      i += 2;
    } else if (c === close) {
      if (s[i + 1] !== close) return i + 1;
      i += 2;
    } else {
      i++;
    }
  }
  return -1;
}

// The offset past a block comment that opens at `i`, counting the `/*` and
// `*/` inside it, as Postgres nests them; -1 with no closer.
function skipSqlBlock(s: string, i: number): number {
  let depth = 1;
  i += 2;
  while (i < s.length) {
    if (s[i] === "/" && s[i + 1] === "*") {
      depth++;
      i += 2;
    } else if (s[i] === "*" && s[i + 1] === "/") {
      depth--;
      i += 2;
      if (depth === 0) return i;
    } else {
      i++;
    }
  }
  return -1;
}

// SQL as Postgres (and squawk's lexer, crates/squawk_lexer) reads it: `--`
// comments to the line end, and `/* */` comments, which nest. Strings:
// '...' with '' for a quote and a backslash taken as a character; E'...',
// where an E that starts a word also makes a backslash hide the next
// character; "quoted identifiers" with "" for a quote; and dollar quotes
// $$...$$ and $tag$...$tag$, whose `$` opens one only at the start of a word
// (a$b$ is an identifier).
function sqlComments(r: Reader): void {
  const s = r.s;
  // Every offset each `$tag$` text starts at, built once: the closer of a
  // dollar quote is the first one at or after its body.
  let dollars: Map<string, number[]> | null = null;
  const closerOf = (tag: string, from: number): number => {
    if (dollars === null) {
      dollars = new Map();
      for (let k = s.indexOf("$"); k >= 0; k = s.indexOf("$", k + 1)) {
        const t = sqlDollarTag(s, k);
        if (t === null) continue;
        const list = dollars.get(t);
        if (list) list.push(k);
        else dollars.set(t, [k]);
      }
    }
    const at = dollars.get(tag) ?? [];
    let lo = 0;
    let hi = at.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((at[mid] as number) < from) lo = mid + 1;
      else hi = mid;
    }
    return lo < at.length ? (at[lo] as number) + tag.length : -1;
  };
  let i = 0;
  while (i < s.length) {
    const c = s[i] as string;
    if (c === "-" && s[i + 1] === "-") {
      i = r.lineComment(i);
    } else if (c === "/" && s[i + 1] === "*") {
      const from = i;
      const end = r.open("/*", from, () => skipSqlBlock(s, from));
      if (end < 0) {
        i += 2;
      } else {
        r.out.push({ start: from, text: s.slice(from, end) });
        i = end;
      }
    } else if (c === "'") {
      const from = i;
      const escape = (s[i - 1] === "e" || s[i - 1] === "E") && !sqlIdentCont(s[i - 2]);
      const end = r.open(escape ? "E'" : "'", from, () => skipSqlQuoted(s, from + 1, "'", escape));
      i = end < 0 ? i + 1 : end;
    } else if (c === '"') {
      const from = i;
      const end = r.open('"', from, () => skipSqlQuoted(s, from + 1, '"', false));
      i = end < 0 ? i + 1 : end;
    } else if (c === "$" && !sqlIdentCont(s[i - 1])) {
      const tag = sqlDollarTag(s, i);
      const from = i;
      const end = tag === null ? -1 : r.open(tag, from, () => closerOf(tag, from + tag.length));
      i = end < 0 ? i + 1 : end;
    } else if (sqlIdentCont(c)) {
      // A word, so a `$` inside it never opens a dollar quote.
      i++;
      while (i < s.length && sqlIdentCont(s[i])) i++;
    } else {
      i++;
    }
  }
}

// HCL (Terraform), as hclsyntax 2.24 lexes it (scan_tokens.rl): `#` and `//`
// line comments and `/* */` block comments, which the first `*/` ends. A
// quoted string ends at its closing quote, with backslash escapes, and never
// runs past its line (a string the line end leaves open makes the file
// invalid, and tflint then reads no comment at all). `${` and `%{` inside a
// string open a template sequence that holds code, with its own strings and
// comments, up to the matching `}`; `$${` and `%%{` are text. A heredoc
// opens with `<<` or `<<-`, a word and the line end, and holds every line up
// to one that reads the word once its blanks are trimmed (for both forms);
// its `${` and `%{` sequences are code too. In a template sequence, `{` and
// `}` nest.
//
// `masked`, when given, collects the spans that are not code: comments, the
// inside of a quoted string (between its quotes) and a heredoc's body (its
// lines before the closing word), template sequences included.
function hclCode(r: Reader, i: number, inTemplate: boolean, depth: number, masked?: [number, number][]): number {
  const s = r.s;
  let braces = 0;
  while (i < s.length) {
    const c = s[i] as string;
    if (inTemplate && c === "}" && braces === 0) return i + 1;
    if (c === "#" || (c === "/" && s[i + 1] === "/")) {
      const end = r.lineComment(i);
      masked?.push([i, end]);
      i = end;
    } else if (c === "/" && s[i + 1] === "*") {
      const from = i;
      const end = r.open("*/", i, () => {
        const close = s.indexOf("*/", from + 2);
        return close < 0 ? -1 : close + 2;
      });
      if (end < 0) {
        i += 2;
      } else {
        r.out.push({ start: i, text: s.slice(i, end) });
        masked?.push([i, end]);
        i = end;
      }
    } else if (c === '"') {
      i = hclString(r, i, depth, masked);
    } else if (c === "<" && s[i + 1] === "<") {
      i = hclHeredoc(r, i, depth, masked);
    } else {
      if (c === "{") braces++;
      else if (c === "}") braces--;
      i++;
    }
  }
  return s.length;
}

// A `${` or `%{` at `j` that opens a template sequence: not `$${` or `%%{`,
// whose first sign makes it text.
const hclTemplateAt = (s: string, j: number): boolean => (s[j] === "$" || s[j] === "%") && s[j + 1] === "{" && s[j - 1] !== s[j];

// The offset past a quoted string whose opening quote is at `i`; the line end
// when the line leaves it open.
function hclString(r: Reader, i: number, depth: number, masked?: [number, number][]): number {
  const s = r.s;
  let j = i + 1;
  while (j < s.length && s[j] !== "\n") {
    const c = s[j];
    if (c === "\\") {
      j += 2;
    } else if (c === '"') {
      masked?.push([i + 1, j]);
      return j + 1;
    } else if (hclTemplateAt(s, j) && depth < MAX_DEPTH) {
      // A sequence left open reads the rest of the file as code.
      j = hclCode(r, j + 2, true, depth + 1, masked);
    } else {
      j++;
    }
  }
  const end = Math.min(j, s.length);
  masked?.push([i + 1, end]);
  return end;
}

const HCL_HEREDOC = /^<<-?([A-Za-z_][A-Za-z0-9_-]*)\r?\n/;

// The offset past a heredoc whose `<<` is at `i`, its closing line included;
// past the `<<` alone when it opens none or has no closing line.
function hclHeredoc(r: Reader, i: number, depth: number, masked?: [number, number][]): number {
  const s = r.s;
  const m = HCL_HEREDOC.exec(s.slice(i, i + MAX_WORD + 8));
  if (!m) return i + 2;
  const body = i + m[0].length;
  const end = r.closer({ word: m[1] as string, indent: "blanks", trailing: true, expands: false }, body);
  if (end < 0) return i + 2;
  // The start of the closing line: the body ends before it.
  const last = Math.max(body, s.lastIndexOf("\n", end - 2) + 1);
  masked?.push([body, last]);
  let j = body;
  while (j < last) {
    if (hclTemplateAt(s, j) && depth < MAX_DEPTH) {
      j = hclCode(r, j + 2, true, depth + 1, masked);
    } else {
      j++;
    }
  }
  // A sequence that ran past the closing line read that text already.
  return Math.min(Math.max(end, j), s.length);
}

// The text of an HCL file with everything that is not code turned into
// blanks, line ends kept: comments, the inside of quoted strings and heredoc
// bodies. Offsets and lines stay those of the file, so a reader of its
// structure (blocks, attributes, braces) never takes a brace or an `=` in a
// string, a heredoc or a comment for code.
export function hclMasked(text: string): string {
  const masked: [number, number][] = [];
  hclCode(new Reader(text), 0, false, 0, masked);
  masked.sort((a, b) => a[0] - b[0]);
  const parts: string[] = [];
  let at = 0;
  for (const [from, to] of masked) {
    if (to <= at) continue;
    const begin = Math.max(from, at);
    parts.push(text.slice(at, begin), text.slice(begin, to).replace(/[^\n]/g, " "));
    at = to;
  }
  parts.push(text.slice(at));
  return parts.join("");
}
