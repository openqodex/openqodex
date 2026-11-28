// The program that opens the issue page in a browser. macOS has "open",
// Linux has "xdg-open", and FreeBSD has "xdg-open" too, because pkg installs
// it. A platform with neither has no opener, and the page is only printed.
//
// Ways it could fail, written before the code:
//  1. A FreeBSD host gets no opener, so the issue page never opens.
//  2. macOS gets a program that is not there.
//  3. A platform with no opener gets one anyway.
//  4. The issue page is not opened on a FreeBSD host, although the opener is
//     named for it.
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { browserOpener, sendIssue } from "../src/feedback.js";
import { removeTempDirs, tempDir } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

const saved = { platform: process.platform, path: process.env.PATH };

// The machine this test pretends to be on.
function on(platform: string): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

afterEach(() => {
  on(saved.platform);
  if (saved.path === undefined) delete process.env.PATH;
  else process.env.PATH = saved.path;
});

// The opener each platform has, one row per platform.
const CASES: { platform: NodeJS.Platform; opener: string | null }[] = [
  { platform: "darwin", opener: "open" },
  { platform: "linux", opener: "xdg-open" },
  { platform: "freebsd", opener: "xdg-open" },
  { platform: "win32", opener: null },
  { platform: "openbsd", opener: null },
];

// A folder for PATH with a recorder standing in for the browser opener (an
// external command): it writes the address it was given to a file, so the
// test can see whether anything tried to leave the machine.
function recorder(): { bin: string; record: string } {
  const bin = tempDir("oq-opener-bin-");
  const record = join(tempDir("oq-opener-record-"), "url.txt");
  writeFileSync(join(bin, "xdg-open"), `#!/bin/sh\nprintf '%s' "$1" > '${record}'\n`);
  chmodSync(join(bin, "xdg-open"), 0o755);
  return { bin, record };
}

describe("the program that opens a browser", () => {
  for (const { platform, opener } of CASES) {
    it(`on ${platform} the opener is ${opener ?? "none"}`, () => {
      expect(browserOpener(platform)).toBe(opener);
    });
  }
});

describe("the issue page on a FreeBSD host", () => {
  it("is opened with xdg-open (1, 4)", async () => {
    on("freebsd");
    const { bin, record } = recorder();
    process.env.PATH = bin;
    const result = await sendIssue({ title: "OpenQodex 0.26.0: internal-error", body: "Command: scan" });
    expect(result).toContain("Opened the new issue page in your browser: https://github.com/openqodex/openqodex/issues/new?");
    expect(readFileSync(record, "utf8")).toContain("https://github.com/openqodex/openqodex/issues/new?");
  });
});
