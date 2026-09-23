import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { ApprovalStateError } from "../core/approval-inbox.js";
import { openProjectState } from "../runtime/project-state.js";
import { renderReviewPage } from "./page.js";

// A local review surface for the evidence ETNPilot already produces: pending
// approvals, queued work, and finished runs. It reads the same databases the
// CLI does, so nothing here is a second source of truth.
//
// Security posture: bound to the loopback interface, and every request must
// carry a token minted at startup. Mutating calls additionally require a
// custom header, which a page on another origin cannot send without a
// preflight this server refuses. Anyone who can read the token can approve
// operations, exactly like anyone who can write the inbox database.
export async function createReviewServer({
  root = process.cwd(),
  env = process.env,
  token = randomBytes(24).toString("base64url"),
} = {}) {
  const state = await openProjectState({ root, env });
  const { inbox, queue } = state;

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      if (request.method === "OPTIONS") return send(response, 405, { error: "cross-origin-requests-are-not-served" });
      if (url.pathname === "/" && request.method === "GET") {
        if (!authorized(url.searchParams.get("token"), token)) {
          return html(response, 401, "<h1>ETNPilot</h1><p>Open the URL printed by <code>etnpilot ui</code>.</p>");
        }
        return html(response, 200, renderReviewPage(token));
      }
      if (!url.pathname.startsWith("/api/")) return send(response, 404, { error: "not-found" });
      if (!authorized(header(request, "x-etnpilot-token"), token)) {
        return send(response, 401, { error: "unauthorized" });
      }
      if (request.method === "GET" && url.pathname === "/api/state") {
        return send(response, 200, await state.collect());
      }
      if (request.method === "POST" && url.pathname === "/api/approvals/decide") {
        const body = await readJsonBody(request);
        return send(response, 200, decideApproval(inbox, body));
      }
      if (request.method === "POST" && url.pathname === "/api/queue/cancel") {
        const body = await readJsonBody(request);
        return send(response, 200, queue.requestCancel(String(body.id), {
          actor: actorName(body, env),
          reason: body.reason ? String(body.reason) : undefined,
        }));
      }
      return send(response, 404, { error: "not-found" });
    } catch (error) {
      const status = error.statusCode ?? (error instanceof ApprovalStateError ? 409 : 500);
      return send(response, status, { error: error.message });
    }
  });

  return {
    server,
    token,
    inbox,
    queue,
    listen({ host = "127.0.0.1", port = 8788 } = {}) {
      return new Promise((resolveListen, reject) => {
        const onError = (error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          const address = server.address();
          resolveListen({ ...address, url: `http://${displayHost(address.address)}:${address.port}/?token=${token}` });
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, host);
      });
    },
    async close() {
      if (server.listening) {
        await new Promise((resolveClose, reject) => server.close((error) => (error ? reject(error) : resolveClose())));
      }
      state.close();
    },
  };
}

function decideApproval(inbox, body) {
  const decision = body.decision === "approve" ? "approved" : body.decision === "reject" ? "rejected" : undefined;
  if (!decision) throw badRequest("decision must be 'approve' or 'reject'.");
  if (!body.id) throw badRequest("An approval id is required.");
  return inbox.decide(String(body.id), decision, {
    actor: actorName(body, process.env),
    reason: body.reason ? String(body.reason) : undefined,
  });
}

function actorName(body, env) {
  // The reviewer names themselves, as with the CLI. Identity asserted by a
  // third party is what the GitLab comment flow is for.
  const actor = body.actor ? String(body.actor).trim() : "";
  return actor.length > 0 ? `ui:${actor.slice(0, 64)}` : `ui:${env.USER ?? "local"}`;
}

function authorized(candidate, expected) {
  if (typeof candidate !== "string") return false;
  const left = Buffer.from(candidate);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function header(request, name) {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

async function readJsonBody(request, maxBytes = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw badRequest("Request body is too large.");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw badRequest("Request body is not valid JSON.");
  }
}

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function displayHost(address) {
  return address === "::" || address === "0.0.0.0" ? "127.0.0.1" : address.includes(":") ? `[${address}]` : address;
}

function send(response, status, payload) {
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(`${JSON.stringify(payload)}\n`);
}

function html(response, status, body) {
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    // The page loads nothing from anywhere: no CDN, no fonts, no analytics.
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
    "referrer-policy": "no-referrer",
  });
  response.end(body);
}
