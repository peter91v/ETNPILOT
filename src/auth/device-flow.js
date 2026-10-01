// OAuth 2.0 device authorization (RFC 8628): the tool shows a short code, the
// person confirms it in a browser on any device, and the tool is handed a
// token. No redirect URL, no secret held by the tool — which is why it suits a
// phone in Termux. GitHub and GitLab speak the same protocol on different paths.

const ENDPOINTS = {
  github: { device: "/login/device/code", token: "/login/oauth/access_token" },
  gitlab: { device: "/oauth/authorize_device", token: "/oauth/token" },
};
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

export class DeviceFlowError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "DeviceFlowError";
    this.code = code;
  }
}

export async function startDeviceFlow({ service, host, clientId, scope, fetchImpl = globalThis.fetch }) {
  const endpoints = ENDPOINTS[service];
  if (!endpoints) throw new DeviceFlowError(`'${service}' has no device sign-in.`, "unsupported");
  if (!clientId) throw new DeviceFlowError("A device sign-in needs the client id of an OAuth application.", "client_id_required");
  const base = host.replace(/\/$/, "");
  const body = await post(fetchImpl, `${base}${endpoints.device}`, { client_id: clientId, scope });
  if (body.error || !body.device_code || !body.user_code) {
    throw new DeviceFlowError(describe(body, "The service did not start a sign-in."), body.error ?? "start_failed");
  }
  return {
    service,
    host: base,
    clientId,
    deviceCode: body.device_code,
    userCode: body.user_code,
    verificationUri: body.verification_uri ?? body.verification_url,
    verificationUriComplete: body.verification_uri_complete,
    interval: Math.max(1, Number(body.interval) || 5),
    expiresAt: Date.now() + (Number(body.expires_in) || 900) * 1000,
  };
}

// One check: still waiting, or done. The caller decides how often — the
// terminal loops, the page asks again every few seconds.
export async function checkDeviceFlow(flow, { fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  if (now() >= flow.expiresAt) return { status: "expired" };
  const endpoints = ENDPOINTS[flow.service];
  const body = await post(fetchImpl, `${flow.host}${endpoints.token}`, {
    client_id: flow.clientId,
    device_code: flow.deviceCode,
    grant_type: DEVICE_GRANT,
  });
  if (body.access_token) {
    return {
      status: "done",
      token: {
        value: body.access_token,
        refreshToken: body.refresh_token,
        expiresAt: body.expires_in ? now() + Number(body.expires_in) * 1000 : undefined,
        scope: body.scope,
      },
    };
  }
  switch (body.error) {
    case "authorization_pending": return { status: "pending" };
    case "slow_down": return { status: "pending", slowDown: true };
    case "expired_token": return { status: "expired" };
    case "access_denied": return { status: "denied" };
    default: throw new DeviceFlowError(describe(body, "The sign-in failed."), body.error ?? "failed");
  }
}

// The terminal's loop: waits for the person, honouring the service's pace.
export async function awaitDeviceFlow(flow, { fetchImpl, sleep = defaultSleep, signal, now = Date.now, onWait } = {}) {
  let interval = flow.interval;
  for (;;) {
    signal?.throwIfAborted();
    await sleep(interval * 1000, signal);
    const result = await checkDeviceFlow(flow, { fetchImpl, now });
    if (result.status === "pending") {
      if (result.slowDown) interval += 5;
      onWait?.();
      continue;
    }
    return result;
  }
}

// Renews an expiring token. GitLab's last two hours; GitHub's do not expire
// unless the application opted in, and then they come with a refresh token too.
export async function refreshToken(entry, { fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  if (!entry.refreshToken || !entry.clientId || !entry.host || !ENDPOINTS[entry.service]) return undefined;
  const body = await post(fetchImpl, `${entry.host}${ENDPOINTS[entry.service].token}`, {
    client_id: entry.clientId,
    grant_type: "refresh_token",
    refresh_token: entry.refreshToken,
  });
  if (!body.access_token) return undefined;
  return {
    ...entry,
    value: body.access_token,
    refreshToken: body.refresh_token ?? entry.refreshToken,
    expiresAt: body.expires_in ? now() + Number(body.expires_in) * 1000 : undefined,
  };
}

async function post(fetchImpl, url, fields) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(Object.entries(fields).filter(([, value]) => value !== undefined)).toString(),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    throw new DeviceFlowError(`Could not reach ${new URL(url).host}: ${error.message}`, "network");
  }
  let body;
  try {
    body = await response.json();
  } catch {
    throw new DeviceFlowError(`${new URL(url).host} answered ${response.status} without JSON.`, "bad_response");
  }
  // Device-flow errors (pending, slow_down…) arrive as 4xx with an 'error' member.
  return body && typeof body === "object" ? body : {};
}

function describe(body, fallback) {
  return String(body.error_description ?? body.message ?? body.error ?? fallback).slice(0, 200);
}

function defaultSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  });
}
