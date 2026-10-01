import { ProviderError } from "./router.js";

// Retrying the same provider, before giving up on it.
//
// The router already falls through to the *next* provider when one fails in a
// way worth retrying. In the normal case there is no next provider — most
// projects configure one — so a single 429 ended the run, which is not a
// failure of the run but of the minute it happened in.
//
// Only what is safe to replay: the error has to say both that it is worth
// retrying and that the call did not already have effects. A request that
// already ran tools is never repeated here.

const DEFAULT_RETRY = Object.freeze({
  attempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 8000,
});

export async function withRetry(operation, {
  attempts = DEFAULT_RETRY.attempts,
  baseDelayMs = DEFAULT_RETRY.baseDelayMs,
  maxDelayMs = DEFAULT_RETRY.maxDelayMs,
  signal,
  sleep = defaultSleep,
  onAttempt,
} = /** @type {any} */ ({})) {
  if (!Number.isInteger(attempts) || attempts < 1) throw new TypeError("attempts must be a positive integer.");
  const tried = [];
  for (let attempt = 1; ; attempt += 1) {
    signal?.throwIfAborted();
    try {
      const value = await operation(attempt);
      if (tried.length > 0) onAttempt?.({ attempt, outcome: "succeeded", tried });
      return { value, attempts: attempt, tried };
    } catch (error) {
      const worthRetrying = error instanceof ProviderError && error.retryable && error.safeToRetry;
      if (!worthRetrying || attempt >= attempts) {
        // The attempts that were made belong in the error, so a receipt does
        // not read as though the provider was asked once.
        if (tried.length > 0) error.attempts = attempt;
        throw error;
      }
      // The server's own answer wins over any guess: a 429 usually says how
      // long to wait, and waiting less is how a rate limit becomes a ban.
      const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const jitter = Math.floor(Math.random() * (backoff / 2));
      const waitMs = error.retryAfterMs ?? backoff + jitter;
      tried.push({ attempt, code: error.code, reason: error.message, waitMs });
      onAttempt?.({ attempt, outcome: "retrying", waitMs, error });
      await sleep(waitMs, signal);
    }
  }
}

// Parses what a rate limiter actually sent: seconds, or an HTTP date.
export function retryAfterMs(header, now = Date.now()) {
  if (typeof header !== "string" || header.trim() === "") return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

function defaultSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("Aborted."));
    };
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}
