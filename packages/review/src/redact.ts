// The one walk every stored or written value of a review goes through for
// secrets: every string but the scanner citations finalize matches on.
import { redactSecrets } from "@openqodex/core";

// Every string in the scan passes through the secret redaction before it is
// kept or written: the runner redacts messages, but a matched secret can sit
// in any other string too (a file name). Candidate ids and tokens are the
// citations finalize matches on and are kept as they are.
export function redactStored<T>(value: T, secrets: string[]): T {
  return secrets.length === 0 ? value : redactWith(value, (text) => redactSecrets(text, secrets));
}

// The scanner citations finalize matches on, kept as the scan wrote them:
// a candidate's `id` and `token`, at exactly these paths of a scan result or
// a report (a number stands for any index). Every other string is redacted,
// a field named `id` or `token` anywhere else included (a symbol id of the
// code graph, a field the reviewer made up).
const CITATIONS: string[][] = [
  ["candidates", "#", "id"],
  ["candidates", "#", "token"],
  ["not_reviewed", "#", "id"],
  ["not_reviewed", "#", "token"],
  ["dropped", "#", "candidate", "id"],
  ["dropped", "#", "candidate", "token"],
];

function isCitation(path: string[]): boolean {
  return CITATIONS.some((c) => c.length === path.length && c.every((part, i) => part === path[i]));
}

// Every string in `value` through `redact`, but the scanner citations: the
// same walk for every caller.
export function redactWith<T>(value: T, redact: (text: string) => string): T {
  const walk = (v: unknown, path: string[]): unknown => {
    if (typeof v === "string") return isCitation(path) ? v : redact(v);
    if (Array.isArray(v)) return v.map((x) => walk(x, [...path, "#"]));
    if (v !== null && typeof v === "object") {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, [...path, k])]));
    }
    return v;
  };
  return walk(value, []) as T;
}
