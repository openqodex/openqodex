// Failures guarded, written before the code:
// 1. A dropped connection loses its transport class or its one retry bound.
// 2. Rate limits and transport failures get separate retry allowances.
// 3. A resumed rate-limit retry skips the wait the provider named.
import { describe, expect, it } from "vitest";
import * as halts from "../lib/halts.mjs";

const failed = (failure) => ({ status: "incomplete", failure });

describe("transport retries", () => {
  it("a dropped connection keeps its transport class and is retried only once", () => {
    for (const cause of ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "EAI_AGAIN", "socket hang up", "fetch failed", "UND_ERR_SOCKET"]) {
      const rec = failed(`the model call failed: the request to the model endpoint failed: ${cause}`);
      expect(halts.reasonClass(rec.failure)).toBe("provider-transport");
      expect(halts.retryOnce(rec, 0)).toEqual({ waitMs: 0 });
      expect(halts.retryOnce(rec, 1)).toBeNull();
    }
  });

  it("a resumed retry owes the provider's wait less the time since the attempt was saved", () => {
    const rate = failed("the model call failed: HTTP 429: retry after 20 seconds");
    expect(halts.resumeWaitMs(rate, 0, 1_000, 6_000)).toBe(15_000);
    expect(halts.resumeWaitMs(rate, 0, 1_000, 60_000)).toBe(0);
    expect(halts.resumeWaitMs(rate, 0, 6_000, 1_000)).toBe(20_000);
    expect(halts.resumeWaitMs(rate, 1, 1_000, 1_000)).toBe(0);
    expect(halts.resumeWaitMs(failed("the model call failed: ECONNRESET"), 0, 1_000, 1_000)).toBe(0);
    expect(halts.resumeWaitMs({ status: "complete", failure: null }, 0, 1_000, 1_000)).toBe(0);
  });

  it("rate limits and transport failures share one retry allowance", () => {
    const rate = failed("the model call failed: HTTP 429: retry after 2 seconds");
    const transport = failed("the model call failed: ECONNRESET");
    for (const [first, second] of [[rate, transport], [transport, rate]]) {
      expect(halts.retryOnce(first, 0)).not.toBeNull();
      expect(halts.retryOnce(second, 1)).toBeNull();
    }
  });
});
