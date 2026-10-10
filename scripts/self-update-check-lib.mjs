// What scripts/check-self-update.mjs does before it runs a published
// package, apart so a test can hold it: the environment every process it
// starts gets, and the release check the updater makes.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// The only variables a process the check starts receives, besides the ones
// the check sets (HOME, OPENQODEX_HOME and the like): what node, git and tar
// need to run and to reach the registry. Built from an allowlist, as the
// reviewer drivers build theirs (packages/review/src/agents/claude.ts), so
// no token of the job (NPM_TOKEN, NODE_AUTH_TOKEN, GITHUB_TOKEN, the Actions
// OIDC request token, a cloud key) reaches a package under test.
export const ALLOWED_ENV = ["PATH", "LANG", "TZ", "TMPDIR", "TERM", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE"];

export function cleanEnv(base, set) {
  const out = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && (ALLOWED_ENV.includes(key) || key.startsWith("LC_"))) out[key] = value;
  }
  return { ...out, ...set };
}

// This repository's own fetch, verification and unpacking modules
// (packages/cli/test/release-entry.ts), bundled with the esbuild that tsup
// brings, from a checkout with its dependencies installed.
export async function loadVerifier(root) {
  const cli = join(root, "packages", "cli");
  const require = createRequire(join(cli, "package.json"));
  const tsup = require.resolve("tsup/package.json");
  const esbuild = createRequire(tsup)("esbuild");
  const outfile = join(mkdtempSync(join(tmpdir(), "oq-release-verify-")), "verify.mjs");
  await esbuild.build({
    entryPoints: [join(cli, "test", "release-entry.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    outfile,
    logLevel: "silent",
    banner: { js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' },
  });
  return import(pathToFileURL(outfile).href);
}

// Downloads <version> from the registry by its exact version and checks it
// as the updater does before any of its code runs: the tarball's sha512
// against the registry's, then its SLSA provenance with Sigstore, signed by
// this repository's release workflow on main, for this very version and
// these very bytes. Only then is it unpacked, into <dir>/package. Returns
// the path of its dist/bin.js. `verifier`: loadVerifier's module.
export async function verifiedRelease(version, metadata, dir, verifier) {
  const dist = metadata?.versions?.[version]?.dist;
  if (typeof dist?.tarball !== "string" || typeof dist.integrity !== "string" || typeof dist.attestations?.url !== "string") {
    throw new Error(`openqodex@${version} has no tarball, integrity or attestations on the registry`);
  }
  const tarball = await verifier.fetchTarball(dist.tarball);
  const attestations = await verifier.fetchAttestations(dist.attestations.url);
  const verified = verifier.verifyRelease({ name: "openqodex", version, tarball, integrity: dist.integrity, attestations });
  if (!verified.ok) throw new Error(`openqodex@${version} did not verify, so nothing of it runs: ${verified.reason}`);
  mkdirSync(dir, { recursive: true });
  const archive = join(dir, "package.tgz");
  writeFileSync(archive, tarball, { mode: 0o600 });
  await verifier.extractArchive(archive, "tar.gz", dir);
  return join(dir, "package", "dist", "bin.js");
}
