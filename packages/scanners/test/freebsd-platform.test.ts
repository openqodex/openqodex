// The platforms OpenQodex names, and the release asset a custom scanner
// picks on each of them. Ways this could fail, written before the code:
// 1. currentPlatform() answers null on FreeBSD, so every scanner on a
//    FreeBSD seat says it has no download for this platform.
// 2. currentPlatform() names a platform the table does not hold.
// 3. currentPlatform() names an architecture a platform does not have, or an
//    operating system OpenQodex does not support.
// 4. A FreeBSD release asset is picked on Linux, or a Linux one on FreeBSD.
// 5. A FreeBSD platform with no FreeBSD asset in the list is answered with
//    some other asset.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { pickAsset } from "../src/custom/release.js";
import { currentPlatform } from "../src/toolchain/table.js";

const dir = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "release-assets");
const load = (repo: string): { tag: string; assets: string[] } => JSON.parse(readFileSync(join(dir, `${repo}.json`), "utf8"));
const versionOf = (tag: string) => tag.replace(/^v/, "");

const savedPlatform = process.platform;
const savedArch = process.arch;

// The machine this test pretends to be on.
function on(os: string, arch: string): void {
  Object.defineProperty(process, "platform", { value: os, configurable: true });
  Object.defineProperty(process, "arch", { value: arch, configurable: true });
}

afterEach(() => {
  on(savedPlatform, savedArch);
});

describe("currentPlatform", () => {
  it("names the platform of the machine it runs on (1, 2, 3)", () => {
    const cases: [string, string, string | null][] = [
      ["freebsd", "x64", "freebsd-x64"],
      ["freebsd", "arm64", "freebsd-arm64"],
      ["darwin", "arm64", "darwin-arm64"],
      ["darwin", "x64", "darwin-x64"],
      ["linux", "x64", "linux-x64"],
      ["linux", "arm64", "linux-arm64"],
      ["freebsd", "ia32", null],
      ["openbsd", "x64", null],
      ["win32", "x64", null],
    ];
    for (const [os, arch, expected] of cases) {
      on(os, arch);
      expect(currentPlatform(), `${os}-${arch}`).toBe(expected);
    }
  });
});

describe("a custom scanner's release asset on FreeBSD", () => {
  it("picks the FreeBSD asset on FreeBSD and the Linux one on Linux (4)", () => {
    const { tag, assets } = load("freebsd-tool");
    const version = versionOf(tag);
    expect(pickAsset(assets, "freebsd-x64", { pattern: null, version })).toBe("tool-1.0.0.freebsd.amd64.tar.gz");
    expect(pickAsset(assets, "freebsd-arm64", { pattern: null, version })).toBe("tool-1.0.0.freebsd.arm64.tar.gz");
    expect(pickAsset(assets, "linux-x64", { pattern: null, version })).toBe("tool-1.0.0.linux.amd64.tar.gz");
    expect(pickAsset(assets, "linux-arm64", { pattern: null, version })).toBe("tool-1.0.0.linux.arm64.tar.gz");
  });

  it("takes a pattern with {os} and {arch} on FreeBSD too (4)", () => {
    const { tag, assets } = load("freebsd-tool");
    expect(pickAsset(assets, "freebsd-x64", { pattern: "tool-{version}.{os}.{arch}.tar.gz", version: versionOf(tag) })).toBe("tool-1.0.0.freebsd.amd64.tar.gz");
    expect(pickAsset(assets, "freebsd-arm64", { pattern: "tool-{version}.{os}.{arch}.tar.gz", version: versionOf(tag) })).toBe("tool-1.0.0.freebsd.arm64.tar.gz");
  });

  it("refuses a FreeBSD platform with no FreeBSD asset in the list (5)", () => {
    const { assets } = load("freebsd-tool");
    const onlyLinux = assets.filter((name) => !name.includes("freebsd"));
    expect(() => pickAsset(onlyLinux, "freebsd-x64", { pattern: null, version: "1.0.0" })).toThrow(/no release asset matches freebsd-x64/);
  });
});
