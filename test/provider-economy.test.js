import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import YAML from "yaml";
import { createAnthropicProvider } from "../src/providers/anthropic.js";
import { createOpenAICompatibleProvider } from "../src/providers/openai-compatible.js";
import { compactConversation, estimateTokens } from "../src/providers/compaction.js";
import { retryAfterMs, withRetry } from "../src/providers/retry.js";
import { ProviderError } from "../src/providers/router.js";
import { initializeProject } from "../src/config/init.js";

// P2: the agent stops paying for the same context twice, stops dying at the
// provider's limit, and stops losing a run to one rate-limited minute.

const context = (overrides = {}) => ({
  agent: { name: "worker", prompt: "Do the work." },
  input: "go",
  instructions: [],
  skills: [],
  approve: async () => ({ kind: "approve-once" }),
  ...overrides,
});

test("what does not change between iterations is cached", async () => {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-cache-"));
  await writeFile(join(root, "a.txt"), "hello\n");
  const bodies = [];
  const replies = [
    { content: [{ type: "tool_use", id: "t1", name: "read_file", input: { path: "a.txt" } }] },
    { content: [{ type: "text", text: "done" }] },
  ];
  await createAnthropicProvider({
    apiKey: "k", tools: true, workingDirectory: root,
    fetchImpl: async (_url, options) => {
      bodies.push(JSON.parse(options.body));
      return new Response(JSON.stringify(replies[bodies.length - 1]), { status: 200 });
    },
  }).invoke(context());

  // The system prompt and the tool schemas go up again on every iteration and
  // never change; by the twelfth they are the largest item on the bill.
  assert.deepEqual(bodies[0].system.at(-1).cache_control, { type: "ephemeral" });
  assert.deepEqual(bodies[0].tools.at(-1).cache_control, { type: "ephemeral" });
  // And a rolling breakpoint at the end of the conversation, so each
  // iteration reads back what the one before it wrote.
  assert.deepEqual(bodies[1].messages.at(-1).content.at(-1).cache_control, { type: "ephemeral" });

  // Four is the limit, and a breakpoint is a position rather than a mark that
  // accumulates: the previous one has to be removed, or the eighth iteration
  // is refused.
  const breakpoints = JSON.stringify(bodies[1]).split("cache_control").length - 1;
  assert.equal(breakpoints <= 4, true, `${breakpoints} breakpoints`);

  const plain = [];
  await createAnthropicProvider({
    apiKey: "k", caching: false,
    fetchImpl: async (_url, options) => {
      plain.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }] }), { status: 200 });
    },
  }).invoke(context());
  assert.equal(JSON.stringify(plain[0]).includes("cache_control"), false);
});

test("a rate-limited minute no longer ends a run", async () => {
  let calls = 0;
  const provider = createAnthropicProvider({
    apiKey: "k", retry: { baseDelayMs: 1 },
    fetchImpl: async () => {
      calls += 1;
      return calls < 3
        ? new Response("{}", { status: 429, headers: { "retry-after": "0" } })
        : new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }] }), { status: 200 });
    },
  });
  const result = await provider.invoke(context());
  assert.equal(calls, 3);
  assert.equal(result.text, "ok");
  // Every attempt is in the result, so a receipt never reads as though the
  // provider answered first time.
  assert.equal(result.retries.length, 2);
  assert.equal(result.retries[0].code, "http_429");
  // The limiter's own answer wins over the backoff: waiting less than it said
  // is how a rate limit becomes a ban.
  assert.deepEqual(result.retries.map((entry) => entry.waitMs), [0, 0]);
});

test("only what is safe to replay is replayed", async () => {
  // A wrong model name is a 400: retrying it three times wastes nothing but
  // time, and hides the answer.
  let calls = 0;
  await assert.rejects(() => createAnthropicProvider({
    apiKey: "k", retry: { baseDelayMs: 1 },
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: { message: "no such model" } }), { status: 400 });
    },
  }).invoke(context()), /no such model/);
  assert.equal(calls, 1);

  // A request that already ran tools is never replayed, whatever the status.
  const attempted = [];
  await assert.rejects(() => withRetry((attempt) => {
    attempted.push(attempt);
    throw new ProviderError("429", { code: "http_429", retryable: true, safeToRetry: false });
  }, { attempts: 3, sleep: async () => {} }), /429/);
  assert.deepEqual(attempted, [1]);

  assert.equal(retryAfterMs("2"), 2000);
  assert.equal(retryAfterMs(undefined), undefined);
  assert.equal(retryAfterMs("not a date"), undefined);
  assert.equal(retryAfterMs(new Date(Date.now() + 5000).toUTCString()) >= 4000, true);
});

test("a long run stays inside the window instead of dying at the provider", async () => {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-compact-"));
  await writeFile(join(root, "big.txt"), "x".repeat(200_000));
  let calls = 0;
  const result = await createAnthropicProvider({
    apiKey: "k", tools: true, workingDirectory: root, contextTokens: 20_000,
    fetchImpl: async () => {
      calls += 1;
      return calls <= 6
        ? new Response(JSON.stringify({ content: [{ type: "tool_use", id: `t${calls}`, name: "read_file", input: { path: "big.txt" } }] }), { status: 200 })
        : new Response(JSON.stringify({ content: [{ type: "text", text: "done" }] }), { status: 200 });
    },
  }).invoke(context());

  assert.equal(result.text, "done", "the run finishes");
  // And says what it lost, because a compacted run that looks complete is
  // worse than one that ran out.
  assert.equal(result.compactions.length > 0, true);
  assert.equal(result.compactions.every((entry) => entry.tokens > 0), true);
});

test("compaction drops the oldest tool output, never a message or the task", () => {
  const messages = [
    { role: "user", content: "the task" },
    { role: "tool", content: "y".repeat(40_000) },
    { role: "assistant", content: "thinking" },
    { role: "tool", content: "z".repeat(40_000) },
    { role: "assistant", content: "more" },
    { role: "tool", content: "recent output that is still being worked with" },
  ];
  const bounded = compactConversation(messages, {
    maxTokens: 5000,
    isToolResult: (message) => message.role === "tool",
    contentOf: (message) => message.content,
    replace: (message, note) => ({ ...message, content: note }),
    keepRecent: 2,
  });

  assert.equal(bounded.messages[0].content, "the task", "the task is never dropped");
  assert.equal(bounded.messages[2].content, "thinking", "nor is what the model said");
  assert.match(bounded.messages[1].content, /compacted: \d+ tokens/);
  assert.match(bounded.messages[1].content, /run the command again/);
  assert.equal(bounded.messages.at(-1).content, "recent output that is still being worked with");
  assert.equal(bounded.compacted.length > 0, true);

  // A conversation that fits is returned untouched.
  const small = compactConversation([{ role: "tool", content: "tiny" }], {
    maxTokens: 100_000,
    isToolResult: () => true,
    contentOf: (message) => message.content,
    replace: () => assert.fail("nothing should be replaced"),
  });
  assert.deepEqual(small.compacted, []);
  assert.equal(estimateTokens("....") , 1);
});

test("a step tells the next one what it did, not the shape of its result object", async () => {
  const { composeAgentInputForTest } = await import("../src/runtime/project-runner.js");
  const composed = composeAgentInputForTest("Now review it.", {
    build: {
      result: {
        text: "I changed the parser.",
        toolCalls: [{ tool: "edit_file", ok: true }, { tool: "run_command", ok: false, error: "refused" }],
        workspace: { changedPaths: ["src/parse.js", "test/parse.test.js"] },
        usage: { inputTokens: 999_999 },
      },
    },
  });
  assert.match(composed, /Now review it\./);
  assert.match(composed, /I changed the parser\./);
  assert.match(composed, /src\/parse\.js, test\/parse\.test\.js/);
  assert.match(composed, /2 calls, 1 refused \(run_command\)/);
  // The fields a following agent cannot use are not carried at all.
  assert.equal(composed.includes("999999"), false);
  assert.equal(composed.includes("inputTokens"), false);

  // And a long answer is cut, with the cut named.
  const long = composeAgentInputForTest("go", { plan: { result: { text: "a".repeat(9000) } } });
  assert.match(long, /more characters/);
  assert.equal(long.length < 9000, true);
});

test("a generated project ships with a ceiling", async () => {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-budget-"));
  await initializeProject(root);
  const config = YAML.parse(await readFile(join(root, ".etnpilot", "etnpilot.yaml"), "utf8"));
  const budgets = config.observability.budgets;
  assert.equal(budgets.maxEstimatedCostPerWorkflow > 0, true, "a loop that goes wrong costs this much and no more");
  assert.equal(budgets.maxInputTokensPerWorkflow > 0, true);
});

test("the OpenAI-compatible adapter retries and compacts the same way", async () => {
  let calls = 0;
  const result = await createOpenAICompatibleProvider({
    baseUrl: "https://api.example/v1", apiKey: "k", retry: { baseDelayMs: 1 },
    fetchImpl: async () => {
      calls += 1;
      return calls < 2
        ? new Response("{}", { status: 503 })
        : new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
    },
  }).invoke(context());
  assert.equal(result.text, "ok");
  assert.equal(result.retries.length, 1);
});
