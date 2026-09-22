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
      return {
        sessionId: "session-1",
        sendAndWait: async ({ prompt }) => ({ data: { content: `answer:${prompt}` } }),
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
  assert.deepEqual(result, { text: "answer:hello", sessionId: "session-1" });
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
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
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
    await harness.providers.get("model").invoke({ agent: { prompt: "System" }, input: "hello", instructions: [] });
    assert.equal(authorization, "Bearer resolved-model-secret");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
