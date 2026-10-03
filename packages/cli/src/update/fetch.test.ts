// The registry client of the self-update. A real local HTTP server stands in
// for a host that is not the registry; its request count, and Node's own
// fetch diagnostics channel, show whether a request left the process.
//
// Failure list, written before the code:
//   1. A URL on a host other than registry.npmjs.org (or on the registry
//      over plain http) is requested, so metadata, attestations or a tarball
//      could come from anywhere.
//   2. With OPENQODEX_OFFLINE=1 a request is made at all.

import { subscribe, unsubscribe } from "node:diagnostics_channel";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fetchAttestations, fetchMetadata, fetchTarball } from "./fetch.js";

let server: Server;
let hits = 0;
let local = "";
let requests = 0;
const count = () => {
  requests++;
};

beforeAll(async () => {
  server = createServer((_req, res) => {
    hits++;
    res.end("{}");
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  local = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  subscribe("undici:request:create", count);
  // The channel must see a plain fetch, or a zero count below proves nothing.
  await (await fetch(local)).text();
  expect(requests).toBe(1);
  hits = 0;
});

afterAll(async () => {
  unsubscribe("undici:request:create", count);
  await new Promise((done) => server.close(done));
});

describe("registry fetch", () => {
  it("refuses a host that is not the registry, and plain http, without a request (failure 1)", async () => {
    const before = requests;
    await expect(fetchTarball(`${local}/openqodex/-/openqodex-0.3.0.tgz`)).rejects.toThrow(/registry\.npmjs\.org/);
    await expect(fetchAttestations(`${local}/-/npm/v1/attestations/openqodex@0.3.0`)).rejects.toThrow(/registry\.npmjs\.org/);
    await expect(fetchTarball("https://registry.npmjs.org.example.com/openqodex/-/openqodex-0.3.0.tgz")).rejects.toThrow(
      /registry\.npmjs\.org/,
    );
    await expect(fetchTarball("http://registry.npmjs.org/openqodex/-/openqodex-0.3.0.tgz")).rejects.toThrow(/https/);
    expect(hits).toBe(0);
    expect(requests).toBe(before);
  });

  it("makes no request at all under OPENQODEX_OFFLINE=1 (failure 2)", async () => {
    const saved = process.env.OPENQODEX_OFFLINE;
    process.env.OPENQODEX_OFFLINE = "1";
    const before = requests;
    try {
      await expect(fetchMetadata()).rejects.toThrow(/offline/);
      await expect(fetchAttestations("https://registry.npmjs.org/-/npm/v1/attestations/openqodex@0.2.0")).rejects.toThrow(
        /offline/,
      );
      await expect(fetchTarball("https://registry.npmjs.org/openqodex/-/openqodex-0.2.0.tgz")).rejects.toThrow(/offline/);
      await expect(fetchTarball(`${local}/x.tgz`)).rejects.toThrow(/offline/);
    } finally {
      if (saved === undefined) delete process.env.OPENQODEX_OFFLINE;
      else process.env.OPENQODEX_OFFLINE = saved;
    }
    expect(hits).toBe(0);
    expect(requests).toBe(before);
  });
});
