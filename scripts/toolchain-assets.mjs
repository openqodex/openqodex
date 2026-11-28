// The shapes an asset in the pinned scanner table may take, the platforms the
// table may name, and the checks that keep each shape what it says.
//
// An asset under a platform is one of three things:
//  - a release download: a file from a GitHub release, pinned by the sha256
//    of its bytes;
//  - null: this platform has none, on purpose;
//  - a system asset: a program the host's package manager installs. On
//    FreeBSD, pkg installs shellcheck, ruff, hadolint, gitleaks, osv-scanner
//    and zizmor. Nothing is downloaded for it, and it is never taken from
//    PATH: the only place looked at is the path under LOCALBASE.
//
// scripts/refresh-toolchain.mjs and the table test both use the checks here,
// so the script that verifies the table and the test that guards it cannot
// drift apart.

// The platforms a release download has always been pinned for. Each of them
// must hold a download: a tool without one cannot run there.
export const RELEASE_PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"];

// The FreeBSD platforms. A tool may have a release download on them, a system
// asset, or none at all.
export const FREEBSD_PLATFORMS = ["freebsd-x64", "freebsd-arm64"];

// What an asset is: a release download, a plain "none", a system asset, an
// entry that is not there at all, or something the table may not hold.
export function assetKind(asset) {
  if (asset === undefined) return "absent";
  if (asset === null) return "none";
  if (typeof asset !== "object" || Array.isArray(asset)) return "unknown";
  if (asset.system !== undefined) return "system";
  return "release";
}

// The number of capture groups a pattern has. The pattern is compiled with
// the "d" flag, which reports one entry per group, and an empty alternative
// is added so that the pattern matches even when it would not.
export function captureGroups(pattern) {
  const probe = new RegExp(`${pattern}|`, "md");
  return probe.exec("").indices.length - 1;
}

// The problems of a release download, one line each.
export function releaseAssetProblems(tool, recipe, platform, asset) {
  const problems = [];
  const where = `${tool} ${platform}`;
  if (typeof asset.name !== "string" || asset.name === "") problems.push(`${where}: the asset has no name`);
  if (typeof asset.binaryPath !== "string" || asset.binaryPath === "") problems.push(`${where}: the asset has no binaryPath`);
  if (!/^[0-9a-f]{64}$/.test(asset.sha256 ?? "")) problems.push(`${where}: the asset has no sha256 of 64 hex digits`);
  let url = null;
  try {
    url = new URL(asset.url);
  } catch {
    problems.push(`${where}: the asset has no URL`);
  }
  if (url !== null) {
    if (url.protocol !== "https:") problems.push(`${where}: the asset URL is not https`);
    if (url.hostname !== "github.com") problems.push(`${where}: the asset URL is not on github.com`);
    if (typeof recipe.repo !== "string" || !url.pathname.startsWith(`/${recipe.repo}/`)) {
      problems.push(`${where}: the asset URL is not under ${recipe.repo ?? "the recipe's repository"}`);
    }
    if (typeof asset.name === "string" && asset.name !== "" && url.pathname.split("/").pop() !== asset.name) {
      problems.push(`${where}: the asset name is not the last part of its URL`);
    }
  }
  return problems;
}

// The problems of a system asset, one line each.
export function systemAssetProblems(tool, platform, asset) {
  const problems = [];
  const where = `${tool} ${platform}`;
  const system = asset.system;
  if (typeof system !== "object" || system === null || Array.isArray(system)) {
    problems.push(`${where}: the system asset has no system part`);
    return problems;
  }
  if (typeof system.package !== "string" || system.package.trim() === "") problems.push(`${where}: the system asset has no package`);
  if (typeof system.path !== "string" || system.path === "") {
    problems.push(`${where}: the system asset has no path`);
  } else {
    if (system.path.startsWith("/")) problems.push(`${where}: the system asset path is absolute`);
    if (system.path.split("/").includes("..")) problems.push(`${where}: the system asset path holds ..`);
  }
  if (!Array.isArray(system.versionArgs) || system.versionArgs.some((arg) => typeof arg !== "string")) {
    problems.push(`${where}: the versionArgs is not a list of strings`);
  }
  if (typeof system.versionPattern !== "string" || system.versionPattern === "") {
    problems.push(`${where}: the system asset has no versionPattern`);
  } else {
    try {
      new RegExp(system.versionPattern, "m");
    } catch {
      problems.push(`${where}: the versionPattern does not compile`);
    }
    let groups = null;
    try {
      groups = captureGroups(system.versionPattern);
    } catch {
      groups = null;
    }
    if (groups !== 1) problems.push(`${where}: the versionPattern has ${groups === null ? "no" : groups} capture group`);
  }
  if (!/^\d+\.\d+\.\d+$/.test(asset.version ?? "")) problems.push(`${where}: the system asset version is not x.y.z`);
  if (asset.url !== undefined || asset.sha256 !== undefined) problems.push(`${where}: a system asset names no download`);
  return problems;
}

// The problems of the whole table, one line each. A tool that does not
// install from a GitHub release holds no asset at all, so a FreeBSD asset on
// one of them is a mistake.
export function tableProblems(tools) {
  const problems = [];
  for (const [tool, recipe] of Object.entries(tools)) {
    const assets = recipe.assets ?? {};
    for (const [platform, asset] of Object.entries(assets)) {
      const kind = assetKind(asset);
      if (platform.startsWith("freebsd-") && recipe.method !== "github-release") {
        problems.push(`${tool} ${platform}: only a GitHub release recipe may carry a FreeBSD asset`);
        continue;
      }
      if (kind === "release") {
        problems.push(...releaseAssetProblems(tool, recipe, platform, asset));
        continue;
      }
      if (kind === "system") {
        if (!platform.startsWith("freebsd-")) {
          problems.push(`${tool} ${platform}: only a FreeBSD platform may hold a system asset`);
          continue;
        }
        problems.push(...systemAssetProblems(tool, platform, asset));
        continue;
      }
      if (kind === "unknown") {
        problems.push(`${tool} ${platform}: the asset is not a release download, a none or a system asset`);
        continue;
      }
    }
    if (recipe.method !== "github-release" && Object.keys(assets).length > 0) {
      problems.push(`${tool}: a ${recipe.method} recipe holds no asset`);
    }
  }
  return problems;
}

// What scripts/refresh-toolchain.mjs has to do with the table: the downloads
// it checks, the system assets it leaves to the host, and the downloads a
// platform must hold but does not. A FreeBSD platform with no asset, or with
// a plain "none", is not a failure: the tool has nothing there on purpose.
// A platform that has always held a download must still hold one.
export function verificationPlan(tools) {
  const entries = [];
  for (const [tool, recipe] of Object.entries(tools)) {
    if (recipe.method !== "github-release") continue;
    for (const platform of RELEASE_PLATFORMS) {
      entries.push({ tool, platform, asset: recipe.assets?.[platform] ?? null, kind: "release" });
    }
    for (const platform of FREEBSD_PLATFORMS) {
      const asset = recipe.assets?.[platform];
      if (asset === undefined || asset === null) continue;
      if (assetKind(asset) === "system") {
        entries.push({ tool, platform, asset, kind: "system", line: `${tool} ${platform}: SYSTEM ${asset.system.package} ${asset.version} (checked at run time on the host)` });
        continue;
      }
      entries.push({ tool, platform, asset, kind: "release" });
    }
  }
  const downloads = entries.filter((entry) => entry.kind === "release" && entry.asset !== null);
  const missing = entries.filter((entry) => entry.kind === "release" && entry.asset === null);
  const systems = entries.filter((entry) => entry.kind === "system");
  return { entries, downloads, missing, systems };
}
