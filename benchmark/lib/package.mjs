// The build a run benchmarks (run.mjs --package): the checkout's own build
// (`local`, the default, whose commit benchmark/build-cli.mjs records), or a
// package build as users install it:
//   npm:<version>     the published openqodex at that version, fetched once
//                     from https://registry.npmjs.org into the cache
//   file:<path.tgz>   a packed build, as `npm pack` writes it (a release
//                     candidate before it is published)
// A package build is unpacked into
// $OPENQODEX_BENCH_CACHE/packages/openqodex-<first 16 hex of the tarball's
// sha256>/package/, beside record.json, and a run uses its dist/bin.js and
// dist/lib.js. No npm command runs, so no lifecycle script, npm cache or
// npm log is involved.
//
// Failure list, written before the code:
// 1. A run on a package build is recorded as the checkout's commit, or
//    without the package's version and sha: the record names the package,
//    its version, the tarball's sha256 and sha512 integrity and its size,
//    and run.mjs records no commit for it.
// 2. A published package comes from wherever the caller's npm points, or
//    from a tarball on another host, or under a version the registry does
//    not list: the packument is read over HTTPS from registry.npmjs.org
//    itself (no setting changes the host), the requested version must be
//    in it, its tarball must be https on that same host, and the bytes
//    downloaded must match its sha512 integrity. The integrity is kept
//    beside the cached tarball and checked on every later use.
// 3. A tarball holds another package or version than asked: its
//    package.json must name openqodex, at the version asked for npm, and
//    the package must hold dist/bin.js and dist/lib.js.
// 4. A tarball replaced between its hashing and its unpacking runs under
//    the first one's hashes: its bytes are read once, and those bytes are
//    hashed and unpacked; the path is never read again.
// 5. A tarball member lands outside the package's folder or as a link: the
//    tarball is read here, not by a tar command, and a member with an
//    absolute path, a `..`, `.` or empty segment, a path outside package/,
//    a symbolic or hard link, or any type but a file or a folder refuses
//    the whole package before anything is written.
// 6. An unpacked package edited after it was unpacked runs under the
//    tarball's sha256: record.json holds the sha256 of every unpacked file,
//    and every file is checked against it before each use; a missing,
//    changed or added file, or a link, means the folder is unpacked again
//    from the tarball's bytes.
// 7. A half-unpacked folder is used: a package is unpacked in a temp folder
//    beside its place, checked, given its record last, and renamed into
//    place whole.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { gunzipSync } from "node:zlib";
import { cacheRoot } from "./licence.mjs";

export const PACKAGE_NAME = "openqodex";
/** The one registry a published package is read from. */
export const REGISTRY_HOST = "registry.npmjs.org";
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** A --package value: { kind: "local" }, { kind: "npm", version } or { kind: "file", path }; throws on anything else. */
export function parsePackageSpec(spec) {
  if (spec === "local") return { kind: "local" };
  if (typeof spec === "string" && spec.startsWith("npm:")) {
    const version = spec.slice(4);
    if (!VERSION.test(version)) throw new Error(`--package npm:<version> takes a version such as 0.12.0, not ${JSON.stringify(version)}`);
    return { kind: "npm", version };
  }
  if (typeof spec === "string" && spec.startsWith("file:") && spec.endsWith(".tgz")) return { kind: "file", path: resolve(spec.slice(5)) };
  throw new Error(`--package takes local, npm:<version> or file:<path to a .tgz npm pack wrote>, not ${JSON.stringify(spec)}`);
}

const integrityOf = (bytes) => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
const sha256Of = (bytes) => createHash("sha256").update(bytes).digest("hex");

/**
 * The tarball URL and sha512 integrity the registry's packument gives for
 * `version` (failure 2); throws when the version is absent, the tarball is
 * not https on the registry's own host, or no sha512 integrity is given.
 */
export function tarballOf(packument, version) {
  const dist = packument?.versions?.[version]?.dist;
  if (!dist) throw new Error(`the registry lists no ${PACKAGE_NAME}@${version}`);
  let url = null;
  try {
    url = new URL(dist.tarball);
  } catch {
    // not a URL
  }
  if (url === null || url.protocol !== "https:" || url.host !== REGISTRY_HOST || url.username !== "" || url.password !== "") {
    throw new Error(`the registry gives ${PACKAGE_NAME}@${version}'s tarball at ${JSON.stringify(dist.tarball)}, which is not on https://${REGISTRY_HOST}`);
  }
  const integrity = String(dist.integrity ?? "").split(/\s+/).find((h) => h.startsWith("sha512-"));
  if (!integrity) throw new Error(`the registry gives no sha512 integrity for ${PACKAGE_NAME}@${version}`);
  return { url: url.href, integrity };
}

// One GET over HTTPS that follows no redirect: the body's bytes.
async function get(url, accept) {
  let response;
  try {
    response = await fetch(url, { headers: { accept }, redirect: "error" });
  } catch (error) {
    throw new Error(`${url} could not be read: ${error?.cause?.code ?? error?.cause?.message ?? error.message}`);
  }
  if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

// The published tarball's bytes and the registry's integrity for them,
// from the cache or fetched from the registry (failure 2). The bytes are
// read once and checked against the integrity.
async function npmTarball(version, cache) {
  const dir = join(cache, "packages", "npm");
  const path = join(dir, `${PACKAGE_NAME}-${version}.tgz`);
  const meta = join(dir, `${PACKAGE_NAME}-${version}.json`);
  if (existsSync(path) && existsSync(meta)) {
    const saved = JSON.parse(readFileSync(meta, "utf8"));
    const bytes = readFileSync(path);
    if (integrityOf(bytes) !== saved.integrity) throw new Error(`${path} has integrity ${integrityOf(bytes)}, not the ${saved.integrity} the registry gave; move it and ${basename(meta)} to the Trash to fetch it again`);
    return { bytes, registryIntegrity: saved.integrity, from: saved.tarball };
  }
  const packument = JSON.parse((await get(`https://${REGISTRY_HOST}/${PACKAGE_NAME}`, "application/vnd.npm.install-v1+json")).toString("utf8"));
  const { url, integrity } = tarballOf(packument, version);
  const bytes = await get(url, "application/octet-stream");
  if (integrityOf(bytes) !== integrity) throw new Error(`the tarball downloaded from ${url} has integrity ${integrityOf(bytes)}, not the ${integrity} the registry gives`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${path}.tmp`, bytes);
  renameSync(`${path}.tmp`, path);
  writeFileSync(meta, `${JSON.stringify({ name: PACKAGE_NAME, version, tarball: url, integrity, fetchedAt: new Date().toISOString() }, null, 2)}\n`);
  return { bytes, registryIntegrity: integrity, from: url };
}

// ---------- the tarball, read here ----------

// The fields of a pax extended header.
function paxFields(body) {
  const out = {};
  let at = 0;
  const text = body.toString("utf8");
  while (at < text.length) {
    const space = text.indexOf(" ", at);
    const length = Number(text.slice(at, space));
    if (!Number.isInteger(length) || length <= 0) break;
    const record = text.slice(space + 1, at + length - 1);
    const eq = record.indexOf("=");
    out[record.slice(0, eq)] = record.slice(eq + 1);
    at += length;
  }
  return out;
}

// Why a member's path is refused, or null (failure 5).
function pathProblem(name) {
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) return "is an absolute path";
  if (name.includes("\\")) return "holds a backslash";
  const parts = name.replace(/\/$/, "").split("/");
  if (parts.includes("..")) return "goes through ..";
  if (parts.some((p) => p === "" || p === ".")) return "has an empty or . segment";
  if (parts[0] !== "package") return "is outside package/";
  return null;
}

/**
 * The members of a gzipped tarball, from its bytes: [{ path, type: "file" |
 * "dir", mode, body }]. Throws, naming the member, on anything but files
 * and folders under package/ (failure 5).
 */
export function tarMembers(gz) {
  const tar = gunzipSync(gz);
  const out = [];
  let pax = {};
  let longName = null;
  for (let at = 0; at + 512 <= tar.length; ) {
    const h = tar.subarray(at, at + 512);
    if (h.every((b) => b === 0)) break;
    const field = (start, length) => {
      const s = h.subarray(start, start + length);
      const end = s.indexOf(0);
      return s.subarray(0, end < 0 ? length : end).toString("utf8");
    };
    if (h[124] & 0x80) throw new Error("the tarball has a member too large to be a package file");
    const size = Number.parseInt(field(124, 12).trim() || "0", 8);
    if (!Number.isInteger(size) || size < 0 || at + 512 + size > tar.length) throw new Error("the tarball is cut short or not a tar");
    const type = h[156] === 0 ? "0" : String.fromCharCode(h[156]);
    const body = tar.subarray(at + 512, at + 512 + size);
    at += 512 + Math.ceil(size / 512) * 512;
    if (type === "x") {
      pax = paxFields(body);
      continue;
    }
    if (type === "g") continue;
    if (type === "L") {
      longName = body.toString("utf8").replace(/\0+$/, "");
      continue;
    }
    const prefix = field(257, 6) === "ustar" ? field(345, 155) : "";
    const name = pax.path ?? longName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
    pax = {};
    longName = null;
    if (type === "1" || type === "2") throw new Error(`the tarball's member ${name} is a ${type === "1" ? "hard link" : "symbolic link"}; a package build holds files and folders only`);
    if (type !== "0" && type !== "7" && type !== "5") throw new Error(`the tarball's member ${name} is of tar type ${JSON.stringify(type)}; a package build holds files and folders only`);
    const problem = pathProblem(name);
    if (problem) throw new Error(`the tarball's member ${name} ${problem}; a package build's files all lie under package/`);
    out.push({ path: name.replace(/\/$/, ""), type: type === "5" ? "dir" : "file", mode: Number.parseInt(field(100, 8).trim() || "644", 8), body: type === "5" ? null : Buffer.from(body) });
  }
  return out;
}

// ---------- the unpacked folder ----------

// Every entry under `dir` except record.json: { files: { path: sha256 },
// odd: [entries that are neither files nor folders] }.
function treeOf(dir) {
  const files = {};
  const odd = [];
  const walk = (rel) => {
    for (const name of readdirSync(join(dir, rel)).sort()) {
      const path = rel === "" ? name : `${rel}/${name}`;
      if (path === "record.json") continue;
      const st = lstatSync(join(dir, path));
      if (st.isDirectory()) walk(path);
      else if (st.isFile()) files[path] = sha256Of(readFileSync(join(dir, path)));
      else odd.push(path);
    }
  };
  walk("");
  return { files, odd };
}

// Why the unpacked folder may not be used as it is (failure 6), or null.
// `expected` is the record the tarball's own bytes make ({ name, version,
// sha256, integrity, bytes, files }), never record.json alone: record.json
// is a file in the same folder and can be edited together with the code it
// vouches for. Every field of record.json must equal it, since the run
// reports the record it returns.
function folderProblem(dir, record, expected) {
  // A field the unpacking never writes (a `spec`, say) would override what
  // the run reports and the release gate it picks.
  if (Object.keys(record).sort().join() !== "bytes,files,integrity,name,sha256,version") return "its record holds other fields";
  if (record.sha256 !== expected.sha256 || record.integrity !== expected.integrity || record.bytes !== expected.bytes) return "its record names another tarball";
  if (record.name !== expected.name || record.version !== expected.version) return "its record names another package";
  const named = Object.keys(record.files ?? {});
  if (named.length !== Object.keys(expected.files).length || named.some((path) => record.files[path] !== expected.files[path])) return "its record lists other files";
  const { files, odd } = treeOf(dir);
  if (odd.length > 0) return `${odd[0]} is neither a file nor a folder`;
  for (const [path, hash] of Object.entries(expected.files)) if (files[path] !== hash) return `${path} is ${files[path] ? "changed" : "missing"}`;
  const added = Object.keys(files).find((path) => !(path in expected.files));
  return added ? `${added} was added` : null;
}

// Unpacks `members` into a new folder `into` (failure 5): files and
// folders only, each path checked again against the folder.
function unpack(members, into) {
  mkdirSync(into, { recursive: true });
  for (const m of members) {
    const target = resolve(into, m.path);
    const rel = relative(into, target);
    if (rel === "" || rel.startsWith("..") || rel.split(sep).includes("..")) throw new Error(`the tarball's member ${m.path} lies outside the package's folder`);
    if (m.type === "dir") mkdirSync(target, { recursive: true });
    else {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, m.body, { mode: m.mode & 0o111 ? 0o755 : 0o644 });
    }
  }
}

/**
 * The package build `spec` names, unpacked in the cache: { dir, cli, lib,
 * record, extracted }, where record is what the manifest's `package` holds
 * (with `files`, the sha256 of every unpacked file) and extracted says
 * "now", "reused" or "again" (the folder differed from its record). Null for
 * `local`. Throws when it cannot be fetched, read or checked.
 */
export async function preparePackage(spec, { cache = cacheRoot() } = {}) {
  const p = parsePackageSpec(spec);
  if (p.kind === "local") return null;
  let source;
  if (p.kind === "npm") source = await npmTarball(p.version, cache);
  else {
    if (!existsSync(p.path)) throw new Error(`there is no file ${p.path}`);
    source = { bytes: readFileSync(p.path), registryIntegrity: null };
  }
  // The bytes are read once; everything below works on them (failure 4).
  const { bytes } = source;
  const sha256 = sha256Of(bytes);
  const shown = p.kind === "npm" ? spec : `file:${basename(p.path)}`;
  const root = join(cache, "packages");
  const dir = join(root, `${PACKAGE_NAME}-${sha256.slice(0, 16)}`);
  const result = (extracted) => {
    const record = JSON.parse(readFileSync(join(dir, "record.json"), "utf8"));
    const pkg = join(dir, "package");
    return { dir: pkg, cli: join(pkg, "dist", "bin.js"), lib: join(pkg, "dist", "lib.js"), extracted, record: { spec: shown, ...record, registryIntegrity: source.registryIntegrity } };
  };
  let extracted = "now";
  if (existsSync(join(dir, "record.json"))) {
    // The expected record comes from the tarball bytes, not from record.json.
    const expectedFiles = {};
    let manifest = null;
    for (const m of tarMembers(bytes)) {
      if (m.type !== "file") continue;
      expectedFiles[m.path] = sha256Of(m.body);
      if (m.path === "package/package.json") manifest = m.body;
    }
    let problem;
    try {
      const { name, version } = JSON.parse(manifest.toString("utf8"));
      problem = folderProblem(dir, JSON.parse(readFileSync(join(dir, "record.json"), "utf8")), { name, version, sha256, integrity: integrityOf(bytes), bytes: bytes.length, files: expectedFiles });
    } catch {
      problem = "its record cannot be read";
    }
    if (problem === null) return result("reused");
    // Never run what differs from the tarball: unpack it again from the bytes.
    rmSync(dir, { recursive: true, force: true });
    extracted = "again";
  }
  const members = tarMembers(bytes);
  mkdirSync(root, { recursive: true });
  const temp = mkdtempSync(join(root, ".unpack-"));
  try {
    unpack(members, temp);
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(join(temp, "package", "package.json"), "utf8"));
    } catch {
      throw new Error(`${shown} holds no package/package.json`);
    }
    if (manifest.name !== PACKAGE_NAME) throw new Error(`${shown} is the package ${manifest.name}, not ${PACKAGE_NAME}`);
    if (p.kind === "npm" && manifest.version !== p.version) throw new Error(`${shown} holds version ${manifest.version}, not ${p.version}`);
    for (const f of ["dist/bin.js", "dist/lib.js"]) if (!existsSync(join(temp, "package", f))) throw new Error(`${shown} holds no ${f}`);
    const record = { name: manifest.name, version: manifest.version, sha256, integrity: integrityOf(bytes), bytes: bytes.length, files: treeOf(temp).files };
    writeFileSync(join(temp, "record.json"), `${JSON.stringify(record, null, 2)}\n`);
    try {
      renameSync(temp, dir);
    } catch (error) {
      // Another run put the same package in place first.
      if (!existsSync(join(dir, "record.json"))) throw error;
    }
    return result(extracted);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

// ---------- a release run on the published package ----------

/**
 * Refuses a release run's package record that is not the published package
 * of its release (run.mjs --package npm:<release>): openqodex at that
 * version, with its tarball's sha256 and a sha512 integrity equal to the
 * one the registry gave when it was fetched. Throws "refused: ...".
 */
export function npmReleaseRecord(release, p) {
  const named = p === null || p === undefined ? "no package record" : p.spec === "local" ? `the local build${p.commit ? ` at ${String(p.commit).slice(0, 12)}` : ""}` : `${p.spec ?? "an unnamed package"} (${p.name ?? "no name"}@${p.version ?? "no version"})`;
  if (p === null || p === undefined || p.spec !== `npm:${release}` || p.name !== PACKAGE_NAME || p.version !== release) throw new Error(`refused: the run names the release ${release}, but it reviewed ${named}, not ${PACKAGE_NAME}@${release} from npm (run.mjs --package npm:${release}); a release run reviews the published package of its release, and a local build is never one`);
  if (!/^[0-9a-f]{64}$/.test(String(p.sha256)) || !String(p.integrity).startsWith("sha512-") || p.registryIntegrity !== p.integrity) throw new Error(`refused: the run's package record of ${PACKAGE_NAME}@${release} does not hold a tarball sha256 and a sha512 integrity that equals the one the registry gave when it was fetched`);
}

/**
 * The release a run's package record makes it once the npm registry, asked
 * again, gives that version the record's integrity: { release, package },
 * or a thrown refusal. `answer` is the registry's record of openqodex at
 * `release` (lib/martian-board.mjs npmRegistryAnswer). lib/suites.mjs
 * selectCases and lib/martian-board.mjs releaseGate both decide an npm
 * release here.
 */
export function npmRelease(release, p, answer) {
  npmReleaseRecord(release, p);
  if (answer?.name !== PACKAGE_NAME || answer?.version !== release || answer?.dist?.integrity !== p.integrity) throw new Error(`refused: the npm registry (https://${REGISTRY_HOST}) gives ${answer?.name}@${answer?.version} the integrity ${answer?.dist?.integrity}, and the run's package record of ${PACKAGE_NAME}@${release} holds ${p.integrity}; the run did not review the published build of its release`);
  return { release, package: p };
}
