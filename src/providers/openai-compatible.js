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
      let response;
      try {
        response = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
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
      return { text: payload.choices?.[0]?.message?.content ?? "", raw: payload };
    },
  };
}
