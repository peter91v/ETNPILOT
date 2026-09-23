import { ProviderError } from "./router.js";
import { createWorkspaceTools } from "./workspace-tools.js";

const DEFAULT_MAX_TOOL_ITERATIONS = 12;

export function createOpenAICompatibleProvider({
  name = "openai-compatible",
  baseUrl,
  apiKey,
  model,
  tools = false,
  workingDirectory,
  toolLimits,
  maxToolIterations = DEFAULT_MAX_TOOL_ITERATIONS,
  fetchImpl = globalThis.fetch,
  toolsImpl,
}) {
  if (!baseUrl) throw new TypeError("baseUrl is required.");
  if (tools && !workingDirectory && !toolsImpl) {
    throw new TypeError("Tool support requires a workingDirectory.");
  }
  if (!Number.isInteger(maxToolIterations) || maxToolIterations < 1) {
    throw new TypeError("maxToolIterations must be a positive integer.");
  }
  const endpoint = `${baseUrl.replace(/\/$/, "")}/chat/completions`;

  return {
    name,
    capabilities: tools ? ["chat", "tools"] : ["chat"],
    async invoke(context) {
      context.signal?.throwIfAborted();
      const workspaceTools = tools
        ? toolsImpl ?? createWorkspaceTools({ workingDirectory, limits: toolLimits, signal: context.signal })
        : undefined;
      const messages = [
        { role: "system", content: buildSystemMessage(context) },
        { role: "user", content: String(context.input) },
      ];
      const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
      const toolCalls = [];
      let payload;
      let responseModel;

      for (let iteration = 0; iteration <= maxToolIterations; iteration += 1) {
        payload = await request({
          endpoint,
          apiKey,
          fetchImpl,
          context,
          body: {
            model: context.agent.model ?? model,
            messages,
            ...(workspaceTools ? { tools: toolSchema(workspaceTools.definitions), tool_choice: "auto" } : {}),
          },
        });
        addUsage(usage, payload.usage);
        responseModel = payload.model ?? responseModel;
        const message = payload.choices?.[0]?.message ?? {};
        const requested = workspaceTools ? message.tool_calls ?? [] : [];
        if (requested.length === 0) {
          return {
            text: message.content ?? "",
            raw: payload,
            model: responseModel ?? context.agent.model ?? model,
            usage,
            ...(workspaceTools ? { toolCalls } : {}),
          };
        }
        if (iteration === maxToolIterations) {
          throw new ProviderError(`Provider exceeded ${maxToolIterations} tool iterations.`, {
            code: "tool_iteration_limit",
            retryable: false,
            safeToRetry: false,
          });
        }
        messages.push(message);
        for (const call of requested) {
          context.signal?.throwIfAborted();
          const toolName = call.function?.name ?? call.name;
          const result = await workspaceTools.invoke(toolName, call.function?.arguments ?? call.arguments, context);
          toolCalls.push({ tool: toolName, ok: result.ok === true, ...(result.error ? { error: result.error } : {}) });
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            // The model sees the same bounded result the receipt records.
            content: JSON.stringify(result),
          });
        }
      }
      throw new ProviderError("Provider tool loop did not terminate.", { code: "tool_loop_error" });
    },
  };
}

async function request({ endpoint, apiKey, fetchImpl, context, body }) {
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      signal: context.signal,
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(body),
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
      // A failed call that already ran tools is not safe to replay blindly.
      safeToRetry: retryable && !bodyHasToolResults(body),
    });
  }
  return response.json();
}

function bodyHasToolResults(body) {
  return (body.messages ?? []).some((message) => message.role === "tool");
}

function buildSystemMessage(context) {
  const parts = [context.agent.prompt, ...context.instructions];
  for (const skill of context.skills ?? []) parts.push(skill?.content ?? String(skill));
  return parts.filter(Boolean).join("\n\n");
}

function toolSchema(definitions) {
  return definitions.map((definition) => ({
    type: "function",
    function: {
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters,
    },
  }));
}

function addUsage(total, usage = {}) {
  const normalized = normalizeUsage(usage);
  total.inputTokens += normalized.inputTokens;
  total.outputTokens += normalized.outputTokens;
  total.cacheReadTokens += normalized.cacheReadTokens;
  total.cacheWriteTokens += normalized.cacheWriteTokens;
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
