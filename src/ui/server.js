import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { ApprovalStateError } from "../core/approval-inbox.js";
import { parseSettingValue, SettingsRefused } from "../config/settings.js";
import { openProjectState } from "../runtime/project-state.js";
import { WorkflowQueueStateError } from "../workflow/queue.js";
import { createProject, describeProject } from "../runtime/first-run.js";
import { renderReviewPage } from "./page.js";
import { renderIcon, renderManifest, renderServiceWorker } from "./app.js";
import { renderSetupPage } from "./setup-page.js";
import { readOrCreateToken, writeToken } from "./token.js";

// A local review surface for the evidence ETNPilot already produces: pending
// approvals, queued work, and finished runs. It reads the same databases the
// CLI does, so nothing here is a second source of truth.
//
// Security posture: bound to the loopback interface, and every request must
// carry the project's token. It arrives one of two ways — in the URL a person
// opened, or in a cookie this server set when they did. Mutating calls
// additionally require a custom header, which a page on another origin cannot
// send without a preflight this server refuses; the cookie alone is never
// enough to change anything. Anyone who can read the token can approve
// operations, exactly like anyone who can write the inbox database.
export async function createReviewServer({
  root = process.cwd(),
  env = process.env,
  token,
  rotateToken = false,
} = {}) {
  // Kept between starts, because an installed app holds a link: a token minted
  // per start locks that icon out at the next restart. A caller may still pass
  // one, which is what the tests do.
  // A directory with no project in it is not an error to crash on: the page
  // offers to create one, exactly as the terminal interface does. Until it
  // exists there is no state to open, and every route that needs one says so
  // rather than failing on a file nobody has heard of.
  const project = await describeProject({ root });
  let state = project.exists ? await openProjectState({ root, env }) : undefined;
  const resolvedToken = token
    ?? (await readOrCreateToken(root, { rotate: rotateToken, persist: project.exists })).token;

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      if (request.method === "OPTIONS") return send(response, 405, { error: "cross-origin-requests-are-not-served" });
      // Two ways in, and the second is the one an installed app has: a link
      // carries the token in its query, and opening it leaves a cookie behind
      // so the next launch — which has no query at all — is still let in.
      const fromQuery = authorized(url.searchParams.get("token"), resolvedToken);
      const fromCookie = authorized(cookie(request, SESSION_COOKIE), resolvedToken);
      if (url.pathname === "/" && request.method === "GET") {
        if (!fromQuery && !fromCookie) {
          return html(response, 401, "<h1>ETNPilot</h1><p>Open the URL printed by <code>etnpilot ui</code>.</p>");
        }
        return html(response, 200, state
          ? renderReviewPage(resolvedToken)
          : renderSetupPage(resolvedToken, await describeProject({ root })), {
          // Refreshed on every visit, so an app in daily use never falls out.
          "set-cookie": sessionCookie(resolvedToken),
        });
      }
      // The app's shell. These three carry no evidence — a name, two drawn
      // icons and a worker script — so they are served without the token:
      // a manifest and a service worker are fetched by the browser itself,
      // sometimes without the page's credentials, and an installed app that
      // cannot fetch its own icon is not installed.
      if (request.method === "GET" && url.pathname === "/manifest.webmanifest") {
        return send(response, 200, renderManifest({ project: state?.config?.git?.project ?? "" }));
      }
      if (request.method === "GET" && (url.pathname === "/icon.svg" || url.pathname === "/icon-maskable.svg")) {
        return svg(response, renderIcon({ maskable: url.pathname.includes("maskable") }));
      }
      if (request.method === "GET" && url.pathname === "/sw.js") {
        // The token is the cache's version, so a new session cannot be served
        // a previous one's shell.
        return script(response, renderServiceWorker(resolvedToken.slice(0, 8)));
      }
      if (!url.pathname.startsWith("/api/")) return send(response, 404, { error: "not-found" });
      // Reading may go through the cookie; changing anything may not. A page
      // on another origin can make a browser send a cookie, but it cannot set
      // this header, and it cannot read what comes back either way. That is
      // the whole of the cross-site defence, so the cookie never widens it.
      const headerToken = authorized(header(request, "x-etnpilot-token"), resolvedToken);
      if (!headerToken && !(request.method === "GET" && fromCookie)) {
        return send(response, 401, { error: "unauthorized" });
      }
      // The only route that works before there is a project, and the only one
      // that stops working once there is: creating one twice is not a thing
      // this surface offers.
      if (request.method === "POST" && url.pathname === "/api/project/create") {
        if (state) throw badRequest("This directory already has a project.");
        const body = await readJsonBody(request);
        const created = await createProject({ root, template: String(body.template ?? "default") })
          .catch((error) => { throw error instanceof TypeError ? badRequest(error.message) : error; });
        state = await openProjectState({ root, env });
        // Now there is somewhere to keep it, so the link survives a restart
        // and the app this project can install is not locked out.
        if (!token) await writeToken(root, resolvedToken).catch(() => {});
        return send(response, 201, created);
      }
      if (!state) return send(response, 409, { error: "no-project-here", root });
      if (request.method === "GET" && url.pathname === "/api/state") {
        return send(response, 200, await state.collect());
      }
      if (request.method === "POST" && url.pathname === "/api/approvals/decide") {
        const body = await readJsonBody(request);
        return send(response, 200, decideApproval(state.inbox, body));
      }
      if (request.method === "POST" && url.pathname === "/api/queue/cancel") {
        const body = await readJsonBody(request);
        return send(response, 200, state.queue.requestCancel(String(body.id), {
          actor: actorName(body, env),
          reason: body.reason ? String(body.reason) : undefined,
        }));
      }
      if (request.method === "POST" && url.pathname === "/api/queue/resume") {
        const body = await readJsonBody(request);
        if (!body.id) throw badRequest("A workflow job id is required.");
        return send(response, 200, state.resumeJob(String(body.id), { force: body.force === true }));
      }
      // Read on demand, never in the poll: one runs 'git status' per worktree,
      // the other crosses the network to GitLab.
      if (request.method === "GET" && url.pathname === "/api/worktrees") {
        return send(response, 200, await state.worktrees());
      }
      if (request.method === "POST" && url.pathname === "/api/worktrees/remove") {
        const body = await readJsonBody(request);
        if (typeof body.name !== "string" || body.name.trim() === "") throw badRequest("A worktree name is required.");
        const removal = await state.removeWorktree(body.name.trim()).catch((error) => {
          throw error instanceof TypeError ? badRequest(error.message) : error;
        });
        return send(response, 200, removal);
      }
      if (request.method === "GET" && url.pathname === "/api/worktrees/changes") {
        const name = url.searchParams.get("name");
        if (!name) throw badRequest("A worktree name is required.");
        const changes = await state.worktreeChanges(name).catch((error) => {
          throw error instanceof TypeError ? badRequest(error.message) : error;
        });
        return send(response, 200, changes);
      }
      if (request.method === "GET" && url.pathname === "/api/worktrees/diff") {
        const name = url.searchParams.get("name");
        const file = url.searchParams.get("file");
        if (!name || !file) throw badRequest("A worktree name and a file are required.");
        const diff = await state.worktreeDiff(name, file).catch((error) => {
          throw error instanceof TypeError ? badRequest(error.message) : error;
        });
        return send(response, 200, diff);
      }
      if (request.method === "GET" && url.pathname === "/api/agents") {
        return send(response, 200, await state.agents());
      }
      if (request.method === "GET" && url.pathname === "/api/usage") {
        return send(response, 200, await state.usage());
      }
      // A provider's models, read live from its own API — never cached here,
      // so the list is what the account can reach right now, not a memory of
      // it. A provider whose key is missing or refused says so; that is not
      // a server fault.
      if (request.method === "GET" && url.pathname.startsWith("/api/providers/") && url.pathname.endsWith("/models")) {
        const name = decodeURIComponent(url.pathname.slice("/api/providers/".length, -"/models".length));
        const result = await state.listProviderModels(name).catch((error) => {
          if (error instanceof TypeError) throw badRequest(error.message);
          return { available: false, reason: error.message };
        });
        return send(response, 200, result);
      }
      if (request.method === "GET" && url.pathname === "/api/merges") {
        const status = url.searchParams.get("status");
        return send(response, 200, await state.mergeRequests(status ? { state: status } : undefined));
      }
      if (request.method === "GET" && url.pathname === "/api/settings") {
        return send(response, 200, await state.settings());
      }
      if (request.method === "POST" && url.pathname === "/api/settings/set") {
        const body = await readJsonBody(request);
        if (typeof body.path !== "string" || body.path.trim() === "") throw badRequest("A setting path is required.");
        // The value arrives as the YAML a person typed, exactly as in the CLI
        // and the TUI, so '4', 'true' and '["read"]' mean what they look like.
        let value;
        try {
          value = typeof body.value === "string" ? parseSettingValue(body.value) : body.value;
        } catch (error) {
          throw badRequest(`That is not valid YAML: ${error.message}`);
        }
        return send(response, 200, await state.setSetting(body.path.trim(), value, { scope: scopeName(body) }));
      }
      if (request.method === "POST" && url.pathname === "/api/settings/unset") {
        const body = await readJsonBody(request);
        if (typeof body.path !== "string" || body.path.trim() === "") throw badRequest("A setting path is required.");
        return send(response, 200, await state.unsetSetting(body.path.trim(), { scope: scopeName(body) }));
      }
      // A run is not awaited: the answer says it started, and everything the
      // run then needs appears in this same page's approvals.
      if (request.method === "POST" && url.pathname === "/api/runs/start") {
        const body = await readJsonBody(request);
        const task = typeof body.task === "string" ? body.task.trim() : "";
        if (task === "") throw badRequest("A run needs a task to work on.");
        const agent = typeof body.agent === "string" && body.agent.trim() !== "" ? body.agent.trim() : undefined;
        state.startRun({ input: task, agent });
        return send(response, 202, { started: true, task, ...(agent ? { agent } : {}) });
      }
      // Whether a receipt is what it claims. It rereads and rehashes the whole
      // file, so it is a route of its own that the page's poll never calls —
      // a person asks for it, per run.
      if (request.method === "GET" && url.pathname.startsWith("/api/verify/")) {
        const file = decodeURIComponent(url.pathname.slice("/api/verify/".length));
        const report = await state.verifyReceipt(file).catch((error) => {
          throw error instanceof TypeError ? badRequest(error.message) : error;
        });
        return send(response, 200, report);
      }
      // The checks this project can run on itself. Listing them is part of the
      // state; running one is a POST, because it reads the working tree.
      if (request.method === "GET" && url.pathname === "/api/checks") {
        return send(response, 200, { checks: state.checks() });
      }
      if (request.method === "POST" && url.pathname === "/api/checks/run") {
        const body = await readJsonBody(request);
        if (typeof body.id !== "string" || body.id.trim() === "") throw badRequest("A check id is required.");
        const result = await state.runCheck(body.id.trim()).catch((error) => {
          throw badRequest(error.message);
        });
        return send(response, 200, result);
      }
      // The file name is never inspected here: readReceipt refuses anything
      // that is not a '*.jsonl' without a path separator, and one check in
      // one place cannot drift from another.
      if (request.method === "GET" && url.pathname.startsWith("/api/runs/")) {
        const file = decodeURIComponent(url.pathname.slice("/api/runs/".length));
        const receipt = await state.readReceipt(file).catch((error) => {
          // A name readReceipt refuses is a bad request, not a server fault.
          throw error instanceof TypeError ? badRequest(error.message) : error;
        });
        return send(response, 200, receipt);
      }
      return send(response, 404, { error: "not-found" });
    } catch (error) {
      return send(response, statusFor(error), errorBody(error));
    }
  });

  return {
    server,
    token: resolvedToken,
    // The state is created when the project is, so these read through rather
    // than being captured once.
    get state() { return state; },
    get inbox() { return state?.inbox; },
    get queue() { return state?.queue; },
    listen({ host = "127.0.0.1", port = 8788 } = {}) {
      return new Promise((resolveListen, reject) => {
        const onError = (error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          const address = server.address();
          // A link that only works on the machine that printed it is no help
          // on a tablet: when the port is open to the network, the address
          // given is one that can actually be reached from there.
          const exposed = !isLoopback(address.address);
          const displayed = exposed ? (localAddress() ?? displayHost(address.address)) : displayHost(address.address);
          resolveListen({
            ...address,
            exposed,
            url: `http://${bracket(displayed)}:${address.port}/?token=${resolvedToken}`,
          });
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, host);
      });
    },
    async close() {
      // Runs this server started are stopped before the databases they write
      // to are closed, rather than being left working for nobody.
      state?.stopRuns();
      if (server.listening) {
        await new Promise((resolveClose, reject) => server.close((error) => (error ? reject(error) : resolveClose())));
      }
      state?.close();
    },
  };
}

// A refusal is an answer, not a crash: the state errors these modules raise
// are conflicts and bad requests, and the page shows them where the action
// was taken rather than as 'request failed (500)'.
function svg(response, body) {
  response.writeHead(200, {
    "content-type": "image/svg+xml; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

function script(response, body) {
  response.writeHead(200, {
    "content-type": "text/javascript; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    // A service worker may only control the paths under its own scope, and
    // this one needs the origin so an installed page is one of them.
    "service-worker-allowed": "/",
  });
  response.end(body);
}

function statusFor(error) {
  if (error.statusCode) return error.statusCode;
  if (error instanceof ApprovalStateError || error instanceof WorkflowQueueStateError) return 409;
  if (error instanceof SettingsRefused) return 409;
  if (error.code === "ENOENT") return 404;
  return 500;
}

function errorBody(error) {
  return {
    error: error.message,
    ...(error.path ? { path: error.path } : {}),
    ...(error.reason ? { reason: error.reason } : {}),
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

function scopeName(body) {
  const scope = body.scope === undefined ? "local" : String(body.scope);
  if (scope !== "local" && scope !== "global") throw badRequest("scope must be 'local' or 'global'.");
  return scope;
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
  return address === "::" || address === "0.0.0.0" ? "127.0.0.1" : address;
}

function bracket(address) {
  return address.includes(":") ? `[${address}]` : address;
}

// 'Loopback' is the whole security posture of this server, so it is decided
// from the address it actually bound to, not from what was asked for.
function isLoopback(address) {
  if (address === "::1" || address === "127.0.0.1") return true;
  if (address === "::" || address === "0.0.0.0") return false;
  return address.startsWith("127.") || address === "::ffff:127.0.0.1";
}

// The address another device on this network would use. Picked rather than
// guessed, so the printed link is one that works from the tablet in your hand.
function localAddress() {
  for (const interfaces of Object.values(networkInterfaces())) {
    for (const entry of interfaces ?? []) {
      if (entry.internal) continue;
      if (entry.family === "IPv4" || entry.family === 4) return entry.address;
    }
  }
  return undefined;
}

function send(response, status, payload) {
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(`${JSON.stringify(payload)}\n`);
}

// The session cookie is the token itself: no second secret to leak, and
// nothing a person has to keep. 'Strict' keeps it off every cross-site
// request, 'HttpOnly' keeps it out of the page's own script, and there is no
// 'Secure' because this server is loopback http by design.
const SESSION_COOKIE = "etnpilot_ui";

function sessionCookie(token) {
  return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${30 * 24 * 60 * 60}; HttpOnly; SameSite=Strict`;
}

function cookie(request, name) {
  const jar = request.headers.cookie;
  if (typeof jar !== "string") return undefined;
  for (const part of jar.split(";")) {
    const at = part.indexOf("=");
    if (at === -1) continue;
    if (part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return undefined;
}

function html(response, status, body, extra = {}) {
  response.writeHead(status, {
    ...extra,
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    // The page loads nothing from anywhere: no CDN, no fonts, no analytics.
    // The three 'self' sources are the app shell this server draws itself —
    // the icons, the manifest and the service worker — and nothing else is
    // reachable from here, which is what 'default-src none' keeps true.
    "content-security-policy": "default-src 'none'; img-src data: 'self'; style-src 'unsafe-inline';"
      + " script-src 'unsafe-inline'; connect-src 'self'; manifest-src 'self'; worker-src 'self'",
    "referrer-policy": "no-referrer",
  });
  response.end(body);
}
