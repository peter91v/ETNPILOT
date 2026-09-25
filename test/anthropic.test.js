import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import YAML from "yaml";
import { initializeProject } from "../src/config/init.js";
import { loadConfig } from "../src/config/load.js";
import { setSetting } from "../src/config/settings.js";
import { createAnthropicProvider } from "../src/providers/anthropic.js";
import { registerConfiguredProviders } from "../src/providers/register.js";
import { ProviderError, ProviderRouter } from "../src/providers/router.js";
import { createSecretResolver } from "../src/secrets/resolver.js";
import { Harness } from "../src/core/harness.js";
import { WORKSPACE_TOOL_DEFINITIONS } from "../src/providers/workspace-tools.js";

const context = (overrides = {}) => ({
  agent: { name: "worker", prompt: "Do the work." },
  input: "hello",
  instructions: [],
  skills: [],
  ...overrides,
});

test("the Anthropic provider speaks the Messages API and counts its tokens", async () => {
  const requests = [];
  const provider = createAnthropicProvider({
    apiKey: "sk-test",
    model: "claude-opus-5",
    fetchImpl: async (url, options) => {
      requests.push({ url, headers: options.headers, body: JSON.parse(options.body) });
      return new Response(JSON.stringify({
        model: "claude-opus-5",
        content: [{ type: "text", text: "done" }],
        usage: {
          input_tokens: 40,
          output_tokens: 12,
          cache_read_input_tokens: 8,
          cache_creation_input_tokens: 3,
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  assert.deepEqual(provider.capabilities, ["chat"]);
  const result = await provider.invoke(context({ instructions: ["Follow the checklist."], skills: ["Skill text."] }));

  assert.equal(result.text, "done");
  assert.equal(result.model, "claude-opus-5");
  assert.deepEqual(result.usage, { inputTokens: 40, outputTokens: 12, cacheReadTokens: 8, cacheWriteTokens: 3 });

  const [request] = requests;
  assert.equal(request.url, "https://api.anthropic.com/v1/messages");
  assert.equal(request.headers["x-api-key"], "sk-test");
  assert.equal(request.headers["anthropic-version"], "2023-06-01");
  // The prompt, the instructions and the skills are one system prompt; the
  // input is the first user message.
  assert.match(request.body.system, /Do the work\.\n\nFollow the checklist\.\n\nSkill text\./);
  assert.deepEqual(request.body.messages, [{ role: "user", content: "hello" }]);
  assert.equal(request.body.max_tokens, 8192);
  // Current models take adaptive thinking; a thinking budget is rejected.
  assert.equal(request.body.thinking, undefined);
});

test("the Anthropic provider runs an approved tool loop", async () => {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-anthropic-tools-"));
  const bodies = [];
  const responses = [
    {
      content: [{
        type: "tool_use",
        id: "toolu_1",
        name: "write_file",
        input: { path: "out.txt", content: "generated" },
      }],
      usage: { input_tokens: 10, output_tokens: 4 },
    },
    {
      content: [{ type: "text", text: "wrote it" }],
      usage: { input_tokens: 12, output_tokens: 6 },
    },
  ];
  const provider = createAnthropicProvider({
    apiKey: "sk-test",
    tools: true,
    workingDirectory: root,
    fetchImpl: async (_url, options) => {
      bodies.push(JSON.parse(options.body));
      return new Response(JSON.stringify(responses[bodies.length - 1]), { status: 200 });
    },
  });
  assert.deepEqual(provider.capabilities, ["chat", "tools"]);

  const approvals = [];
  const result = await provider.invoke(context({
    approve: async (request) => (approvals.push(request.kind), { kind: "approve-once" }),
  }));

  assert.equal(result.text, "wrote it");
  assert.equal(await readFile(join(root, "out.txt"), "utf8"), "generated");
  assert.deepEqual(approvals, ["write"]);
  assert.deepEqual(result.toolCalls, [{ tool: "write_file", ok: true }]);
  assert.deepEqual(result.usage, { inputTokens: 22, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 });
  // The tools are declared in the API's own shape, and the result goes back as
  // a tool_result block the model can read.
  // Every tool the workspace offers, rather than a number that goes stale
  // the next time one is added — which is exactly what happened.
  assert.equal(bodies[0].tools.length, WORKSPACE_TOOL_DEFINITIONS.length);
  assert.equal(bodies[0].tools[0].input_schema.type, "object");
  const back = bodies[1].messages.at(-1);
  assert.equal(back.role, "user");
  assert.equal(back.content[0].type, "tool_result");
  assert.equal(back.content[0].tool_use_id, "toolu_1");
  assert.equal(JSON.parse(back.content[0].content).ok, true);
});

test("the Anthropic tool loop is bounded", async () => {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-anthropic-bound-"));
  const provider = createAnthropicProvider({
    apiKey: "sk-test",
    tools: true,
    workingDirectory: root,
    maxToolIterations: 2,
    fetchImpl: async () => new Response(JSON.stringify({
      content: [{ type: "tool_use", id: "toolu", name: "list_files", input: {} }],
    }), { status: 200 }),
  });

  await assert.rejects(
    () => provider.invoke(context({ approve: async () => ({ kind: "approve-once" }) })),
    /exceeded 2 tool iterations/,
  );
});

test("a refused or missing credential says which one, and whether to retry", async () => {
  const keyless = createAnthropicProvider({ fetchImpl: async () => new Response("{}", { status: 200 }) });
  await assert.rejects(() => keyless.invoke(context()), (error) => {
    assert.equal(error.code, "missing_api_key");
    assert.equal(error.retryable, false);
    assert.match(error.message, /ANTHROPIC_API_KEY/);
    return true;
  });

  // The API's own message is the useful half: a 400 is a bad model name as
  // often as a bad request, and only the message says which.
  const rejected = createAnthropicProvider({
    apiKey: "sk-test",
    fetchImpl: async () => new Response(
      JSON.stringify({ type: "error", error: { type: "not_found_error", message: "model: nope" } }),
      { status: 404 },
    ),
  });
  await assert.rejects(() => rejected.invoke(context()), (error) => {
    assert.equal(error.code, "http_404");
    assert.equal(error.retryable, false);
    assert.match(error.message, /model: nope/);
    return true;
  });

  const overloaded = createAnthropicProvider({
    apiKey: "sk-test",
    fetchImpl: async () => new Response(JSON.stringify({ error: { message: "overloaded" } }), { status: 529 }),
  });
  await assert.rejects(() => overloaded.invoke(context()), (error) => {
    assert.equal(error.retryable, true);
    assert.equal(error.safeToRetry, true);
    return true;
  });

  // A host that cannot be reached names the host, not 'fetch failed'.
  const unreachable = createAnthropicProvider({
    apiKey: "sk-test",
    fetchImpl: async () => {
      throw Object.assign(new TypeError("fetch failed"), {
        cause: new Error("getaddrinfo ENOTFOUND api.anthropic.invalid"),
      });
    },
  });
  await assert.rejects(() => unreachable.invoke(context()), (error) => {
    assert.equal(error instanceof ProviderError, true);
    assert.match(error.message, /ENOTFOUND api\.anthropic\.invalid/);
    return true;
  });
});

test("a configured anthropic provider resolves its key from the environment", async () => {
  const harness = new Harness();
  const resolver = createSecretResolver({
    env: { ANTHROPIC_API_KEY: "sk-from-env" },
    config: { secrets: {
      providers: { env: { type: "env", allow: ["ANTHROPIC_API_KEY"] } },
      values: { "anthropic.apiKey": { provider: "env", key: "ANTHROPIC_API_KEY" } },
    } },
  });
  const originalFetch = globalThis.fetch;
  let key;
  globalThis.fetch = async (_url, options) => {
    key = options.headers["x-api-key"];
    return new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }] }), { status: 200 });
  };
  try {
    await registerConfiguredProviders(harness, {
      anthropic: { type: "anthropic", model: "claude-opus-5" },
    }, { secretResolver: resolver, env: {} });
    const result = await harness.providers.get("anthropic").invoke(context());
    assert.equal(key, "sk-from-env");
    assert.equal(result.text, "ok");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the generated project configures all three providers, and one setting switches them", async () => {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-providers-"));
  await initializeProject(root);
  const file = join(root, ".etnpilot", "etnpilot.yaml");
  const env = { ...process.env, ETNPILOT_CONFIG_HOME: join(root, "config-home") };

  const config = await loadConfig(file, env);
  assert.deepEqual(Object.keys(config.providers), ["github-copilot", "anthropic", "openai"]);
  assert.equal(config.providers.anthropic.type, "anthropic");
  assert.equal(config.providers.openai.type, "openai-compatible");
  // Every configured provider is one the policy allows; a provider the project
  // ships and the policy denies would fail only once a run reached it.
  const allowed = config.policy.providers.rules.flatMap((rule) => rule.providers ?? []);
  for (const name of Object.keys(config.providers)) assert.equal(allowed.includes(name), true, name);

  // The starter agent names no provider, so the project's default decides.
  const manifest = YAML.parse(await readFile(join(root, ".etnpilot", "agents", "orchestrator.yaml"), "utf8"));
  assert.equal(manifest.provider, undefined);

  // On a machine with no Copilot build, one local setting moves every run to
  // Anthropic — 'routing.defaults' is empty so nothing quietly outranks it.
  assert.deepEqual(config.routing.defaults, []);
  const changed = await setSetting("defaultProvider", "anthropic", { root, env, scope: "local" });
  assert.equal(changed.effective, "anthropic");
  const local = await loadConfig(file, env);
  const stub = (name) => ({ name, capabilities: ["chat", "tools"], invoke: async () => ({ text: name }) });
  const registry = {
    has: (name) => name in local.providers,
    get: (name) => stub(name),
    list: () => Object.keys(local.providers),
  };
  const router = new ProviderRouter(registry, local.routing, { defaultProvider: local.defaultProvider });
  const routed = await router.invoke(context({ agent: { name: "orchestrator", requires: ["chat"] } }));
  assert.equal(routed.provider, "anthropic");
});

test("the models this account can currently reach", async () => {
  const { listModels } = await import("../src/providers/anthropic.js");
  let seenHeaders;
  const models = await listModels({
    apiKey: "sk-ant-test",
    fetchImpl: async (url, options) => {
      seenHeaders = options.headers;
      assert.equal(url, "https://api.anthropic.com/v1/models");
      return new Response(JSON.stringify({
        data: [
          { id: "claude-opus-5", display_name: "Claude Opus 5", created_at: "2026-01-01T00:00:00Z" },
          { id: "claude-haiku-4-5", display_name: "Claude Haiku 4.5", created_at: "2025-10-01T00:00:00Z" },
        ],
        has_more: false,
      }), { status: 200 });
    },
  });
  assert.equal(seenHeaders["x-api-key"], "sk-ant-test");
  assert.equal(seenHeaders["anthropic-version"], "2023-06-01");
  assert.deepEqual(models.map((m) => m.id), ["claude-haiku-4-5", "claude-opus-5"]);
  assert.equal(models.find((m) => m.id === "claude-opus-5").displayName, "Claude Opus 5");
});
