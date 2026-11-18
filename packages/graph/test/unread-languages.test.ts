// Source files in a language the graph does not parse must not vanish.
//
// Ways it could fail, written before the code:
//  1. A Rust-only repository says "ok" with no eligible file and nothing
//     else: the user cannot tell the graph read none of the code.
//  2. A mixed repository counts the Rust files nowhere.
//  3. Assets and config (json, md, css, images) are counted as source, or
//     vendored folders (target, node_modules) inflate the count.
//  4. The count goes stale: a .rs file added after a build leaves the kept
//     build looking current, so the count never changes.
//  5. The count leaks into the answers' reasons (a floor on every answer)
//     or into the review packet's build block.
//  6. A link, or a path git or the caller lists that is gone from disk, is
//     counted as a file: only regular files are.
import { rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildGraph, openStore } from "../src/index.js";
import { workTreeDigest } from "../src/build.js";
import { listInventory } from "../src/capture/inventory.js";
import { RepoReader } from "../src/safe-fs.js";
import { query } from "../src/query/engine.js";
import type { Session } from "../src/query/answer.js";
import { commitAll, makeHome, makeRepo, writeFiles } from "./helpers.js";
import { removeTempDirs } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

const home = makeHome();

const RUST = {
  "Cargo.toml": '[package]\nname = "demo"\nversion = "0.1.0"\nedition = "2021"\n[dependencies]\naxum = "0.7"\n',
  "src/lib.rs": "pub fn get_user(id: u32) -> u32 { id }\npub fn helper() -> u32 { get_user(1) }\n",
  "src/main.rs": 'use axum::{routing::get, Router};\nuse demo::helper;\nfn main() { let _app: Router = Router::new().route("/users/:id", get(|| async { "x" })); let _ = helper(); }\n',
};
const TS = {
  "web/a.ts": "export function a(): number { return b(); }\nexport function b(): number { return 1; }\n",
  "web/package.json": '{"name":"web","version":"1.0.0"}\n',
};

function sessionOf(graph: Awaited<ReturnType<typeof buildGraph>>): Session {
  return { graph, generation: "test-build", treeSha: null, builtAt: null, laterEditsKnown: false };
}
const status = (graph: Awaited<ReturnType<typeof buildGraph>>) => query(sessionOf(graph), { apiVersion: 1, kind: "status" }).items[0] as Record<string, unknown>;
const caps = (graph: Awaited<ReturnType<typeof buildGraph>>) => query(sessionOf(graph), { apiVersion: 1, kind: "capabilities" }).items[0] as Record<string, unknown>;

describe("source files the graph cannot read", () => {
  it("counts the files of a Rust-only repository by language (1)", async () => {
    const root = makeRepo(RUST);
    const g = await buildGraph({ repoRoot: root, store: null });
    expect(g.status.eligibleFiles).toBe(0);
    expect(g.status.unreadLanguages).toEqual([{ language: "rust", files: 2 }]);
    expect(status(g).unreadLanguages).toEqual([{ language: "rust", files: 2 }]);
    expect(caps(g).unreadLanguages).toEqual([{ language: "rust", files: 2 }]);
  });

  it("counts the Rust files of a mixed repository next to the TypeScript one (2)", async () => {
    const root = makeRepo({ ...TS, "core/Cargo.toml": RUST["Cargo.toml"], "core/src/lib.rs": RUST["src/lib.rs"], "core/src/main.rs": RUST["src/main.rs"] });
    const g = await buildGraph({ repoRoot: root, store: null });
    expect(g.status.eligibleFiles).toBe(1);
    expect(g.status.unreadLanguages).toEqual([{ language: "rust", files: 2 }]);
  });

  it("counts each known language once, by name, in a stable order (2)", async () => {
    const root = makeRepo({
      "a.c": "int a(void){return 1;}\n",
      "a.h": "int a(void);\n",
      "b.cpp": "int b(){return 1;}\n",
      "b.hpp": "int b();\n",
      "c.cs": "class C {}\n",
      "d.kt": "fun d() {}\n",
      "d.kts": "val x = 1\n",
      "e.swift": "func e() {}\n",
      "f.php": "<?php\n",
      "g.scala": "object G\n",
      "h.rs": "fn h() {}\n",
    });
    const g = await buildGraph({ repoRoot: root, store: null });
    expect(g.status.unreadLanguages).toEqual([
      { language: "c", files: 2 },
      { language: "c#", files: 1 },
      { language: "c++", files: 2 },
      { language: "kotlin", files: 2 },
      { language: "php", files: 1 },
      { language: "rust", files: 1 },
      { language: "scala", files: 1 },
      { language: "swift", files: 1 },
    ]);
  });

  it("counts nothing for assets, config and vendored folders (3)", async () => {
    const root = makeRepo({
      "package.json": '{"name":"x"}\n',
      "README.md": "# x\n",
      "style.css": "a{}\n",
      "logo.png": "x",
      "data.json": "{}\n",
      "target/debug/gen.rs": "fn g() {}\n",
      "node_modules/pkg/x.rs": "fn g() {}\n",
      "vendor/lib/x.c": "int x;\n",
    });
    const g = await buildGraph({ repoRoot: root, store: null });
    expect(g.status.unreadLanguages ?? []).toEqual([]);
    expect(status(g).unreadLanguages ?? []).toEqual([]);
  });

  it("never puts the count in the reasons or the status (5)", async () => {
    const root = makeRepo({ ...TS, ...RUST });
    const g = await buildGraph({ repoRoot: root, store: null });
    expect(g.status.status).toBe("ok");
    expect(g.status.reasons).toEqual([]);
    const a = query(sessionOf(g), { apiVersion: 1, kind: "callers", target: { name: "a", file: "web/a.ts" } });
    expect(a.unknown.reasons.join(" ")).not.toMatch(/rust/i);
  });

  it("changes the count and rebuilds when a .rs file is added or removed (4)", async () => {
    const root = makeRepo({ ...TS, "src/lib.rs": RUST["src/lib.rs"] });
    commitAll(root);
    const opened = await openStore(root, { home });
    if (!opened.ok) throw new Error(opened.reason);
    const st = opened.store;
    const first = await buildGraph({ repoRoot: root, store: st, mode: "retained" });
    expect(first.status.unreadLanguages).toEqual([{ language: "rust", files: 1 }]);
    const digest1 = await workTreeDigest(root, 1_000_000);
    writeFiles(root, { "src/extra.rs": "pub fn extra() {}\n" });
    expect(await workTreeDigest(root, 1_000_000)).not.toBe(digest1);
    const second = await buildGraph({ repoRoot: root, store: st, mode: "retained" });
    expect(Object.keys(second.status.stages)).not.toContain("load-index");
    expect(second.status.unreadLanguages).toEqual([{ language: "rust", files: 2 }]);
    // The same capture again is the kept build, and keeps its count.
    const third = await buildGraph({ repoRoot: root, store: st, mode: "retained" });
    expect(third.status.unreadLanguages).toEqual([{ language: "rust", files: 2 }]);
  });

  it("counts only regular files: never a link, nor a listed path that is gone (6)", async () => {
    const root = makeRepo({ ...TS, "src/lib.rs": RUST["src/lib.rs"], "src/gone.rs": "pub fn gone() {}\n" });
    commitAll(root);
    rmSync(join(root, "src/gone.rs"));
    symlinkSync("lib.rs", join(root, "src/link.rs"));
    symlinkSync("missing.rs", join(root, "src/dangling.rs"));
    const g = await buildGraph({ repoRoot: root, store: null });
    expect(g.status.unreadLanguages).toEqual([{ language: "rust", files: 1 }]);
    const files = ["src/lib.rs", "src/gone.rs", "src/link.rs", "src/dangling.rs", "src/never.rs"].map((path) => ({ path, blob: "0".repeat(40) }));
    expect(listInventory(root, new RepoReader(root), { files, maxFileBytes: 1_000_000 }).unread).toEqual({ rust: 1 });
  });
});
