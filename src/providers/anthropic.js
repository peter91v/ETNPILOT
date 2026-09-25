import { missingApiKey } from "./openai-compatible.js";
import { ProviderError } from "./router.js";
import { createWorkspaceTools } from "./workspace-tools.js";
import { createResultEnvelope } from "./tool-results.js";

const DEFAULT_MAX_TOOL_ITERATIONS = 12;
const DEFAULT_BASE_URL = "https://api.anthropic.com";
const DEFAULT_MODEL = "claude-opus-5";
const DEFAULT_MAX_TOKENS = 8192;
const API_VERSION = "2023-06-01";

// The Anthropic Messages API, spoken directly. This project depends on no SDK
// on purpose: every adapter takes an injectable 'fetchImpl', which is what the
// tests, the replay fixtures, and the offline paths use.
export function createAnthropicProvider({
  name = "anthropic",
  baseUrl = DEFAULT_BASE_URL,
  apiKey,
  model = DEFAULT_MODEL,
  maxTokens = DEFAULT_MAX_TOKENS,
  tools = false,
  workingDirectory,
  toolLimits,
  sandbox,
  maxToolIterations = DEFAULT_MAX_TOOL_ITERATIONS,
  fetchImpl = globalThis.fetch,
  toolsImpl,
  apiKeySource,
}) {
  if (tools && !workingDirectory && !toolsImpl) {
    throw new TypeError("Tool support requires a workingDirectory.");
  }
  if (!Number.isInteger(maxToolIterations) || maxToolIterations < 1) {
    throw new TypeError("maxToolIterations must be a positive integer.");
  }
  if (!Number.isInteger(maxTokens) || maxTokens < 1) {
    throw new TypeError("maxTokens must be a positive integer.");
  }
  const endpoint = `${baseUrl.replace(/\/$/, "")}/v1/messages`;

  return {
    name,
    capabilities: tools ? ["chat", "tools"] : ["chat"],
    async invoke(context) {
      context.signal?.throwIfAborted();
      // A key that is absent is the most common reason this provider cannot
      // run, and a 401 from the API says less about it than this does.
      if (!apiKey) throw missingApiKey(name, apiKeySource, "ANTHROPIC_API_KEY");
      const workspaceTools = tools
        ? toolsImpl ?? createWorkspaceTools({
          workingDirectory,
          limits: toolLimits,
          signal: context.signal,
          sandbox,
          // What this agent is allowed to use, from its manifest. The tools
          // used to hang on the provider alone, so every agent sharing one
          // got all of them.
          allowed: context.agent.tools,
          fetchImpl,
        })
        : undefined;
      const messages = [{ role: "user", content: String(context.input) }];
      // One envelope per invocation: the marker a file could name is never
      // the marker in use.
      const envelope = createResultEnvelope(context.runId);
      const system = buildSystemMessage(context, workspaceTools ? envelope : undefined);
      const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
      const toolCalls = [];
      let responseModel;

      for (let iteration = 0; iteration <= maxToolIterations; iteration += 1) {
        const payload = await request({
          endpoint,
          apiKey,
          fetchImpl,
          context,
          body: {
            model: context.agent.model ?? model,
            max_tokens: maxTokens,
            ...(system ? { system } : {}),
            messages,
            ...(workspaceTools ? { tools: toolSchema(workspaceTools.definitions) } : {}),
          },
        });
        addUsage(usage, payload.usage);
        responseModel = payload.model ?? responseModel;
        const content = Array.isArray(payload.content) ? payload.content : [];
        const requested = workspaceTools ? content.filter((block) => block?.type === "tool_use") : [];
        if (requested.length === 0) {
          return {
            text: textOf(content),
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
        messages.push({ role: "assistant", content });
        const results = [];
        for (const call of requested) {
          context.signal?.throwIfAborted();
          const result = await workspaceTools.invoke(call.name, call.input ?? {}, context);
          toolCalls.push({ tool: call.name, ok: result.ok === true, ...(result.error ? { error: result.error } : {}) });
          results.push({
            type: "tool_result",
            tool_use_id: call.id,
            ...(result.ok === true ? {} : { is_error: true }),
            // The model sees the same bounded result the receipt records.
            content: envelope.wrap(result),
          });
        }
        messages.push({ role: "user", content: results });
      }
      throw new ProviderError("Provider tool loop did not terminate.", { code: "tool_loop_error" });
    },
  };
}

// The models this account can currently reach. Anthropic's own /v1/models
// only lists what is currently offered — nothing retired — so unlike the
// OpenAI-compatible listing this needs no chat/non-chat filter.
export async function listModels({ baseUrl = DEFAULT_BASE_URL, apiKey, fetchImpl = globalThis.fetch } = {}) {
  const endpoint = `${baseUrl.replace(/\/$/, "")}/v1/models`;
  let response;
  try {
    response = await fetchImpl(endpoint, {
      headers: {
        "anthropic-version": API_VERSION,
        ...(apiKey ? { "x-api-key": apiKey } : {}),
      },
    });
  } catch (error) {
    const detail = error?.cause?.message ?? error?.message ?? String(error);
    throw new ProviderError(`Provider network request failed: ${detail}`, {
      code: "network_error", retryable: true, safeToRetry: true, cause: error,
    });
  }
  if (!response.ok) {
    const detail = await errorDetail(response);
    throw new ProviderError(`Provider request failed (${response.status})${detail ? `: ${detail}` : "."}`, {
      code: `http_${response.status}`, retryable: response.status === 429 || response.status >= 500,
    });
  }
  const payload = await response.json();
  return (payload.data ?? [])
    .map((entry) => ({ id: entry.id, displayName: entry.display_name, created: entry.created_at }))
    .filter((entry) => typeof entry.id === "string")
    .sort((a, b) => a.id.localeCompare(b.id));
}

async function request({ endpoint, apiKey, fetchImpl, context, body }) {
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      signal: context.signal,
      headers: {
        "content-type": "application/json",
        "anthropic-version": API_VERSION,
        ...(apiKey ? { "x-api-key": apiKey } : {}),
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    // A cancelled step must not be replayed by the router; the workflow
    // engine owns timeouts and aborts.
    if (context.signal?.aborted) throw context.signal.reason ?? error;
    // fetch's own message is 'fetch failed'; what a person needs is one level
    // below it, where the host they cannot reach is named.
    const detail = error?.cause?.message ?? error?.message ?? String(error);
    throw new ProviderError(`Provider network request failed: ${detail}`, {
      code: "network_error",
      retryable: true,
      safeToRetry: true,
      cause: error,
    });
  }
  if (!response.ok) {
    const retryable = response.status === 429 || response.status >= 500;
    // The API answers with '{"error":{"type","message"}}'; an expired key and a
    // model that does not exist both arrive as 400, and only the message says
    // which.
    const detail = await errorDetail(response);
    throw new ProviderError(
      `Provider request failed (${response.status})${detail ? `: ${detail}` : "."}`,
      {
        code: `http_${response.status}`,
        retryable,
        // A failed call that already ran tools is not safe to replay blindly.
        safeToRetry: retryable && !bodyHasToolResults(body),
      },
    );
  }
  return response.json();
}

async function errorDetail(response) {
  const text = await response.text().catch(() => "");
  if (!text) return "";
  try {
    const parsed = JSON.parse(text);
    return String(parsed?.error?.message ?? parsed?.message ?? text).slice(0, 300);
  } catch {
    return text.slice(0, 300);
  }
}

function bodyHasToolResults(body) {
  return (body.messages ?? []).some((message) => Array.isArray(message.content)
    && message.content.some((block) => block?.type === "tool_result"));
}

function textOf(content) {
  return content
    .filter((block) => block?.type === "text")
    .map((block) => block.text ?? "")
    .join("");
}

function buildSystemMessage(context, envelope) {
  const parts = [context.agent.prompt, ...context.instructions];
  for (const skill of context.skills ?? []) parts.push(skill?.content ?? String(skill));
  // Last, so it is the most recent thing said about how to read what follows.
  if (envelope) parts.push(envelope.instruction);
  return parts.filter(Boolean).join("\n\n");
}

function toolSchema(definitions) {
  return definitions.map((definition) => ({
    name: definition.name,
    description: definition.description,
    input_schema: definition.parameters,
  }));
}

function addUsage(total, usage = {}) {
  total.inputTokens += usage.input_tokens ?? 0;
  total.outputTokens += usage.output_tokens ?? 0;
  total.cacheReadTokens += usage.cache_read_input_tokens ?? 0;
  total.cacheWriteTokens += usage.cache_creation_input_tokens ?? 0;
}
