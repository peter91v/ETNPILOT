import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { ApprovalPolicy } from "../src/core/approval-policy.js";
import { Harness } from "../src/core/harness.js";
import { git } from "../src/git/command.js";
import { loadPlugins } from "../src/plugins/load-plugin.js";
import { runProject } from "../src/runtime/project-runner.js";
import { resolvePluginEntry } from "../src/plugins/worker-host.js";
import { createSecretResolver, SecretResolutionError } from "../src/secrets/resolver.js";

const VAULT_PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), "../src/plugins/vault.js");
const VAULT_ORIGIN = "https://vault.example.test";

test("bundled Vault plugin is available through the package subpath", async () => {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  assert.equal(await resolvePluginEntry("etnpilot/plugins/vault", repositoryRoot), VAULT_PLUGIN);
});

test("project startup can resolve bootstrap credentials through the isolated Vault plugin", async () => {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-vault-bootstrap-"));
  const etn = join(root, ".etnpilot");
  await Promise.all([
    mkdir(join(etn, "agents"), { recursive: true }),
    mkdir(join(etn, "prompts"), { recursive: true }),
  ]);
  await writeFile(join(etn, "prompts", "worker.md"), "Work.");
  await writeFile(join(etn, "agents", "worker.yaml"), "name: worker\nprovider: fake\npromptRef: worker\n");
  await writeFile(join(etn, "etnpilot.yaml"), [
    "version: 1",
    "defaultAgent: worker",
    "providers:",
    "  fake: { type: fake }",
    "secrets:",
    "  providers:",
    "    bootstrap: { type: env, allow: [ETNPILOT_VAULT_OIDC_TOKEN] }",
    "  values:",
    "    vault.oidcToken: { provider: bootstrap, key: ETNPILOT_VAULT_OIDC_TOKEN }",
    "    gitlab.apiToken: { provider: vault, key: apps/service#gitlabToken }",
    "policy:",
    "  operations:",
    "    default: deny",
    "    rules:",
    "      - { id: vault, effect: allow, kinds: [network], hosts: [vault.example.test] }",
    "plugins:",
    `  - path: ${JSON.stringify(VAULT_PLUGIN)}`,
    "    bootstrap: true",
    "    secretInputs: [vault.oidcToken]",
    `    networkAllow: [${VAULT_ORIGIN}/v1/]`,
    "    options:",
    "      name: vault",
    `      address: ${VAULT_ORIGIN}`,
    "      auth: { method: jwt, mount: jwt, role: etnpilot, tokenSecret: vault.oidcToken }",
    "      engine: { mount: secret, version: 2 }",
    "      allowedPaths: [apps]",
    "observability: { enabled: false }",
    "codegraph: { enabled: false }",
    "workflow:",
    "  steps: [{ id: agent, type: agent, agent: worker }]",
    "",
  ].join("\n"));
  await git(["init", "-b", "main"], { cwd: root });
  await git(["config", "user.email", "test@example.invalid"], { cwd: root });
  await git(["config", "user.name", "ETNPilot Test"], { cwd: root });
  await git(["add", "."], { cwd: root });
  await git(["commit", "-m", "initial"], { cwd: root });
  const paths = [];
  const result = await runProject({
    root,
    input: "bootstrap",
    worktree: false,
    env: { ETNPILOT_VAULT_OIDC_TOKEN: "workload-token" },
    providerFactories: {
      fake: (name) => ({ name, invoke: async () => ({ text: "done" }) }),
    },
    fetchImpl: async (url) => {
      const path = new URL(url).pathname;
      paths.push(path);
      if (path === "/v1/auth/jwt/login") {
        return jsonResponse({ auth: { client_token: "bootstrap-client-token", lease_duration: 3600, renewable: false } });
      }
      if (path === "/v1/secret/data/apps/service") {
        return jsonResponse({ data: { data: { gitlabToken: "gitlab-token" } } });
      }
      return new Response(null, { status: 204 });
    },
  });
  assert.equal(result.summary.status, "succeeded");
  assert.equal(paths.includes("/v1/secret/data/apps/service"), true);
  assert.equal(paths.includes("/v1/auth/token/revoke-self"), true);
});

test("isolated Vault plugin exchanges an OIDC token, reads an allowed field, and revokes its token", async () => {
  const calls = [];
  const { resolver, harness } = await loadVault({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      const path = new URL(url).pathname;
      if (path === "/v1/auth/jwt/login") {
        assert.deepEqual(JSON.parse(options.body), { role: "etnpilot", jwt: "workload-token" });
        return jsonResponse({ auth: { client_token: "vault-client-token", lease_duration: 3600, renewable: true } });
      }
      if (path === "/v1/secret/data/apps/service") {
        assert.equal(options.headers["x-vault-token"], "vault-client-token");
        return jsonResponse({ data: { data: { apiKey: "resolved-value" } } });
      }
      if (path === "/v1/auth/token/revoke-self") return new Response(null, { status: 204 });
      return new Response(null, { status: 404 });
    },
  });

  assert.equal(await resolver.get("service.apiKey", { required: true }), "resolved-value");
  await harness.close();
  assert.equal(calls.filter((call) => new URL(call.url).pathname === "/v1/auth/token/revoke-self").length, 1);
  assert.equal(resolver.providers.has("vault"), false);
});

test("Vault plugin renews renewable client tokens before expiry", async () => {
  const paths = [];
  const { resolver, harness } = await loadVault({
    options: { renewBeforeSeconds: 60 },
    fetchImpl: async (url) => {
      const path = new URL(url).pathname;
      paths.push(path);
      if (path === "/v1/auth/jwt/login") {
        return jsonResponse({ auth: { client_token: "short-token", lease_duration: 1, renewable: true } });
      }
      if (path === "/v1/auth/token/renew-self") {
        return jsonResponse({ auth: { lease_duration: 120, renewable: true } });
      }
      if (path === "/v1/secret/data/apps/service") {
        return jsonResponse({ data: { data: { apiKey: "resolved-value" } } });
      }
      return new Response(null, { status: 204 });
    },
  });

  assert.equal(await resolver.get("service.apiKey", { required: true }), "resolved-value");
  assert.equal(await resolver.get("service.apiKey", { required: true }), "resolved-value");
  assert.equal(paths.filter((path) => path === "/v1/auth/token/renew-self").length, 1);
  await harness.close();
});

test("Vault plugin denies undeclared bootstrap secrets, network targets, and secret path traversal", async () => {
  let fetchCalls = 0;
  const withoutSecretGrant = await loadVault({
    secretInputs: [],
    fetchImpl: async () => {
      fetchCalls += 1;
      return jsonResponse({});
    },
  });
  await assert.rejects(
    withoutSecretGrant.resolver.get("service.apiKey", { required: true }),
    (error) => safeProviderFailure(error),
  );
  assert.equal(fetchCalls, 0);
  await withoutSecretGrant.harness.close();

  const wrongNetworkGrant = await loadVault({
    networkAllow: ["https://other.example.test/v1/"],
    fetchImpl: async () => {
      fetchCalls += 1;
      return jsonResponse({});
    },
  });
  await assert.rejects(
    wrongNetworkGrant.resolver.get("service.apiKey", { required: true }),
    (error) => safeProviderFailure(error),
  );
  assert.equal(fetchCalls, 0);
  await wrongNetworkGrant.harness.close();

  const traversal = await loadVault({
    values: { bad: { provider: "vault", key: "apps/../admin#token" } },
    fetchImpl: async () => {
      fetchCalls += 1;
      return jsonResponse({});
    },
  });
  await assert.rejects(traversal.resolver.get("bad", { required: true }), (error) => safeProviderFailure(error));
  assert.equal(fetchCalls, 0);
  await traversal.harness.close();
});

test("Vault plugin normalizes upstream failures and bounds network responses", async () => {
  const upstreamMarker = "upstream-body-must-not-escape";
  const failed = await loadVault({
    fetchImpl: async () => new Response(upstreamMarker, { status: 500 }),
  });
  await assert.rejects(
    failed.resolver.get("service.apiKey", { required: true }),
    (error) => safeProviderFailure(error) && !JSON.stringify(error).includes(upstreamMarker),
  );
  await failed.harness.close();

  const oversized = await loadVault({
    limits: { maxMessageBytes: 4_096 },
    fetchImpl: async () => new Response("x".repeat(8_192), { status: 200 }),
  });
  await assert.rejects(
    oversized.resolver.get("service.apiKey", { required: true }),
    (error) => safeProviderFailure(error),
  );
  await oversized.harness.close();
  assert.equal(oversized.resolver.providers.has("vault"), false);
});

async function loadVault({
  fetchImpl,
  secretInputs = ["vault.oidcToken"],
  networkAllow = [`${VAULT_ORIGIN}/v1/`],
  options = {},
  values = { "service.apiKey": { provider: "vault", key: "apps/service#apiKey" } },
  limits,
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-vault-plugin-"));
  await writeFile(join(root, "package.json"), "{\"type\":\"module\"}\n");
  const resolver = createSecretResolver({
    env: { ETNPILOT_VAULT_OIDC_TOKEN: "workload-token" },
    config: {
      secrets: {
        providers: { bootstrap: { type: "env", allow: ["ETNPILOT_VAULT_OIDC_TOKEN"] } },
        values: {
          "vault.oidcToken": { provider: "bootstrap", key: "ETNPILOT_VAULT_OIDC_TOKEN" },
          ...values,
        },
      },
    },
  });
  const harness = new Harness({
    approvalPolicy: new ApprovalPolicy({ allow: ["network"], requireHuman: [] }),
    secrets: resolver,
  });
  await loadPlugins([{
    path: VAULT_PLUGIN,
    secretInputs,
    networkAllow,
    limits,
    options: {
      name: "vault",
      address: VAULT_ORIGIN,
      auth: { method: "jwt", mount: "jwt", role: "etnpilot", tokenSecret: "vault.oidcToken" },
      engine: { mount: "secret", version: 2 },
      allowedPaths: ["apps"],
      ...options,
    },
  }], harness, root, { secretResolver: resolver, fetchImpl });
  return { resolver, harness };
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function safeProviderFailure(error) {
  return error instanceof SecretResolutionError
    && error.code === "provider_failed"
    && !JSON.stringify(error).includes("workload-token")
    && !JSON.stringify(error).includes("vault-client-token");
}
