// @ts-check
import { ProviderError } from "./router.js";

// Server-sent events, and the two ways a provider's stream is folded back into
// the single response the rest of the adapter already knows how to read.
//
// Streaming exists here for one reason: a long answer over one silent request
// is a request that can time out before it finishes, and nothing in between
// can tell "still working" from "gone". The adapters keep their loop exactly
// as it was — a stream is read to its end and becomes the same payload
// 'response.json()' would have returned — so tool calls, usage and the receipt
// do not learn a second shape.

export async function* readEvents(response, { signal, maxBytes = 16 * 1024 * 1024, maxEventBytes = 1024 * 1024 } = /** @type {any} */ ({})) {
  if (!response.body?.getReader) {
    throw new ProviderError("The provider sent no stream to read.", { code: "stream_missing", retryable: false, safeToRetry: false });
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let bytes = 0;
  const abort = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal?.throwIfAborted();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      const { value, done } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new ProviderError("Provider stream byte limit exceeded.", { code: "stream_limit" });
      buffer += decoder.decode(value, { stream: true });
      let boundary = nextBoundary(buffer);
      while (boundary) {
        if (boundary.index > maxEventBytes) throw new ProviderError("Provider stream event limit exceeded.", { code: "stream_limit" });
        const raw = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        const event = parseEvent(raw);
        if (event) yield event;
        boundary = nextBoundary(buffer);
      }
      if (Buffer.byteLength(buffer) > maxEventBytes) throw new ProviderError("Provider stream event limit exceeded.", { code: "stream_limit" });
    }
    // Whatever is left has no blank line after it: by the SSE rules an event
    // is only complete once it does, so a stream cut mid-event ends without it
    // rather than delivering half a JSON object as though it were whole.
  } finally {
    signal?.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock?.();
  }
}

function nextBoundary(text) {
  const match = /\r?\n\r?\n/.exec(text);
  return match ? { index: match.index, length: match[0].length } : undefined;
}

function parseEvent(raw) {
  let name;
  const data = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line === "" || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") name = value;
    else if (field === "data") data.push(value);
  }
  return data.length === 0 && !name ? undefined : { event: name, data: data.join("\n") };
}

function parseJson(text, what) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ProviderError(`The provider's stream carried ${what} that is not JSON: ${error.message}`, {
      code: "stream_protocol",
      retryable: false,
      safeToRetry: false,
    });
  }
}

// Anthropic: message_start, then content blocks built from deltas, then
// message_delta with the stop reason and the final output count.
// 'onDelta' hears each piece of answer text as it arrives; the return value is
// still the whole message, so nothing downstream depends on it being called.
export async function collectAnthropicStream(response, { onDelta, onUsage, signal } = /** @type {any} */ ({})) {
  const message = { content: [], usage: {} };
  const blocks = [];
  for await (const { event, data } of readEvents(response, { signal })) {
    if (!data || event === "ping") continue;
    const payload = parseJson(data, `a '${event}' event`);
    const type = payload.type ?? event;
    if (type === "message_start") {
      const start = payload.message ?? {};
      Object.assign(message, { ...start, content: [] });
      message.usage = { ...(start.usage ?? {}) };
      onUsage?.(message.usage, message.model);
    } else if (type === "content_block_start") {
      if (!Number.isInteger(payload.index) || payload.index < 0 || payload.index >= 256) throw new ProviderError("Invalid stream block index.", { code: "stream_protocol" });
      blocks[payload.index] = { ...payload.content_block };
      if (blocks[payload.index].type === "tool_use") blocks[payload.index]._json = "";
    } else if (type === "content_block_delta") {
      const block = blocks[payload.index];
      const delta = payload.delta ?? {};
      if (!block) continue;
      if (delta.type === "text_delta") {
        block.text = (block.text ?? "") + delta.text;
        onDelta?.(delta.text);
      }
      else if (delta.type === "input_json_delta") block._json = (block._json ?? "") + delta.partial_json;
      else if (delta.type === "thinking_delta") block.thinking = (block.thinking ?? "") + delta.thinking;
      // A thinking block is sent back unchanged on the next request, and the
      // API refuses it without the signature it was given.
      else if (delta.type === "signature_delta") block.signature = delta.signature;
    } else if (type === "content_block_stop") {
      const block = blocks[payload.index];
      if (block && "_json" in block) {
        block.input = block._json === "" ? {} : parseJson(block._json, `the arguments of '${block.name}'`);
        delete block._json;
      }
    } else if (type === "message_delta") {
      Object.assign(message, payload.delta ?? {});
      message.usage = { ...message.usage, ...(payload.usage ?? {}) };
      onUsage?.(message.usage, message.model);
    } else if (type === "error") {
      const kind = payload.error?.type ?? "error";
      // 'overloaded_error' is the API asking for a retry, mid-stream.
      const retryable = kind === "overloaded_error" || kind === "api_error";
      throw new ProviderError(`Provider stream failed (${kind}): ${payload.error?.message ?? "no message"}`, {
        code: `stream_${kind}`,
        retryable,
        safeToRetry: retryable,
      });
    }
  }
  if (!message.stop_reason) {
    throw new ProviderError("The provider's stream ended before it said why it stopped.", {
      code: "stream_truncated",
      retryable: true,
      safeToRetry: true,
    });
  }
  /** @type {any} */ (message).content = blocks.filter(Boolean);
  return message;
}

// OpenAI-compatible: chat.completion.chunk objects, tool calls arriving in
// pieces keyed by index, and a final chunk with usage when asked for.
export async function collectChatStream(response, { onDelta, onUsage, signal } = /** @type {any} */ ({})) {
  const message = { role: "assistant", content: "" };
  const calls = [];
  let finish;
  let usage;
  let model;
  let id;
  let sawDone = false;
  for await (const { data } of readEvents(response, { signal })) {
    if (data === "[DONE]") {
      sawDone = true;
      break;
    }
    if (!data) continue;
    const chunk = parseJson(data, "a chunk");
    if (chunk.error) {
      throw new ProviderError(`Provider stream failed: ${chunk.error.message ?? "no message"}`, {
        code: "stream_error",
        retryable: false,
        safeToRetry: false,
      });
    }
    model = chunk.model ?? model;
    id = chunk.id ?? id;
    usage = chunk.usage ?? usage;
    if (chunk.usage) onUsage?.(usage, model);
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta ?? {};
    if (typeof delta.content === "string") {
      message.content += delta.content;
      if (delta.content !== "") onDelta?.(delta.content);
    }
    for (const piece of delta.tool_calls ?? []) {
      if (!Number.isInteger(piece.index ?? 0) || (piece.index ?? 0) < 0 || (piece.index ?? 0) >= 256) throw new ProviderError("Invalid stream tool index.", { code: "stream_protocol" });
      const call = calls[piece.index ?? 0] ??= { id: undefined, type: "function", function: { name: "", arguments: "" } };
      call.id = piece.id ?? call.id;
      call.function.name += piece.function?.name ?? "";
      call.function.arguments += piece.function?.arguments ?? "";
    }
    finish = choice.finish_reason ?? finish;
  }
  if (!sawDone && finish === undefined) {
    throw new ProviderError("The provider's stream ended before it finished.", {
      code: "stream_truncated",
      retryable: true,
      safeToRetry: true,
    });
  }
  const done = calls.filter(Boolean);
  if (done.length > 0) {
    message.tool_calls = done;
    if (message.content === "") /** @type {any} */ (message).content = null;
  }
  return { id, model, choices: [{ index: 0, message, finish_reason: finish }], usage };
}

// OpenAI /responses: typed events. The text arrives as 'response.output_text.delta'
// pieces, and the finished response — the same object a non-streaming call
// returns, output items and usage included — arrives whole in
// 'response.completed'. So the pieces are only for showing, and what is returned
// is that final object: tool calls and reasoning items never have to be
// reassembled from fragments.
export async function collectResponsesStream(response, { onDelta, onUsage, signal } = /** @type {any} */ ({})) {
  let final;
  for await (const { event, data } of readEvents(response, { signal })) {
    if (!data || data === "[DONE]") continue;
    const payload = parseJson(data, `a '${event}' event`);
    const type = payload.type ?? event;
    if (type === "response.output_text.delta") {
      if (typeof payload.delta === "string" && payload.delta !== "") onDelta?.(payload.delta);
    } else if (type === "response.completed" || type === "response.incomplete") {
      final = payload.response;
      if (final?.usage) onUsage?.(final.usage, final.model);
    } else if (type === "response.failed" || type === "error") {
      const failure = payload.response?.error ?? payload.error ?? payload;
      const retryable = failure.code === "server_error" || failure.code === "rate_limit_exceeded";
      throw new ProviderError(`Provider stream failed${failure.code ? ` (${failure.code})` : ""}: ${failure.message ?? "no message"}`, {
        code: "stream_error",
        retryable,
        safeToRetry: retryable,
      });
    }
  }
  if (!final) {
    throw new ProviderError("The provider's stream ended before it finished.", { code: "stream_truncated", retryable: true, safeToRetry: true });
  }
  return final;
}
