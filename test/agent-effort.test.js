import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import test from "node:test";
import { Harness } from "../src/core/harness.js";
import { createAnthropicProvider } from "../src/providers/anthropic.js";
import { createOpenAICompatibleProvider } from "../src/providers/openai-compatible.js";

// P4.5: how hard the model thinks is the agent's choice. One provider serves a
// planner and a builder, and they send different requests.

const ok = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const context = (agent) => ({ runId: "r", agent, input: "go", instructions: [], skills: [], approve: async () => ({ kind: "approve-once" }) });

test("one Anthropic provider sends two different requests for two agents", async () => {
  const bodies = [];
  const provider = createAnthropicProvider({
    apiKey: "k", workingDirectory: tmpdir(),
    fetchImpl: async (url, init) => { bodies.push(JSON.parse(init.body)); return ok({ content: [{ type: "text", text: "x" }], model: "m", usage: {} }); },
  });
  const planned = await provider.invoke(context({ name: "planner", prompt: "P", effort: "high" }));
  const built = await provider.invoke(context({ name: "builder", prompt: "P" }));
  assert.deepEqual(bodies[0].thinking, { type: "adaptive" });
  assert.deepEqual(bodies[0].output_config, { effort: "high" });
  // An agent that asks for nothing gets nothing: older models refuse adaptive thinking.
  assert.equal(bodies[1].thinking, undefined);
  assert.equal(bodies[1].output_config, undefined);
  // It is in the result, so the receipt can say what was asked for.
  assert.equal(planned.effort, "high");
  assert.equal(built.effort, undefined);
});

test("OpenAI: the agent's effort beats the provider's default", async () => {
  const bodies = [];
  const provider = createOpenAICompatibleProvider({
    name: "openai", apiKey: "k", baseUrl: "https://example.test/v1", model: "m", reasoningEffort: "none",
    fetchImpl: async (url, init) => { bodies.push(JSON.parse(init.body)); return ok({ choices: [{ message: { content: "x" } }], usage: {} }); },
  });
  const planned = await provider.invoke(context({ name: "planner", prompt: "P", effort: "high" }));
  await provider.invoke(context({ name: "builder", prompt: "P" }));
  assert.equal(bodies[0].reasoning_effort, "high");
  assert.equal(bodies[1].reasoning_effort, "none");
  assert.equal(planned.effort, "high");
});

test("a manifest with an effort nobody defined is refused", () => {
  const harness = new Harness();
  harness.registerAgent({ name: "a", provider: "p", prompt: "x", effort: "low" });
  assert.throws(() => harness.registerAgent({ name: "b", provider: "p", prompt: "x", effort: "extreme" }), /effort/);
});
