import { createHmac, timingSafeEqual } from "node:crypto";

export function authenticateGitLabWebhook({
  headers,
  rawBody,
  signingSecret,
  token,
  now = Date.now(),
  timestampToleranceSeconds = 300,
}) {
  const signature = header(headers, "webhook-signature");
  if (signature) {
    if (!signingSecret) return { authenticated: false, reason: "signing-secret-not-configured" };
    return verifyStandardSignature({
      signingSecret,
      messageId: header(headers, "webhook-id"),
      timestamp: header(headers, "webhook-timestamp"),
      signature,
      rawBody,
      now,
      timestampToleranceSeconds,
    });
  }
  if (!token) return { authenticated: false, reason: "webhook-token-not-configured" };
  const received = header(headers, "x-gitlab-token");
  const authenticated = Boolean(received) && secureEqual(String(token), received);
  return {
    authenticated,
    method: "token",
    reason: authenticated ? undefined : received ? "token-mismatch" : "token-missing",
  };
}

export function verifyStandardSignature({
  signingSecret,
  messageId,
  timestamp,
  signature,
  rawBody,
  now = Date.now(),
  timestampToleranceSeconds = 300,
}) {
  if (!messageId || !timestamp || !signature) {
    return { authenticated: false, method: "signature", reason: "signature-headers-missing" };
  }
  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds)) {
    return { authenticated: false, method: "signature", reason: "timestamp-invalid" };
  }
  if (Math.abs(Math.floor(now / 1000) - timestampSeconds) > timestampToleranceSeconds) {
    return { authenticated: false, method: "signature", reason: "timestamp-outside-tolerance" };
  }
  let key;
  try {
    if (!String(signingSecret).startsWith("whsec_")) throw new Error("prefix missing");
    const encoded = String(signingSecret).slice("whsec_".length);
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error("invalid base64");
    key = Buffer.from(encoded, "base64");
    if (key.length === 0) throw new Error("empty key");
  } catch {
    return { authenticated: false, method: "signature", reason: "signing-secret-invalid" };
  }
  const message = `${messageId}.${timestamp}.${rawBody}`;
  const expected = `v1,${createHmac("sha256", key).update(message).digest("base64")}`;
  const authenticated = String(signature).split(" ").some((candidate) => secureEqual(expected, candidate));
  return {
    authenticated,
    method: "signature",
    reason: authenticated ? undefined : "signature-mismatch",
  };
}

export function deliveryIdFromHeaders(headers) {
  return header(headers, "webhook-id")
    ?? header(headers, "idempotency-key")
    ?? header(headers, "x-gitlab-event-uuid");
}

function header(headers, name) {
  if (typeof headers?.get === "function") return headers.get(name) ?? undefined;
  const entry = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name);
  const value = entry?.[1];
  return Array.isArray(value) ? value[0] : value;
}

function secureEqual(expected, received) {
  const left = Buffer.from(String(expected));
  const right = Buffer.from(String(received));
  return left.length === right.length && timingSafeEqual(left, right);
}
