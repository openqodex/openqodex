// Loads the tree-sitter runtime and the seven grammars. The wasm files ship
// beside the CLI bundle in `wasm/` (copied by scripts/copy-assets.mjs); in
// this package's own build and tests they are read from the installed
// dependencies. Paths come from import.meta.url, never the current folder.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Language, Parser } from "web-tree-sitter";
import type { Lang } from "./types.js";

export const LANGS: readonly Lang[] = ["typescript", "tsx", "javascript", "python", "go", "ruby", "java"];

export const RUNTIME_WASM = "web-tree-sitter.wasm";
export function grammarFile(lang: Lang): string {
  return `tree-sitter-${lang}.wasm`;
}

// The folder that holds the wasm files: `<package root>/wasm` beside the
// bundle (dist/bin.js), else the installed dependencies (tests, this
// package's own dist).
function wasmPath(file: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const shipped = join(here, "..", "wasm", file);
  if (existsSync(shipped)) return shipped;
  const require = createRequire(import.meta.url);
  if (file === RUNTIME_WASM) return join(dirname(require.resolve("web-tree-sitter")), file);
  return join(dirname(require.resolve("@vscode/tree-sitter-wasm/package.json")), "wasm", file);
}

let runtime: Promise<void> | null = null;
const languages = new Map<Lang, Promise<Language>>();
const grammarBytes = new Map<Lang, Uint8Array>();

function bytes(lang: Lang): Uint8Array {
  let b = grammarBytes.get(lang);
  if (!b) {
    b = readFileSync(wasmPath(grammarFile(lang)));
    grammarBytes.set(lang, b);
  }
  return b;
}

// A short hash of the grammar file, part of every cache key: a new grammar
// invalidates the facts extracted with the old one.
const grammarHashes = new Map<Lang, string>();
export function grammarVersion(lang: Lang): string {
  let h = grammarHashes.get(lang);
  if (!h) {
    h = createHash("sha1").update(bytes(lang)).digest("hex").slice(0, 12);
    grammarHashes.set(lang, h);
  }
  return h;
}

export async function parserFor(lang: Lang): Promise<Parser> {
  runtime ??= Parser.init({ locateFile: () => wasmPath(RUNTIME_WASM) });
  await runtime;
  let language = languages.get(lang);
  if (!language) {
    language = Language.load(bytes(lang));
    languages.set(lang, language);
  }
  const parser = new Parser();
  parser.setLanguage(await language);
  return parser;
}
