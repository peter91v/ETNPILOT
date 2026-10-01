import { randomBytes } from "node:crypto";
import { checkDeviceFlow, DeviceFlowError } from "../auth/device-flow.js";
import { authStatus, beginDeviceLogin, finishDeviceLogin, logout, saveKey } from "../auth/login.js";
import { serviceFor } from "../auth/services.js";

// The page's side of signing in. The browser never sees a credential: it sends
// a key once and gets back who it belongs to, or it asks for a device code and
// then asks "done yet?" while the person confirms elsewhere. The flow's secret
// device code stays here.

const MAX_FLOWS = 6;

export function createAccountRoutes({ env = process.env, fetchImpl, gitlabHost = () => undefined } = {}) {
  const flows = new Map();

  function prune() {
    for (const [id, entry] of flows) if (entry.flow.expiresAt < Date.now()) flows.delete(id);
    while (flows.size >= MAX_FLOWS) flows.delete(flows.keys().next().value);
  }

  return async function handle(method, pathname, body) {
    if (!pathname.startsWith("/api/auth")) return undefined;
    try {
      if (method === "GET" && pathname === "/api/auth") {
        return { status: 200, body: { services: await authStatus({ env }), projectGitLabHost: gitlabHost() } };
      }
      if (method === "POST" && pathname === "/api/auth/key") {
        const service = serviceFor(body?.service);
        const result = await saveKey(service.id, body?.value, {
          env, fetchImpl, verify: body?.verify !== false,
          host: service.id === "gitlab" ? (typeof body?.host === "string" && body.host ? body.host : gitlabHost()) : undefined,
        });
        return { status: 200, body: result };
      }
      if (method === "POST" && pathname === "/api/auth/device/start") {
        const service = serviceFor(body?.service);
        prune();
        const flow = await beginDeviceLogin(service.id, {
          env, fetchImpl,
          clientId: typeof body?.clientId === "string" && body.clientId.trim() ? body.clientId.trim() : undefined,
          host: typeof body?.host === "string" && body.host ? body.host : (service.id === "gitlab" ? gitlabHost() : undefined),
        });
        const id = randomBytes(12).toString("hex");
        flows.set(id, { flow });
        return {
          status: 200,
          body: {
            flowId: id,
            service: service.id,
            userCode: flow.userCode,
            verificationUri: flow.verificationUri,
            verificationUriComplete: flow.verificationUriComplete,
            interval: flow.interval,
            expiresAt: flow.expiresAt,
          },
        };
      }
      if (method === "POST" && pathname === "/api/auth/device/poll") {
        const entry = flows.get(String(body?.flowId ?? ""));
        if (!entry) return { status: 404, body: { error: "That sign-in is not running any more. Start it again.", code: "unknown_flow" } };
        const result = await checkDeviceFlow(entry.flow, { fetchImpl }).catch((error) => {
          flows.delete(body.flowId);
          throw error;
        });
        if (result.status === "pending") return { status: 200, body: { status: "pending", slowDown: result.slowDown === true } };
        flows.delete(body.flowId);
        if (result.status !== "done") return { status: 200, body: { status: result.status } };
        const done = await finishDeviceLogin(entry.flow, result.token, { env, fetchImpl });
        return { status: 200, body: { status: "done", account: done.account } };
      }
      const named = /^\/api\/auth\/([a-z]+)$/.exec(pathname);
      if (method === "DELETE" && named) {
        const result = await logout(named[1], { env });
        return { status: 200, body: result };
      }
      return { status: 404, body: { error: "not-found" } };
    } catch (error) {
      if (error instanceof DeviceFlowError || error.code === "rejected" || /^Unknown service|^Enter the|does not look like a key/.test(error.message)) {
        return { status: 400, body: { error: error.message, code: error.code } };
      }
      throw error;
    }
  };
}
