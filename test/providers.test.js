import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { initializeProject } from "../src/config/init.js";
import { loadConfig } from "../src/config/load.js";
import { createCopilotProvider } from "../src/providers/copilot.js";
import { createOpenAICompatibleProvider } from "../src/providers/openai-compatible.js";
import { ProviderError } from "../src/providers/router.js";
import { Harness } from "../src/core/harness.js";
import { registerConfiguredProviders } from "../src/providers/register.js";
import { createSecretResolver } from "../src/secrets/resolver.js";

test("Copilot provider uses the SDK session and preserves safe approvals", async () => {
  const calls = [];
  class CopilotClient {
    constructor(options) { calls.push(["client", options]); }
    async start() { calls.push(["start"]); }
    async createSession(options) {
      calls.push(["session", options]);
      let usageListener;
      return {
        sessionId: "session-1",
        on: (type, listener) => {
          assert.equal(type, "assistant.usage");
          usageListener = listener;
        },
        sendAndWait: async ({ prompt }) => {
          usageListener({ data: {
            inputTokens: 120,
            outputTokens: 30,
            cacheReadTokens: 20,
            cacheWriteTokens: 5,
            cost: 1,
            model: "copilot-model",
          } });
          return { data: { content: `answer:${prompt}` } };
        },
        disconnect: async () => calls.push(["disconnect"]),
      };
    }
    async stop() { calls.push(["stop"]); }
  }
  const provider = createCopilotProvider({ importer: async () => ({ CopilotClient }) });
  const result = await provider.invoke({
    agent: { prompt: "System", model: "auto" },
    input: "hello",
    instructions: ["Instruction"],
    skills: [{ content: "Skill" }],
    approve: async () => ({ kind: "reject", reason: "blocked" }),
  });
  assert.deepEqual(result, {
    text: "answer:hello",
    sessionId: "session-1",
    model: "copilot-model",
    usage: {
      inputTokens: 120,
      outputTokens: 30,
      cacheReadTokens: 20,
      cacheWriteTokens: 5,
      providerUnits: 1,
    },
  });
  assert.deepEqual(calls.slice(-2), [["disconnect"], ["stop"]]);
});

test("Copilot provider marks post-delivery failures unsafe to replay", async () => {
  class CopilotClient {
    async start() {}
    async createSession() {
      return {
        sendAndWait: async () => { throw new Error("connection lost"); },
        disconnect: async () => {},
      };
    }
    async stop() {}
  }
  const provider = createCopilotProvider({ importer: async () => ({ CopilotClient }) });
  await assert.rejects(
    () => provider.invoke({
      agent: { prompt: "System" }, input: "hello", instructions: [], skills: [], approve: async () => ({ kind: "reject" }),
    }),
    (error) => error instanceof ProviderError && error.retryable && !error.safeToRetry,
  );
});

test("Copilot provider attaches local CodeGraph MCP and classifies its allow-listed tool as read-only", async () => {
  const server = {
    type: "local",
    command: process.execPath,
    args: ["codegraph", "serve", "--mcp"],
    tools: ["codegraph_explore"],
  };
  let sessionOptions;
  let approvalRequest;
  class CopilotClient {
    async start() {}
    async createSession(options) {
      sessionOptions = options;
      const decision = await options.onPermissionRequest({ kind: "mcp", toolName: "codegraph_explore" });
      assert.deepEqual(decision, { kind: "approve-once" });
      return {
        sessionId: "with-codegraph",
        sendAndWait: async () => ({ data: { content: "ok" } }),
        disconnect: async () => {},
      };
    }
    async stop() {}
  }
  const provider = createCopilotProvider({
    importer: async () => ({ CopilotClient }),
    mcpServers: { codegraph: server },
    readOnlyMcpTools: ["codegraph_explore"],
  });
  await provider.invoke({
    agent: { prompt: "System" },
    input: "inspect",
    instructions: [],
    skills: [],
    approve: async (request) => {
      approvalRequest = request;
      return { kind: "approve-once" };
    },
  });
  assert.deepEqual(sessionOptions.mcpServers, { codegraph: server });
  assert.equal(approvalRequest.kind, "read");
  assert.equal(approvalRequest.path, ".");
  assert.equal(approvalRequest.sourceKind, "mcp");
  assert.equal(approvalRequest.toolName, "codegraph_explore");
});

test("OpenAI-compatible provider exposes retry-safe transient failures", async () => {
  const provider = createOpenAICompatibleProvider({
    baseUrl: "https://models.example.invalid/v1",
    apiKey: "key",
    fetchImpl: async () => ({ ok: false, status: 503, text: async () => "busy" }),
  });
  await assert.rejects(
    () => provider.invoke({ agent: { prompt: "System" }, input: "hello", instructions: [] }),
    (error) => error instanceof ProviderError && error.code === "http_503" && error.safeToRetry,
  );
});

test("configured providers resolve API keys through the secret resolver", async () => {
  const harness = new Harness();
  const resolver = createSecretResolver({
    env: { MODEL_TOKEN: "resolved-model-secret" },
    config: { secrets: {
      providers: { env: { type: "env", allow: ["MODEL_TOKEN"] } },
      values: { "model.apiKey": { provider: "env", key: "MODEL_TOKEN" } },
    } },
  });
  const originalFetch = globalThis.fetch;
  let authorization;
  globalThis.fetch = async (_url, options) => {
    authorization = options.headers.authorization;
    return new Response(JSON.stringify({
      model: "team-model",
      choices: [{ message: { content: "ok" } }],
      usage: {
        prompt_tokens: 80,
        completion_tokens: 20,
        prompt_tokens_details: { cached_tokens: 10 },
      },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    await registerConfiguredProviders(harness, {
      model: {
        type: "openai-compatible",
        baseUrl: "https://models.example.invalid/v1",
        apiKeySecret: "model.apiKey",
      },
    }, { secretResolver: resolver, env: {} });
    const result = await harness.providers.get("model").invoke({ agent: { prompt: "System" }, input: "hello", instructions: [] });
    assert.equal(authorization, "Bearer resolved-model-secret");
    assert.equal(result.model, "team-model");
    assert.deepEqual(result.usage, {
      inputTokens: 80,
      outputTokens: 20,
      cacheReadTokens: 10,
      cacheWriteTokens: 0,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("where no Copilot build exists, the advice does not send you in a circle", async () => {
  const { copilotSdkAdvice, copilotSdkPlatformSupported, createCopilotProvider } =
    await import("../src/providers/copilot.js");

  for (const platform of ["linux", "darwin", "win32"]) {
    assert.equal(copilotSdkPlatformSupported(platform), true);
    assert.match(copilotSdkAdvice(platform, "x64"), /^Install '@github\/copilot-sdk'/);
  }

  // On Android, 'npm install @github/copilot-sdk' reports success and installs
  // nothing, so telling someone to install it is worse than saying nothing.
  assert.equal(copilotSdkPlatformSupported("android"), false);
  const advice = copilotSdkAdvice("android", "arm64");
  assert.match(advice, /publishes no Copilot SDK build for android-arm64/);
  assert.doesNotMatch(advice, /^Install/);
  // Nor to a provider the project never listed: policy.providers denies it,
  // and being stricter-only, no local file can allow it either.
  assert.match(advice, /another provider this project configures/);

  // The runtime failure carries the same advice, not a bare module error.
  const provider = createCopilotProvider({
    importer: () => { throw new Error("Cannot find module '@github/copilot-sdk'"); },
  });
  await assert.rejects(provider.invoke({ input: "x", agent: { name: "a" } }), (error) => {
    assert.equal(error.code, "sdk_unavailable");
    assert.match(error.message, /requires '@github\/copilot-sdk'/);
    return true;
  });
});

test("a refused request keeps the server's own message, and loopback needs no key", async () => {
  // '(401)' alone does not say whether the key is wrong, the model is out of
  // reach, or something between here and OpenAI refused the call.
  const refused = createOpenAICompatibleProvider({
    baseUrl: "https://api.openai.example/v1",
    apiKey: "sk-wrong",
    fetchImpl: async () => new Response(
      JSON.stringify({ error: { message: "Incorrect API key provided: sk-wrong.", code: "invalid_api_key" } }),
      { status: 401 },
    ),
  });
  await assert.rejects(
    () => refused.invoke({ agent: { prompt: "System" }, input: "hello", instructions: [] }),
    (error) => {
      assert.equal(error.code, "http_401");
      assert.equal(error.retryable, false);
      assert.match(error.message, /Incorrect API key provided/);
      return true;
    },
  );

  // A model server on this machine is the one endpoint that legitimately has
  // no key, so demanding one there would refuse a working setup.
  const local = createOpenAICompatibleProvider({
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "local",
    fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 }),
  });
  assert.equal((await local.invoke({ agent: { prompt: "p" }, input: "hi", instructions: [] })).text, "ok");
});

test("the openai provider reads OPENAI_API_KEY, and says so when it is missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-openai-"));
  await initializeProject(root);
  const config = await loadConfig(join(root, ".etnpilot", "etnpilot.yaml"), { ...process.env });
  assert.equal(config.providers.openai.apiKeySecret, "openai.apiKey");

  const withKey = createSecretResolver({
    env: { OPENAI_API_KEY: "sk-from-env" },
    config,
  });
  const harness = new Harness();
  let authorization;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    authorization = options.headers.authorization;
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
  };
  try {
    await registerConfiguredProviders(harness, { openai: config.providers.openai }, {
      secretResolver: withKey,
      workingDirectory: root,
      env: {},
    });
    const result = await harness.providers.get("openai").invoke({
      agent: { name: "worker", prompt: "p" },
      input: "hi",
      instructions: [],
      skills: [],
      approve: async () => ({ kind: "approve-once" }),
    });
    assert.equal(authorization, "Bearer sk-from-env");
    assert.equal(result.text, "ok");
  } finally {
    globalThis.fetch = originalFetch;
  }

  // Without it, the message names the variable this provider reads — not the
  // adapter's generic default, which is not the one to set here.
  const empty = new Harness();
  await registerConfiguredProviders(empty, { openai: config.providers.openai }, {
    secretResolver: createSecretResolver({ env: {}, config }),
    workingDirectory: root,
    env: {},
  });
  await assert.rejects(
    () => empty.providers.get("openai").invoke({ agent: { name: "w", prompt: "p" }, input: "hi", instructions: [] }),
    (error) => {
      assert.equal(error.code, "missing_api_key");
      assert.match(error.message, /Set OPENAI_API_KEY in the environment \(secret 'openai\.apiKey'/);
      return true;
    },
  );
});

test("a named secret with nothing behind it says so, instead of reading another one", async () => {
  // The trap this closes: 'apiKeySecret: openai.apiKey' in a project that maps
  // no such secret used to fall through to the adapter's generic variable —
  // reading a key nobody pointed at, and naming the wrong one when unset.
  const harness = new Harness();
  const resolver = createSecretResolver({
    env: { ETNPILOT_PROVIDER_API_KEY: "sk-generic" },
    config: { secrets: { values: {} } },
  });
  let authorization = "unset";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    authorization = options.headers.authorization;
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
  };
  try {
    await registerConfiguredProviders(harness, {
      openai: {
        type: "openai-compatible",
        baseUrl: "https://api.openai.example/v1",
        apiKeySecret: "openai.apiKey",
      },
    }, { secretResolver: resolver, env: {} });
    await assert.rejects(
      () => harness.providers.get("openai").invoke({ agent: { name: "w", prompt: "p" }, input: "hi", instructions: [] }),
      (error) => {
        assert.equal(error.code, "missing_api_key");
        assert.match(error.message, /secret 'openai\.apiKey' is not mapped under 'secrets\.values'/);
        return true;
      },
    );
    assert.equal(authorization, "unset", "nothing was sent with the wrong key");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the models an OpenAI-compatible endpoint currently offers, filtered to the chat-capable ones", async () => {
  const { listModels, looksLikeChatModel } = await import("../src/providers/openai-compatible.js");
  let seenAuth;
  const all = await listModels({
    baseUrl: "https://api.openai.example/v1",
    apiKey: "sk-test",
    fetchImpl: async (url, options) => {
      seenAuth = options.headers.authorization;
      assert.equal(url, "https://api.openai.example/v1/models");
      return new Response(JSON.stringify({
        data: [
          { id: "gpt-5", object: "model", owned_by: "openai" },
          { id: "text-embedding-3-large", object: "model", owned_by: "openai" },
          { id: "whisper-1", object: "model", owned_by: "openai" },
          { id: "gpt-5-mini", object: "model", owned_by: "openai" },
        ],
      }), { status: 200 });
    },
  });
  assert.equal(seenAuth, "Bearer sk-test");
  assert.deepEqual(all.map((m) => m.id), ["gpt-5", "gpt-5-mini", "text-embedding-3-large", "whisper-1"]);

  // The chat filter is this project's own judgment, applied by the caller —
  // not something '/v1/models' states.
  assert.equal(looksLikeChatModel("gpt-5"), true);
  assert.equal(looksLikeChatModel("gpt-5-mini"), true);
  assert.equal(looksLikeChatModel("text-embedding-3-large"), false);
  assert.equal(looksLikeChatModel("whisper-1"), false);
  assert.equal(looksLikeChatModel("dall-e-3"), false);
});

test("a refused models request keeps the server's own message", async () => {
  const { listModels } = await import("../src/providers/openai-compatible.js");
  await assert.rejects(
    () => listModels({
      baseUrl: "https://api.openai.example/v1",
      apiKey: "sk-bad",
      fetchImpl: async () => new Response(
        JSON.stringify({ error: { message: "Incorrect API key provided." } }),
        { status: 401 },
      ),
    }),
    (error) => {
      assert.equal(error.code, "http_401");
      assert.match(error.message, /Incorrect API key provided/);
      return true;
    },
  );
});

test("a server that needs a request field of its own gets it, and cannot break the call", async () => {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-openai-body-"));
  const bodies = [];
  const provider = createOpenAICompatibleProvider({
    baseUrl: "https://api.openai.example/v1",
    apiKey: "sk-test",
    model: "gpt-5.6-luna",
    tools: true,
    workingDirectory: root,
    reasoningEffort: "none",
    requestBody: { service_tier: "flex" },
    fetchImpl: async (_url, options) => {
      bodies.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
    },
  });

  const result = await provider.invoke({ agent: { prompt: "System" }, input: "hello", instructions: [] });
  assert.equal(result.text, "ok");
  const [body] = bodies;
  // The configured fields reach the wire under the API's own names.
  assert.equal(body.reasoning_effort, "none");
  assert.equal(body.service_tier, "flex");
  // What the adapter needs to work is still its own: the tools are declared
  // and the model is the configured one, whatever the passthrough contains.
  assert.equal(body.model, "gpt-5.6-luna");
  assert.equal(body.tools.length > 0, true);
  assert.equal(body.tool_choice, "auto");

  // A passthrough that would overwrite the mechanics is refused at
  // construction, where the config can still be fixed — not on the call,
  // where it would look like the server's fault.
  for (const key of ["model", "messages", "tools", "tool_choice", "stream"]) {
    assert.throws(
      () => createOpenAICompatibleProvider({
        baseUrl: "https://api.openai.example/v1",
        apiKey: "sk-test",
        requestBody: { [key]: "anything" },
      }),
      new RegExp(`requestBody must not set '${key}'`),
    );
  }
  assert.throws(
    () => createOpenAICompatibleProvider({ baseUrl: "https://x/v1", apiKey: "k", requestBody: [] }),
    /requestBody must be a mapping/,
  );
  assert.throws(
    () => createOpenAICompatibleProvider({ baseUrl: "https://x/v1", apiKey: "k", reasoningEffort: 3 }),
    /reasoningEffort must be a string/,
  );
});

test("a reasoning model that refuses function tools names the setting that fixes it", async () => {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-openai-reasoning-"));
  const refusal = () => new Response(JSON.stringify({ error: { message:
    "Function tools with reasoning_effort are not supported for gpt-5.6-luna in /v1/chat/completions."
    + " To use function tools, use /v1/responses or set reasoning_effort to 'none'.",
  } }), { status: 400 });
  const options = {
    name: "openai",
    baseUrl: "https://api.openai.example/v1",
    apiKey: "sk-test",
    model: "gpt-5.6-luna",
    tools: true,
    workingDirectory: root,
    fetchImpl: async () => refusal(),
  };
  const invoke = (provider) => provider.invoke({ agent: { prompt: "System" }, input: "hello", instructions: [] });

  await assert.rejects(() => invoke(createOpenAICompatibleProvider(options)), (error) => {
    assert.equal(error.code, "http_400");
    // The server's own words stay first; the advice is added, not substituted.
    assert.match(error.message, /set reasoning_effort to 'none'/);
    assert.match(error.message, /this provider sends no reasoning_effort/i);
    assert.match(error.message, /providers\.openai\.reasoningEffort/);
    return true;
  });

  // Once it is set, repeating the advice would send someone in a circle: the
  // server is refusing something else now, and only its message says what.
  await assert.rejects(
    () => invoke(createOpenAICompatibleProvider({ ...options, reasoningEffort: "none" })),
    (error) => {
      assert.equal(/providers\.openai\.reasoningEffort/.test(error.message), false);
      return true;
    },
  );

  // A 400 with no tools in the request is a different problem, and advice
  // about tools would be a wrong guess.
  await assert.rejects(
    () => invoke(createOpenAICompatibleProvider({ ...options, tools: false })),
    (error) => {
      assert.equal(/providers\.openai\.reasoningEffort/.test(error.message), false);
      return true;
    },
  );
});
