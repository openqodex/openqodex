// Checks a lock file that another job wrote before pin-bump.mjs takes it:
// the lock is read block by block, and its packages must be exactly the
// dependency tree of the pinned tool, as the registry declares it for that
// platform and Python, every package at a version its requirements allow.
// Nothing here starts a program or evaluates code from a package: it reads
// PyPI's requires_dist and RubyGems' runtime dependencies as data.
//
// Every reader walks its input once, with string methods and anchored
// patterns of single character classes.

export class LockRefused extends Error {}

export const pyName = (name) => name.toLowerCase().replace(/[-_.]+/g, "-");

// ---------- the lock files ----------

// A uv lock: blocks of `name==version \` and then `    --hash=sha256:<hex>`
// lines, each ending ` \` but the last. Blank lines between blocks are
// allowed. A package pinned twice, a requirement with no hash, or a block
// whose hash lines run on into the next requirement refuses the lock.
export function readUvLock(text, file) {
  const blocks = [];
  const seen = new Set();
  let current = null;
  // True while the previous line ended with " \": a hash line must follow.
  let open = false;
  for (const line of text.split("\n")) {
    if (line === "" && !open) {
      if (current !== null && current.hashes.length === 0) throw new LockRefused(`${file}: ${current.name} has no hash`);
      continue;
    }
    const pin = /^([A-Za-z0-9][A-Za-z0-9._-]*)==([0-9][0-9A-Za-z.+!]*) \\$/.exec(line);
    if (pin && !open) {
      if (current !== null && current.hashes.length === 0) throw new LockRefused(`${file}: ${current.name} has no hash`);
      const norm = pyName(pin[1]);
      if (seen.has(norm)) throw new LockRefused(`${file}: ${norm} is pinned twice`);
      seen.add(norm);
      current = { name: pin[1], norm, version: pin[2], hashes: [] };
      blocks.push(current);
      open = true;
      continue;
    }
    const hash = /^ {4}--hash=sha256:([0-9a-f]{64})( \\)?$/.exec(line);
    if (hash && open && current !== null) {
      current.hashes.push(hash[1]);
      open = hash[2] !== undefined;
      continue;
    }
    throw new LockRefused(`${file}: not a lock line where it stands: ${line.slice(0, 80)}`);
  }
  if (open) throw new LockRefused(`${file}: the last block runs on past the end of the file`);
  for (const b of blocks) if (b.hashes.length === 0) throw new LockRefused(`${file}: ${b.name} has no hash`);
  return blocks;
}

// The uv lock as uv writes it, from the checked blocks.
export function writeUvLock(blocks) {
  return blocks.map((b) => `${b.name}==${b.version} \\\n${b.hashes.map((h) => `    --hash=sha256:${h}`).join(" \\\n")}\n`).join("");
}

// A gem lock: the header line lock-scanners.mjs writes for this recipe, then
// `<name> <version> sha256:<hex>` lines in name order, each gem once.
export function readGemLock(text, file, header) {
  const lines = text.split("\n");
  if (lines[0] !== header) throw new LockRefused(`${file}: the first line is not "${header}"`);
  const gems = [];
  for (const line of lines.slice(1)) {
    if (line === "") continue;
    const m = /^([A-Za-z0-9_.-]+) ([0-9][0-9.]*) sha256:([0-9a-f]{64})$/.exec(line);
    if (!m) throw new LockRefused(`${file}: not a lock line: ${line.slice(0, 80)}`);
    if (gems.length > 0 && !(gems[gems.length - 1].name < m[1])) throw new LockRefused(`${file}: ${m[1]} is out of order or pinned twice`);
    gems.push({ name: m[1], version: m[2], sha: m[3] });
  }
  return gems;
}

export function writeGemLock(header, gems) {
  return [header, ...gems.map((g) => `${g.name} ${g.version} sha256:${g.sha}`), ""].join("\n");
}

// ---------- PEP 440 versions and specifiers ----------

const PRE = { a: 0, alpha: 0, b: 1, beta: 1, c: 2, rc: 2, pre: 2, preview: 2 };

// A version as a comparable record: release numbers, then pre, post, dev.
// Null for a version that is not PEP 440.
export function pyVersion(text) {
  let t = text.trim().toLowerCase();
  if (t.startsWith("v")) t = t.slice(1);
  const plus = t.indexOf("+");
  if (plus !== -1) t = t.slice(0, plus);
  const release = /^\d+(\.\d+)*/.exec(t);
  if (!release) return null;
  const v = { release: release[0].split(".").map(Number), pre: null, post: null, dev: null };
  let rest = t.slice(release[0].length);
  const take = (words) => {
    const sep = /^[-_.]?/.exec(rest)[0];
    const after = rest.slice(sep.length);
    const word = words.find((w) => after.startsWith(w));
    if (word === undefined) return null;
    rest = after.slice(word.length);
    const num = /^[-_.]?(\d*)/.exec(rest);
    rest = rest.slice(num[0].length);
    return { word, n: num[1] === "" ? 0 : Number(num[1]) };
  };
  const pre = take(["alpha", "beta", "preview", "pre", "rc", "a", "b", "c"]);
  if (pre) v.pre = [PRE[pre.word], pre.n];
  const post = take(["post", "rev", "r"]);
  if (post) v.post = post.n;
  const dev = take(["dev"]);
  if (dev) v.dev = dev.n;
  return rest === "" ? v : null;
}

export function comparePy(a, b) {
  const n = Math.max(a.release.length, b.release.length);
  for (let i = 0; i < n; i++) {
    const d = (a.release[i] ?? 0) - (b.release[i] ?? 0);
    if (d !== 0) return d;
  }
  // dev before pre before final before post.
  const key = (v) => [v.pre === null && v.post === null && v.dev !== null ? -1 : v.pre === null ? 1 : 0, v.pre?.[0] ?? 0, v.pre?.[1] ?? 0, v.post ?? -1, v.dev === null ? Infinity : v.dev];
  const x = key(a);
  const y = key(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

// Whether `version` meets every clause of a specifier such as ">=1.0,<2".
export function pySatisfies(version, specifier) {
  const v = pyVersion(version);
  if (v === null) return false;
  for (const raw of specifier.split(",")) {
    const clause = raw.trim();
    if (clause === "") continue;
    const op = ["===", "~=", "==", "!=", "<=", ">=", "<", ">"].find((o) => clause.startsWith(o));
    if (op === undefined) throw new LockRefused(`cannot read the requirement "${specifier}"`);
    const want = clause.slice(op.length).trim();
    if (op === "===") {
      if (version !== want) return false;
      continue;
    }
    if ((op === "==" || op === "!=") && want.endsWith(".*")) {
      const prefix = pyVersion(want.slice(0, -2));
      if (prefix === null) throw new LockRefused(`cannot read the requirement "${specifier}"`);
      const match = prefix.release.every((n, i) => (v.release[i] ?? 0) === n);
      if (match !== (op === "==")) return false;
      continue;
    }
    const w = pyVersion(want);
    if (w === null) throw new LockRefused(`cannot read the requirement "${specifier}"`);
    const c = comparePy(v, w);
    if (op === "==" && c !== 0) return false;
    if (op === "!=" && c === 0) return false;
    if (op === "<=" && c > 0) return false;
    if (op === ">=" && c < 0) return false;
    if (op === "<" && c >= 0) return false;
    if (op === ">" && c <= 0) return false;
    if (op === "~=") {
      if (c < 0 || w.release.length < 2) return false;
      const head = w.release.slice(0, -1);
      if (!head.every((n, i) => (v.release[i] ?? 0) === n)) return false;
    }
  }
  return true;
}

// ---------- PEP 508 requirements and markers ----------

// `name[extra1,extra2] (spec) ; marker` or `name[extras]spec;marker`.
export function readRequirement(text) {
  const t = text.trim();
  const name = /^[A-Za-z0-9][A-Za-z0-9._-]*/.exec(t)?.[0];
  if (name === undefined) throw new LockRefused(`cannot read the requirement "${text}"`);
  let rest = t.slice(name.length).trimStart();
  let extras = [];
  if (rest.startsWith("[")) {
    const close = rest.indexOf("]");
    if (close === -1) throw new LockRefused(`cannot read the requirement "${text}"`);
    extras = rest.slice(1, close).split(",").map((e) => pyName(e.trim())).filter((e) => e !== "");
    rest = rest.slice(close + 1).trimStart();
  }
  const semi = rest.indexOf(";");
  let spec = (semi === -1 ? rest : rest.slice(0, semi)).trim();
  const marker = semi === -1 ? "" : rest.slice(semi + 1).trim();
  if (spec.startsWith("@")) throw new LockRefused(`a requirement on a URL is not locked by version: "${text}"`);
  if (spec.startsWith("(") && spec.endsWith(")")) spec = spec.slice(1, -1).trim();
  return { name: pyName(name), extras, spec, marker };
}

// The marker environment for one lock file: the platform it was made for and
// the recipe's Python. Only the platforms a lock file exists for are read: a
// PyPI or RubyGems scanner has no FreeBSD lock file, because no uv or gem
// recipe supports FreeBSD.
export function markerEnv(platform, python) {
  const [os, arch] = platform.split("-");
  if (os !== "darwin" && os !== "linux") throw new LockRefused(`${platform}: there is no lock file for this platform; FreeBSD has no PyPI or RubyGems lock file`);
  const darwin = os === "darwin";
  return {
    python_version: python,
    python_full_version: `${python}.0`,
    implementation_version: `${python}.0`,
    implementation_name: "cpython",
    platform_python_implementation: "CPython",
    os_name: "posix",
    sys_platform: darwin ? "darwin" : "linux",
    platform_system: darwin ? "Darwin" : "Linux",
    platform_machine: arch === "x64" ? "x86_64" : darwin ? "arm64" : "aarch64",
    platform_release: "",
    platform_version: "",
  };
}

const VERSION_VARS = new Set(["python_version", "python_full_version", "implementation_version"]);

function markerTokens(text) {
  const tokens = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === " " || c === "\t") {
      i += 1;
    } else if (c === "(" || c === ")") {
      tokens.push(c);
      i += 1;
    } else if (c === '"' || c === "'") {
      const end = text.indexOf(c, i + 1);
      if (end === -1) throw new LockRefused(`cannot read the marker "${text}"`);
      tokens.push({ str: text.slice(i + 1, end) });
      i = end + 1;
    } else {
      const op = ["===", "==", "!=", "<=", ">=", "~=", "<", ">"].find((o) => text.startsWith(o, i));
      if (op) {
        tokens.push(op);
        i += op.length;
        continue;
      }
      const word = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(text.slice(i, i + 64))?.[0];
      if (!word) throw new LockRefused(`cannot read the marker "${text}"`);
      tokens.push(word);
      i += word.length;
    }
  }
  return tokens;
}

// Whether a marker holds in `env`, with `extra` as the extra being asked for
// ("" for none).
export function markerHolds(marker, env, extra) {
  if (marker.trim() === "") return true;
  const tokens = markerTokens(marker);
  let at = 0;
  const peek = () => tokens[at];
  const value = () => {
    const t = tokens[at++];
    if (t && typeof t === "object") return { str: t.str, name: null };
    if (t === "extra") return { str: extra, name: "extra" };
    if (typeof t === "string" && Object.hasOwn(env, t)) return { str: env[t], name: t };
    throw new LockRefused(`cannot read the marker "${marker}"`);
  };
  const compareAtom = () => {
    if (peek() === "(") {
      at += 1;
      const v = orExpr();
      if (tokens[at++] !== ")") throw new LockRefused(`cannot read the marker "${marker}"`);
      return v;
    }
    const left = value();
    let op = tokens[at++];
    if (op === "not" && tokens[at] === "in") {
      at += 1;
      op = "not in";
    }
    const right = value();
    if (op === "in") return right.str.includes(left.str);
    if (op === "not in") return !right.str.includes(left.str);
    const name = left.name ?? right.name;
    if (name === "extra") {
      const a = pyName(left.str);
      const b = pyName(right.str);
      if (op === "==") return a === b;
      if (op === "!=") return a !== b;
      throw new LockRefused(`cannot read the marker "${marker}"`);
    }
    if (VERSION_VARS.has(name ?? "") && op !== "===") {
      const versionSide = left.name !== null ? right.str : left.str;
      const envSide = left.name !== null ? left.str : right.str;
      if (left.name !== null) return pySatisfies(envSide, `${op}${versionSide}`);
      // "3.8" <= python_version: flip the comparison.
      const flip = { "<": ">", ">": "<", "<=": ">=", ">=": "<=", "==": "==", "!=": "!=" }[op];
      if (flip === undefined) throw new LockRefused(`cannot read the marker "${marker}"`);
      return pySatisfies(envSide, `${flip}${versionSide}`);
    }
    if (op === "==" || op === "===") return left.str === right.str;
    if (op === "!=") return left.str !== right.str;
    throw new LockRefused(`cannot read the marker "${marker}"`);
  };
  const andExpr = () => {
    let v = compareAtom();
    while (peek() === "and") {
      at += 1;
      const r = compareAtom();
      v = v && r;
    }
    return v;
  };
  const orExpr = () => {
    let v = andExpr();
    while (peek() === "or") {
      at += 1;
      const r = andExpr();
      v = v || r;
    }
    return v;
  };
  const result = orExpr();
  if (at !== tokens.length) throw new LockRefused(`cannot read the marker "${marker}"`);
  return result;
}

// ---------- the dependency trees ----------

// The PyPI lock of one platform checked against the tool's tree: from the
// recipe's pins (package==version and `with`), every requirement whose marker
// holds there, with the extras asked for, recursively. Every package must be
// in the lock at a version its requirements allow, every hash must be one
// PyPI publishes for that version, and the lock may hold nothing else.
export async function checkPyTree({ blocks, file, recipe, platform, metadata }) {
  const env = markerEnv(platform, recipe.python);
  const locked = new Map(blocks.map((b) => [b.norm, b]));
  const extrasOf = new Map();
  const queue = [];
  const want = (name, extras, why) => {
    const b = locked.get(name);
    if (!b) throw new LockRefused(`${file}: ${why} needs ${name}, which the lock does not hold`);
    const had = extrasOf.get(name);
    const add = extras.filter((e) => !had?.has(e));
    if (had && add.length === 0) return b;
    extrasOf.set(name, new Set([...(had ?? []), ...extras]));
    queue.push(name);
    return b;
  };
  for (const pin of [`${recipe.package}==${recipe.version}`, ...(recipe.with ?? [])]) {
    const [n, v] = pin.split("==");
    const b = want(pyName(n), [], "the recipe");
    if (b.version !== v) throw new LockRefused(`${file}: the recipe pins ${pin}, the lock holds ${b.version}`);
  }
  while (queue.length > 0) {
    const name = queue.shift();
    const b = locked.get(name);
    const info = await metadata(b.name, b.version);
    const published = new Set((info.urls ?? []).map((u) => u?.digests?.sha256).filter((h) => typeof h === "string"));
    for (const h of b.hashes) if (!published.has(h)) throw new LockRefused(`${file}: PyPI publishes no file of ${b.norm}==${b.version} with sha256 ${h}`);
    const extras = ["", ...extrasOf.get(name)];
    for (const raw of info.info?.requires_dist ?? []) {
      const req = readRequirement(raw);
      if (!extras.some((e) => markerHolds(req.marker, env, e))) continue;
      const dep = want(req.name, req.extras, `${b.norm}==${b.version}`);
      if (req.spec !== "" && !pySatisfies(dep.version, req.spec)) {
        throw new LockRefused(`${file}: ${b.norm}==${b.version} needs ${req.name}${req.spec}, the lock holds ${dep.version}`);
      }
    }
  }
  for (const b of blocks) if (!extrasOf.has(b.norm)) throw new LockRefused(`${file}: ${b.norm}==${b.version} is not in the dependency tree of ${recipe.package}`);
}

// RubyGems requirements: "~> 1.2", ">= 1.10, < 2.0", "= 7.1.3".
const gemNumbers = (v) => v.split(".").map(Number);
function gemCompare(a, b) {
  const x = gemNumbers(a);
  const y = gemNumbers(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export function gemSatisfies(version, requirement) {
  return requirement.split(",").every((part) => {
    const t = part.trim();
    const op = ["~>", ">=", "<=", "!=", ">", "<", "="].find((o) => t.startsWith(o)) ?? "=";
    const want = t.startsWith(op) ? t.slice(op.length).trim() : t;
    if (!/^\d+(\.\d+)*$/.test(want)) throw new LockRefused(`cannot read the requirement "${requirement}"`);
    const c = gemCompare(version, want);
    if (op === "=") return c === 0;
    if (op === "!=") return c !== 0;
    if (op === ">=") return c >= 0;
    if (op === ">") return c > 0;
    if (op === "<=") return c <= 0;
    if (op === "<") return c < 0;
    const parts = gemNumbers(want);
    const upper = parts.length > 1 ? [...parts.slice(0, -2), parts[parts.length - 2] + 1].join(".") : `${parts[0] + 1}`;
    return c >= 0 && gemCompare(version, upper) < 0;
  });
}

// The gem lock checked against the recipe's gems and their runtime
// dependencies, recursively; every sha256 must be the one RubyGems publishes.
export async function checkGemTree({ gems, file, recipe, metadata }) {
  const locked = new Map(gems.map((g) => [g.name, g]));
  const seen = new Set();
  const queue = [];
  const want = (name, why) => {
    const g = locked.get(name);
    if (!g) throw new LockRefused(`${file}: ${why} needs ${name}, which the lock does not hold`);
    if (!seen.has(name)) {
      seen.add(name);
      queue.push(name);
    }
    return g;
  };
  for (const spec of recipe.gems) {
    const [n, v] = spec.split(":");
    const g = want(n, "the recipe");
    if (g.version !== v) throw new LockRefused(`${file}: the recipe pins ${spec}, the lock holds ${g.version}`);
  }
  while (queue.length > 0) {
    const g = locked.get(queue.shift());
    const info = await metadata(g.name, g.version);
    if (info.sha !== g.sha) throw new LockRefused(`${file}: RubyGems publishes another sha256 for ${g.name} ${g.version}`);
    for (const d of info.dependencies?.runtime ?? []) {
      const dep = want(d.name, `${g.name} ${g.version}`);
      if (!gemSatisfies(dep.version, d.requirements)) throw new LockRefused(`${file}: ${g.name} ${g.version} needs ${d.name} ${d.requirements}, the lock holds ${dep.version}`);
    }
  }
  for (const g of gems) if (!seen.has(g.name)) throw new LockRefused(`${file}: ${g.name} ${g.version} is not in the dependency tree of ${recipe.gems.join(", ")}`);
}
