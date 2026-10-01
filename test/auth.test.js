import assert from "node:assert/strict";
import { mkdtemp, stat, readFile } from "node:fs/promises";
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
  let now = 1_000_000;
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
