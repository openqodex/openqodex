// Failures guarded, written before the code:
// 1. A dropped connection is classed as a provider failure and never retried.
// 2. Rate limits and transport failures each get their own retry allowance.
import { describe, expect, it } from "vitest";
import * as halts from "../lib/halts.mjs";

const failed = (failure) => ({ status: "incomplete", failure });

describe("transport retries", () => {
  it("a dropped connection is classed as a provider failure and never retried", () => {
    for (const cause of ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "EAI_AGAIN", "socket hang up", "fetch failed", "UND_ERR_SOCKET"]) {
      const rec = failed(`the model call failed: the request to the model endpoint failed: ${cause}`);
      expect(halts.reasonClass(rec.failure)).toBe("provider-transport");
      expect(halts.retryOnce(rec, 0)).toEqual({ waitMs: 0 });
      expect(halts.retryOnce(rec, 1)).toBeNull();
    }
  });

  it("rate limits and transport failures each get their own retry allowance", () => {
    const rate = failed("the model call failed: HTTP 429: retry after 2 seconds");
    const transport = failed("the model call failed: ECONNRESET");
    for (const [first, second] of [[rate, transport], [transport, rate]]) {
      expect(halts.retryOnce(first, 0)).not.toBeNull();
      expect(halts.retryOnce(second, 1)).toBeNull();
    }
  });
});
