// The pinned scanner table (packages/scanners/toolchain.json) and the shapes
// an asset under a platform may take. The table is what the installer trusts:
// an asset that is not what it says becomes a download the product runs.
//
// Failure list, written before the code:
//   1. A FreeBSD asset is something other than a release download, a plain
//      "none" or a system asset, and the table test passes.
//   2. A release asset has no sha256, a URL that is not an https URL on
//      github.com under the recipe's own repository, a name that is not the
//      last part of its URL, or no binaryPath, and the table test passes.
//   3. A system asset has no package, an absolute path, a path with "..",
//      versionArgs that are not a list of strings, a versionPattern that does
//      not compile or has not exactly one capture group, or a version that is
//      not x.y.z, and the table test passes.
//   4. A system asset's versionPattern does not read the version out of the
//      output the tool prints on a FreeBSD host, and the table test passes.
//   5. A tool that does not install from a GitHub release carries a FreeBSD
//      asset, and the table test passes.
//   6. scripts/refresh-toolchain.mjs checks a system asset as if it were a
//      download, or leaves a FreeBSD release asset unchecked, or counts a
//      system asset among the assets it verified.
//   7. A platform that has always held a download has none, and the plan
//      does not call it missing.
//   8. A FreeBSD platform with no asset, or a plain "none", is called
//      missing, and the plan fails on it.
//   9. A FreeBSD system asset is pinned to a version another architecture's
//      package does not have, so the package that is installed is refused.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FREEBSD_PLATFORMS, RELEASE_PLATFORMS, assetKind, captureGroups, tableProblems, verificationPlan } from "../../../scripts/toolchain-assets.mjs";

const root = new URL("../../../", import.meta.url);
const tools = JSON.parse(readFileSync(new URL("packages/scanners/toolchain.json", root), "utf8")).tools as Record<string, any>;

// The output each FreeBSD tool prints when it is asked for its version, as
// seen on a FreeBSD host. The table's pattern must read the version out of
// it, and the version it reads must be the one the table pins.
const SAMPLES: Record<string, string> = {
  gitleaks: "v8.30.1",
  "osv-scanner": "osv-scanner version: 2.7.0",
  hadolint: "Haskell Dockerfile Linter 2.14.0",
  shellcheck: "version: 0.11.0",
  ruff: "ruff 0.17.5",
};

// The output of a tool whose package is not the same on both architectures:
// one sample per FreeBSD platform, because each architecture has a pin of
// its own.
const SAMPLES_BY_PLATFORM: Record<string, Record<string, string>> = {
  zizmor: {
    "freebsd-x64": "zizmor 1.33.1",
    "freebsd-arm64": "zizmor 1.32.0",
  },
};

const clone = (value: unknown): any => JSON.parse(JSON.stringify(value));

// Every system asset in the table, with the tool it belongs to.
function systemAssets(of: Record<string, any> = tools): [string, string, any][] {
  const out: [string, string, any][] = [];
  for (const [tool, recipe] of Object.entries(of)) {
    for (const [platform, asset] of Object.entries(recipe.assets ?? {})) {
      if (assetKind(asset) === "system") out.push([tool, platform, asset]);
    }
  }
  return out;
}

describe("the pinned scanner table", () => {
  it("holds only the shapes an asset may take (1)", () => {
    expect(tableProblems(tools)).toEqual([]);
    for (const [tool, recipe] of Object.entries(tools)) {
      for (const [platform, asset] of Object.entries(recipe.assets ?? {})) {
        expect(["release", "none", "system"], `${tool} ${platform}`).toContain(assetKind(asset));
      }
    }
  });

  it("pins every release download with a sha256, a github.com URL under its own repository, a name and a binaryPath (2)", () => {
    for (const [tool, recipe] of Object.entries(tools)) {
      for (const [platform, asset] of Object.entries(recipe.assets ?? {})) {
        if (assetKind(asset) !== "release") continue;
        expect(asset.sha256, `${tool} ${platform}`).toMatch(/^[0-9a-f]{64}$/);
        expect(asset.url, `${tool} ${platform}`).toMatch(/^https:\/\/github\.com\//);
        expect(asset.url, `${tool} ${platform}`).toContain(`/${recipe.repo}/`);
        expect(asset.url.split("/").pop(), `${tool} ${platform}`).toBe(asset.name);
        expect(typeof asset.binaryPath, `${tool} ${platform}`).toBe("string");
        expect(asset.binaryPath.length, `${tool} ${platform}`).toBeGreaterThan(0);
      }
    }
  });

  it("names a package, a relative path, the version arguments and one capture group for every system asset (3)", () => {
    for (const [tool, platform, asset] of systemAssets()) {
      expect(asset.system.package, `${tool} ${platform}`).toBeTruthy();
      expect(typeof asset.system.package, `${tool} ${platform}`).toBe("string");
      expect(asset.system.path, `${tool} ${platform}`).toBeTruthy();
      expect(asset.system.path.startsWith("/"), `${tool} ${platform} path is absolute`).toBe(false);
      expect(asset.system.path.split("/"), `${tool} ${platform} path holds ..`).not.toContain("..");
      expect(Array.isArray(asset.system.versionArgs), `${tool} ${platform}`).toBe(true);
      for (const arg of asset.system.versionArgs) expect(typeof arg, `${tool} ${platform}`).toBe("string");
      expect(() => new RegExp(asset.system.versionPattern, "m"), `${tool} ${platform}`).not.toThrow();
      expect(captureGroups(asset.system.versionPattern), `${tool} ${platform}`).toBe(1);
      expect(asset.version, `${tool} ${platform}`).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  it("reads the version out of the output each FreeBSD tool prints (4)", () => {
    for (const [tool, platform, asset] of systemAssets()) {
      const sample = SAMPLES_BY_PLATFORM[tool]?.[platform] ?? SAMPLES[tool];
      expect(sample, `${tool} has no sample output to check its pattern against`).toBeDefined();
      const found = new RegExp(asset.system.versionPattern, "m").exec(sample as string);
      expect(found, `${tool} ${platform}: the pattern reads no version out of ${JSON.stringify(sample)}`).not.toBeNull();
      expect(found?.[1], `${tool} ${platform}`).toBe(asset.version);
    }
  });

  it("pins each architecture's zizmor to the version that architecture's package has (9)", () => {
    const assets = tools.zizmor.assets;
    expect(assets["freebsd-x64"], "zizmor has no FreeBSD amd64 asset").toMatchObject({ version: "1.33.1" });
    expect(assets["freebsd-arm64"], "zizmor has no FreeBSD arm64 asset").toMatchObject({ version: "1.32.0" });
  });

  it("gives a FreeBSD asset only to a tool that installs from a GitHub release (5)", () => {
    for (const [tool, recipe] of Object.entries(tools)) {
      const freebsd = Object.keys(recipe.assets ?? {}).filter((p) => p.startsWith("freebsd-"));
      if (recipe.method === "github-release") continue;
      expect(freebsd, `${tool} is a ${recipe.method} recipe and carries a FreeBSD asset`).toEqual([]);
    }
  });

  it("fails a table whose assets are broken (1, 2, 3, 5)", () => {
    const broken = clone(tools);
    broken.shellcheck.assets["freebsd-x64"] = { system: { package: "", path: "/bin/shellcheck", versionArgs: "--version", versionPattern: "no group" }, version: "0.11" };
    const problems = tableProblems(broken);
    expect(problems.join("\n")).toMatch(/freebsd-x64: the system asset has no package/);
    expect(problems.join("\n")).toMatch(/freebsd-x64: the system asset path is absolute/);
    expect(problems.join("\n")).toMatch(/freebsd-x64: the versionArgs is not a list of strings/);
    expect(problems.join("\n")).toMatch(/freebsd-x64: the versionPattern has 0 capture group/);
    expect(problems.join("\n")).toMatch(/freebsd-x64: the system asset version is not x\.y\.z/);

    const noSum = clone(tools);
    noSum.shellcheck.assets["linux-x64"].sha256 = "abc";
    expect(tableProblems(noSum).join("\n")).toMatch(/shellcheck linux-x64: the asset has no sha256/);

    const otherHost = clone(tools);
    otherHost.shellcheck.assets["linux-x64"].url = "https://example.invalid/shellcheck.tar.xz";
    expect(tableProblems(otherHost).join("\n")).toMatch(/shellcheck linux-x64: the asset URL is not on github\.com/);

    const otherRepo = clone(tools);
    otherRepo.shellcheck.assets["linux-x64"].url = "https://github.com/mallory/shellcheck/releases/download/v0.10.0/shellcheck.tar.xz";
    expect(tableProblems(otherRepo).join("\n")).toMatch(/shellcheck linux-x64: the asset URL is not under koalaman\/shellcheck/);

    const wrongName = clone(tools);
    wrongName.shellcheck.assets["linux-x64"].name = "other.tar.xz";
    expect(tableProblems(wrongName).join("\n")).toMatch(/shellcheck linux-x64: the asset name is not the last part of its URL/);

    const registry = clone(tools);
    registry.semgrep.assets = { "freebsd-x64": { name: "x", url: "https://github.com/a/b/x", sha256: "0".repeat(64), binaryPath: "x" } };
    expect(tableProblems(registry).join("\n")).toMatch(/semgrep freebsd-x64: only a GitHub release recipe may carry a FreeBSD asset/);
  });
});

describe("what scripts/refresh-toolchain.mjs verifies (6)", () => {
  const plan = verificationPlan(tools);

  it("checks a download for each of the four original platforms of every release tool", () => {
    for (const [tool, recipe] of Object.entries(tools)) {
      if (recipe.method !== "github-release") continue;
      for (const platform of RELEASE_PLATFORMS) {
        expect(plan.downloads.some((job) => job.tool === tool && job.platform === platform), `${tool} ${platform}`).toBe(true);
      }
    }
  });

  it("checks a FreeBSD release download and leaves a system asset to the host", () => {
    for (const [tool, recipe] of Object.entries(tools)) {
      for (const platform of FREEBSD_PLATFORMS) {
        const asset = recipe.assets?.[platform];
        if (asset === undefined || asset === null) {
          expect(plan.downloads.some((job) => job.tool === tool && job.platform === platform), `${tool} ${platform}`).toBe(false);
          continue;
        }
        if (assetKind(asset) === "system") {
          expect(plan.downloads.some((job) => job.tool === tool && job.platform === platform), `${tool} ${platform}`).toBe(false);
          expect(plan.systems.some((job) => job.tool === tool && job.platform === platform), `${tool} ${platform}`).toBe(true);
          continue;
        }
        expect(plan.downloads.some((job) => job.tool === tool && job.platform === platform), `${tool} ${platform}`).toBe(true);
      }
    }
  });

  it("names the package and the version of every system asset it skips", () => {
    for (const [tool, platform, asset] of systemAssets()) {
      const job = plan.systems.find((j) => j.tool === tool && j.platform === platform);
      expect(job, `${tool} ${platform}`).toBeDefined();
      expect(job?.line).toBe(`${tool} ${platform}: SYSTEM ${asset.system.package} ${asset.version} (checked at run time on the host)`);
    }
  });

  it("counts only the downloads it verified", () => {
    expect(plan.downloads.length).toBeGreaterThan(0);
    expect(plan.downloads.every((job) => assetKind(job.asset) === "release")).toBe(true);
    expect(plan.systems.every((job) => assetKind(job.asset) === "system")).toBe(true);
  });

  it("calls a platform that has always held a download missing when it has none (7)", () => {
    const broken = clone(tools);
    delete broken.shellcheck.assets["linux-x64"];
    const planOfBroken = verificationPlan(broken);
    const job = planOfBroken.missing.find((j) => j.tool === "shellcheck" && j.platform === "linux-x64");
    expect(job, "the plan does not call the platform missing").toBeDefined();
    expect(planOfBroken.downloads.some((j) => j.tool === "shellcheck" && j.platform === "linux-x64")).toBe(false);
  });

  it("leaves a FreeBSD platform with no asset, or a plain none, out of the missing (8)", () => {
    const without = clone(tools);
    delete without.oxlint.assets["freebsd-x64"];
    const planOfWithout = verificationPlan(without);
    expect(planOfWithout.missing.some((j) => j.platform.startsWith("freebsd-"))).toBe(false);
    expect(planOfWithout.entries.some((j) => j.tool === "oxlint" && j.platform === "freebsd-x64")).toBe(false);
    expect(tableProblems(without).join("\n")).not.toMatch(/oxlint freebsd-x64/);

    const none = clone(tools);
    none.oxlint.assets["freebsd-arm64"] = null;
    const planOfNone = verificationPlan(none);
    expect(planOfNone.missing.some((j) => j.platform.startsWith("freebsd-"))).toBe(false);
    expect(planOfNone.entries.some((j) => j.tool === "oxlint" && j.platform === "freebsd-arm64")).toBe(false);
    expect(tableProblems(none).join("\n")).not.toMatch(/oxlint freebsd-arm64/);
  });
});
