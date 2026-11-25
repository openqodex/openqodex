// The constants a plugin's fact reader looks up while it keeps the strings
// of a file are found from one index per file. Way it could fail, written
// before the code: each concatenation's constant scans every fact of the
// file again, so a file under the size cap that repeats `P + "/" + S`
// thousands of times after thousands of other assignments costs the square
// of its facts before any cap applies. The check: a file four times as large
// takes about four times the CPU time to read, never about sixteen.
import { expect, it } from "vitest";
import { readFacts as expressFacts } from "../src/frameworks/express/facts.js";
import { readFacts as fastapiFacts } from "../src/frameworks/fastapi/facts.js";
import { readFacts as goFacts } from "../src/frameworks/go-http/facts.js";
import { expectLinear, growthTests, readerCpuMs } from "../src/test-timing.js";
import type { Lang } from "../src/types.js";

// `n` other module-level assignments, the two constants, then n / 2
// concatenations of them, each file under the plugins' 256 KiB read cap.
const sources: Record<string, { lang: Lang; read: (root: never) => unknown; source: (n: number) => string; n: number }> = {
  express: {
    lang: "javascript",
    read: expressFacts as (root: never) => unknown,
    n: 3000,
    source: (n) => ['import express from "express";', "const app = express();", ...Array.from({ length: n }, (_, i) => `const a${i} = "1";`), 'const P = "/api";', 'const S = "/users";', ...Array.from({ length: n / 2 }, () => 'app.get(P + "/" + S + "/" + P, h);')].join("\n"),
  },
  fastapi: {
    lang: "python",
    read: fastapiFacts as (root: never) => unknown,
    n: 7000,
    source: (n) => ["from fastapi import FastAPI", "app = FastAPI()", ...Array.from({ length: n }, (_, i) => `a${i}=1`), 'P = "/api"', 'S = "/users"', ...Array.from({ length: n / 2 }, () => 'c.get(P+"/"+S)')].join("\n"),
  },
  go: {
    lang: "go",
    read: goFacts as (root: never) => unknown,
    n: 2600,
    source: (n) => ["package main", 'import "net/http"', ...Array.from({ length: n }, (_, i) => `const a${i} = "1"`), 'const P = "/api"', 'const S = "/users"', "func main() {", "\tmux := http.NewServeMux()", ...Array.from({ length: n / 2 }, () => '\tmux.HandleFunc(P+"/"+S+"/"+P+"/"+S+"/"+P+"/"+S, h)'), "}"].join("\n"),
  },
};

growthTests("the constants a fact reader looks up", () => {
  for (const [plugin, s] of Object.entries(sources)) {
    it(`${plugin}: reads a file four times as large in about four times the CPU time, never the square`, async () => {
      const large = s.source(s.n * 2);
      expect(large.length).toBeLessThan(256 * 1024);
      const read = s.read as (root: unknown) => unknown;
      expectLinear(`the ${plugin} fact reader`, await readerCpuMs(s.lang, [s.source(s.n / 2)], read), await readerCpuMs(s.lang, [large], read));
    }, 120_000);
  }
});
