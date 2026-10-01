// @ts-check
import { swallow } from "../runtime/swallow.js";

// A run that waits for a person is only as useful as the person knowing it
// waits. With `approval.notify.url` set, a new pending approval is announced
// with one POST. What is sent is small on purpose: the kind of operation, the
// agent and the id. The command, path or URL being approved leave the machine
// only with `includeDetails: true`, because a notification service is a third
// party and the details can hold what the policy exists to protect.
//
//   approval:
//     notify:
//       url: https://ntfy.sh/my-private-topic   # https, or http to this machine
//       format: ntfy                           # ntfy | json (default json)
//       includeDetails: false
//       timeoutMs: 5000

const FORMATS = ["json", "ntfy"];

export function normalizeNotifyConfig(config) {
  if (config === undefined || config === null) return undefined;
  if (typeof config !== "object" || Array.isArray(config)) throw new TypeError("approval.notify must be an object.");
  if (config.url === undefined) return undefined;
  let url;
  try {
    url = new URL(config.url);
  } catch {
    throw new TypeError("approval.notify.url must be an address.");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new TypeError("approval.notify.url must be https (http only to this machine).");
  }
  const format = config.format ?? "json";
  if (!FORMATS.includes(format)) throw new TypeError(`approval.notify.format must be one of ${FORMATS.join(", ")}.`);
  const timeoutMs = config.timeoutMs ?? 5000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
    throw new TypeError("approval.notify.timeoutMs must be an integer from 100 to 60000.");
  }
  return { url: url.href, host: url.hostname, format, includeDetails: config.includeDetails === true, timeoutMs };
}

// Returns a function to use as an approval handler's `onPending`, or undefined
// when nothing is configured. It never throws and never waits for longer than
// timeoutMs: a notification that cannot be delivered must not hold a run (the
// approval is still in the inbox) or make it fail.
export function createApprovalNotifier(config, { fetchImpl = globalThis.fetch, onError } = /** @type {any} */ ({})) {
  const notify = normalizeNotifyConfig(config);
  if (!notify) return undefined;
  return async (approval) => {
    try {
      const { headers, body } = compose(notify, approval);
      const response = await fetchImpl(notify.url, {
        method: "POST",
        headers,
        body,
        redirect: "error",
        signal: AbortSignal.timeout(notify.timeoutMs),
      });
      if (!response.ok) throw new Error(`${notify.host} answered ${response.status}`);
    } catch (error) {
      // The address can hold a secret (an ntfy topic), so only the host is named.
      const message = `Could not send the approval notification to ${notify.host}: ${error?.name === "TimeoutError" ? "timed out" : error?.message ?? error}`;
      (onError ?? swallow("approval notification", undefined))(new Error(message));
      if (onError === undefined) process.stderr.write(`${message}\n`);
    }
  };
}

function compose(notify, approval) {
  const what = `${approval.operationKind}${approval.agent ? ` by ${approval.agent}` : ""}`;
  const details = notify.includeDetails ? (approval.details ?? {}) : undefined;
  if (notify.format === "ntfy") {
    const lines = [`${what} is waiting for a decision.`, `etnpilot approval show ${approval.id}`];
    if (details) lines.push(...["command", "file", "url", "tool"].filter((key) => details[key]).map((key) => `${key}: ${String(details[key]).slice(0, 300)}`));
    return {
      headers: { "Content-Type": "text/plain; charset=utf-8", Title: "ETNPilot needs a decision", Priority: "high", Tags: "warning" },
      body: lines.join("\n"),
    };
  }
  return {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      event: "approval.pending",
      id: approval.id,
      kind: approval.operationKind,
      agent: approval.agent ?? null,
      runId: approval.runId ?? null,
      expiresAt: approval.expiresAt,
      ...(details ? { details } : {}),
    }),
  };
}
