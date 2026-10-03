// Proves, offline, that a downloaded release was built by this repository's
// release workflow. The gate is the identity in the Sigstore signing
// certificate, checked after full verification against the trusted root
// embedded in this package: a stolen npm token can publish a tarball and even
// a valid provenance statement, but not one signed by this workflow's
// GitHub Actions identity. Claims inside the signed statement (repository,
// workflow, ref) are not trusted on their own. No network call is made here.
import { createHash } from "node:crypto";
import { bundleFromJSON, isBundleWithDsseEnvelope, type Bundle } from "@sigstore/bundle";
import { TrustedRoot } from "@sigstore/protobuf-specs";
import { toSignedEntity, toTrustMaterial, Verifier, type TrustMaterial } from "@sigstore/verify";
// The Sigstore public good instance trusted root (Fulcio CAs, Rekor and CT log
// keys, timestamp authority), byte for byte from
// https://raw.githubusercontent.com/sigstore/root-signing/main/targets/trusted_root.json
// fetched 2026-10-03, sha256 6494e21ea73fa7ee769f85f57d5a3e6a08725eae1e38c755fc3517c9e6bc0b66,
// the hash the signed TUF targets at tuf-repo-cdn.sigstore.dev list for it.
// Each release ships the current one; a candidate never supplies it.
import trustedRoot from "./trusted-root.json";

// The only signer a release is accepted from: the OIDC issuer and the
// certificate identity (SAN URI) Fulcio writes for a GitHub Actions run of
// .github/workflows/release.yml on main.
export const RELEASE_SIGNER = {
  issuer: "https://token.actions.githubusercontent.com",
  identity: "https://github.com/openqodex/openqodex/.github/workflows/release.yml@refs/heads/main",
} as const;

export const SLSA_PROVENANCE_V1 = "https://slsa.dev/provenance/v1";
const IN_TOTO_PAYLOAD = "application/vnd.in-toto+json";
const IN_TOTO_STATEMENT_V1 = "https://in-toto.io/Statement/v1";

export type VerifyResult = { ok: true } | { ok: false; reason: string };

export type ReleaseToVerify = {
  name: string;
  version: string;
  tarball: Buffer;
  // dist.integrity from the registry metadata, "sha512-<base64>".
  integrity: string;
  // The parsed JSON at dist.attestations.url.
  attestations: unknown;
};

let trust: TrustMaterial | undefined;
function trustMaterial(): TrustMaterial {
  trust ??= toTrustMaterial(TrustedRoot.fromJSON(trustedRoot));
  return trust;
}

function refuse(reason: string): VerifyResult {
  return { ok: false, reason };
}

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 200);
}

// The SLSA entries of an attestation set. npm's own publish attestation is
// signed by the registry, not by the build, so it never counts.
function provenanceBundles(attestations: unknown): unknown[] {
  const list = (attestations as { attestations?: unknown } | null)?.attestations;
  if (!Array.isArray(list)) return [];
  return list
    .filter((a): a is { predicateType: unknown; bundle: unknown } => typeof a === "object" && a !== null)
    .filter((a) => a.predicateType === SLSA_PROVENANCE_V1)
    .map((a) => a.bundle);
}

// One provenance bundle, checked in full against the tarball's sha512 (hex).
function verifyBundle(raw: unknown, name: string, version: string, sha512: string): VerifyResult {
  let bundle: Bundle;
  try {
    bundle = bundleFromJSON(raw);
  } catch (error) {
    return refuse(`the provenance bundle does not parse: ${message(error)}`);
  }
  if (!isBundleWithDsseEnvelope(bundle)) return refuse("the provenance is not a signed in-toto envelope");

  // Certificate chain to the embedded Fulcio roots, certificate transparency,
  // transparency log inclusion, timestamps and the signature over the
  // envelope. It returns the signer only when all of that holds.
  let signer;
  try {
    signer = new Verifier(trustMaterial()).verify(toSignedEntity(bundle));
  } catch (error) {
    return refuse(`the provenance signature does not verify: ${message(error)}`);
  }
  // The gate: the verified certificate's issuer and identity, compared
  // exactly. The library's own policy option treats the identity as a regular
  // expression, so it is not used.
  const identity = signer.identity?.subjectAlternativeName;
  const issuer = signer.identity?.extensions?.issuer;
  if (identity !== RELEASE_SIGNER.identity || issuer !== RELEASE_SIGNER.issuer) {
    return refuse(`signed by ${identity ?? "an unknown identity"}, not this repository's release workflow`);
  }

  // The signed statement: in-toto, SLSA provenance, one subject that is this
  // package at this version with this tarball's digest.
  const envelope = bundle.content.dsseEnvelope;
  if (envelope.payloadType !== IN_TOTO_PAYLOAD) return refuse("the signed payload is not an in-toto statement");
  let statement: { _type?: unknown; predicateType?: unknown; subject?: unknown };
  try {
    statement = JSON.parse(envelope.payload.toString("utf8")) as typeof statement;
  } catch {
    return refuse("the signed statement is not JSON");
  }
  if (statement._type !== IN_TOTO_STATEMENT_V1) return refuse("the signed statement is not an in-toto v1 statement");
  if (statement.predicateType !== SLSA_PROVENANCE_V1) return refuse("the signed statement is not SLSA provenance v1");
  const subjects = Array.isArray(statement.subject) ? (statement.subject as Array<Record<string, unknown>>) : [];
  const expected = `pkg:npm/${name}@${version}`;
  if (subjects.length !== 1 || subjects[0]?.name !== expected) {
    return refuse(`the signed subject is not ${expected}`);
  }
  const digest = (subjects[0].digest as Record<string, unknown> | undefined)?.sha512;
  if (typeof digest !== "string" || digest.toLowerCase() !== sha512) {
    return refuse("the signed subject digest differs from the downloaded tarball");
  }
  return { ok: true };
}

// Never throws for a bad release; the reason is one short plain line.
export function verifyRelease(release: ReleaseToVerify): VerifyResult {
  const sha512 = createHash("sha512").update(release.tarball).digest();
  const m = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(release.integrity.trim());
  if (!m) return refuse("the registry checksum is not a sha512 value");
  if (!Buffer.from(m[1]!, "base64").equals(sha512)) {
    return refuse("the download does not match the registry checksum");
  }

  const bundles = provenanceBundles(release.attestations);
  if (bundles.length === 0) return refuse("no build provenance attestation (SLSA v1) for this release");

  let first: VerifyResult | undefined;
  for (const bundle of bundles) {
    let result: VerifyResult;
    try {
      result = verifyBundle(bundle, release.name, release.version, sha512.toString("hex"));
    } catch (error) {
      result = refuse(`the provenance could not be checked: ${message(error)}`);
    }
    if (result.ok) return result;
    first ??= result;
  }
  return first!;
}
