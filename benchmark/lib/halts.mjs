// The halt rules of a model reviewer run (PLAN-benchmark 4.7, P4 4.5): after
// each finished review, run.mjs asks whether the run should stop and ask a
// person, rather than spend on. A halt names its rule and why; run.mjs
// records it in the run's end record (`ended.halt`) and stops launching,
// the reviews running finish and are saved, and --resume continues.
//
// The rules, in the order they are asked:
// - provider-blocked: the endpoint refused the key (HTTP 401 or 403), the
//   quota (insufficient_quota) or the billing. At once: every later call
//   would get the same answer. Any other 429 is a rate limit: run.mjs waits
//   and tries that review once more (retryOnce), and a rate limit that
//   outlasts its retry counts like any other reason below.
// - served-model-changed: a review names a served model the earlier reviews
//   of its configuration did not, or names two. The deployment changed
//   under the run. Each configuration (each model reviewer) has its own.
// - same-reason-twice: two reviews in a row, in the order they ended, did
//   not complete, for the same reason class (reasonClass).
// - from the 10th review of this invocation on: incomplete-share (more than
//   20% did not complete), cost-over-estimate (the mean cost of a finished
//   review is past 1.5 times the estimate, when the run had one) and
//   forecast-past-cap (what the run had spent, plus what the finished
//   reviews cost, plus their mean for each review not finished, passes
//   --max-usd; the reservations of reviews in flight are named apart).
// Hard caps are lib/budget.mjs's and are not repeated here. smokeCap holds
// a smoke run to its number of reviewer invocations.
//
// Failure list, written before the code:
// 1. A key, quota or billing refusal is read as one more incomplete review,
//    and the run spends its envelopes on calls that cannot be answered.
// 2. A per-minute rate limit ("per-minute quota exceeded; retry after 2
//    seconds") halts the run as a quota refusal, or is retried without a
//    bound: a 429 halts at once only for insufficient_quota or billing;
//    otherwise one retry per review, after the wait the text names or 10
//    seconds, never more than 60.
// 3. A deployment that changes during the run mixes two models in one run.
// 4. Two reviews that end incomplete for one cause (a broken setup) are
//    followed by a third; or two for different causes halt the run.
// 5. A run whose reviews mostly fail, or cost far more than planned, spends
//    to its cap before anyone looks.
// 6. The cost rules divide the spend of reviews still running by the
//    reviews finished: the mean is over each finished review's own spend.
// 7. A resumed run halts again at once on the counts that halted it: every
//    count is of this invocation only; the served models seen before are
//    carried in, since a model change across a resume is still a change.
// 8. Retries let a smoke run invoke the reviewer more times than its cap:
//    smokeCap counts every invocation, retries and a resumed run's earlier
//    attempts included.

/** Reviews of one invocation before the share and cost rules apply. */
export const HALT_AFTER = 10;
/** The share of reviews that may end not complete. */
export const MAX_NOT_COMPLETE_SHARE = 0.2;
/** How far the mean cost per review may pass the run's estimate. */
export const COST_OVER_ESTIMATE = 1.5;
/** Shared retries for rate limits and transport failures, and the rate-limit waits. */
export const RATE_LIMIT_RETRIES = 1;
export const RATE_LIMIT_WAIT_S = 10;
export const RATE_LIMIT_MAX_WAIT_S = 60;

// Reason classes, the first that matches a failure's text, in this order.
const CLASSES = [
  ["provider-auth", /\bHTTP 40[13]\b/],
  ["provider-quota", /insufficient_quota|\bHTTP \d{3}\b[^;]*\bbilling\b/i],
  ["provider-rate-limit", /\bHTTP 429\b/],
  ["provider-transport", /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN)\b|socket hang up|fetch failed|\bUND_ERR_/i],
  ["provider", /the model call failed|the model endpoint|reply could not be read/],
  ["budget", /budget refused/],
  ["deadline", /timed out|deadline|time ran out|did not finish in time/],
  // The staged forms: a finder or verifier whose answer still failed its
  // numbered checks, or a verifier that used up its correction rounds.
  ["answer-checks", /answer still failed \d+ checks?|was not examined by (?:local|contracts): \d+\. |were not verified: (?:\d+\. |the verifier exhausted its correction rounds)/],
  ["coverage", /ranges? (?:was|were) not (?:read|given|sent)/],
  ["objects", /missing objects|not a commit|missing commit|history unknown|diverged|git failed/],
  ["outside", /outside its workDir/],
  ["threw", /the review threw/],
];

/** The reason class of a failure's text: a named class, or "other: " and the text with its numbers taken out. */
export function reasonClass(failure) {
  const text = String(failure ?? "");
  for (const [name, re] of CLASSES) if (re.test(text)) return name;
  return `other: ${text.split(";")[0].replace(/\d+/g, "N").trim().slice(0, 120)}`;
}

/** Why the endpoint will refuse every later call (a key, quota or billing refusal), or null. */
export function providerBlock(failure) {
  const c = reasonClass(failure);
  if (c !== "provider-auth" && c !== "provider-quota") return null;
  const re = CLASSES.find(([name]) => name === c)[1];
  return String(failure).split(";").map((part) => part.trim()).find((part) => re.test(part)) ?? String(failure);
}

/**
 * Whether a finished attempt failed on transport or was rate limited and may be tried once more
 * (failure 2): { waitMs } after `retries` retries of its review, or null.
 */
export function retryOnce(rec, retries) {
  if (rec.status === "complete" || retries >= RATE_LIMIT_RETRIES) return null;
  const cls = reasonClass(rec.failure);
  if (cls === "provider-transport") return { waitMs: 0 };
  if (cls !== "provider-rate-limit") return null;
  const named = /(?:retry after|try again in)\s+(\d+(?:\.\d+)?)\s*(?:seconds?|s)\b/i.exec(String(rec.failure));
  const seconds = Math.min(RATE_LIMIT_MAX_WAIT_S, named ? Number(named[1]) : RATE_LIMIT_WAIT_S);
  return { waitMs: Math.round(seconds * 1000) };
}

const money = (usd) => `$${usd.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}`;

/**
 * The halt rules of one invocation. `maxUsd` is the run's cap, `toRun` the
 * reviews this invocation plans, `estimatePerReview` the estimate's dollars
 * per review (null when there is none), `servedBefore` the served models
 * the run's earlier samples named, per configuration ({ <config>: [models] }),
 * and `spentBefore` what the run had spent when this invocation started.
 * `after(record, { ownUsd, reservedUsd })` is asked once per finished
 * review, with its last saved sample record (lib/server-review.mjs), what
 * that review spent itself (every attempt's envelope, from the ledger) and
 * what reviews in flight hold reserved; it returns { rule, why } or null.
 */
export function haltRules({ maxUsd, toRun, estimatePerReview = null, servedBefore = {}, spentBefore = 0 }) {
  // Per configuration: each model reviewer of a run answers from its own deployment.
  const servedBy = new Map(Object.entries(servedBefore).map(([config, models]) => [config, new Set(models.filter((m) => typeof m === "string" && m !== ""))]));
  let reviews = 0;
  let notComplete = 0;
  let finishedOwn = 0;
  let lastClass = null;
  const halt = (rule, why) => ({ rule, why });
  return {
    after(rec, { ownUsd = null, reservedUsd = 0 } = {}) {
      reviews++;
      finishedOwn += typeof ownUsd === "number" ? ownUsd : (rec.usage?.cost_usd ?? 0);
      const ok = rec.status === "complete";
      const cls = ok ? null : reasonClass(rec.failure ?? rec.status);
      if (!ok) notComplete++;
      const blocked = ok ? null : providerBlock(rec.failure);
      if (blocked !== null) return halt("provider-blocked", `the model endpoint refused the key, the quota or the billing (${cls}): ${blocked}`);
      const named = (rec.servedModels ?? []).filter((m) => typeof m === "string" && m !== "");
      if (named.length > 1) return halt("served-model-changed", `one review was answered by ${named.join(" and ")}`);
      if (!servedBy.has(rec.config)) servedBy.set(rec.config, new Set());
      const served = servedBy.get(rec.config);
      const fresh = named.filter((m) => !served.has(m));
      if (fresh.length > 0 && served.size > 0) return halt("served-model-changed", `the served model of ${rec.config} changed from ${[...served].join(" and ")} to ${fresh.join(" and ")}`);
      for (const m of named) served.add(m);
      const previous = lastClass;
      lastClass = cls;
      if (cls !== null && previous === cls) return halt("same-reason-twice", `two reviews in a row did not complete for one reason (${cls}): ${String(rec.failure ?? rec.status).slice(0, 300)}`);
      if (reviews < HALT_AFTER) return null;
      if (notComplete / reviews > MAX_NOT_COMPLETE_SHARE) return halt("incomplete-share", `${notComplete} of ${reviews} reviews did not complete, more than ${MAX_NOT_COMPLETE_SHARE * 100}%`);
      // Finished reviews only (failure 6).
      const mean = finishedOwn / reviews;
      if (typeof estimatePerReview === "number" && estimatePerReview > 0 && mean > COST_OVER_ESTIMATE * estimatePerReview) {
        return halt("cost-over-estimate", `a finished review cost ${money(mean)} on average, more than ${COST_OVER_ESTIMATE} times the estimate of ${money(estimatePerReview)}`);
      }
      const left = Math.max(0, toRun - reviews);
      const forecast = spentBefore + finishedOwn + mean * left;
      if (forecast > maxUsd) {
        return halt("forecast-past-cap", `${reviews} finished reviews cost ${money(finishedOwn)}${spentBefore > 0 ? ` on top of ${money(spentBefore)} spent before` : ""}, and ${left} more at ${money(mean)} each would bring the run to ${money(forecast)}, past --max-usd ${money(maxUsd)}${reservedUsd > 0 ? `; ${money(reservedUsd)} is reserved by reviews in flight and is not counted` : ""}`);
      }
      return null;
    },
  };
}

/**
 * The cap on a smoke run's reviewer invocations (failure 8): `take(config,
 * { retry })` before each invocation, a first attempt or a retry, returns
 * null, or { rule: "smoke-cap", why } once `max` invocations of that
 * configuration were made. `rows` (the run's rows.jsonl) seeds the counts
 * of a resumed run.
 */
export function smokeCap(max, { rows = [] } = {}) {
  const by = new Map();
  const count = (config) => by.get(config) ?? by.set(config, { all: 0, retries: 0 }).get(config);
  for (const r of rows) {
    const c = count(r.config);
    c.all++;
    if ((r.attempt ?? 1) > 1) c.retries++;
  }
  return {
    take(config, { retry = false } = {}) {
      const c = count(config);
      if (c.all >= max) return { rule: "smoke-cap", why: `a smoke run invokes the reviewer at most ${max} times per configuration, and ${config} was invoked ${c.all} times, ${c.retries} of them ${c.retries === 1 ? "a retry" : "retries"}` };
      c.all++;
      if (retry) c.retries++;
      return null;
    },
  };
}
