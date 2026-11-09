// The licence of a real pull request's repository, and the GitHub facts the
// split groups repositories by (current name, fork source). Every answer
// GitHub gives is cached under $OPENQODEX_BENCH_CACHE/github/, so the ingest
// asks once and reads the cache from then on.
//
// Failure list, written before the code:
// 1. A pull request whose repository has no licence is used: a repository
//    with no licence file is class none, and the ingest excludes it and
//    names it in its report. No licence text is guessed by a script.
// 1a. A licence GitHub cannot name is recorded as verified: NOASSERTION,
//    or an id on none of the lists below, is class unverified. The case is
//    used and published in full like any other (Sid, 2026-10-12). A person's
//    reading is noted only for the licence file read (its sha256); the
//    class stays unverified. Local board conversion accepts it; board
//    submissions still refuse it through publishRefusal.
// 2. Two ingests read the licence differently (a new day, a changed
//    repository), so the same dataset gives two suites: the first answer is
//    cached with the day it was read, and the cache is the only source after
//    that. A person moves a cache file to the Trash to read it again.
// 3. A quota, login or permission error is read as "no licence": only a 404
//    on the licence endpoint of a repository GitHub knows means no licence
//    file. A 401, 403 or 429, a rate limit, or any other failure stops at
//    once with GitHub's own words, and nothing is cached.
// 4. A renamed or moved repository is grouped under its old name only:
//    GitHub's current full name is cached beside the name asked.
// 5. An OR expression is classed by a closed option: chosen is the first
//    permissive option, else the first copyleft one, else the first
//    source-available one.
// 6. Code from a repository whose licence is not permissive is published:
//    excerpts is "full" only for permissive, "omit" otherwise
//    (outside adjudication reads the class).
// 7. A pull request named only by its link is read at a different commit on
//    each ingest (a push after the first reading): GitHub's answer for the
//    pull request is cached with the day it was read, and the cache is the
//    only source after that, as for failure 2.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const PERMISSIVE = ["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "MPL-2.0", "Unlicense", "Zlib", "0BSD"];
const COPYLEFT = /^(A|L)?GPL-[23]\.[01](-only|-or-later|\+)?$/;
const SOURCE_AVAILABLE = /^(Elastic-2\.0|SSPL-1\.0|BUSL-1\.1|FSL-1\.[01]-(MIT|Apache-2\.0|ALv2))$/;
export const USE = "local review and scoring";
// The recognised licence classes, in the order an OR expression's
// options are taken.
export const PUBLISHABLE = ["permissive", "copyleft", "source-available"];
// The classes a case may be used and published under; none excludes it.
export const USABLE = [...PUBLISHABLE, "unverified"];

// A person's reading of a licence file GitHub cannot name, by repository:
// what the file says, who read it and when, and the file read (its path and
// sha256 as GitHub's licence API served it). A reading is a note; the case
// stays unverified and is used and published like any other.
export const LICENCE_READINGS = Object.freeze({
  "getsentry/sentry": { spdx: "FSL-1.1-Apache-2.0", by: "Sid", on: "2026-10-11", file: "LICENSE.md", fileSha256: "1f2a39da390f36830e83d88b17f7720527a7c95f8f137b16ebb68f283cbbfabc" },
  "ai-code-review-evaluation/sentry-greptile": { spdx: "FSL-1.1-Apache-2.0", by: "Sid", on: "2026-10-11", file: "LICENSE.md", fileSha256: "1f2a39da390f36830e83d88b17f7720527a7c95f8f137b16ebb68f283cbbfabc" },
});

const classOf = (id) => (PERMISSIVE.includes(id) ? "permissive" : COPYLEFT.test(id) ? "copyleft" : SOURCE_AVAILABLE.test(id) ? "source-available" : null);

// A licence id or an SPDX OR expression to { chosen, class }.
export function classify(spdx) {
  if (spdx === null || spdx === undefined || spdx === "") return { chosen: null, class: "none" };
  const options = String(spdx)
    .split(/\s+OR\s+/i)
    .map((o) => o.replace(/^\(|\)$/g, "").replace(/\s+WITH\s+.*$/i, "").trim());
  for (const wanted of PUBLISHABLE) {
    const chosen = options.find((o) => classOf(o) === wanted);
    if (chosen) return { chosen, class: wanted };
  }
  return { chosen: null, class: "unverified" };
}

export const cacheRoot = (env = process.env) => env.OPENQODEX_BENCH_CACHE || join(homedir(), ".cache", "openqodex-bench");

const answerPath = (cache, repo) => join(cache, "github", `${repo.toLowerCase().replace("/", "__")}.json`);

// A cached GitHub answer: { v: 1, asked, readOn, found, fullName, fork,
// source, licence? }. licence is absent when it was never asked for, null
// when the repository has no licence file, else { spdx, key, file,
// fileSha256 }.
export function readRepoAnswer(cache, repo) {
  const path = answerPath(cache, repo);
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
}

export function saveRepoAnswer(cache, answer) {
  const path = answerPath(cache, answer.asked);
  mkdirSync(join(cache, "github"), { recursive: true });
  const ordered = { v: 1, asked: answer.asked, readOn: answer.readOn, found: answer.found, fullName: answer.fullName ?? null, fork: answer.fork ?? false, source: answer.source ?? null };
  if (answer.licence !== undefined) ordered.licence = answer.licence;
  writeFileSync(`${path}.tmp`, `${JSON.stringify(ordered, null, 2)}\n`);
  renameSync(`${path}.tmp`, path);
  return ordered;
}

// One GitHub API call through the gh command. Returns the parsed body, or
// null on a 404; stops on anything else.
function ghApi(path) {
  try {
    return JSON.parse(execFileSync("gh", ["api", path], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 26 }));
  } catch (error) {
    const said = `${error.stderr ?? ""}${error.stdout ?? ""}`.trim() || error.message;
    if (/\(HTTP 404\)/.test(said) && !/rate limit/i.test(said)) return null;
    throw new Error(`gh api ${path} failed, so the ingest stops: ${said}`);
  }
}

// GitHub's answer for a repository, from the cache or, unless offline, from
// GitHub (then cached). With `licence`, the licence file is read too.
export function repoAnswer(repo, { cache = cacheRoot(), offline = false, licence = false, today = new Date().toISOString().slice(0, 10) } = {}) {
  const cached = readRepoAnswer(cache, repo);
  if (cached && (!licence || !cached.found || cached.licence !== undefined)) return cached;
  if (offline) throw new Error(`no cached GitHub answer for ${repo}${licence ? " with its licence" : ""} in ${join(cache, "github")}, and the ingest is offline`);
  let answer = cached;
  if (!answer) {
    const body = ghApi(`repos/${repo}`);
    answer = body ? { asked: repo, readOn: today, found: true, fullName: body.full_name, fork: body.fork === true, source: body.fork ? (body.source?.full_name ?? body.parent?.full_name ?? null) : null } : { asked: repo, readOn: today, found: false, fullName: null, fork: false, source: null };
  }
  if (licence && answer.found) {
    const body = ghApi(`repos/${repo}/license`);
    answer = { ...answer, licence: body ? { spdx: body.license?.spdx_id ?? null, key: body.license?.key ?? null, file: body.path ?? null, fileSha256: body.content ? createHash("sha256").update(Buffer.from(body.content, "base64")).digest("hex") : null } : null };
  }
  return saveRepoAnswer(cache, answer);
}

// Whether GitHub still serves a commit of a repository: a pull request
// pushed over after a dataset was made can leave the dataset's head with no
// branch or pull request ref, and GitHub then drops it. Cached like the
// repository answers, as { v: 1, repo, sha, readOn, served }, under
// github/commits/<owner>__<name>/<sha>.json. "No commit found" and a 404
// mean not served; any other failure stops with GitHub's words, and nothing
// is cached.
const commitPath = (cache, repo, sha) => join(cache, "github", "commits", repo.toLowerCase().replace("/", "__"), `${sha}.json`);

export function saveCommitAnswer(cache, answer) {
  const path = commitPath(cache, answer.repo, answer.sha);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(`${path}.tmp`, `${JSON.stringify({ v: 1, repo: answer.repo, sha: answer.sha, readOn: answer.readOn, served: answer.served }, null, 2)}\n`);
  renameSync(`${path}.tmp`, path);
  return answer;
}

export function commitAnswer(repo, sha, { cache = cacheRoot(), offline = false, today = new Date().toISOString().slice(0, 10) } = {}) {
  const path = commitPath(cache, repo, sha);
  if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8"));
  if (offline) throw new Error(`no cached GitHub answer for ${repo} commit ${sha} in ${join(cache, "github", "commits")}, and the ingest is offline`);
  let served = true;
  try {
    execFileSync("gh", ["api", `repos/${repo}/commits/${sha}`, "--jq", ".sha"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    const said = `${error.stderr ?? ""}${error.stdout ?? ""}`.trim() || error.message;
    if (!/No commit found for SHA|\(HTTP 404\)/.test(said) || /rate limit/i.test(said)) throw new Error(`gh api repos/${repo}/commits/${sha} failed, so the ingest stops: ${said}`);
    served = false;
  }
  return saveCommitAnswer(cache, { repo, sha, readOn: today, served });
}

// A pull request as GitHub serves it: its base and head commits, when it was
// opened, its size and its repository's language. A dataset that names a
// pull request by its link alone (Martian's) freezes these at ingest. Cached
// like the repository answers, as { v: 1, repo, number, readOn, found,
// baseSha, headSha, createdAt, additions, deletions, language }, under
// github/pulls/<owner>__<name>/<number>.json. A 404 means not served; any
// other failure stops with GitHub's words, and nothing is cached.
const pullPath = (cache, repo, number) => join(cache, "github", "pulls", repo.toLowerCase().replace("/", "__"), `${number}.json`);

export function savePullAnswer(cache, answer) {
  const path = pullPath(cache, answer.repo, answer.number);
  mkdirSync(join(path, ".."), { recursive: true });
  const keys = ["repo", "number", "readOn", "found", "baseSha", "headSha", "createdAt", "additions", "deletions", "language"];
  writeFileSync(`${path}.tmp`, `${JSON.stringify({ v: 1, ...Object.fromEntries(keys.map((k) => [k, answer[k] ?? null])) }, null, 2)}\n`);
  renameSync(`${path}.tmp`, path);
  return answer;
}

export function pullAnswer(repo, number, { cache = cacheRoot(), offline = false, today = new Date().toISOString().slice(0, 10) } = {}) {
  const path = pullPath(cache, repo, number);
  if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8"));
  if (offline) throw new Error(`no cached GitHub answer for ${repo} pull request ${number} in ${join(cache, "github", "pulls")}, and the ingest is offline`);
  const body = ghApi(`repos/${repo}/pulls/${number}`);
  const found = body !== null && typeof body.base?.sha === "string" && typeof body.head?.sha === "string";
  return savePullAnswer(cache, {
    repo,
    number,
    readOn: today,
    found,
    baseSha: found ? body.base.sha : null,
    headSha: found ? body.head.sha : null,
    createdAt: found ? (body.created_at ?? null) : null,
    additions: found ? (body.additions ?? null) : null,
    deletions: found ? (body.deletions ?? null) : null,
    language: found ? (body.base.repo?.language ?? null) : null,
  });
}

// The licence record of a case (PLAN-benchmark 4.2), from a cached answer.
export function licenceRecord(answer) {
  const l = answer?.found ? answer.licence : null;
  const spdx = l ? l.spdx : null;
  const { chosen, class: cls } = l ? (spdx === null ? { chosen: null, class: "unverified" } : classify(spdx)) : classify(null);
  const read = cls === "unverified" ? LICENCE_READINGS[String(answer?.asked ?? "").toLowerCase()] : undefined;
  return {
    spdx,
    chosen,
    class: cls,
    file: l?.file ?? null,
    fileSha256: l?.fileSha256 ?? null,
    at: `the default branch on ${answer?.readOn ?? "an unknown day"}`,
    source: "the GitHub licence API",
    use: USE,
    excerpts: cls === "permissive" ? "full" : "omit",
    ...(read && read.fileSha256 === l?.fileSha256 ? { reading: { spdx: read.spdx, by: read.by, on: read.on } } : {}),
  };
}

// Why a case under this licence is excluded, or null when it may be used
// and published, including an unverified one.
export function licenceExclusion(record) {
  if (USABLE.includes(record.class)) return null;
  if (record.class === "none") return "licence none: the repository has no licence file, so its code is all rights reserved";
  return `licence ${record.class}: no class this benchmark uses, so the case is not used`;
}

// A licence record in one line for a report: its id and file, and a
// person's reading when there is one.
export const licenceNote = (l) => `${l.spdx ?? "none"}, ${l.file ?? "no file"}${l.reading ? `; read by ${l.reading.by} on ${l.reading.on} as ${l.reading.spdx}` : ""}`;

// Why a board submission refuses a run because of its cases' licences,
// or null. Published runs and local board conversions include unverified
// cases. `cases` are { name, licence } with licence the class. Anything
// that writes a board submission calls this before writing anything.
export function publishRefusal(cases) {
  const names = cases.filter((c) => c.licence === "unverified").map((c) => c.name).sort();
  if (names.length === 0) return null;
  return `refused: ${names.length} case${names.length === 1 ? "" : "s"} of this run hold${names.length === 1 ? "s" : ""} an unverified licence, which board submissions still refuse (GitHub names no licence it can classify): ${names.join(", ")}`;
}
