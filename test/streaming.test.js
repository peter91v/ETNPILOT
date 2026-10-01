import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import test from "node:test";
import { createAnthropicProvider } from "../src/providers/anthropic.js";
import { createOpenAICompatibleProvider } from "../src/providers/openai-compatible.js";
import { collectAnthropicStream, collectChatStream, collectResponsesStream, readEvents } from "../src/providers/sse.js";

// P2.4: a stream is read to its end and becomes the payload the adapter
// already understood, so nothing downstream learns a second shape.

// Split at arbitrary byte offsets: a real network does not respect line ends.
function streamOf(text, size = 7) {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({
    start(controller) {
      for (let at = 0; at < bytes.length; at += size) controller.enqueue(bytes.slice(at, at + size));
      controller.close();
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
}

const sse = (events) => events.map(([name, data]) => `${name ? `event: ${name}\n` : ""}data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`).join("");

test("events survive being cut anywhere, CRLF and comments included", async () => {
  const response = streamOf(": keep-alive\r\n\r\nevent: a\r\ndata: 1\r\n\r\ndata: 2\ndata: 3\n\n", 3);
  const seen = [];
  for await (const event of readEvents(response)) seen.push(event);
  assert.deepEqual(seen, [{ event: "a", data: "1" }, { event: undefined, data: "2\n3" }]);
  // A last event with no blank line after it was cut off, and is not delivered.
  const cut = [];
  for await (const event of readEvents(streamOf("data: whole\n\ndata: {\"half"))) cut.push(event);
  assert.deepEqual(cut, [{ event: undefined, data: "whole" }]);
});

const anthropicEvents = [
  ["message_start", { type: "message_start", message: { id: "m1", model: "claude-x", role: "assistant", usage: { input_tokens: 10, cache_read_input_tokens: 4 } } }],
  ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }],
  ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm " } }],
  ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "SIG" } }],
  ["content_block_stop", { type: "content_block_stop", index: 0 }],
  ["content_block_start", { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }],
  ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Reading " } }],
  ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "it." } }],
  ["content_block_stop", { type: "content_block_stop", index: 1 }],
  ["content_block_start", { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "t1", name: "read_file", input: {} } }],
  ["content_block_delta", { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: "{\"path\":" } }],
  ["content_block_delta", { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: "\"a.txt\"}" } }],
  ["content_block_stop", { type: "content_block_stop", index: 2 }],
  ["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 33 } }],
  ["message_stop", { type: "message_stop" }],
];

test("an Anthropic stream folds into the message it would have been", async () => {
  const message = await collectAnthropicStream(streamOf(sse(anthropicEvents)));
  assert.equal(message.id, "m1");
  assert.equal(message.stop_reason, "tool_use");
  assert.deepEqual(message.usage, { input_tokens: 10, cache_read_input_tokens: 4, output_tokens: 33 });
  assert.deepEqual(message.content, [
    { type: "thinking", thinking: "hmm ", signature: "SIG" },
    { type: "text", text: "Reading it." },
    { type: "tool_use", id: "t1", name: "read_file", input: { path: "a.txt" } },
  ]);
});

test("a stream that stops without saying why is an error worth retrying, not an answer", async () => {
  await assert.rejects(
    collectAnthropicStream(streamOf(sse(anthropicEvents.slice(0, 8)))),
    (error) => error.code === "stream_truncated" && error.retryable === true,
  );
  await assert.rejects(
    collectAnthropicStream(streamOf(sse([["error", { type: "error", error: { type: "overloaded_error", message: "busy" } }]]))),
    (error) => error.code === "stream_overloaded_error" && error.retryable === true,
  );
});

test("the Anthropic adapter with stream on sends stream:true and runs the same loop", async () => {
  const bodies = [];
  let call = 0;
  const provider = createAnthropicProvider({
    apiKey: "k", stream: true, tools: true, workingDirectory: tmpdir(),
    fetchImpl: async (url, init) => {
      bodies.push(JSON.parse(init.body));
      call += 1;
      return call === 1
        ? streamOf(sse(anthropicEvents))
        : streamOf(sse([
          ["message_start", { type: "message_start", message: { id: "m2", model: "claude-x", usage: { input_tokens: 5 } } }],
          ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
          ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } }],
          ["content_block_stop", { type: "content_block_stop", index: 0 }],
          ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }],
          ["message_stop", { type: "message_stop" }],
        ]));
    },
  });
  const result = await provider.invoke({
    runId: "r", agent: { name: "a", prompt: "P" }, input: "go", instructions: [], skills: [],
    approve: async () => ({ kind: "approve-once" }),
  });
  assert.equal(bodies[0].stream, true);
  assert.equal(result.text, "done");
  assert.equal(result.toolCalls[0].tool, "read_file");
  // The thinking block went back with its signature, or the API would refuse it.
  const assistant = bodies[1].messages.find((message) => message.role === "assistant");
  assert.equal(assistant.content[0].signature, "SIG");
});

const chatChunks = (extra = {}) => [
  [undefined, { id: "c1", model: "gpt-x", choices: [{ index: 0, delta: { role: "assistant", content: "" } }] }],
  [undefined, { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read_file", arguments: "" } }] } }] }],
  [undefined, { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "{\"path\":" } }] } }] }],
  [undefined, { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "\"a.txt\"}" } }] } }] }],
  [undefined, { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }],
  [undefined, { choices: [], usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 }, ...extra }],
  [undefined, "[DONE]"],
];

test("a chat stream folds into the completion it would have been", async () => {
  const payload = await collectChatStream(streamOf(sse(chatChunks())));
  const message = payload.choices[0].message;
  assert.equal(payload.choices[0].finish_reason, "tool_calls");
  assert.equal(message.content, null);
  assert.deepEqual(message.tool_calls, [
    { id: "call_1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"a.txt\"}" } },
  ]);
  assert.deepEqual(payload.usage, { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 });
  await assert.rejects(collectChatStream(streamOf(sse(chatChunks()).slice(0, 200))), (error) => error.code === "stream_truncated");
});

test("the OpenAI-compatible adapter with stream on asks for usage and returns the text", async () => {
  const bodies = [];
  const provider = createOpenAICompatibleProvider({
    name: "openai", apiKey: "k", baseUrl: "https://example.test/v1", model: "m", stream: true,
    fetchImpl: async (url, init) => {
      bodies.push(JSON.parse(init.body));
      return streamOf(sse([
        [undefined, { choices: [{ index: 0, delta: { content: "hel" } }] }],
        [undefined, { choices: [{ index: 0, delta: { content: "lo" }, finish_reason: "stop" }] }],
        [undefined, { choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } }],
        [undefined, "[DONE]"],
      ]));
    },
  });
  const result = await provider.invoke({
    runId: "r", agent: { name: "a", prompt: "P" }, input: "go", instructions: [], skills: [],
    approve: async () => ({ kind: "approve-once" }),
  });
  assert.equal(bodies[0].stream, true);
  assert.deepEqual(bodies[0].stream_options, { include_usage: true });
  assert.equal(result.text, "hello");
});

test("the pieces of an answer are heard as they arrive, in order, and the whole is unchanged", async () => {
  const heard = [];
  const message = await collectAnthropicStream(streamOf(sse(anthropicEvents)), { onDelta: (piece) => heard.push(piece) });
  assert.deepEqual(heard, ["Reading ", "it."]);
  assert.equal(message.content[1].text, "Reading it.");

  const said = [];
  const payload = await collectChatStream(streamOf(sse([
    [undefined, { choices: [{ index: 0, delta: { content: "hel" } }] }],
    [undefined, { choices: [{ index: 0, delta: { content: "" } }] }],
    [undefined, { choices: [{ index: 0, delta: { content: "lo" }, finish_reason: "stop" }] }],
    [undefined, "[DONE]"],
  ])), { onDelta: (piece) => said.push(piece) });
  assert.deepEqual(said, ["hel", "lo"]);
  assert.equal(payload.choices[0].message.content, "hello");
});


// /v1/responses: pieces of text for showing, and the whole final response in one event.
const finalResponse = {
  id: "resp_1",
  model: "gpt-x",
  output: [{ type: "message", content: [{ type: "output_text", text: "Reading it." }] }],
  usage: { input_tokens: 12, output_tokens: 5, input_tokens_details: { cached_tokens: 2 } },
};

test("a responses stream shows its text as it comes and returns the final response whole", async () => {
  const heard = [];
  const usages = [];
  const result = await collectResponsesStream(streamOf(sse([
    ["response.created", { type: "response.created", response: { id: "resp_1" } }],
    ["response.output_text.delta", { type: "response.output_text.delta", delta: "Reading " }],
    ["response.output_text.delta", { type: "response.output_text.delta", delta: "it." }],
    ["response.completed", { type: "response.completed", response: finalResponse }],
  ])), { onDelta: (text) => heard.push(text), onUsage: (usage) => usages.push(usage) });
  assert.deepEqual(heard, ["Reading ", "it."]);
  assert.deepEqual(result, finalResponse);
  assert.equal(usages[0].input_tokens, 12);
});

test("a responses stream that fails or stops early is an error, not a half answer", async () => {
  await assert.rejects(
    collectResponsesStream(streamOf(sse([["response.failed", { type: "response.failed", response: { error: { code: "server_error", message: "overloaded" } } }]]))),
    (error) => error.retryable === true && /overloaded/.test(error.message),
  );
  await assert.rejects(
    collectResponsesStream(streamOf(sse([["response.output_text.delta", { type: "response.output_text.delta", delta: "half" }]]))),
    (error) => error.code === "stream_truncated" && error.retryable === true,
  );
});

test("streaming works through the whole responses tool loop", async () => {
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "etnpilot-responses-stream-"));
  await writeFile(join(root, "a.txt"), "file text\n");
  const bodies = [];
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    bodies.push(body);
    const answered = body.input.some((item) => item.type === "function_call_output");
    return answered
      ? streamOf(sse([
        ["response.output_text.delta", { type: "response.output_text.delta", delta: "It says " }],
        ["response.output_text.delta", { type: "response.output_text.delta", delta: "file text." }],
        ["response.completed", { type: "response.completed", response: { model: "gpt-x", output: [{ type: "message", content: [{ type: "output_text", text: "It says file text." }] }], usage: { input_tokens: 30, output_tokens: 6 } } }],
      ]))
      : streamOf(sse([
        ["response.completed", { type: "response.completed", response: { model: "gpt-x", output: [{ type: "function_call", call_id: "c1", name: "read_file", arguments: "{\"path\":\"a.txt\"}" }], usage: { input_tokens: 20, output_tokens: 4 } } }],
      ]));
  };
  const deltas = [];
  const provider = createOpenAICompatibleProvider({
    name: "openai", baseUrl: "https://api.example/v1", apiKey: "k", model: "gpt-x", tools: true, api: "responses", stream: true, workingDirectory: root, fetchImpl,
  });
  const result = await provider.invoke({
    runId: "r", agent: { name: "a", prompt: "P" }, input: "read", instructions: [], skills: [],
    emitDelta: (text) => deltas.push(text), approve: async () => ({ kind: "approve-once" }),
  });
  assert.equal(bodies[0].stream, true);
  assert.equal(result.text, "It says file text.");
  assert.deepEqual(deltas, ["It says ", "file text."]);
  assert.equal(result.toolCalls[0].ok, true);
  assert.equal(result.usage.inputTokens, 50);
});
