// Ways the graph's folder in the owning repository could fail, each checked
// below on a real git repo in a temp folder, with real files and, where two
// processes matter, real child processes:
// 1. crash-between-files: a publisher killed after it wrote some files of a
//    generation leaves a folder that is listed, opened or pointed at, or
//    `current` moves; or the collector removes that folder while it may
//    still be in flight (under an hour old), or never removes it after.
// 2. A generation whose files do not match its manifest (a changed byte, a
//    missing file) is listed or opened, even when `current` names it.
// 3. concurrent-readers: two publishers in two processes at once lose a
//    generation, mix files of both into one, or leave `current` on the
//    older build; or a publisher waiting for the lock loses the folder it
//    wrote to a collection another process runs meanwhile.
// 4. collect-while-pinned: a leased generation is removed by a collection
//    that would otherwise remove it, or a released lease still protects it.
// 5. pin-versus-collect: a reader's lease taken while another process
//    publishes and collects lands on a generation that is being removed.
// 6. pid-reuse: a lease of a dead process past 24 hours, or of a pid that
//    now belongs to another process (alive, other start time), keeps its
//    generation; or a live reader past 24 hours, or a dead one under 24
//    hours, loses its generation.
// 7. quota-with-leases: over the size bound the collector removes leased
//    content, the newest build or `current`, removes newer content before
//    older, or fails the publish when protected content alone exceeds the
//    bound instead of reporting it.
// 8. disk-full: a full disk throws, moves `current`, leaves half a
//    generation visible, or the facts writer keeps trying after the first
//    failure.
// 9. A link at `.openqodex/graph`, at a facts folder, at a generation folder
//    or at `current` is followed by a read or a write.
// 10. A file under `.openqodex/graph` that git tracks (a commit could ship
//     forged facts or generations) is used instead of refused.
// 11. A file other users can read (not 0600) or a folder they can enter
//     (not 0700), including a graph folder an older version made 0755.
// 12. reopen-dirty-generation: the capture's ref is not kept while a
//     generation of its tree is kept, so `git show <tree>:<path>` loses a
//     dirty file's bytes after an edit and `git gc --prune=now`; or the ref
//     outlives the last generation of its tree.
// 13. two-partial-one-complete: three publishes of identical input share an
//     id or a folder, or `complete/<tree>` names a partial build or an older
//     complete one.
// 14. The 5, 2, 5 sequence: facts of a complete build are pruned by the
//     collection after a later partial build that did not visit them; or
//     facts no kept inventory names are never pruned once every kept build
//     is complete.
// 15. Facts: an entry with another key, a corrupt body, a body that fails
//     the schema or one over 32 MiB is returned; hasFacts says yes for a
//     link or a folder; a write leaves a temp file behind.
// 16. The folder lock: a lock of a dead process, of a reused pid, or older
//     than 60 seconds blocks the folder; a live lock is taken over; the wait
//     does not end in "busy" after 10 seconds, or leaves a timer that keeps
//     the process alive.
// 17. meta.json: two processes updating it at once lose an update.
// 18. A cache entry of the layout before this one (`graph/<sha1>.json`) or
//     a temp file a crash left in the graph folder stays forever and counts
//     against the size bound; or the folder's own files are removed.
// 19. Listing the builds reads every file of every build (seconds once a
//     build holds a 100 MB index), although a file left as it was published
//     needs no new check before it is read.
// 20. Over the size bound the facts the newest build names are removed
//     while an older kept build's large index stays (measured on vscode:
//     a 552 MB index kept, the facts of every file removed, and the next
//     build parsed everything again).
// 21. A store already open keeps reading and writing after .openqodex or
//     .openqodex/graph is moved aside and a link to it is left at the old
//     name: the folder it remembered is the same folder, now reached
//     through a link.
// 22. A graph folder other users can write is used, so facts or builds
//     they planted there are read as the developer's own; or its refusal
//     stops the build, narrows it to look trusted, or reaches no one. The
//     same for the record of builds in OpenQodex's home.
// 23. A facts file another user owns, or one other users can write, is
//     read; or the build does not say how many it refused.
// 24. A build whose manifest this user's store did not write is opened,
//     listed or leased: a copy of a valid build under a new id with its
//     manifest written again for that id, a build edited under its own id
//     with its checksums computed again, or a store using another home.
// 25. A folder or a link named lock.takeover (beside a lock its holder
//     left) or lock makes every publication wait its full 10 seconds and
//     fail, forever; or one that is safe to remove (yours, not a link,
//     past the stale window) is kept, or one that is not is removed, or the
//     build does not say why it was not saved.
// 26. A folder named like a build made in the future (a clock that ran
//     ahead, or a planted name) and holding no valid manifest is never
//     removed: its age is taken from the time in its name.
// 27. A facts file planted with the developer's own user (0600, the right
//     key, valid facts with calls removed, as an archive extracted over the
//     repository could leave) is read, so the graph hides callers; or the
//     facts parsed again in its place are never trusted after, so every
//     later build parses that file again.
// 28. A build and the record of builds in OpenQodex's home, copied from
//     another repository (or kept from a repository that stood at the same
//     path before), vouch for a build or a facts file here.
// 29. A record whose repository identity is missing or names another
//     repository vouches for anything.
// 30. Facts a process wrote before it was killed, without publishing, are
//     trusted by the next build.
// 31. The record grows forever: facts and builds the collector removes, or
//     the developer deletes, keep their entries.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, chownSync, copyFileSync, cpSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildGraph, factsKey } from "../src/build.js";
import { blobId } from "../src/capture/inventory.js";
import { isFileFacts } from "../src/safe-fs.js";
import { ownStart } from "../src/store/lock.js";
import { openStore } from "../src/store/store.js";
import { buildIdTime, type GraphStore, type PublishResult } from "../src/store/types.js";
import { factsOf, keyOf, publishInput } from "./fixtures/store/input.js";
import { callSites, commitAll, git, makeRepo, symbol } from "./helpers.js";
import { adoptTempDir, removeTempDirs, tempDir } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

const HOUR = 3600_000;
const here = dirname(fileURLToPath(import.meta.url));
let bundle = "";
// OpenQodex's home for every store here, the child processes' included:
// the record of the builds each store published lives there, never in the
// developer's own ~/.openqodex.
const HOME = tempDir("oq-store-home-");

// store-child.ts bundled with esbuild (the bundler tsup uses) into one .mjs
// file a child `node` process runs; the code is this repo's own, unchanged.
beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const tsup = dirname(require.resolve("tsup/package.json"));
  const esbuild = createRequire(join(tsup, "package.json"))("esbuild") as { build: (options: Record<string, unknown>) => Promise<unknown> };
  const dir = tempDir("oq-store-child-");
  bundle = join(dir, "child.mjs");
  await esbuild.build({
    entryPoints: [join(here, "store-child.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    outfile: bundle,
    logLevel: "silent",
    banner: { js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' },
  });
}, 60_000);

type ChildDone = { out: Record<string, unknown> | null; signal: NodeJS.Signals | null; startedAt: number; exitedAt: number; stderr: string };

function child(command: Record<string, unknown>): { proc: ChildProcess; done: Promise<ChildDone> } {
  const startedAt = Date.now();
  const proc = spawn(process.execPath, [bundle, JSON.stringify({ home: HOME, ...command })], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  proc.stdout!.on("data", (b: Buffer) => (stdout += b.toString("utf8")));
  proc.stderr!.on("data", (b: Buffer) => (stderr += b.toString("utf8")));
  const done = new Promise<ChildDone>((resolve) => {
    let exitedAt = 0;
    let signal: NodeJS.Signals | null = null;
    proc.on("exit", (_code, s) => {
      exitedAt = Date.now();
      signal = s;
    });
    proc.on("close", () => {
      let out: Record<string, unknown> | null = null;
      try {
        out = JSON.parse(stdout.trim().split("\n").pop() ?? "") as Record<string, unknown>;
      } catch {
        // killed, or crashed: stderr says why
      }
      resolve({ out, signal, startedAt, exitedAt, stderr });
    });
  });
  return { proc, done };
}

function repo(): string {
  const root = makeRepo({ "a.ts": "export const a = 1;\n" });
  commitAll(root);
  return root;
}

function outside(): string {
  const dir = tempDir("oq-store-out-");
  return dir;
}

async function storeOf(root: string, opts: { maxCacheMb?: number; now?: () => number; home?: string } = {}): Promise<GraphStore> {
  const opened = await openStore(root, { ...opts, home: opts.home ?? HOME });
  if (!opened.ok) throw new Error(opened.reason);
  return opened.store;
}

function ok(r: PublishResult): string {
  if (!r.ok) throw new Error(`publish failed: ${r.error}: ${r.reason}`);
  return r.id;
}

const later = (ms: number) => (): number => Date.now() + ms;
const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));
const ids = (store: GraphStore): string[] => store.list().map((m) => m.id);
const folders = (store: GraphStore): string[] => readdirSync(join(store.dir, "generations")).sort();
const there = (path: string): boolean => lstatSync(path, { throwIfNoEntry: false }) !== undefined;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    out.push(path);
    if (lstatSync(path).isDirectory()) out.push(...walk(path));
  }
  return out;
}

// A lease file as a reader in another process would have written it.
function leaseBy(store: GraphStore, id: string, pid: number, start: string, ageMs: number): string {
  const name = `${pid}-0-${randomBytes(4).toString("hex")}.json`;
  writeFileSync(join(store.dir, "leases", name), JSON.stringify({ id, pid, start, purpose: "review", time: Date.now() - ageMs }), { mode: 0o600 });
  return name;
}

// A pid no process has: a child that has already ended.
function deadPid(): number {
  return spawnSync(process.execPath, ["-e", ""]).pid!;
}

const OTHER_START = "Mon Jan 1 00:00:00 2001";

describe("generations", () => {
  it("1. a publisher killed between files leaves a folder that is never listed, opened or pointed at, kept for an hour as a build in flight, then removed", async () => {
    const root = repo();
    const store = await storeOf(root);
    const first = ok(await store.publish(publishInput({ tag: "first" })));
    const run = child({ cmd: "publish", repo: root, tag: "crash", count: 1, at: 0, complete: true, files: 6000, bytes: 256 });
    const gens = join(store.dir, "generations");
    let half = "";
    const deadline = Date.now() + 20_000;
    while (half === "" && Date.now() < deadline) {
      for (const name of readdirSync(gens)) if (name !== first && readdirSync(join(gens, name)).length >= 20) half = name;
      if (half === "") await sleep(2);
    }
    run.proc.kill("SIGKILL");
    expect((await run.done).signal).toBe("SIGKILL");
    expect(half).not.toBe("");
    expect(there(join(gens, half, "manifest.json"))).toBe(false);
    expect(ids(store)).toEqual([first]);
    expect(store.open({ id: half })).toBeNull();
    expect(store.open("current")?.manifest.id).toBe(first);
    // Named by hand in `current`, it still does not open.
    writeFileSync(join(store.dir, "current"), `${half}\n`);
    expect(store.open("current")).toBeNull();
    expect(await store.lease("current", "cli")).toBeNull();
    writeFileSync(join(store.dir, "current"), `${first}\n`);
    // Under an hour old, it may be a build still writing.
    expect((await store.collect()).removedGenerations).toEqual([]);
    expect(there(join(gens, half))).toBe(true);
    const twoHoursOn = await storeOf(root, { now: later(2 * HOUR) });
    expect((await twoHoursOn.collect()).removedGenerations).toEqual([half]);
    expect(folders(store)).toEqual([first]);
  }, 60_000);

  it("2. a generation whose files no longer match its manifest is never listed or opened, even when current names it", async () => {
    const root = repo();
    const store = await storeOf(root);
    const a = ok(await store.publish(publishInput({ tag: "a" })));
    const b = ok(await store.publish(publishInput({ tag: "b" })));
    expect(ids(store)).toEqual([b, a]);
    const projects = join(store.dir, "generations", b, "projects.json");
    // One byte changed, the length kept.
    writeFileSync(projects, readFileSync(projects, "utf8").replace('"b"', '"c"'));
    expect(ids(store)).toEqual([a]);
    expect(store.open({ id: b })).toBeNull();
    expect(store.open("current")).toBeNull();
    expect(await store.lease("current", "review")).toBeNull();
    unlinkSync(join(store.dir, "generations", a, "coverage.json"));
    expect(store.list()).toEqual([]);
    // A generation opened before a file changed reads that file as missing.
    const c = ok(await store.publish(publishInput({ tag: "c" })));
    const g = store.open({ id: c })!;
    expect(g.read("projects.json")).toContain('"c"');
    expect(g.read("manifest.json")).toBeNull();
    expect(g.read("../../current")).toBeNull();
    const cProjects = join(store.dir, "generations", c, "projects.json");
    writeFileSync(cProjects, readFileSync(cProjects, "utf8").replace('"c"', '"d"'));
    expect(g.read("projects.json")).toBeNull();
    expect(await store.lease({ tree: "0".repeat(40) }, "cli")).toBeNull();
  });

  it("3. two publishers in two processes at once give two valid generations, one pointer to the newer, and no file of one in the other", async () => {
    const root = repo();
    const store = await storeOf(root);
    const at = Date.now() + 1500;
    const tags = ["left", "right"];
    const runs = tags.map((tag) => child({ cmd: "publish", repo: root, tag, count: 1, at, complete: true, files: 300, bytes: 64 }));
    const outs = await Promise.all(runs.map((r) => r.done));
    const published = outs.map((o) => {
      const r = (o.out?.results as PublishResult[] | undefined)?.[0];
      return r?.ok ? r.id : `failed: ${JSON.stringify(o.out)} ${o.stderr}`;
    });
    expect(published[0]).not.toBe(published[1]);
    expect(ids(store).sort()).toEqual([...published].sort());
    expect(store.open("current")?.manifest.id).toBe([...published].sort()[1]);
    for (const [i, tag] of tags.entries()) {
      const other = tags[1 - i]!;
      const g = store.open({ id: published[i]! })!;
      const texts = Object.keys(g.manifest.files)
        .filter((p) => p !== "inventory.json")
        .map((p) => g.read(p));
      expect(texts.length).toBe(302);
      expect(texts.every((t) => t !== null && t.includes(tag) && !t.includes(other))).toBe(true);
    }
  }, 60_000);

  it("3b. a publisher waiting for the lock keeps the folder it wrote through a collection another process runs meanwhile", async () => {
    const root = repo();
    const store = await storeOf(root);
    const first = ok(await store.publish(publishInput({ tag: "first", complete: false })));
    const lock = join(store.dir, "lock");
    writeFileSync(lock, JSON.stringify({ pid: process.pid, start: await ownStart(), time: Date.now() }), { mode: 0o600 });
    const run = child({ cmd: "publish", repo: root, tag: "waiting", count: 1, at: 0, complete: false, files: 50, bytes: 16 });
    const gens = join(store.dir, "generations");
    const deadline = Date.now() + 20_000;
    let waiting = "";
    while (waiting === "" && Date.now() < deadline) {
      for (const name of readdirSync(gens)) if (name !== first && readdirSync(join(gens, name)).length >= 53) waiting = name;
      if (waiting === "") await sleep(5);
    }
    expect(waiting).not.toBe("");
    // Release the hold, then collect while the publisher is still in flight.
    // Whichever process takes the freed lock first, the assertions below
    // hold: a collection that runs before the manifest exists must keep the
    // fresh folder, and one that runs after the publish must keep the fresh
    // build. A collection that loses the race waits out the publish instead
    // of failing on a busy lock, which is what flaked under full-suite load
    // when the publish held the lock past the 10 second wait.
    rmSync(lock);
    const releasedAt = Date.now();
    let removed: string[] | undefined;
    try {
      removed = (await store.collect()).removedGenerations;
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("held the graph folder's lock")) throw error;
      const raced = await run.done;
      expect((raced.out?.results as PublishResult[] | undefined)?.[0], raced.stderr).toMatchObject({ ok: true, id: waiting });
      removed = (await store.collect()).removedGenerations;
    }
    expect(removed).toEqual([]);
    const done = await run.done;
    const result = (done.out?.results as PublishResult[] | undefined)?.[0];
    expect(result, done.stderr).toMatchObject({ ok: true, id: waiting });
    expect(store.open("current")?.manifest.id).toBe(waiting);
    // The waiter finished after the hold was released, never before, and
    // well inside a generous ceiling: it waited out the lock, it did not
    // slip through early or stall on a busy timeout.
    expect(done.exitedAt).toBeGreaterThanOrEqual(releasedAt);
    expect(done.exitedAt - releasedAt).toBeLessThan(60_000);
  }, 120_000);

  it("13. three publishes of identical input get three ids in order, and complete/<tree> names the newest complete build", async () => {
    const root = repo();
    const store = await storeOf(root);
    const tree = git(root, "write-tree").trim();
    const same = (complete: boolean) => publishInput({ tag: "same", tree, complete });
    const pointer = (): string => readFileSync(join(store.dir, "complete", tree), "utf8").trim();
    // Made in one millisecond by one process.
    const three = (await Promise.all([store.publish(same(true)), store.publish(same(true)), store.publish(same(true))])).map(ok);
    expect(new Set(three).size).toBe(3);
    expect([...three].sort()).toEqual(three);
    expect(pointer()).toBe(three[2]);
    // Two partial builds and one complete build of the same capture.
    ok(await store.publish(same(false)));
    ok(await store.publish(same(false)));
    expect(pointer()).toBe(three[2]);
    const complete = ok(await store.publish(same(true)));
    expect(pointer()).toBe(complete);
    expect(store.open({ tree })?.manifest.id).toBe(complete);
    const partial = ok(await store.publish(same(false)));
    expect(store.open("current")?.manifest.id).toBe(partial);
    expect(store.open({ tree })?.manifest.id).toBe(complete);
  });
});

describe("leases", () => {
  it("4. a leased generation survives a collection that would remove it, and goes once the lease is released", async () => {
    const store = await storeOf(repo());
    const a = ok(await store.publish(publishInput({ tag: "a", complete: false })));
    const held = await store.lease("current", "review");
    expect(held?.lease.id).toBe(a);
    const b = ok(await store.publish(publishInput({ tag: "b", complete: false })));
    const c = ok(await store.publish(publishInput({ tag: "c", complete: false })));
    expect((await store.collect()).removedGenerations).toEqual([b]);
    expect(ids(store)).toEqual([c, a]);
    expect(held!.generation.read("projects.json")).toContain('"a"');
    held!.lease.release();
    held!.lease.release();
    expect((await store.collect()).removedGenerations).toEqual([a]);
    expect(readdirSync(join(store.dir, "leases"))).toEqual([]);
  });

  it("5. a reader leasing in one process while another publishes and collects never holds a generation being removed", async () => {
    const root = repo();
    const store = await storeOf(root);
    ok(await store.publish(publishInput({ tag: "start", complete: false })));
    const reader = child({ cmd: "lease-loop", repo: root, rounds: 30, holdMs: 150 });
    const writer = child({ cmd: "publish-loop", repo: root, rounds: 60 });
    const [r, w] = await Promise.all([reader.done, writer.done]);
    expect(r.out?.failures, r.stderr).toEqual([]);
    expect(r.out?.leased).toBeGreaterThan(20);
    expect(w.out?.published, w.stderr).toBe(60);
    expect(w.out?.removed).toBeGreaterThan(10);
  }, 120_000);

  it("6. a lease of a dead process or a reused pid past 24 hours protects nothing; a dead reader under 24 hours and a live one past 24 hours keep theirs", async () => {
    const root = repo();
    const store = await storeOf(root);
    const publish = async (tag: string): Promise<string> => ok(await store.publish(publishInput({ tag, complete: false })));
    const dead = deadPid();
    const a = await publish("a");
    const deadOld = leaseBy(store, a, dead, OTHER_START, 25 * HOUR);
    const b = await publish("b");
    const reusedOld = leaseBy(store, b, process.pid, OTHER_START, 25 * HOUR);
    const c = await publish("c");
    const deadYoung = leaseBy(store, c, dead, OTHER_START, HOUR);
    const d = await publish("d");
    const live = (await store.lease({ id: d }, "mcp"))!;
    const e = await publish("e");
    await store.collect();
    expect(ids(store)).toEqual([e, d, c]);
    const leases = readdirSync(join(store.dir, "leases"));
    expect(leases).toContain(deadYoung);
    expect(leases).toContain(live.lease.file);
    expect(leases).not.toContain(deadOld);
    expect(leases).not.toContain(reusedOld);
    // A day on, the dead reader's lease is old; the live one's process still runs.
    const dayOn = await storeOf(root, { now: later(25 * HOUR) });
    await dayOn.collect();
    expect(ids(store)).toEqual([e, d]);
    live.lease.release();
    await dayOn.collect();
    expect(ids(store)).toEqual([e]);
  });
});

describe("size bound", () => {
  it("7. over a 1 MB bound the oldest facts no build names go first, then older builds no one holds, then facts no leased build names; leased builds stay and the overrun is reported", async () => {
    // Two hours on, so no fact counts as written by a build still running.
    // The facts are written under a larger bound (a writer holds the bound
    // as it writes); the 1 MB store then publishes and collects.
    const root = repo();
    const writer = await storeOf(root, { maxCacheMb: 64, now: later(2 * HOUR) });
    const store = await storeOf(root, { maxCacheMb: 1, now: later(2 * HOUR) });
    const keys = Array.from({ length: 30 }, (_, i) => keyOf(`q${i}`));
    const base = Date.now() / 1000 - 3 * 3600;
    for (const [i, k] of keys.entries()) {
      expect(writer.writeFacts(k, factsOf(`q${i}`, 300))).toBe("ok");
      utimesSync(join(store.dir, "facts", k.slice(0, 2), `${k}.json`), base + i, base + i);
    }
    // A build ends inside the folder lock (here its meta update), which
    // records in the home the facts it wrote.
    await writer.updateMeta((m) => m ?? {});
    // The 1 MB store writes nothing more: the folder is past its bound.
    expect(store.writeFacts(keyOf("over"), factsOf("over", 300))).toBe("over-budget");
    expect(store.hasFacts(keyOf("over"))).toBe(false);
    // A partial build names the five oldest; by the partial-build rule alone every fact would stay.
    const a = await store.publish(publishInput({ tag: "a", complete: false, keys: keys.slice(0, 5) }));
    const aId = ok(a);
    expect(a.ok && a.overBudget).toBeNull();
    expect(a.ok && a.collected.bytesAfter).toBeLessThanOrEqual(1024 * 1024);
    expect(keys.slice(0, 5).every((k) => store.hasFacts(k))).toBe(true);
    const gone = keys.slice(5).filter((k) => !store.hasFacts(k));
    expect(gone.length).toBeGreaterThan(0);
    expect(gone).toEqual(keys.slice(5, 5 + gone.length));

    // Leased and kept content alone exceeds the bound: the build still publishes.
    const held = (await store.lease("current", "review"))!;
    const big = { "index/big.jsonl": "z".repeat(1200 * 1024) };
    const b = await store.publish(publishInput({ tag: "b", complete: false, keys: keys.slice(0, 5), files: big }));
    const bId = ok(b);
    expect(b.ok && b.overBudget?.protected).toEqual([aId, bId].sort());
    expect(b.ok && b.overBudget!.totalBytes).toBeGreaterThan(1024 * 1024);
    expect(keys.slice(0, 5).every((k) => store.hasFacts(k))).toBe(true);
    expect(keys.slice(5).some((k) => store.hasFacts(k))).toBe(false);
    expect(ids(store)).toEqual([bId, aId]);

    // Released: the old build goes, then the older build no one holds now
    // (b, which c replaces as current); that is enough to be under the bound,
    // so the facts it named stay for the next build.
    held.lease.release();
    const c = await store.publish(publishInput({ tag: "c", complete: false }));
    const cId = ok(c);
    expect(c.ok && c.collected.removedGenerations).toEqual([aId, bId]);
    expect(c.ok && c.collected.bytesAfter).toBeLessThanOrEqual(1024 * 1024);
    expect(keys.slice(0, 5).every((k) => store.hasFacts(k))).toBe(true);
    expect(c.ok && c.overBudget).toBeNull();
    expect(ids(store)).toEqual([cId]);
  });
});

describe("disk full", () => {
  it("8. a full disk gives disk-full, leaves current where it was and no half generation, and stops the facts writer at the first failure", async () => {
    if (process.platform !== "darwin") {
      console.warn("skipped: the full-disk case makes a 2 MB disk image with hdiutil, which only macOS has");
      return;
    }
    const dir = outside();
    const image = join(dir, "full.dmg");
    const volume = join(dir, "mnt");
    mkdirSync(volume);
    for (const args of [
      ["create", "-quiet", "-size", "2m", "-fs", "HFS+", "-volname", "oqfull", image],
      ["attach", "-quiet", "-nobrowse", "-mountpoint", volume, image],
    ]) {
      const r = spawnSync("hdiutil", args, { encoding: "utf8" });
      if (r.status !== 0) throw new Error(`hdiutil ${args[0]}: ${r.stderr}`);
    }
    try {
      const root = join(volume, "repo");
      mkdirSync(root);
      git(root, "init", "-q", "--template=");
      const store = await storeOf(root);
      const first = ok(await store.publish(publishInput({ tag: "first" })));
      const big = await store.publish(publishInput({ tag: "big", files: { "index/big.jsonl": "z".repeat(3 * 1024 * 1024) } }));
      expect(big).toMatchObject({ ok: false, error: "disk-full" });
      expect(store.diskFull).toBe(true);
      expect(store.open("current")?.manifest.id).toBe(first);
      expect(ids(store)).toEqual([first]);
      expect(folders(store)).toEqual([first]);

      const fresh = await storeOf(root);
      let result = "ok";
      for (let n = 0; result === "ok" && n < 1000; n++) result = fresh.writeFacts(keyOf(`full${n}`), factsOf(`full${n}`, 300));
      expect(result).toBe("disk-full");
      expect(fresh.diskFull).toBe(true);
      expect(fresh.writeFacts(keyOf("after"), factsOf("after"))).toBe("disk-full");
      expect(fresh.hasFacts(keyOf("after"))).toBe(false);
      expect(walk(join(fresh.dir, "facts")).some((p) => p.endsWith(".tmp"))).toBe(false);
      expect(fresh.open("current")?.manifest.id).toBe(first);
    } finally {
      spawnSync("hdiutil", ["detach", "-force", volume]);
    }
  }, 120_000);
});

describe("links and tracked files", () => {
  it("9a. a link at .openqodex/graph or at one of its folders makes open refuse, and nothing is written where it points", async () => {
    const target = outside();
    const root = repo();
    mkdirSync(join(root, ".openqodex"), { mode: 0o700 });
    symlinkSync(target, join(root, ".openqodex", "graph"));
    const refused = await openStore(root, { home: HOME });
    expect(!refused.ok && refused.reason).toMatch(/\.openqodex\/graph is a symbolic link/);
    const root2 = repo();
    const store = await storeOf(root2);
    rmSync(join(store.dir, "facts"), { recursive: true });
    symlinkSync(target, join(store.dir, "facts"));
    const refused2 = await openStore(root2, { home: HOME });
    expect(!refused2.ok && refused2.reason).toMatch(/graph\/facts is a symbolic link/);
    expect(store.writeFacts(keyOf("through"), factsOf("through"))).toBe("refused");
    expect(readdirSync(target)).toEqual([]);
  });

  it("9b. a link at a facts folder is never followed: no read, no answer from hasFacts, no write", async () => {
    const store = await storeOf(repo());
    const target = outside();
    const key = keyOf("linked");
    // The store wrote these very bytes, so only the link can refuse them.
    expect(store.writeFacts(key, factsOf("linked"))).toBe("ok");
    rmSync(join(store.dir, "facts", key.slice(0, 2)), { recursive: true });
    writeFileSync(join(target, `${key}.json`), JSON.stringify({ key, facts: factsOf("linked") }));
    symlinkSync(target, join(store.dir, "facts", key.slice(0, 2)));
    expect(store.readFacts(key)).toBeNull();
    expect(store.hasFacts(key)).toBe(false);
    expect(store.writeFacts(key, factsOf("other"))).toBe("refused");
    expect(readdirSync(target)).toEqual([`${key}.json`]);
    expect(JSON.parse(readFileSync(join(target, `${key}.json`), "utf8")).facts).toEqual(factsOf("linked"));
  });

  it("9c. a link at a generation folder is never listed or opened, and the collector removes the link, not what it points at", async () => {
    const root = repo();
    const store = await storeOf(root);
    const a = ok(await store.publish(publishInput({ tag: "a" })));
    const moved = join(outside(), a);
    renameSync(join(store.dir, "generations", a), moved);
    symlinkSync(moved, join(store.dir, "generations", a));
    const files = readdirSync(moved).sort();
    expect(store.list()).toEqual([]);
    expect(store.open({ id: a })).toBeNull();
    expect(store.open("current")).toBeNull();
    await (await storeOf(root, { now: later(2 * HOUR) })).collect();
    expect(there(join(store.dir, "generations", a))).toBe(false);
    expect(readdirSync(moved).sort()).toEqual(files);
  });

  it("9d. a link at current is never read or written through", async () => {
    const store = await storeOf(repo());
    const a = ok(await store.publish(publishInput({ tag: "a" })));
    const file = join(outside(), "pointer");
    writeFileSync(file, `${a}\n`);
    unlinkSync(join(store.dir, "current"));
    symlinkSync(file, join(store.dir, "current"));
    expect(store.open("current")).toBeNull();
    const b = await store.publish(publishInput({ tag: "b" }));
    expect(b.ok).toBe(false);
    expect(readFileSync(file, "utf8")).toBe(`${a}\n`);
    expect(ids(store)).toEqual([a]);
  });

  it("21. a parent folder moved aside with a link to it at its old name is refused by every read and write of a store already open", async () => {
    for (const moved of [".openqodex", ".openqodex/graph"]) {
      const root = repo();
      const store = await storeOf(root);
      const key = keyOf("chain");
      expect(store.writeFacts(key, factsOf("chain"))).toBe("ok");
      const a = ok(await store.publish(publishInput({ tag: "a", keys: [key] })));
      await store.updateMeta(() => ({ rate: 1 }));
      // Every read works before the move, so a refusal below is the link's doing.
      expect(store.readFacts(key)).toEqual(factsOf("chain"));
      expect(store.hasFacts(key)).toBe(true);
      expect(ids(store)).toEqual([a]);
      expect(store.readMeta()).toEqual({ rate: 1 });
      const from = join(root, ...moved.split("/"));
      const aside = `${from}-aside`;
      renameSync(from, aside);
      symlinkSync(aside, from);
      const before = walk(aside).sort();
      expect(store.readFacts(key), moved).toBeNull();
      expect(store.hasFacts(key), moved).toBe(false);
      expect(store.list(), moved).toEqual([]);
      expect(store.open("current"), moved).toBeNull();
      expect(store.open({ id: a }), moved).toBeNull();
      expect(store.readMeta(), moved).toBeNull();
      await expect(store.lease({ id: a }, "cli"), moved).rejects.toThrow(/symbolic link/);
      expect(store.writeFacts(keyOf("new"), factsOf("new")), moved).toBe("refused");
      expect((await store.publish(publishInput({ tag: "b" }))).ok, moved).toBe(false);
      await expect(store.updateMeta(() => ({ rate: 2 })), moved).rejects.toThrow(/symbolic link/);
      expect(walk(aside).sort(), moved).toEqual(before);
    }
  });

  it("10. a file under .openqodex/graph that git tracks makes open refuse", async () => {
    const root = repo();
    mkdirSync(join(root, ".openqodex", "graph"), { recursive: true });
    writeFileSync(join(root, ".openqodex", "graph", "current"), "forged\n");
    git(root, "add", "-f", ".openqodex/graph/current");
    git(root, "commit", "-q", "-m", "forged");
    const refused = await openStore(root, { home: HOME });
    expect(!refused.ok && refused.reason).toMatch(/holds files git tracks/);
  });

  it("11. every file is 0600 and every folder 0700, and a graph folder an older version made 0755 is closed", async () => {
    const root = repo();
    mkdirSync(join(root, ".openqodex", "graph"), { recursive: true });
    chmodSync(join(root, ".openqodex", "graph"), 0o755);
    const store = await storeOf(root);
    expect(store.writeFacts(keyOf("m"), factsOf("m"))).toBe("ok");
    ok(await store.publish(publishInput({ tag: "m", tree: git(root, "write-tree").trim(), files: { "index/by-file/x.json": "{}" } })));
    const held = (await store.lease("current", "cli"))!;
    await store.updateMeta(() => ({ rate: 1 }));
    const all = [store.dir, ...walk(store.dir)];
    const wrong = all.filter((p) => (statSync(p).mode & 0o777) !== (statSync(p).isDirectory() ? 0o700 : 0o600));
    expect(wrong).toEqual([]);
    expect(all.length).toBeGreaterThan(12);
    held.lease.release();
  });
});

describe("git refs", () => {
  it("12. the capture's ref keeps a dirty file's bytes readable after an edit and git gc while a build of its tree is kept, and goes with the last one", async () => {
    const root = repo();
    const treeOf = (text: string): string => {
      writeFileSync(join(root, "a.ts"), text);
      git(root, "add", "a.ts");
      const tree = git(root, "write-tree").trim();
      git(root, "reset", "-q");
      return tree;
    };
    const refs = (): string[] =>
      git(root, "for-each-ref", "--format=%(refname)", "refs/openqodex/graph/")
        .trim()
        .split("\n")
        .filter(Boolean)
        .sort();
    const dirty = "export const a = 2; // dirty\n";
    const t2 = treeOf(dirty);
    const store = await storeOf(root);
    ok(await store.publish(publishInput({ tag: "dirty", tree: t2 })));
    expect(refs()).toEqual([`refs/openqodex/graph/${t2}`]);
    writeFileSync(join(root, "a.ts"), "export const a = 3;\n");
    git(root, "gc", "-q", "--prune=now");
    expect(git(root, "show", `${t2}:a.ts`)).toBe(dirty);
    // Two newer complete builds of other captures: the dirty one is no longer kept.
    const t3 = treeOf("export const a = 3;\n");
    const t4 = treeOf("export const a = 4;\n");
    ok(await store.publish(publishInput({ tag: "t3", tree: t3 })));
    ok(await store.publish(publishInput({ tag: "t4", tree: t4 })));
    expect(refs()).toEqual([t3, t4].map((t) => `refs/openqodex/graph/${t}`).sort());
    git(root, "gc", "-q", "--prune=now");
    expect(spawnSync("git", ["show", `${t2}:a.ts`], { cwd: root }).status).not.toBe(0);
  });
});

describe("facts", () => {
  it("14. facts a partial build did not visit survive its collection, and facts no build names go once every kept build is complete", async () => {
    const keys = [1, 2, 3, 4, 5].map((i) => keyOf(`f${i}`));
    // The sequence of T3: five files, then a partial build of two, then five.
    const store = await storeOf(repo(), { now: later(2 * HOUR) });
    for (const [i, k] of keys.entries()) store.writeFacts(k, factsOf(`f${i}`));
    ok(await store.publish(publishInput({ tag: "five", keys })));
    ok(await store.publish(publishInput({ tag: "two", complete: false, keys: keys.slice(0, 2) })));
    expect(keys.every((k) => store.readFacts(k) !== null)).toBe(true);
    ok(await store.publish(publishInput({ tag: "five-again", keys })));
    expect(keys.every((k) => store.hasFacts(k))).toBe(true);

    // The rule on its own: no complete build keeps these facts.
    const lone = await storeOf(repo(), { now: later(2 * HOUR) });
    for (const [i, k] of keys.entries()) lone.writeFacts(k, factsOf(`f${i}`));
    ok(await lone.publish(publishInput({ tag: "two", complete: false, keys: keys.slice(0, 2) })));
    await lone.collect();
    expect(keys.every((k) => lone.hasFacts(k))).toBe(true);
    // The partial build is still current when the first complete build collects.
    ok(await lone.publish(publishInput({ tag: "four", keys: keys.slice(0, 4) })));
    expect(keys.every((k) => lone.hasFacts(k))).toBe(true);
    ok(await lone.publish(publishInput({ tag: "four-again", keys: keys.slice(0, 4) })));
    expect(keys.map((k) => lone.hasFacts(k))).toEqual([true, true, true, true, false]);
  });

  it("15. a facts entry is returned only when its key, body and schema match, within 32 MiB; hasFacts says no for a link or a folder; a write leaves no temp file", async () => {
    const store = await storeOf(repo());
    const key = keyOf("one");
    const facts = factsOf("one", 3);
    expect(store.hasFacts(key)).toBe(false);
    expect(store.writeFacts(key, facts)).toBe("ok");
    expect(store.readFacts(key)).toEqual(facts);
    expect(store.hasFacts(key)).toBe(true);
    const folder = join(store.dir, "facts", key.slice(0, 2));
    expect(readdirSync(folder)).toEqual([`${key}.json`]);
    const file = join(folder, `${key}.json`);
    writeFileSync(file, JSON.stringify({ key: keyOf("two"), facts }));
    expect(store.readFacts(key)).toBeNull();
    writeFileSync(file, "{ not json");
    expect(store.readFacts(key)).toBeNull();
    writeFileSync(file, JSON.stringify({ key, facts: { ...facts, lang: "cobol" } }));
    expect(store.readFacts(key)).toBeNull();
    // Valid JSON padded past the bound.
    writeFileSync(file, `${JSON.stringify({ key, facts })}${" ".repeat(32 * 1024 * 1024)}`);
    expect(store.readFacts(key)).toBeNull();
    rmSync(file);
    const elsewhere = join(outside(), "facts.json");
    writeFileSync(elsewhere, JSON.stringify({ key, facts }));
    symlinkSync(elsewhere, file);
    expect(store.hasFacts(key)).toBe(false);
    expect(store.readFacts(key)).toBeNull();
    rmSync(file);
    mkdirSync(file);
    expect(store.hasFacts(key)).toBe(false);
    expect(store.writeFacts("../escape", facts)).toBe("refused");
    expect(store.readFacts("../escape")).toBeNull();
  });
});

describe("the folder lock", () => {
  it("16a. a lock left by a dead process, by a reused pid, or older than 60 seconds is taken over at once", async () => {
    const store = await storeOf(repo());
    const lock = join(store.dir, "lock");
    for (const holder of [
      { pid: deadPid(), start: OTHER_START, time: Date.now() },
      { pid: process.pid, start: OTHER_START, time: Date.now() },
      { pid: process.pid, start: await ownStart(), time: Date.now() - 61_000 },
    ]) {
      writeFileSync(lock, JSON.stringify(holder), { mode: 0o600 });
      const started = Date.now();
      ok(await store.publish(publishInput({ tag: "x" })));
      expect(Date.now() - started).toBeLessThan(3000);
      expect(there(lock)).toBe(false);
    }
  });

  it("25. a folder or a link named lock.takeover or lock ends in a finished build within seconds: an old folder of yours is removed and the build kept, a new folder or a link stays and the build runs in memory with the cause stated", async () => {
    for (const name of ["lock.takeover", "lock"]) {
      for (const kind of ["old folder", "new folder", "link"] as const) {
        const label = `${name} as ${kind}`;
        const root = repo();
        const store = await storeOf(root);
        ok(await store.publish(publishInput({ tag: "a" })));
        // A lock its holder left behind: a waiter takes it over through lock.takeover.
        if (name === "lock.takeover") writeFileSync(join(store.dir, "lock"), JSON.stringify({ pid: deadPid(), start: OTHER_START, time: Date.now() }), { mode: 0o600 });
        const path = join(store.dir, name);
        if (kind === "link") symlinkSync(outside(), path);
        else {
          mkdirSync(path);
          writeFileSync(join(path, "left"), "x");
          const t = Date.now() / 1000 - (kind === "old folder" ? 120 : 0);
          utimesSync(path, t, t);
        }
        const started = Date.now();
        // A store already open meets it when it publishes; a new one when it opens.
        const published = await store.publish(publishInput({ tag: "b" }));
        const reopened = await openStore(root, { home: HOME });
        const g = await buildGraph({ repoRoot: root, store: reopened.ok ? reopened.store : null, storeRefused: reopened.ok ? undefined : reopened.reason });
        expect(Date.now() - started, label).toBeLessThan(5000);
        if (kind === "old folder") {
          expect(published.ok, label).toBe(true);
          expect(reopened.ok, label).toBe(true);
          expect(g.status.generation, label).not.toBeNull();
          expect(there(path), label).toBe(false);
        } else {
          const cause = `.openqodex/graph/${name} is ${kind === "link" ? "a symbolic link" : "a folder"} where openqodex keeps its lock file`;
          expect(published, label).toMatchObject({ ok: false, error: "invalid" });
          expect(!published.ok && published.reason, label).toContain(cause);
          expect(!reopened.ok && reopened.reason, label).toContain(cause);
          expect(g.status.generation, label).toBeNull();
          expect(g.status.reasons[0], label).toContain(cause);
          expect(there(path), label).toBe(true);
        }
      }
    }
  }, 120_000);

  it("16b. a live lock holds a publisher in another process for 10 seconds, then busy, and that process ends at once after", async () => {
    const root = repo();
    const store = await storeOf(root);
    const a = ok(await store.publish(publishInput({ tag: "a" })));
    const lock = join(store.dir, "lock");
    writeFileSync(lock, JSON.stringify({ pid: process.pid, start: await ownStart(), time: Date.now() }), { mode: 0o600 });
    const done = await child({ cmd: "publish", repo: root, tag: "b", count: 1, at: 0, complete: true, files: 0, bytes: 0 }).done;
    rmSync(lock);
    expect((done.out?.results as PublishResult[] | undefined)?.[0], done.stderr).toMatchObject({ ok: false, error: "busy" });
    expect((done.out!.printedAt as number) - done.startedAt).toBeGreaterThanOrEqual(10_000);
    expect(done.exitedAt - (done.out!.printedAt as number)).toBeLessThan(1000);
    expect(folders(store)).toEqual([a]);
  }, 60_000);
});

describe("the graph folder", () => {
  it("18. a cache entry of the old layout and a temp file a crash left are removed once an hour old, and the folder's own files never", async () => {
    const root = repo();
    const store = await storeOf(root);
    ok(await store.publish(publishInput({ tag: "a" })));
    await store.updateMeta(() => ({ rate: 1 }));
    const oldEntry = join(store.dir, `${keyOf("old layout")}.json`);
    writeFileSync(oldEntry, "{}");
    writeFileSync(join(store.dir, ".current.123.abcdef01.tmp"), "half");
    await store.collect();
    expect(there(oldEntry)).toBe(true);
    await (await storeOf(root, { now: later(2 * HOUR) })).collect();
    expect(readdirSync(store.dir).sort()).toEqual(["complete", "current", "facts", "generations", "leases", "meta.json"]);
  });
});

describe("meta", () => {
  it("17. two processes updating meta.json at once lose no update", async () => {
    const root = repo();
    const store = await storeOf(root);
    expect(store.readMeta()).toBeNull();
    const runs = [child({ cmd: "meta", repo: root, rounds: 25 }), child({ cmd: "meta", repo: root, rounds: 25 })];
    const outs = await Promise.all(runs.map((r) => r.done));
    expect(outs.map((o) => o.out?.done)).toEqual([25, 25]);
    expect(store.readMeta()).toEqual({ count: 50 });
    writeFileSync(join(store.dir, "meta.json"), "[1, 2]");
    expect(store.readMeta()).toBeNull();
  }, 60_000);
});

describe("listing", () => {
  it("19. lists a build without reading its files while they are as published, and still refuses one that changed", async () => {
    const root = repo();
    const store = await storeOf(root);
    const a = ok(await store.publish(publishInput({ tag: "a" })));
    const projects = join(store.dir, "generations", a, "projects.json");
    // Unreadable but untouched: listing it needs no read, reading it fails.
    chmodSync(projects, 0o000);
    try {
      expect(ids(store)).toEqual([a]);
      expect(store.open({ id: a })?.read("projects.json")).toBeNull();
    } finally {
      chmodSync(projects, 0o600);
    }
    // Changed in place, length kept: refused again.
    writeFileSync(projects, readFileSync(projects, "utf8").replace('"a"', '"z"'));
    expect(ids(store)).toEqual([]);
  });
});

describe("the size bound and kept builds", () => {
  it("20. removes an older kept build that no one holds before the facts the newest build names", async () => {
    const root = repo();
    const writer = await storeOf(root, { maxCacheMb: 64, now: later(2 * HOUR) });
    const keys = Array.from({ length: 10 }, (_, i) => keyOf(`k${i}`));
    const old = Date.now() / 1000 - 3 * 3600;
    for (const [i, k] of keys.entries()) {
      expect(writer.writeFacts(k, factsOf(`k${i}`, 50))).toBe("ok");
      utimesSync(join(writer.dir, "facts", k.slice(0, 2), `${k}.json`), old + i, old + i);
    }
    // An older complete build with a large index, then a newer one naming the same facts.
    const a = ok(await writer.publish(publishInput({ tag: "a", keys, files: { "index/big.jsonl": "z".repeat(1100 * 1024) } })));
    const store = await storeOf(root, { maxCacheMb: 1, now: later(2 * HOUR) });
    const b = await store.publish(publishInput({ tag: "b", keys }));
    const bId = ok(b);
    expect(b.ok && b.collected.removedGenerations).toEqual([a]);
    expect(keys.every((k) => store.hasFacts(k))).toBe(true);
    expect(b.ok && b.overBudget).toBeNull();
    expect(ids(store)).toEqual([bId]);
  });
});

// Makes `path` a real file another user owns, the honest ways this machine
// allows: as root, a file written with `text` and given to uid 1 with
// chown; otherwise a hard link to a root-owned file on the same disk that
// only its owner can write (macOS allows that link; Linux with
// fs.protected_hardlinks refuses it). Null when neither is possible.
function otherOwned(path: string, text: string): "chown" | "link" | null {
  if (process.getuid?.() === 0) {
    writeFileSync(path, text, { mode: 0o600 });
    chownSync(path, 1, 1);
    return "chown";
  }
  const dev = statSync(dirname(path)).dev;
  for (const dir of ["/Library/Preferences", "/private/etc", "/etc"]) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const src = join(dir, name);
      const st = lstatSync(src, { throwIfNoEntry: false });
      // Readable by others too: the test copies its bytes after the check.
      if (!st?.isFile() || st.uid === process.getuid?.() || st.dev !== dev || (st.mode & 0o022) !== 0 || (st.mode & 0o004) === 0) continue;
      try {
        linkSync(src, path);
        return "link";
      } catch {
        // refused: the next one
      }
    }
  }
  return null;
}

describe("trust", () => {
  it("22. a graph folder other users can write is refused at open and left as it was, with the folder and the fix named, and the build runs in memory with that reason", async () => {
    for (const mode of [0o777, 0o770]) {
      const root = repo();
      const graph = join(root, ".openqodex", "graph");
      mkdirSync(graph, { recursive: true });
      chmodSync(graph, mode);
      const refused = await openStore(root, { home: HOME });
      const reason = refused.ok ? "" : refused.reason;
      expect(reason).toBe(`.openqodex/graph can be written by other users (mode 0${mode.toString(8)}), so what it holds may not be yours: remove .openqodex/graph and openqodex makes a new one`);
      expect(statSync(graph).mode & 0o777).toBe(mode);
      const g = await buildGraph({ repoRoot: root, store: null, storeRefused: reason });
      expect(g.status.filesParsed).toBe(1);
      expect(g.status.generation).toBeNull();
      expect(g.status.reasons[0]).toBe(`the graph folder is not used: ${reason}`);
      expect(readdirSync(graph)).toEqual([]);
    }
    // A layout folder in it other users can write: the same.
    const root = repo();
    await storeOf(root);
    chmodSync(join(root, ".openqodex", "graph", "generations"), 0o777);
    const refused = await openStore(root, { home: HOME });
    expect(!refused.ok && refused.reason).toMatch(/^\.openqodex\/graph\/generations can be written by other users \(mode 0777\)/);
    // The record of builds in OpenQodex's home: the same.
    const home = outside();
    await storeOf(repo(), { home });
    chmodSync(join(home, "graph"), 0o777);
    const homeRefused = await openStore(repo(), { home });
    expect(homeRefused.ok ? "" : homeRefused.reason).toBe(`${join(home, "graph")} can be written by other users (mode 0777), so the record of your graph builds there may not be yours: remove ${join(home, "graph")} and openqodex makes a new one`);
  });

  it("23. a facts file other users can write, or one another user owns, is a cache miss the store counts, and the build says how many it parsed again", async () => {
    const store = await storeOf(repo());
    const key = keyOf("mode");
    expect(store.writeFacts(key, factsOf("mode"))).toBe("ok");
    const file = join(store.dir, "facts", key.slice(0, 2), `${key}.json`);
    for (const [mode, trusted] of [
      [0o666, false],
      [0o620, false],
      [0o602, false],
      [0o644, true],
      [0o600, true],
    ] as const) {
      chmodSync(file, mode);
      expect(store.readFacts(key), mode.toString(8)).toEqual(trusted ? factsOf("mode") : null);
      expect(store.hasFacts(key), mode.toString(8)).toBe(trusted);
    }
    expect(store.refusedFacts).toBe(3);
    // A facts folder other users can write: every file in it is refused, and nothing is written there.
    chmodSync(dirname(file), 0o777);
    expect(store.readFacts(key)).toBeNull();
    expect(store.refusedFacts).toBe(4);
    expect(store.writeFacts(key, factsOf("mode"))).toBe("refused");
    chmodSync(dirname(file), 0o700);
    expect(store.readFacts(key)).toEqual(factsOf("mode"));
    expect(store.refusedFacts).toBe(4);

    // Owned by another user, in place of a file this store wrote. A hard
    // link brings that user's content, which is no facts entry: the count,
    // which a file with other bytes never moves, says the owner refused it.
    const otherKey = keyOf("other");
    expect(store.writeFacts(otherKey, factsOf("other"))).toBe("ok");
    const at = join(store.dir, "facts", otherKey.slice(0, 2), `${otherKey}.json`);
    unlinkSync(at);
    const how = otherOwned(at, JSON.stringify({ key: otherKey, facts: factsOf("other") }));
    if (how === null) {
      console.warn("skipped the other-owner case: not root, and no root-owned file on this disk could be hard linked (fs.protected_hardlinks)");
    } else {
      expect(store.readFacts(otherKey)).toBeNull();
      expect(store.hasFacts(otherKey)).toBe(false);
      expect(store.refusedFacts).toBe(5);
      // The same bytes in a file this user owns: read, and not counted.
      const mine = `${at}.mine`;
      copyFileSync(at, mine);
      unlinkSync(at);
      renameSync(mine, at);
      chmodSync(at, 0o600);
      expect(store.readFacts(otherKey)).toEqual(how === "chown" ? factsOf("other") : null);
      expect(store.refusedFacts).toBe(5);
      // The linked file's bytes are not the ones this store wrote.
      expect(store.changedFacts).toBe(how === "chown" ? 0 : 1);
    }

    // A build parses a refused file again and says how many.
    const root = repo();
    const built = await storeOf(root);
    expect((await buildGraph({ repoRoot: root, store: built, mode: "fresh" })).status.parses).toBe(1);
    expect((await buildGraph({ repoRoot: root, store: built, mode: "fresh" })).status.parses).toBe(0);
    const facts = walk(join(built.dir, "facts")).filter((p) => p.endsWith(".json"));
    expect(facts.length).toBe(1);
    chmodSync(facts[0]!, 0o666);
    const again = await buildGraph({ repoRoot: root, store: built, mode: "fresh" });
    expect(again.status.parses).toBe(1);
    expect(again.status.reasons).toContain("1 facts file in the graph folder could be changed by other users and was parsed again");
  });

  it("24. a build whose manifest this user's store did not write is never opened, listed or leased, and another home trusts none of this store's builds", async () => {
    const root = repo();
    const store = await storeOf(root);
    const a = ok(await store.publish(publishInput({ tag: "a" })));
    const gens = join(store.dir, "generations");
    const manifestOf = (id: string): Record<string, unknown> & { files: Record<string, unknown> } => JSON.parse(readFileSync(join(gens, id, "manifest.json"), "utf8"));
    // A copy of a under a newer id, its manifest written again for that id.
    const planted = `${(buildIdTime(a) + 1).toString(36).padStart(9, "0")}0000-zz-0123abcd`;
    cpSync(join(gens, a), join(gens, planted), { recursive: true });
    writeFileSync(join(gens, planted, "manifest.json"), `${JSON.stringify({ ...manifestOf(a), id: planted })}\n`, { mode: 0o600 });
    expect(ids(store)).toEqual([a]);
    expect(store.open({ id: planted })).toBeNull();
    expect(await store.lease({ id: planted }, "cli")).toBeNull();
    writeFileSync(join(store.dir, "current"), `${planted}\n`);
    expect(store.open("current")).toBeNull();
    expect(await store.lease("current", "review")).toBeNull();
    writeFileSync(join(store.dir, "current"), `${a}\n`);
    expect(store.open("current")?.manifest.id).toBe(a);
    // a itself edited under its own id, its checksums computed again.
    const projects = join(gens, a, "projects.json");
    const forged = readFileSync(projects, "utf8").replace('"a"', '"forged"');
    writeFileSync(projects, forged);
    const m = manifestOf(a);
    m.files["projects.json"] = { bytes: Buffer.byteLength(forged), sha256: createHash("sha256").update(forged).digest("hex") };
    writeFileSync(join(gens, a, "manifest.json"), `${JSON.stringify(m)}\n`);
    expect(ids(store)).toEqual([]);
    expect(store.open({ id: a })).toBeNull();
    // What this store publishes it trusts; a store with another home trusts none of it.
    const b = ok(await store.publish(publishInput({ tag: "b" })));
    expect(ids(store)).toEqual([b]);
    const elsewhere = await storeOf(root, { home: outside() });
    expect(ids(elsewhere)).toEqual([]);
    expect(elsewhere.open("current")).toBeNull();
  });
});

describe("future builds", () => {
  it("26. a folder named like a build from the future, with no valid manifest, is removed once its files are an hour old", async () => {
    const root = repo();
    const store = await storeOf(root);
    ok(await store.publish(publishInput({ tag: "a" })));
    const future = `${(Date.now() + 10 * 365 * 24 * HOUR).toString(36).padStart(9, "0")}0000-1-deadbeef`;
    const folder = join(store.dir, "generations", future);
    mkdirSync(folder, { mode: 0o700 });
    writeFileSync(join(folder, "inventory.json"), "{}", { mode: 0o600 });
    await (await storeOf(root, { now: later(2 * HOUR) })).collect();
    expect(there(folder)).toBe(false);
  });
});

// The record of what this user's store wrote, in OpenQodex's home.
function recordPath(root: string, home = HOME): string {
  return join(home, "graph", `${createHash("sha256").update(realpathSync(root)).digest("hex")}.json`);
}
type HomeRecord = { repo?: unknown; builds: Record<string, string>; facts: Record<string, string> };
const recordOf = (root: string): HomeRecord => JSON.parse(readFileSync(recordPath(root), "utf8")) as HomeRecord;
const factsFile = (store: GraphStore, key: string): string => join(store.dir, "facts", key.slice(0, 2), `${key}.json`);

describe("the record of facts and builds", () => {
  it("27. a planted 0600 facts file with the right key and valid facts with its calls removed is parsed again, the graph finds the calls, and the facts written in its place are read from the cache after", async () => {
    const files = {
      "a.ts": "export function f(): number {\n  return 1;\n}\n",
      "b.ts": 'import { f } from "./a.js";\n\nexport function g(): number {\n  return f(); // CALL\n}\n',
    };
    const root = makeRepo(files);
    commitAll(root);
    const first = await buildGraph({ repoRoot: root, store: await storeOf(root), mode: "fresh" });
    expect(callSites(first, symbol(first, "a.ts", "f"))).toEqual(["b.ts:4"]);
    const store = await storeOf(root);
    const inventory = JSON.parse(store.open("current")!.read("inventory.json")!) as { files: Record<string, { key: string }> };
    const key = inventory.files["b.ts"]!.key;
    const file = factsFile(store, key);
    const entry = JSON.parse(readFileSync(file, "utf8")) as { key: string; facts: { calls: unknown[] } };
    expect(entry.key).toBe(key);
    expect(entry.facts.calls.length).toBeGreaterThan(0);
    // Planted with the developer's own user: the right key, valid facts, no calls, 0600.
    entry.facts.calls = [];
    expect(isFileFacts(entry.facts)).toBe(true);
    writeFileSync(file, JSON.stringify(entry));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(file).uid).toBe(process.getuid?.());
    expect(store.readFacts(key)).toBeNull();
    expect(store.changedFacts).toBe(1);
    expect(store.refusedFacts).toBe(0);

    const again = await buildGraph({ repoRoot: root, store: await storeOf(root), mode: "fresh" });
    expect(again.status.parses).toBe(1);
    expect(callSites(again, symbol(again, "a.ts", "f"))).toEqual(["b.ts:4"]);
    expect(again.status.reasons).toContain("1 facts file in the graph folder differed from what openqodex recorded and was parsed again");
    // The same capture: no new build was published, and still the facts
    // written in place of the planted file are trusted by the next run.
    expect(again.status.generation).toBe(first.status.generation);
    const third = await buildGraph({ repoRoot: root, store: await storeOf(root), mode: "fresh" });
    expect(third.status.parses).toBe(0);
    expect(third.status.cacheHits).toBe(2);
    expect(callSites(third, symbol(third, "a.ts", "f"))).toEqual(["b.ts:4"]);
  });

  it("28. a build and its home record copied from another repository, or kept from a repository that stood at the same path before, vouch for no build and no facts", async () => {
    const a = repo();
    const storeA = await storeOf(a);
    const key = keyOf("transplant");
    expect(storeA.writeFacts(key, factsOf("transplant"))).toBe("ok");
    const built = ok(await storeA.publish(publishInput({ tag: "a", keys: [key] })));
    expect(ids(storeA)).toEqual([built]);
    expect(storeA.readFacts(key)).toEqual(factsOf("transplant"));

    // Another repository: A's graph folder and A's record copied in.
    const b = repo();
    cpSync(join(a, ".openqodex"), join(b, ".openqodex"), { recursive: true });
    copyFileSync(recordPath(a), recordPath(b));
    const storeB = await storeOf(b);
    expect(readFileSync(join(storeB.dir, "generations", built, "manifest.json"), "utf8")).toBe(readFileSync(join(storeA.dir, "generations", built, "manifest.json"), "utf8"));
    expect(ids(storeB)).toEqual([]);
    expect(storeB.open("current")).toBeNull();
    expect(storeB.readFacts(key)).toBeNull();
    expect(storeB.hasFacts(key)).toBe(false);
    // What B's store publishes itself it trusts; A's build stays refused.
    const own = ok(await storeB.publish(publishInput({ tag: "b" })));
    expect(ids(storeB)).toEqual([own]);

    // A moved aside and a copy put at its path: the same path, another folder.
    const aside = `${a}-aside`;
    renameSync(a, aside);
    adoptTempDir(aside);
    cpSync(aside, a, { recursive: true });
    const copy = await storeOf(a);
    expect(ids(copy)).toEqual([]);
    expect(copy.readFacts(key)).toBeNull();
    expect(copy.hasFacts(key)).toBe(false);
  });

  it("29. a record whose repository identity is missing or names another repository vouches for nothing, and the same record with this repository's identity vouches again", async () => {
    const root = repo();
    const store = await storeOf(root);
    const key = keyOf("identity");
    expect(store.writeFacts(key, factsOf("identity"))).toBe("ok");
    const a = ok(await store.publish(publishInput({ tag: "a", keys: [key] })));
    const path = recordPath(root);
    const original = readFileSync(path, "utf8");
    const record = JSON.parse(original) as HomeRecord & { repo: Record<string, unknown> };
    expect(Object.keys(record.builds)).toEqual([a]);
    expect(Object.keys(record.facts)).toEqual([key]);
    const other = repo();
    for (const [label, repoField] of [
      ["missing", undefined],
      ["another path", { ...record.repo, path: realpathSync(other) }],
      ["another folder", { ...record.repo, ino: String(statSync(other).ino) }],
      ["the path alone", realpathSync(root)],
    ] as const) {
      writeFileSync(path, JSON.stringify({ ...record, repo: repoField }));
      const reopened = await storeOf(root);
      expect(ids(reopened), label).toEqual([]);
      expect(reopened.readFacts(key), label).toBeNull();
      expect(reopened.hasFacts(key), label).toBe(false);
    }
    writeFileSync(path, original);
    const restored = await storeOf(root);
    expect(ids(restored)).toEqual([a]);
    expect(restored.readFacts(key)).toEqual(factsOf("identity"));
  });

  it("30. facts a process wrote before it was killed, without publishing, are parsed again by the next build", async () => {
    const text = "export function a(): number {\n  return 1;\n}\n";
    const root = makeRepo({ "a.ts": text });
    commitAll(root);
    const key = factsKey("typescript", blobId(Buffer.from(text)));
    const run = child({ cmd: "write-facts", repo: root, entries: [[key, factsOf("planted")]] });
    const file = join(root, ".openqodex", "graph", "facts", key.slice(0, 2), `${key}.json`);
    const deadline = Date.now() + 20_000;
    while (!there(file) && Date.now() < deadline) await sleep(5);
    run.proc.kill("SIGKILL");
    const done = await run.done;
    expect(done.signal, done.stderr).toBe("SIGKILL");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ key, facts: factsOf("planted") });

    const g = await buildGraph({ repoRoot: root, store: await storeOf(root), mode: "fresh" });
    expect(g.status.parses).toBe(1);
    expect(g.status.cacheHits).toBe(0);
    expect((g.defsByFile.get("a.ts") ?? []).map((d) => d.name)).toEqual(["a"]);
    // A file the record has no entry for is a plain cache miss: nothing changed it.
    expect(g.status.reasons.some((r) => r.includes("facts file"))).toBe(false);
  }, 60_000);

  it("31. the record keeps entries only for facts and builds the folder still holds: what the collector removes or the developer deletes leaves it at the next collection", async () => {
    const root = repo();
    const store = await storeOf(root, { now: later(2 * HOUR) });
    const keys = [1, 2, 3, 4, 5].map((i) => keyOf(`r${i}`));
    for (const [i, k] of keys.entries()) expect(store.writeFacts(k, factsOf(`r${i}`))).toBe("ok");
    // A complete build names four: the fifth goes with the collection.
    ok(await store.publish(publishInput({ tag: "four", keys: keys.slice(0, 4) })));
    expect(store.hasFacts(keys[4]!)).toBe(false);
    expect(Object.keys(recordOf(root).facts).sort()).toEqual(keys.slice(0, 4).sort());
    // The developer deletes one facts folder.
    rmSync(join(store.dir, "facts", keys[0]!.slice(0, 2)), { recursive: true });
    await store.collect();
    const left = keys.slice(0, 4).filter((k) => there(factsFile(store, k)));
    expect(left.length).toBeLessThan(4);
    expect(Object.keys(recordOf(root).facts).sort()).toEqual(left.sort());
    // Builds the collector removes leave it too.
    for (const tag of ["b", "c", "d"]) ok(await store.publish(publishInput({ tag, keys: left })));
    expect(Object.keys(recordOf(root).builds).sort()).toEqual(ids(store).sort());
    expect(ids(store).length).toBe(2);
  });
});
