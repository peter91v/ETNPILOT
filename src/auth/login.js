// @ts-check
import { awaitDeviceFlow, checkDeviceFlow, DeviceFlowError, refreshToken, startDeviceFlow } from "./device-flow.js";
import { openCredentialStore } from "./credential-store.js";
import { SERVICE_IDS, SERVICES, normalizeAuthHost, serviceFor } from "./services.js";

// Sign in, sign out, and say who is signed in. The terminal and the web page
// both call this; neither holds any of it itself.

export function storeFor({ env = process.env, fetchImpl } = /** @type {any} */ ({})) {
  const store = openCredentialStore({
    env,
    refresher: (entry) => refreshToken(entry, { fetchImpl }),
  });
  if (!store) throw new Error("No home directory to keep a login in. Set ETNPILOT_HOME to a directory.");
  return store;
}

// Asks the service whether the credential works. A refusal is final; a network
// failure says nothing about the credential, so it is reported separately and
// the caller decides whether to keep it anyway.
export async function verifyCredential(service, value, { fetchImpl = globalThis.fetch, host, baseUrl } = /** @type {any} */ ({})) {
  const definition = serviceFor(service);
  const request = verification(definition, value, { host, baseUrl });
  let response;
  try {
    response = await fetchImpl(request.url, { headers: request.headers, signal: AbortSignal.timeout(15_000) });
  } catch (error) {
    return { ok: false, reason: "unreachable", message: `Could not reach ${new URL(request.url).host}: ${error.message}` };
  }
  if (response.status === 401 || response.status === 403) {
    return { ok: false, reason: "rejected", status: response.status, message: `${definition.label} refused this credential (${response.status}).` };
  }
  if (!response.ok) {
    return { ok: false, reason: "unreachable", status: response.status, message: `${definition.label} answered ${response.status}; the credential could not be checked.` };
  }
  let account;
  if (request.account) {
    try { account = request.account(await response.json()); } catch { /* the credential works; who it is is a courtesy */ }
  }
  return { ok: true, account };
}

function verification(service, value, { host, baseUrl }) {
  switch (service.id) {
    case "anthropic":
      return {
        url: `${(baseUrl ?? service.baseUrl).replace(/\/$/, "")}/v1/models?limit=1`,
        headers: { "x-api-key": value, "anthropic-version": "2023-06-01" },
      };
    case "openai":
      return { url: `${(baseUrl ?? service.baseUrl).replace(/\/$/, "")}/models`, headers: { authorization: `Bearer ${value}` } };
    case "github":
      return { url: `${service.apiBase}/user`, headers: { authorization: `Bearer ${value}`, accept: "application/vnd.github+json", "user-agent": "etnpilot" }, account: (body) => body.login };
    case "gitlab":
      return { url: `${(host ?? service.host).replace(/\/$/, "")}/api/v4/user`, headers: { authorization: `Bearer ${value}` }, account: (body) => body.username };
    default:
      throw new Error(`No check for '${service.id}'.`);
  }
}

// A key or a token someone typed. Checked first; a refused one is not stored.
export async function saveKey(serviceId, value, { env, fetchImpl, verify = true, host: given, baseUrl } = /** @type {any} */ ({})) {
  const service = serviceFor(serviceId);
  const host = given ? normalizeAuthHost(given) : undefined;
  const key = String(value ?? "").trim();
  if (key === "") throw new Error(`Enter the ${service.label} ${service.method === "key" ? "key" : "token"}.`);
  if (/\s/.test(key)) throw new Error("That does not look like a key: it contains spaces or line breaks.");
  /** @type {{ ok: boolean, reason?: string, message?: string, status?: number, account?: string }} */
  let result = { ok: false, reason: "skipped" };
  if (verify) {
    result = await verifyCredential(service.id, key, { fetchImpl, host, baseUrl });
    if (!result.ok && result.reason === "rejected") {
      throw Object.assign(new Error(result.message), { code: "rejected" });
    }
  }
  const store = storeFor({ env, fetchImpl });
  await store.save(service.secret, {
    value: key,
    kind: "key",
    service: service.id,
    ...(result.account ? { account: result.account } : {}),
    ...(service.id === "gitlab" ? { host: (host ?? service.host).replace(/\/$/, "") } : {}),
    // Kept even when the check could not run, but marked, so it is not shown as proven.
    ...(result.ok ? {} : { verified: false }),
  });
  return { service: service.id, account: result.account, verified: result.ok, note: result.ok ? undefined : result.message };
}

// Starts the browser sign-in. The client id is remembered, so it is typed once.
export async function beginDeviceLogin(serviceId, { env = process.env, fetchImpl, clientId, host } = /** @type {any} */ ({})) {
  const service = serviceFor(serviceId);
  if (service.method !== "device") throw new DeviceFlowError(`${service.label} has no browser sign-in; use a key.`, "unsupported");
  const store = storeFor({ env, fetchImpl });
  const app = await store.app(service.id);
  const id = clientId ?? env[`ETNPILOT_${service.id.toUpperCase()}_CLIENT_ID`] ?? app?.clientId;
  const base = normalizeAuthHost(host ?? app?.host ?? service.host);
  if (!id) {
    const error = new DeviceFlowError(`Browser sign-in needs the client id of an OAuth application. ${service.appHelp}`, "client_id_required");
    throw error;
  }
  const flow = await startDeviceFlow({ service: service.id, host: base, clientId: id, scope: service.scope, fetchImpl });
  await store.saveApp(service.id, { clientId: id, host: base });
  return flow;
}

export async function finishDeviceLogin(flow, token, { env, fetchImpl, verify = true } = /** @type {any} */ ({})) {
  const service = serviceFor(flow.service);
  const result = verify ? await verifyCredential(service.id, token.value, { fetchImpl, host: flow.host }) : { ok: false };
  const store = storeFor({ env, fetchImpl });
  await store.save(service.secret, {
    value: token.value,
    kind: "oauth",
    service: service.id,
    host: flow.host,
    clientId: flow.clientId,
    ...(token.refreshToken ? { refreshToken: token.refreshToken } : {}),
    ...(token.expiresAt ? { expiresAt: token.expiresAt } : {}),
    ...(result.account ? { account: result.account } : {}),
  });
  return { service: service.id, account: result.account };
}

// Terminal: start, show the code, wait, store.
export async function loginWithDevice(serviceId, { env, fetchImpl, clientId, host, onCode, onWait, sleep, signal } = /** @type {any} */ ({})) {
  const flow = await beginDeviceLogin(serviceId, { env, fetchImpl, clientId, host });
  onCode?.(flow);
  const result = await awaitDeviceFlow(flow, { fetchImpl, sleep, signal, onWait });
  if (result.status === "expired") throw new DeviceFlowError("The code ran out before it was confirmed. Run the login again.", "expired");
  if (result.status === "denied") throw new DeviceFlowError("The sign-in was declined.", "access_denied");
  return finishDeviceLogin(flow, result.token, { env, fetchImpl });
}

export { checkDeviceFlow };

// A host the owner chose to send a stored login to, such as a proxy in front of
// the service. Without this a login is only used with the hosts it was issued for.
export async function allowHost(serviceId, host, { env } = /** @type {any} */ ({})) {
  const service = serviceFor(serviceId);
  const clean = String(host ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/[/:].*$/, "");
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(clean)) throw new Error(`'${host}' is not a host name.`);
  return { service: service.id, hosts: await storeFor({ env }).allowHost(service.secret, clean) };
}

export async function logout(serviceId, { env } = /** @type {any} */ ({})) {
  const service = serviceFor(serviceId);
  const removed = await storeFor({ env }).remove(service.secret);
  return { service: service.id, removed };
}

// For every service: connected or not, from where, and as whom. Values never.
export async function authStatus({ env = process.env } = /** @type {any} */ ({})) {
  let store;
  try { store = storeFor({ env }); } catch { store = undefined; }
  const entries = [];
  for (const id of SERVICE_IDS) {
    const service = SERVICES[id];
    const stored = await store?.describe(service.secret);
    const fromEnvironment = typeof env[service.env] === "string" && env[service.env] !== "";
    const app = await store?.app(id);
    const problem = id === SERVICE_IDS[0] ? await store?.permissionsProblem() : undefined;
    entries.push({
      ...(problem ? { storeProblem: problem } : {}),
      id,
      label: service.label,
      method: service.method,
      secret: service.secret,
      connected: Boolean(stored) || fromEnvironment,
      // The environment is consulted first, so it is what a run actually uses.
      source: fromEnvironment ? "environment" : stored ? "stored" : undefined,
      environmentVariable: service.env,
      stored: stored ?? undefined,
      clientId: app?.clientId ? true : false,
      usedFor: service.usedFor,
      help: service.keyHelp,
      appHelp: service.appHelp,
      defaultHost: service.host,
    });
  }
  return entries;
}
