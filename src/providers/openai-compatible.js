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
    async invoke(context) {
      const response = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
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
      if (!response.ok) throw new Error(`Provider request failed (${response.status}): ${await response.text()}`);
      const payload = await response.json();
      return { text: payload.choices?.[0]?.message?.content ?? "", raw: payload };
    },
  };
}
