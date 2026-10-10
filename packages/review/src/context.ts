// The context items a host gives a review with the change (reviewChange's
// `context`): lessons from earlier reviews, comments on the change,
// summaries, notes and findings from earlier reviews. They reach the
// reviewer only as quoted data in the brief (brief.ts), framed as the
// owners' instructions are: an item never grants a tool and never changes a
// rule.
//
//   check  before anything runs: each item well formed, at most 32 KB, and
//          at most 128 KB together. An item over a limit is refused with
//          the reason, never cut: a cut would drop what follows it without
//          a trace.
//   use    once the change is known: an item about folders that hold no
//          file of the change is left out of the brief and reported; every
//          item given is hashed into the run manifest, its source redacted.
import { createHash } from "node:crypto";
import { OpenQodexError, canonicalJson, redactSecrets } from "@openqodex/core";
import type { Change, ContextItem, ContextKind, RunManifest } from "@openqodex/core";
import { admitted } from "./scopes.js";
import type { Admit } from "./scopes.js";

export type { ContextItem, ContextKind } from "@openqodex/core";

export const CONTEXT_KINDS: readonly ContextKind[] = ["lesson", "comment", "summary", "note", "prior_finding"];
// An item's size is its text and its source, in UTF-8 bytes.
export const CONTEXT_ITEM_MAX_BYTES = 32 * 1024;
export const CONTEXT_MAX_BYTES = 128 * 1024;

// One item the brief left out: its place in the list given (from 0), its
// kind and source, and why.
export type ContextOmission = { index: number; kind: ContextKind; source: string; reason: string };

export type ContextUse = {
  // The items the brief carries, in the order given.
  shown: ContextItem[];
  omitted: ContextOmission[];
  // Every item given, for the run manifest.
  manifest: NonNullable<RunManifest["context"]>;
};

const kb = (bytes: number) => `${bytes / 1024} KB`;

// A folder path inside the repository, as the change names files: no
// leading "./", no trailing "/", no empty, "." or ".." part. Null when it is
// not one.
function folder(scope: string): string | null {
  const s = scope.replace(/^(\.\/)+/, "").replace(/\/+$/, "");
  if (s === "" || s.startsWith("/") || s.includes("\\")) return null;
  return s.split("/").every((part) => part !== "" && part !== "." && part !== "..") ? s : null;
}

// The items, checked whole. Throws an OpenQodexError naming the first item
// that cannot be used and why; a refusal never quotes an item's text or
// source, which may hold a secret.
export function checkContext(items: unknown): ContextItem[] {
  if (!Array.isArray(items)) throw new OpenQodexError("context must be a list of items");
  let total = 0;
  const out: ContextItem[] = [];
  items.forEach((raw: unknown, i) => {
    const n = i + 1;
    const it = (raw ?? {}) as Record<string, unknown>;
    const kind = it.kind as ContextKind;
    if (!CONTEXT_KINDS.includes(kind)) throw new OpenQodexError(`context item ${n}: kind must be one of ${CONTEXT_KINDS.join(", ")}`);
    const at = `context item ${n} (${kind})`;
    if (typeof it.text !== "string" || it.text.trim() === "") throw new OpenQodexError(`${at}: text must hold at least one character that is not a space`);
    if (typeof it.source !== "string" || it.source.trim() === "") throw new OpenQodexError(`${at}: source must name where the item came from`);
    let scopes: string[] | undefined;
    if (it.scopes !== undefined) {
      if (!Array.isArray(it.scopes) || it.scopes.some((s) => typeof s !== "string")) throw new OpenQodexError(`${at}: scopes must be a list of folder paths in the repository, such as "services/api"`);
      if (it.scopes.length === 0) throw new OpenQodexError(`${at}: scopes must list at least one folder; leave scopes out for an item about the whole repository`);
      scopes = (it.scopes as string[]).map((s, k) => {
        const f = folder(s);
        if (f === null) throw new OpenQodexError(`${at}: scope ${k + 1} is not a folder path inside the repository, such as "services/api"`);
        return f;
      });
    }
    const bytes = Buffer.byteLength(it.text, "utf8") + Buffer.byteLength(it.source, "utf8");
    if (bytes > CONTEXT_ITEM_MAX_BYTES) throw new OpenQodexError(`${at} is ${bytes} bytes, over the ${kb(CONTEXT_ITEM_MAX_BYTES)} limit for one item; it is refused, never cut: shorten it so all of it reaches the review`);
    total += bytes;
    out.push({ kind, text: it.text, source: it.source, ...(scopes ? { scopes } : {}) });
  });
  if (total > CONTEXT_MAX_BYTES) throw new OpenQodexError(`the context items are ${total} bytes together, over the ${kb(CONTEXT_MAX_BYTES)} limit; they are refused, never cut: give fewer or shorter items`);
  return out;
}

// Checked items against the change: an item with folders is shown when one
// of them holds a file of the change (its path, or a renamed file's old
// path); else it is left out and reported. Both questions go through the
// one folder rule of scopes.ts: `admit`, the review's own admission (a
// scoped server review), decides which of those paths count at all, and an
// item's folders are an admission of their own. `secrets`: the scan's
// matched secrets, redacted from every source and folder named in the
// omissions and the manifest.
export function useContext(items: readonly ContextItem[], change: Change, secrets: string[], admit?: Admit): ContextUse {
  const paths = change.files.flatMap((f) => (f.oldPath ? [f.path, f.oldPath] : [f.path])).filter((p) => admit === undefined || admit(p));
  const clean = (text: string) => redactSecrets(text, secrets);
  const use: ContextUse = { shown: [], omitted: [], manifest: [] };
  items.forEach((item, index) => {
    const touched = item.scopes === undefined || paths.some(admitted(item.scopes, []));
    const reason = touched ? null : clean(`its folders (${(item.scopes ?? []).join(", ")}) hold no file of this change`);
    if (reason === null) use.shown.push(item);
    else use.omitted.push({ index, kind: item.kind, source: clean(item.source), reason });
    const sha256 = createHash("sha256").update(canonicalJson({ kind: item.kind, source: item.source, text: item.text, scopes: item.scopes ?? null })).digest("hex");
    use.manifest.push({ kind: item.kind, source: clean(item.source), sha256, omitted: reason });
  });
  return use;
}
