import { ProviderError } from "./router.js";

export function createOpenAICompatibleProvider({
  name = "openai-compatible",
  baseUrl,
  apiKey,
  model,
  fetchImpl = globalThis.fetch,
}) {
  if (!baseUrl) throw new TypeError("baseUrl is required.");
  return {
    name,
    capabilities: ["chat"],
    async invoke(context) {
      context.signal?.throwIfAborted();
      let response;
      try {
        response = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          signal: context.signal,
          headers: {
            "content-type": "application/json",
            ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
          },
          body: JSON.stringify({
            model: context.agent.model ?? model,
            messages: [
              { role: "system", content: [context.agent.prompt, ...context.instructions].join("\n\n") },
              { role: "user", content: String(context.input) },
            ],
          }),
        });
      } catch (error) {
        // A cancelled step must not be replayed by the router; the workflow
        // engine owns timeouts and aborts.
        if (context.signal?.aborted) throw context.signal.reason ?? error;
        throw new ProviderError("Provider network request failed.", {
          code: "network_error",
          retryable: true,
          safeToRetry: true,
          cause: error,
        });
      }
      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        await response.text();
        throw new ProviderError(`Provider request failed (${response.status}).`, {
          code: `http_${response.status}`,
          retryable,
          safeToRetry: retryable,
        });
      }
      const payload = await response.json();
      return {
        text: payload.choices?.[0]?.message?.content ?? "",
        raw: payload,
        model: payload.model ?? context.agent.model ?? model,
        usage: normalizeUsage(payload.usage),
      };
    },
  };
}

function normalizeUsage(usage = {}) {
  return {
    inputTokens: usage.input_tokens ?? usage.prompt_tokens ?? 0,
    outputTokens: usage.output_tokens ?? usage.completion_tokens ?? 0,
    cacheReadTokens: usage.input_tokens_details?.cached_tokens
      ?? usage.prompt_tokens_details?.cached_tokens
      ?? 0,
    cacheWriteTokens: usage.input_tokens_details?.cache_creation_tokens ?? 0,
  };
}
