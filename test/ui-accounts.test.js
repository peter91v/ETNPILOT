import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAccountRoutes } from "../src/ui/accounts.js";
import { renderReviewPage } from "../src/ui/page.js";

function reply(body, status = 200) {
  return { ok: status < 300, status, json: async () => body };
}

async function routes(fetchImpl) {
  const env = { ETNPILOT_HOME: await mkdtemp(join(tmpdir(), "etn-acc-")) };
  return { env, handle: createAccountRoutes({ env, fetchImpl, gitlabHost: () => "https://git.example.com" }) };
}

test("the page sends a key once and never gets one back", async () => {
  const { handle } = await routes(async () => reply({ login: "peter91v" }));
  const saved = await handle("POST", "/api/auth/key", { service: "github", value: "ghp_secretvalue123456" });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.account, "peter91v");
  const status = await handle("GET", "/api/auth");
  assert.equal(JSON.stringify(status.body).includes("secretvalue"), false);
  assert.equal(status.body.services.find((item) => item.id === "github").stored.account, "peter91v");
  assert.equal(status.body.projectGitLabHost, "https://git.example.com");
});

test("a refused key is a 400 with the reason, not a 500", async () => {
  const { handle } = await routes(async () => reply({}, 401));
  const result = await handle("POST", "/api/auth/key", { service: "openai", value: "sk-nope-nope-nope" });
  assert.equal(result.status, 400);
  assert.match(result.body.error, /refused/);
  assert.equal((await handle("POST", "/api/auth/key", { service: "bogus", value: "x" })).status, 400);
});

test("a browser sign-in: start, wait, done — the device code stays on the server", async () => {
  let polls = 0;
  const fetchImpl = async (url) => {
    if (String(url).includes("/oauth/authorize_device")) return reply({ device_code: "SECRET-DEVICE", user_code: "GL-1234", verification_uri: "https://git.example.com/oauth/device", interval: 1, expires_in: 600 });
    if (String(url).includes("/oauth/token")) return ++polls < 2 ? reply({ error: "authorization_pending" }, 400) : reply({ access_token: "glpat-tok", refresh_token: "r", expires_in: 7200 });
    if (String(url).includes("/api/v4/user")) return reply({ username: "peter" });
    throw new Error(String(url));
  };
  const { handle } = await routes(fetchImpl);
  const refused = await handle("POST", "/api/auth/device/start", { service: "gitlab" });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.code, "client_id_required");
  const started = await handle("POST", "/api/auth/device/start", { service: "gitlab", clientId: "app-1" });
  assert.equal(started.body.userCode, "GL-1234");
  assert.equal(JSON.stringify(started.body).includes("SECRET-DEVICE"), false);
  assert.equal((await handle("POST", "/api/auth/device/poll", { flowId: started.body.flowId })).body.status, "pending");
  const done = await handle("POST", "/api/auth/device/poll", { flowId: started.body.flowId });
  assert.deepEqual(done.body, { status: "done", account: "peter" });
  assert.equal((await handle("POST", "/api/auth/device/poll", { flowId: started.body.flowId })).status, 404);
  const gitlab = (await handle("GET", "/api/auth")).body.services.find((item) => item.id === "gitlab");
  assert.equal(gitlab.stored.kind, "oauth");
  assert.equal(gitlab.clientId, true);
  assert.equal((await handle("DELETE", "/api/auth/gitlab")).body.removed, true);
});

test("the page has an Accounts view and parses", () => {
  const page = renderReviewPage("t");
  assert.match(page, /id="view-accounts"/);
  assert.match(page, /function renderAccounts\(/);
  const script = page.slice(page.lastIndexOf("<script>") + 8, page.lastIndexOf("</script>"));
  assert.doesNotThrow(() => new Function(script));
});
