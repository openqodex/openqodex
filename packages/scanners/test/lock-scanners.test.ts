// scripts/lock-scanners.mjs reads registry answers to make the lock files.
//
// Failure list, written before the change:
//   1. A registry answer (metadata JSON) is read whole, with no limit, before
//      it is parsed, so an endless answer fills memory.
//   2. A registry answer that redirects is followed.
//   3. A lock file for a platform that has no lock files (FreeBSD) is checked
//      as if it were a Linux one.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
let origin = "";
let server: Server;
let sent = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/moved.json") {
      res.writeHead(301, { location: "https://example.invalid/x.json" }).end();
      return;
    }
    // An answer that never ends: `{"x":"` and then blanks.
    res.writeHead(200, { "content-type": "application/json" });
    res.write('{"x":"');
    const chunk = Buffer.alloc(64 * 1024, 32);
    const tick = setInterval(() => {
      if (res.destroyed || sent > 256 * 1024 * 1024) {
        clearInterval(tick);
        res.end();
        return;
      }
      sent += chunk.length;
      res.write(chunk);
    }, 1);
    res.on("close", () => clearInterval(tick));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

describe("lock-scanners reads registry answers within limits", () => {
  it("gives up an answer at the metadata limit instead of reading it whole (1)", async () => {
    const { fetchMetadata, MAX_METADATA_BYTES } = await import(join(here, "..", "..", "..", "scripts", "lock-scanners.mjs"));
    expect(MAX_METADATA_BYTES).toBe(16 * 1024 * 1024);
    sent = 0;
    await expect(fetchMetadata(`${origin}/endless.json`)).rejects.toThrow(/larger than/);
    expect(sent).toBeLessThan(MAX_METADATA_BYTES + 8 * 1024 * 1024);
  }, 60_000);

  it("refuses an answer that redirects (2)", async () => {
    const { fetchMetadata } = await import(join(here, "..", "..", "..", "scripts", "lock-scanners.mjs"));
    await expect(fetchMetadata(`${origin}/moved.json`)).rejects.toThrow(/redirect/);
  });

  it("refuses a lock file for a platform that has none (3)", async () => {
    const { markerEnv } = await import(join(here, "..", "..", "..", "scripts", "lock-check.mjs"));
    expect(() => markerEnv("freebsd-x64", "3.11")).toThrow(/FreeBSD/);
    expect(markerEnv("linux-x64", "3.11").sys_platform).toBe("linux");
    expect(markerEnv("darwin-arm64", "3.11").sys_platform).toBe("darwin");
  });
});
