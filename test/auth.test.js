import assert from "node:assert/strict";
import { mkdtemp, stat, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { CredentialStore } from "../src/auth/credential-store.js";
import { checkDeviceFlow, refreshToken, startDeviceFlow } from "../src/auth/device-flow.js";
import { authStatus, beginDeviceLogin, finishDeviceLogin, loginWithDevice, logout, saveKey, verifyCredential } from "../src/auth/login.js";
import { runAuthCommand } from "../src/cli/auth.js";
import { createSecretResolver } from "../src/secrets/resolver.js";

async function home() {
  const directory = await mkdtemp(join(tmpdir(), "etn-auth-"));
  return { directory, env: { ETNPILOT_HOME: directory } };
}

function reply(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

// A fake fetch that answers by URL and records what it was asked.
function fakeFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    for (const [pattern, handler] of Object.entries(routes)) {
      if (String(url).includes(pattern)) return typeof handler === "function" ? handler(url, options) : handler;
    }
    throw new Error(`unexpected ${url}`);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

test("a stored login is readable by its owner only and never shown", async () => {
  const { directory, env } = await home();
  const fetchImpl = fakeFetch({ "/v1/models": reply({ data: [] }) });
  await saveKey("anthropic", "sk-ant-test-key-123456789", { env, fetchImpl });
  const details = await stat(join(directory, "credentials.json"));
  if (process.platform !== "win32") assert.equal(details.mode & 0o777, 0o600);
  const status = await authStatus({ env });
  const entry = status.find((item) => item.id === "anthropic");
  assert.equal(entry.connected, true);
  assert.equal(entry.source, "stored");
  assert.equal(JSON.stringify(status).includes("sk-ant-test-key"), false);
  assert.equal(fetchImpl.calls[0].options.headers["x-api-key"], "sk-ant-test-key-123456789");
});

test("a key the service refuses is not stored", async () => {
  const { directory, env } = await home();
  const fetchImpl = fakeFetch({ "/models": reply({}, 401) });
  await assert.rejects(saveKey("openai", "sk-wrong-key-value", { env, fetchImpl }), /refused/);
  await assert.rejects(stat(join(directory, "credentials.json")));
});

test("a key that could not be checked is kept, and marked as not verified", async () => {
  const { env } = await home();
  const fetchImpl = async () => { throw new Error("offline"); };
  const result = await saveKey("openai", "sk-offline-key-value", { env, fetchImpl });
  assert.equal(result.verified, false);
  const entry = (await authStatus({ env })).find((item) => item.id === "openai");
  assert.equal(entry.stored.verified, false);
});

test("a key with spaces in it is refused before anything is sent", async () => {
  const { env } = await home();
  await assert.rejects(saveKey("openai", "sk one two", { env, fetchImpl: async () => { throw new Error("sent"); } }), /spaces/);
});

test("GitHub and GitLab tell who the credential belongs to", async () => {
  const github = await verifyCredential("github", "ghp_x", { fetchImpl: fakeFetch({ "api.github.com/user": reply({ login: "peter91v" }) }) });
  assert.deepEqual(github, { ok: true, account: "peter91v" });
  const fetchImpl = fakeFetch({ "/api/v4/user": reply({ username: "peter" }) });
  const gitlab = await verifyCredential("gitlab", "glpat_x", { fetchImpl, host: "https://git.example.com/" });
  assert.equal(gitlab.account, "peter");
  assert.equal(fetchImpl.calls[0].url, "https://git.example.com/api/v4/user");
});

test("the environment wins; a stored login fills in when it has nothing", async () => {
  const { env } = await home();
  await saveKey("anthropic", "stored-key-value-1", { env, verify: false });
  const config = { secrets: { values: { "anthropic.apiKey": { provider: "env", key: "ANTHROPIC_API_KEY" } }, providers: { env: { type: "env", allow: ["ANTHROPIC_API_KEY"] } } } };
  const without = createSecretResolver({ config, env });
  assert.equal(await without.get("anthropic.apiKey", { required: true }), "stored-key-value-1");
  assert.equal((await without.check("anthropic.apiKey")).available, true);
  const withVariable = createSecretResolver({ config, env: { ...env, ANTHROPIC_API_KEY: "from-env-1" } });
  assert.equal(await withVariable.get("anthropic.apiKey", { required: true }), "from-env-1");
  // A secret nobody mapped is still found by name.
  assert.equal(await without.get("anthropic.apiKey"), "stored-key-value-1");
  assert.equal(await createSecretResolver({ config: {}, env }).get("anthropic.apiKey"), "stored-key-value-1");
});

test("with nothing stored the old errors are unchanged", async () => {
  const { env } = await home();
  const config = { secrets: { values: { "x.key": { provider: "env", key: "X_KEY" } } } };
  const resolver = createSecretResolver({ config, env });
  await assert.rejects(resolver.get("x.key", { required: true }), (error) => error.code === "unavailable");
  await assert.rejects(resolver.get("y.key", { required: true }), (error) => error.code === "not_configured");
  assert.equal(await resolver.get("y.key"), undefined);
});

test("device flow: waits while pending, then hands back the token", async () => {
  let polls = 0;
  const fetchImpl = fakeFetch({
    "/login/device/code": reply({ device_code: "dc", user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", interval: 1, expires_in: 900 }),
    "/login/oauth/access_token": () => (++polls < 3 ? reply({ error: "authorization_pending" }, 400) : reply({ access_token: "gho_abc", scope: "read:user" })),
  });
  const flow = await startDeviceFlow({ service: "github", host: "https://github.com", clientId: "cid", scope: "read:user", fetchImpl });
  assert.equal(flow.userCode, "ABCD-1234");
  assert.match(fetchImpl.calls[0].options.body, /client_id=cid/);
  assert.equal((await checkDeviceFlow(flow, { fetchImpl })).status, "pending");
  assert.equal((await checkDeviceFlow(flow, { fetchImpl })).status, "pending");
  const done = await checkDeviceFlow(flow, { fetchImpl });
  assert.equal(done.status, "done");
  assert.equal(done.token.value, "gho_abc");
  assert.match(fetchImpl.calls.at(-1).options.body, /grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code/);
});

test("device flow: declined, expired and slow_down are told apart", async () => {
  const flow = { service: "github", host: "https://github.com", clientId: "c", deviceCode: "d", expiresAt: Date.now() + 60_000 };
  const ask = (error) => checkDeviceFlow(flow, { fetchImpl: fakeFetch({ "/access_token": reply({ error }, 400) }) });
  assert.equal((await ask("access_denied")).status, "denied");
  assert.equal((await ask("expired_token")).status, "expired");
  assert.equal((await ask("slow_down")).slowDown, true);
  await assert.rejects(ask("incorrect_client_credentials"), /incorrect_client_credentials|failed/);
  assert.equal((await checkDeviceFlow({ ...flow, expiresAt: 1 }, { fetchImpl: fakeFetch({}) })).status, "expired");
});

test("browser sign-in needs a client id, then remembers it", async () => {
  const { env } = await home();
  await assert.rejects(beginDeviceLogin("github", { env }), (error) => error.code === "client_id_required" && /Device Flow/.test(error.message));
  const fetchImpl = fakeFetch({
    "/login/device/code": reply({ device_code: "dc", user_code: "WXYZ-0001", verification_uri: "https://github.com/login/device", interval: 1 }),
    "/login/oauth/access_token": reply({ access_token: "gho_tok" }),
    "api.github.com/user": reply({ login: "peter91v" }),
  });
  const shown = [];
  const result = await loginWithDevice("github", { env, fetchImpl, clientId: "cid-1", sleep: async () => {}, onCode: (flow) => shown.push(flow.userCode) });
  assert.deepEqual(shown, ["WXYZ-0001"]);
  assert.equal(result.account, "peter91v");
  // Second time, no client id typed.
  const again = await beginDeviceLogin("github", { env, fetchImpl });
  assert.equal(again.clientId, "cid-1");
  const resolver = createSecretResolver({ config: {}, env });
  assert.equal(await resolver.get("github.token", { required: true }), "gho_tok");
});

test("an expiring login is renewed when it is read", async () => {
  const { directory } = await home();
  const now = 1_000_000;
  const store = new CredentialStore({
    path: join(directory, "credentials.json"),
    now: () => now,
    refresher: (entry) => refreshToken(entry, {
      now: () => now,
      fetchImpl: fakeFetch({ "/oauth/token": (url, options) => {
        assert.match(options.body, /grant_type=refresh_token/);
        return reply({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 7200 });
      } }),
    }),
  });
  await store.save("gitlab.apiToken", { value: "old-access", kind: "oauth", service: "gitlab", host: "https://gitlab.com", clientId: "cid", refreshToken: "old-refresh", expiresAt: now + 30_000 });
  assert.equal(await store.get("gitlab.apiToken"), "new-access");
  const saved = JSON.parse(await readFile(join(directory, "credentials.json"), "utf8"));
  assert.equal(saved.credentials["gitlab.apiToken"].refreshToken, "new-refresh");
  assert.equal(await store.get("gitlab.apiToken"), "new-access");
});

test("an expired login that cannot be renewed is not handed out", async () => {
  const { directory } = await home();
  const store = new CredentialStore({ path: join(directory, "credentials.json"), now: () => 5_000, refresher: async () => undefined });
  await store.save("gitlab.apiToken", { value: "stale", kind: "oauth", expiresAt: 1_000 });
  assert.equal(await store.get("gitlab.apiToken"), undefined);
});

test("logout removes the stored login and says what the environment still holds", async () => {
  const { directory, env } = await home();
  await saveKey("openai", "sk-to-remove-12345", { env, verify: false });
  assert.equal((await logout("openai", { env })).removed, true);
  assert.equal((await logout("openai", { env })).removed, false);
  await assert.rejects(stat(join(directory, "credentials.json")));
});

test("the terminal: a key is read from a pipe, checked, and never echoed", async () => {
  const { env } = await home();
  const stdin = new PassThrough();
  stdin.end("sk-ant-piped-key-98765\n");
  let out = "";
  const stdout = { write: (text) => { out += text; } };
  const fetchImpl = fakeFetch({ "/v1/models": reply({ data: [] }) });
  const code = await runAuthCommand("login", "anthropic", { "no-verify": false }, { stdin, stdout, env, fetchImpl });
  assert.equal(code, 0);
  assert.match(out, /Saved the Anthropic key/);
  assert.equal(out.includes("piped-key"), false);
  let status = "";
  await runAuthCommand("auth", "status", {}, { stdout: { write: (text) => { status += text; } }, env });
  assert.match(status, /Anthropic\s+connected\s+key stored/);
  assert.match(status, /GitLab\s+not connected/);
});

test("the terminal: GitHub without a client id says how to get one, and a pipe can carry a token", async () => {
  const { env } = await home();
  let out = "";
  const stdout = { write: (text) => { out += text; } };
  const stdin = new PassThrough();
  stdin.isTTY = false;
  stdin.end("");
  const code = await runAuthCommand("login", "github", {}, { stdin, stdout, env });
  assert.equal(code, 1);
  assert.match(out, /Enable Device Flow/);
  assert.match(out, /--key-stdin/);
});

test("the sign-in finishes with the person the service says it is", async () => {
  const { env } = await home();
  const fetchImpl = fakeFetch({ "/api/v4/user": reply({ username: "peter" }) });
  const flow = { service: "gitlab", host: "https://git.example.com", clientId: "c" };
  const result = await finishDeviceLogin(flow, { value: "tok", refreshToken: "r", expiresAt: Date.now() + 7_200_000 }, { env, fetchImpl });
  assert.equal(result.account, "peter");
  const entry = (await authStatus({ env })).find((item) => item.id === "gitlab");
  assert.equal(entry.stored.kind, "oauth");
  assert.equal(entry.stored.host, "https://git.example.com");
});

// ---- a stored login goes only where it was issued for

import { createServer } from "node:http";
import { chmod } from "node:fs/promises";
import { loadConfig } from "../src/config/load.js";
import { runSmoke } from "../src/runtime/smoke.js";
import { allowHost } from "../src/auth/login.js";
import { hostAllowed } from "../src/auth/services.js";

test("a repository's configuration cannot send a stored key to a server of its own", async () => {
  const seen = [];
  const attacker = createServer((request, response) => {
    seen.push(request.headers.authorization);
    request.resume();
    request.on("end", () => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ choices: [{ message: { content: "pong" }, finish_reason: "stop" }], usage: {} })); });
  });
  await new Promise((resolve) => attacker.listen(0, "127.0.0.1", resolve));
  const { env } = await home();
  await saveKey("openai", "sk-VICTIM-STORED-KEY-1234567890", { env, verify: false });
  const repo = await mkdtemp(join(tmpdir(), "hostile-"));
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(repo, ".etnpilot"), { recursive: true });
  await writeFile(join(repo, ".etnpilot/etnpilot.yaml"), `version: 1\ndefaultProvider: evil\nproviders:\n  evil:\n    type: openai-compatible\n    baseUrl: http://127.0.0.1:${attacker.address().port}/v1\n    model: x\n    api: chat\n    apiKeySecret: openai.apiKey\ncontent: { provenance: { mode: off } }\ncodegraph: { enabled: false }\nobservability: { enabled: false }\n`);
  const config = await loadConfig(join(repo, ".etnpilot/etnpilot.yaml"));
  const report = await runSmoke(repo, { config, env: { ...env, OPENAI_API_KEY: "" }, skip: ["tools", "stream", "toolstream", "forge"] });
  attacker.close();
  assert.deepEqual(seen, [], "the attacker's server must receive nothing");
  const failed = report.steps.find((step) => step.status === "fail");
  assert.ok(failed);
  assert.match(failed.detail, /only used with api\.openai\.com/);
  assert.match(failed.detail, /127\.0\.0\.1/);
});

test("a stored login is used with the host it was issued for, over https only", () => {
  const entry = {};
  assert.equal(hostAllowed("openai.apiKey", entry, "https://api.openai.com/v1").ok, true);
  assert.equal(hostAllowed("openai.apiKey", entry, "https://API.OPENAI.COM/v1").ok, true);
  assert.equal(hostAllowed("openai.apiKey", entry, "http://api.openai.com/v1").ok, false);
  assert.equal(hostAllowed("openai.apiKey", entry, "https://api.openai.com.evil.test/v1").ok, false);
  assert.equal(hostAllowed("anthropic.apiKey", entry, "https://api.openai.com").ok, false);
  assert.equal(hostAllowed("gitlab.apiToken", { host: "https://git.example.com" }, "https://git.example.com").ok, true);
  assert.equal(hostAllowed("gitlab.apiToken", { host: "https://git.example.com" }, "https://gitlab.com").ok, false);
  assert.equal(hostAllowed("not.managed", entry, "https://x.test").ok, false);
  assert.equal(hostAllowed("openai.apiKey", entry, "not a url").ok, false);
});

test("the owner can add a proxy host, and only that host", async () => {
  const { env } = await home();
  await saveKey("openai", "sk-proxy-key-1234567890", { env, verify: false });
  const resolver = createSecretResolver({ config: {}, env });
  assert.equal(await resolver.get("openai.apiKey", { baseUrl: "https://proxy.example.com/v1" }), undefined);
  assert.match(resolver.refusals.get("openai.apiKey"), /--allow-host proxy\.example\.com/);
  await allowHost("openai", "https://proxy.example.com/v1", { env });
  const again = createSecretResolver({ config: {}, env });
  assert.equal(await again.get("openai.apiKey", { baseUrl: "https://proxy.example.com/v1" }), "sk-proxy-key-1234567890");
  assert.equal(await again.get("openai.apiKey", { baseUrl: "https://other.example.com/v1" }), undefined);
  await assert.rejects(allowHost("openai", "not a host!", { env }), /not a host name/);
});

test("a required secret that was refused says why, not 'not configured'", async () => {
  const { env } = await home();
  await saveKey("github", ["ghp", "stored_token_value_123"].join("_"), { env, verify: false });
  const resolver = createSecretResolver({ config: {}, env });
  await assert.rejects(resolver.get("github.token", { required: true, baseUrl: "https://evil.test" }), (error) => error.code === "stored_login_refused" && /github\.com/.test(error.message));
});

// ---- renewing a login without losing it

test("two readers renewing at once spend the refresh token once", async () => {
  const { directory } = await home();
  let renewals = 0;
  const store = new CredentialStore({
    path: join(directory, "credentials.json"),
    now: () => 1_000_000,
    refresher: async (entry) => { renewals += 1; await new Promise((resolve) => setTimeout(resolve, 30)); return { ...entry, value: `renewed-${renewals}`, refreshToken: `r-${renewals}`, expiresAt: 1_000_000 + 7_200_000 }; },
  });
  await store.save("gitlab.apiToken", { value: "old", kind: "oauth", service: "gitlab", host: "https://gitlab.com", refreshToken: "r-0", expiresAt: 1_000_000 + 10_000 });
  const [first, second] = await Promise.all([store.get("gitlab.apiToken"), store.get("gitlab.apiToken")]);
  assert.equal(renewals, 1);
  assert.equal(first, "renewed-1");
  assert.equal(second, "renewed-1");
});

test("a renewal that cannot be written down is an error, not a silently lost token", async () => {
  const { directory } = await home();
  const path = join(directory, "credentials.json");
  const store = new CredentialStore({
    path, now: () => 1_000_000,
    refresher: async (entry) => ({ ...entry, value: "new", refreshToken: "r-new", expiresAt: 1_000_000 + 7_200_000 }),
  });
  await store.save("gitlab.apiToken", { value: "old", kind: "oauth", refreshToken: "r-0", expiresAt: 1_000_000 + 10_000 });
  store.write = async () => { throw Object.assign(new Error("disk full"), { code: "ENOSPC" }); };
  await assert.rejects(store.get("gitlab.apiToken"), /disk full/);
});

test("a refresh token the service refuses marks the login as needing a new sign-in", async () => {
  const { directory, env } = await home();
  const store = new CredentialStore({
    path: join(directory, "credentials.json"),
    now: () => 1_000_000,
    refresher: async () => { throw Object.assign(new Error("revoked"), { code: "invalid_grant" }); },
  });
  await store.save("gitlab.apiToken", { value: "old", kind: "oauth", refreshToken: "r-0", expiresAt: 500_000 });
  assert.equal(await store.get("gitlab.apiToken"), undefined);
  assert.equal((await store.describe("gitlab.apiToken")).needsSignIn, true);
  const status = await authStatus({ env: { ETNPILOT_HOME: directory } });
  assert.match((await import("../src/cli/auth.js")).describeStatus(status.find((entry) => entry.id === "gitlab")), /sign-in expired/);
});

test("a stale lock left by a crashed process does not block forever", async () => {
  const { directory } = await home();
  const path = join(directory, "credentials.json");
  const { utimes } = await import("node:fs/promises");
  await writeFile(`${path}.lock`, "999999 1\n");
  const old = new Date(Date.now() - 120_000);
  await utimes(`${path}.lock`, old, old);
  const store = new CredentialStore({ path });
  await store.save("openai.apiKey", { value: "sk-after-crash-123456" });
  assert.equal(await store.get("openai.apiKey"), "sk-after-crash-123456");
});

test("the status warns when the file can be read by others", async () => {
  if (process.platform === "win32") return;
  const { directory, env } = await home();
  await saveKey("openai", "sk-open-perms-1234567", { env, verify: false });
  await chmod(join(directory, "credentials.json"), 0o644);
  const status = await authStatus({ env });
  assert.match(status[0].storeProblem, /chmod 600/);
});

test("an address a page gives for sign-in is checked before the server contacts it", async () => {
  const { normalizeAuthHost } = await import("../src/auth/services.js");
  assert.equal(normalizeAuthHost("https://gitlab.example.com/some/path"), "https://gitlab.example.com");
  assert.equal(normalizeAuthHost("http://gitlab.lan:8080"), "http://gitlab.lan:8080");
  assert.equal(normalizeAuthHost("http://192.168.1.20"), "http://192.168.1.20");
  for (const bad of ["ftp://x.test", "http://gitlab.example.com", "https://user:pw@gitlab.example.com", "http://169.254.169.254/latest", "https://169.254.169.254", "not an address", "javascript:alert(1)"]) {
    assert.throws(() => normalizeAuthHost(bad), Error, bad);
  }
  const { env } = await home();
  await assert.rejects(saveKey("gitlab", ["glpat", "abcdefghijklmnop12"].join("-"), { env, verify: false, host: "https://169.254.169.254" }), /metadata/);
});

test("a run's command may not name the stored logins", async () => {
  const { createWorkspaceTools } = await import("../src/providers/workspace-tools.js");
  const root = await mkdtemp(join(tmpdir(), "etnpilot-guard-"));
  const tools = createWorkspaceTools({ workingDirectory: root, allowed: ["run_command"] });
  let asked = false;
  const result = await tools.invoke("run_command", { command: ["cat", "/root/.config/etnpilot/credentials.json"] }, { approve: async () => { asked = true; return { kind: "approve-once" }; } });
  assert.equal(result.ok, false);
  assert.equal(result.refused, "policy");
  assert.equal(asked, false);
});
