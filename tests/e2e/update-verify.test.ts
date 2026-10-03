import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { fetchAttestations, fetchTarball } from "../../packages/cli/src/update/fetch.js";
import { RELEASE_SIGNER, verifyRelease } from "../../packages/cli/src/update/verify.js";
import { skipNetwork } from "./support.js";

// Release verification for the self-update, against the real npm registry:
// the published openqodex@0.2.0 tarball and its real Sigstore attestations,
// and a real release of another package that also carries npm provenance.
// Nothing here is a fixture: the bytes and bundles are downloaded each run.
//
// Failure list, written before the code:
//   a. The real 0.2.0 release is refused (the embedded trusted root, the
//      Sigstore verification or the expected signer identity is wrong), so
//      no update could ever install.
//   b. A tarball with one byte changed is accepted.
//   c. A tarball with altered bytes and a matching integrity value (what a
//      registry that serves both could do) is accepted, because only the
//      metadata checksum was compared and not the signed subject digest.
//   d. A stolen publish token: provenance from another package, or another
//      package's own valid release, is accepted because the signature is
//      valid, without checking that the signer is this repository's release
//      workflow.
//   e. A release with only npm's publish attestation (no SLSA provenance) is
//      accepted.
//   f. One release's tarball and attestations are accepted as another
//      version, so an old signed release could pass as a newer one.

type Attestations = { attestations: Array<{ predicateType: string; bundle: unknown }> };
const SLSA = "https://slsa.dev/provenance/v1";
const OTHER = { name: "sigstore", version: "5.0.0" };
const offline = skipNetwork("update-verify");

function integrityOf(bytes: Buffer): string {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

describe.skipIf(offline)("release verification against the real registry", () => {
  let tarball: Buffer;
  let integrity: string;
  let attestations: Attestations;
  let otherTarball: Buffer;
  let otherAttestations: Attestations;

  beforeAll(async () => {
    const meta = (await (await fetch("https://registry.npmjs.org/openqodex/0.2.0")).json()) as {
      dist: { tarball: string; integrity: string; attestations: { url: string } };
    };
    integrity = meta.dist.integrity;
    tarball = await fetchTarball(meta.dist.tarball);
    attestations = (await fetchAttestations(meta.dist.attestations.url)) as Attestations;
    const other = (await (await fetch(`https://registry.npmjs.org/${OTHER.name}/${OTHER.version}`)).json()) as {
      dist: { tarball: string; attestations: { url: string } };
    };
    otherTarball = await fetchTarball(other.dist.tarball);
    otherAttestations = (await fetchAttestations(other.dist.attestations.url)) as Attestations;
    // The other package must really carry SLSA provenance, or case d tests nothing.
    expect(otherAttestations.attestations.some((a) => a.predicateType === SLSA)).toBe(true);
  }, 120_000);

  it("a. the published 0.2.0 release verifies with the embedded trusted root and this repo's workflow identity", () => {
    expect(RELEASE_SIGNER.identity).toBe(
      "https://github.com/openqodex/openqodex/.github/workflows/release.yml@refs/heads/main",
    );
    expect(verifyRelease({ name: "openqodex", version: "0.2.0", tarball, integrity, attestations })).toEqual({ ok: true });
  });

  it("b. one changed byte is refused on the checksum", () => {
    const altered = Buffer.from(tarball);
    altered[altered.length >> 1] ^= 0xff;
    const result = verifyRelease({ name: "openqodex", version: "0.2.0", tarball: altered, integrity, attestations });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toMatch(/checksum/);
  });

  it("c. altered bytes with a matching integrity value are refused on the signed subject digest", () => {
    const altered = Buffer.concat([tarball, Buffer.from([0])]);
    const result = verifyRelease({
      name: "openqodex",
      version: "0.2.0",
      tarball: altered,
      integrity: integrityOf(altered),
      attestations,
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toMatch(/subject digest/);
  });

  it("d. another package's provenance, or its own valid release, is refused because the signer is not this repo's workflow", () => {
    const borrowed = verifyRelease({ name: "openqodex", version: "0.2.0", tarball, integrity, attestations: otherAttestations });
    expect(borrowed.ok).toBe(false);
    expect(!borrowed.ok && borrowed.reason).toMatch(/not this repository's release workflow/);
    const own = verifyRelease({
      name: OTHER.name,
      version: OTHER.version,
      tarball: otherTarball,
      integrity: integrityOf(otherTarball),
      attestations: otherAttestations,
    });
    expect(own.ok).toBe(false);
    expect(!own.ok && own.reason).toMatch(/not this repository's release workflow/);
  });

  it("e. only npm's publish attestation, with the SLSA provenance removed, is refused", () => {
    const publishOnly = { attestations: attestations.attestations.filter((a) => a.predicateType !== SLSA) };
    expect(publishOnly.attestations.length).toBeGreaterThan(0);
    const result = verifyRelease({ name: "openqodex", version: "0.2.0", tarball, integrity, attestations: publishOnly });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toMatch(/provenance/);
  });

  it("f. a version other than the signed one is refused, so an older release cannot pass as a newer one", () => {
    const result = verifyRelease({ name: "openqodex", version: "0.3.0", tarball, integrity, attestations });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toMatch(/openqodex@0\.3\.0/);
  });
});
