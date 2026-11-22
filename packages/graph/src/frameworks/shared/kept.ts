// What a framework plugin keeps of a string literal in its cached facts:
// one rule for every plugin.
//
// The facts of every file are cached under .openqodex/graph and feed the
// review packet and the brief, and each plugin reads every file of its
// language, so a literal kept for no reason would copy a secret written
// anywhere in the code (an API key, a header, a test's title, a URL's user
// or query string) into those places. A plugin keeps a literal only where
// its resolve reads one, and only through this file:
// - shaped: in the form the plugin reads it in (a route path or a piece of
//   one, a request target, an HTTP method, a route name, a dotted name), and
//   nothing past a query string or a fragment;
// - applied to the whole value read: a concatenation is checked as the
//   value its pieces make, so pieces that each pass cannot rebuild a key;
// - bounded: a literal over MAX_KEPT characters is not kept at all;
// - redacted: every key-shaped run replaced by a marker that names the run
//   by a short hash (`[redacted:1a2b3c4d]`), and the literal dropped whole
//   when its percent-decoded form hides a key.
// Every other literal is kept as a placeholder the plugin does not read.
// A kept string is display text: a plugin compares it with another kept
// string, or with a name of the repository put in the same form
// (`keptName`), never with the value as written. Two kept strings are equal
// exactly when the values were (a redacted run by its hash), so a template
// named like a key still finds its file and no two values match on a part
// of them. Downstream, the packet and the brief also pass every string
// through core's redaction of the secrets the scanners found.
import { createHash } from "node:crypto";
import { REDACTED } from "@openqodex/core";

// The longest literal a fact keeps. A longer one is not kept: a cut text
// would match another that shares its start.
export const MAX_KEPT = 512;

// Prefixes of keys and tokens that common services issue.
const KEY_PREFIXES = ["sk_live_", "sk_test_", "rk_live_", "rk_test_", "pk_live_", "pk_test_", "whsec_", "ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_", "glpat-", "xoxa-", "xoxb-", "xoxp-", "xoxr-", "xoxs-", "xapp-", "AKIA", "ASIA", "AIza", "sq0atp-", "sq0csp-", "shpat_", "shpca_", "shppa_", "shpss_", "npm_", "dop_v1_"];

const isTokenChar = (c: number) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 45;

// Whether a run of letters, digits, "_" and "-" looks like a key: a known
// key prefix, at its start or after a "_" or "-" inside it
// (`customer_ghp_...`), followed by eight characters or more, or one of its
// pieces between "_" and "-" is an opaque blob of sixteen characters or
// more with at least two digits and two letters (a hex or base64 secret,
// never a word or a slug of words).
export function keyShaped(run: string): boolean {
  for (let at = 0; at < run.length; at++) {
    if (at > 0 && run[at - 1] !== "_" && run[at - 1] !== "-") continue;
    for (const p of KEY_PREFIXES) if (run.startsWith(p, at) && run.length - at >= p.length + 8) return true;
  }
  let start = 0;
  for (let i = 0; i <= run.length; i++) {
    const c = i < run.length ? run.charCodeAt(i) : 95;
    if (c !== 95 && c !== 45) continue;
    if (i - start >= 16) {
      let digits = 0;
      let letters = 0;
      for (let j = start; j < i; j++) {
        const d = run.charCodeAt(j);
        if (d >= 48 && d <= 57) digits++;
        else letters++;
      }
      if (digits >= 2 && letters >= 2) return true;
    }
    start = i + 1;
  }
  return false;
}

// The marker of a redacted run: core's redaction marker with the first
// eight hex digits of the run's SHA-256, so two runs are told apart and the
// same run always reads the same. Eight digits name one of four billion
// values: they tell runs of one repository apart, and never name the run.
function marker(run: string): string {
  return `${REDACTED.slice(0, -1)}:${createHash("sha256").update(run, "utf8").digest("hex").slice(0, 8)}]`;
}

// The text with every key-shaped run replaced by its marker.
function scrub(s: string): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    if (!isTokenChar(s.charCodeAt(i))) {
      out += s[i];
      i++;
      continue;
    }
    let j = i;
    while (j < s.length && isTokenChar(s.charCodeAt(j))) j++;
    const run = s.slice(i, j);
    out += keyShaped(run) ? marker(run) : run;
    i = j;
  }
  return out;
}

// The value of a hexadecimal digit's character code, or -1.
function hexValue(c: number): number {
  if (c >= 48 && c <= 57) return c - 48;
  const l = c | 32;
  return l >= 97 && l <= 102 ? l - 87 : -1;
}

// The text with its %XX escapes decoded, as a server would read it.
function decoded(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const hi = hexValue(s.charCodeAt(i + 1));
    const lo = hexValue(s.charCodeAt(i + 2));
    if (s[i] === "%" && hi >= 0 && lo >= 0) {
      out += String.fromCharCode(hi * 16 + lo);
      i += 2;
    } else out += s[i];
  }
  return out;
}

// A literal as a fact keeps it: key-shaped runs replaced by their markers.
// Null, so the plugin reads it as a value it does not know, when it is
// longer than MAX_KEPT or its percent-decoded form holds a key.
export function keptText(s: string): string | null {
  if (s.length > MAX_KEPT) return null;
  if (hidesKey(s)) return null;
  return scrub(s);
}

// Whether the percent-decoded form of the text holds a key the text itself
// does not show (`ghp%5F...`).
export function hidesKey(s: string): boolean {
  return s.includes("%") && scrub(decoded(s)) !== decoded(s);
}

// A whole text replaced by one marker that names it by its hash, for a line
// of source whose encoded form hides a key.
export function redactedWhole(s: string): string {
  return marker(s);
}

// A name of the repository (a file path, a template's name under its
// folder) in the form a kept string has, so the two compare: equal exactly
// when the kept string was kept from this name.
export function keptName(s: string): string {
  return scrub(s);
}

// A value assembled from kept pieces, such as a route path a concatenation
// and its constants make: itself when the rule keeps it as it is; null when
// the pieces join into a key or the value is over the bound.
export function assembledText(s: string): string | null {
  return keptText(s) === s ? s : null;
}

// A path as the plugins read it, a route path in a route table or a
// request a test makes: no scheme, user, password or host, and nothing
// from the first "?" or "#" on; then kept as `keptText` keeps it.
export function pathText(s: string): string | null {
  let p = s;
  const scheme = p.indexOf("://");
  if (scheme >= 0) {
    const slash = p.indexOf("/", scheme + 3);
    p = slash < 0 ? "/" : p.slice(slash);
  }
  for (const stop of ["?", "#"]) {
    const at = p.indexOf(stop);
    if (at >= 0) p = p.slice(0, at);
  }
  return keptText(p);
}

// A dotted name, such as a Python module path or a model reference
// (`mysite.urls`, `auth.User`): identifiers joined by dots, with no
// key-shaped part.
export function dottedText(s: string): string | null {
  if (s.length === 0 || s.length > 256) return null;
  let start = true;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const letter = (c | 32) >= 97 && (c | 32) <= 122;
    if (c === 46) {
      if (start) return null;
      start = true;
      continue;
    }
    if (letter || c === 95 || (!start && c >= 48 && c <= 57)) {
      start = false;
      continue;
    }
    return null;
  }
  return start || keptText(s) !== s ? null : s;
}

// A shape a plugin reads in, kept by the rule: the shaped text as
// `keptText` keeps it, or null when the shape does not hold.
export function keptShape(shape: (s: string) => string | null): (s: string) => string | null {
  return (s) => {
    const t = shape(s);
    return t === null ? null : keptText(t);
  };
}

// ---------- the shapes of an HTTP router's routes and requests ----------

// An absolute http or https URL split into its scheme and host (with no
// user or password) and its path (with no query or fragment); null when
// the text is not one.
export function urlParts(s: string): { origin: string; path: string } | null {
  const lower = s.slice(0, 8).toLowerCase();
  const scheme = lower.startsWith("https://") ? "https" : lower.startsWith("http://") ? "http" : null;
  if (scheme === null) return null;
  const rest = s.slice(scheme.length + 3);
  let end = rest.length;
  for (const stop of ["/", "?", "#"]) {
    const i = rest.indexOf(stop);
    if (i >= 0 && i < end) end = i;
  }
  const authority = rest.slice(0, end);
  const host = authority.slice(authority.lastIndexOf("@") + 1);
  let path = rest.slice(end);
  for (const stop of ["?", "#"]) {
    const i = path.indexOf(stop);
    if (i >= 0) path = path.slice(0, i);
  }
  return { origin: `${scheme}://${host}`, path };
}

// What a place reads a path as:
// - "route": the path or prefix a registration gives, as the router writes
//   it ("", "*" or text that starts with "/"), kept whole: a "?" or a "#"
//   in it is part of the route (Express's optional `:id?`, a literal "#").
// - "request": a request's target: an absolute URL gives its path, and
//   nothing from the first "?" or "#" on is read.
// - "either": a call that may be a registration or a request, as Express's
//   `x.get(path)` on an application or on a test agent: a "?" followed by
//   a name=value is a query and is cut, a "?" before a "/" or at the end is
//   the route's own; anything else ("/x?secret", a "#") could be either and
//   is not kept.
export type PathForm = "route" | "request" | "either";

const rooted = (t: string): string | null => (t === "" || t === "*" || t.startsWith("/") ? t : null);

// Where a query starts in a path the "either" form reads, the text's length
// when none does, or -1 when the text could be a route or a request.
function eitherCut(s: string): number {
  if (s.includes("#")) return -1;
  const q = s.indexOf("?");
  if (q < 0) return s.length;
  if (s.indexOf("=", q) >= 0) return q;
  for (let i = q; i >= 0; i = s.indexOf("?", i + 1)) if (i + 1 < s.length && s[i + 1] !== "/") return -1;
  return s.length;
}

// The first piece of a path in each form, shaped: the text kept and
// whether a query or fragment ended the path there. Null when the form does
// not hold.
function shapeFirst(form: PathForm, s: string): { text: string; stop: boolean } | null {
  const u = urlParts(s);
  if (u) return { text: u.path, stop: s.includes("?") || s.includes("#") };
  if (form === "route") return rooted(s) === null ? null : { text: s, stop: false };
  if (form === "request") {
    const at = [s.indexOf("?"), s.indexOf("#")].filter((i) => i >= 0);
    const end = at.length > 0 ? Math.min(...at) : s.length;
    return rooted(s.slice(0, end)) === null ? null : { text: s.slice(0, end), stop: end < s.length };
  }
  const end = eitherCut(s);
  return end < 0 || rooted(s.slice(0, end)) === null ? null : { text: s.slice(0, end), stop: end < s.length };
}

// A later piece of a path in each form (the `/users` of `"/" + V + "/users"`):
// any text up to where the form stops reading, never an absolute URL.
function shapeLater(form: PathForm, s: string): { text: string; stop: boolean } | null {
  if (urlParts(s) !== null) return null;
  if (form === "route") return { text: s, stop: false };
  if (form === "request") {
    const at = [s.indexOf("?"), s.indexOf("#")].filter((i) => i >= 0);
    const end = at.length > 0 ? Math.min(...at) : s.length;
    return { text: s.slice(0, end), stop: end < s.length };
  }
  const end = eitherCut(s);
  return end < 0 ? null : { text: s.slice(0, end), stop: end < s.length };
}

// A whole path literal in a form, kept by the rule.
export const routePathText = keptShape((s) => shapeFirst("route", s)?.text ?? null);
export const requestPathText = keptShape((s) => shapeFirst("request", s)?.text ?? null);
export const eitherPathText = keptShape((s) => shapeFirst("either", s)?.text ?? null);
// A later piece of a path in a form, kept by the rule (a constant the
// piece names, such as the `v1` of `"/" + VERSION`).
export const routeSegmentText = keptShape((s) => shapeLater("route", s)?.text ?? null);
export const requestSegmentText = keptShape((s) => shapeLater("request", s)?.text ?? null);
export const eitherSegmentText = keptShape((s) => shapeLater("either", s)?.text ?? null);

// An HTTP method as written: letters only.
export const methodText = keptShape((s) => {
  if (s.length === 0 || s.length > 20) return null;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i) | 32;
    if (c < 97 || c > 122) return null;
  }
  return s;
});

// A name a route is given (`name="read_item"`): a letter or "_" first, then
// letters, digits, "_", "-" or ".".
export const nameText = keptShape((s) => {
  if (s.length === 0 || s.length > 128) return null;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const letter = (c | 32) >= 97 && (c | 32) <= 122;
    if (letter || c === 95 || (i > 0 && ((c >= 48 && c <= 57) || c === 45 || c === 46))) continue;
    return null;
  }
  return s;
});

// The pieces of a concatenation in a place a plugin reads a path, kept by
// the rule applied to the value they make, or null (the plugin keeps the
// whole concatenation as a value it does not read):
// - the first literal in the form `first` gives (a plugin's own shape, such
//   as a Go pattern, or the form's), each later literal in `form` up to
//   where the form stops reading, and no piece past that;
// - an address of another host (the first piece, or the constant it names,
//   an absolute URL) keeps a later literal only as a piece of its path
//   (one that starts with "/"), and an address with no host yet
//   (`"https://" + rest`) is not kept, so a user, a password or a key the
//   later pieces write into it are not copied;
// - the kept pieces, with the constants `constant` knows in their kept
//   form, must make a value the rule keeps as it is: pieces that join into
//   a key, or a value over the bound, drop the whole concatenation.
// `use` hears of each name a piece reads, with the first piece that leads
// it (null for the first piece itself), so its constant can be kept in the
// form that place reads (`ledForm`).
export function keepParts<P extends { s: string } | { ref: string[] }>(parts: readonly P[], form: PathForm, use: (ref: string[], lead: P | null) => void, constant: (name: string) => string | null = () => null, first: ((s: string) => string | null) | null = null): P[] | null {
  const known = (p: P | undefined): string | null => (p === undefined ? null : "s" in p ? p.s : p.ref.length === 1 ? constant(p.ref[0] as string) : null);
  const head = known(parts[0]);
  const address = head !== null && urlParts(head) !== null;
  if (address && (urlParts(head)?.origin ?? "").endsWith("://")) return null;
  const out: P[] = [];
  let run = "";
  for (const [i, p] of parts.entries()) {
    if (!("s" in p)) {
      use(p.ref, i === 0 ? null : (parts[0] as P));
      out.push(p);
      const v = known(p);
      const kept = v === null ? null : keptText(v);
      if (kept === null) {
        if (run !== "" && assembledText(run) === null) return null;
        run = "";
      } else run += kept;
      continue;
    }
    let shaped: { text: string; stop: boolean } | null;
    if (i === 0) {
      const f = shapeFirst(form, p.s);
      if (first === null) shaped = f;
      else {
        const t = first(p.s);
        shaped = t === null ? null : { text: t, stop: f?.stop ?? false };
      }
    } else if (address) shaped = p.s.startsWith("/") ? shapeLater("request", p.s) : null;
    else shaped = shapeLater(form, p.s);
    if (shaped === null) return null;
    const t = keptText(shaped.text);
    if (t === null) return null;
    out.push({ ...p, s: t });
    run += t;
    // Past a query string or a fragment, nothing is read.
    if (shaped.stop) break;
  }
  if (run !== "" && assembledText(run) === null) return null;
  return out;
}

// The form a constant read as a later piece of a concatenation is kept in.
// After a literal path, or a name whose constant is a path, it is a piece of
// that path: a segment. After an absolute URL, or a name whose constant is
// one, the concatenation is an address of another host, and a piece of it
// is kept only as a path, so a key written into such an address
// (`"https://api.example.com/bot" + TOKEN`) is not kept.
export function ledForm(lead: { s: string } | { ref: string[] }, constant: (name: string) => string | null): "segment" | "path" {
  const text = "s" in lead ? lead.s : lead.ref.length === 1 ? constant(lead.ref[0] as string) : null;
  return text !== null && urlParts(text) === null && rooted(text) !== null ? "segment" : "path";
}
