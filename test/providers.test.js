import assert from "node:assert/strict";
import { test } from "node:test";
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
  assert.match(advice, /openai-compatible/);

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
