import { accountRequest } from "./usage-meter.js";
import { providerToolNames } from "./tool-names.js";
import { missingApiKey } from "./openai-compatible.js";
import { ProviderError } from "./router.js";
import { collectAnthropicStream } from "./sse.js";
import { retryAfterMs, withRetry } from "./retry.js";
import { createWorkspaceTools, describeCall, lazySkills, skillsOf } from "./workspace-tools.js";
import { createResultEnvelope } from "./tool-results.js";
import { compactConversation } from "./compaction.js";

const DEFAULT_MAX_TOOL_ITERATIONS = 12;
const DEFAULT_BASE_URL = "https://api.anthropic.com";
const DEFAULT_MODEL = "claude-opus-5";
const DEFAULT_MAX_TOKENS = 8192;
const API_VERSION = "2023-06-01";

// The Anthropic Messages API, spoken directly. This project depends on no SDK
// on purpose: every adapter takes an injectable 'fetchImpl', which is what the
// tests, the replay fixtures, and the offline paths use.
// A rolling breakpoint at the end of the conversation, so each iteration
// reads back everything the one before it wrote instead of paying for it
// again. The previous breakpoint is removed first: they are positions, not
// accumulating marks, and four is the limit.
function withConversationBreakpoint(messages) {
  if (messages.length === 0) return messages;
  const cleaned = messages.map((message) => (Array.isArray(message.content)
    ? { ...message, content: message.content.map(({ cache_control: _dropped, ...block }) => block) }
    : message));
  const last = cleaned.at(-1);
  const blocks = Array.isArray(last.content)
    ? last.content
    : [{ type: "text", text: String(last.content) }];
  if (blocks.length === 0) return cleaned;
  return [
    ...cleaned.slice(0, -1),
    { ...last, content: [...blocks.slice(0, -1), { ...blocks.at(-1), cache_control: { type: "ephemeral" } }] },
  ];
}

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
  // Off only where a proxy in front of the API rejects the field.
  caching = true,
  retry,
  // What this agent's conversation may grow to before the oldest tool output
  // is summarised away. Well under any current model's window on purpose:
  // the point is to stay inside it, not to find its edge.
  contextTokens = 120_000,
  extraTools = [],
  // Read the answer as a stream and fold it into the same payload. Off by
  // default: it changes how a long answer travels, not what it says.
  stream = false,
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
          canSpawn: (context.agent.subagents ?? []).length > 0,
          subagents: context.subagents ?? [],
          extraTools: context.extraTools ?? extraTools,
          scopedInstructions: context.scopedInstructions,
          skills: skillsOf(context),
          fetchImpl,
        })
        : undefined;
      // A conversation's earlier turns come first, as plain text.
      const messages = [...(context.history ?? []), { role: "user", content: String(context.input) }];
      // One envelope per invocation: the marker a file could name is never
      // the marker in use.
      const envelope = createResultEnvelope(context.runId);
      const system = buildSystemMessage(context, workspaceTools ? envelope : undefined, workspaceTools);
      const wireTools = providerToolNames(workspaceTools?.definitions);
      const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 0 };
      // Marks the last block of a list so everything before it is cached.
      // Anthropic allows four such breakpoints; this uses three — the tools,
      // the system prompt, and a rolling one at the end of the conversation.
      const cacheable = (blocks) => {
        if (!caching || blocks.length === 0) return blocks;
        return [...blocks.slice(0, -1), { ...blocks.at(-1), cache_control: { type: "ephemeral" } }];
      };
      const toolCalls = [];
      // Every attempt that was made and failed, so a receipt never reads as
      // though the provider answered first time.
      const retried = [];
      const compactions = [];
      let responseModel;
      let knownRequests = 0;

      try {
      for (let iteration = 0; iteration <= maxToolIterations; iteration += 1) {
        const attempt = await withRetry((number) => accountRequest(context, usage,
          responseModel ?? context.agent.model ?? model, addUsage, (requestContext) => request({
          endpoint,
          apiKey,
          fetchImpl,
          context: requestContext,
          attempt: number,
          stream,
          body: {
            ...(stream ? { stream: true } : {}),
            model: context.agent.model ?? model,
            max_tokens: maxTokens,
            // Only when the agent asks: adaptive thinking is refused by models
            // older than the 4.6 generation, so it is never a default sent to
            // everybody. The agent's manifest chose it, for this agent.
            ...(context.agent.effort
              ? { thinking: { type: "adaptive" }, output_config: { effort: context.agent.effort } }
              : {}),
            // Cached, because the expensive half of a tool loop is what does
            // not change: the same system prompt and the same tool schemas go
            // up again on every iteration, and by the twelfth they are the
            // largest item on the bill this project itself reports.
            ...(system ? { system: cacheable([{ type: "text", text: system }]) } : {}),
            // Only once there is a conversation worth caching. On the first
            // request there is one short user message: a breakpoint there
            // rewrites it into blocks for nothing, because a prompt that
            // short is under the minimum a cache entry needs anyway.
            messages: caching && messages.length > 1 ? withConversationBreakpoint(messages) : messages,
            // An agent allowed no tool at all is sent none: an empty list is not a
            // request every API accepts.
            ...(workspaceTools?.definitions.length > 0 ? { tools: cacheable(toolSchema(wireTools.definitions)) } : {}),
          },
        })), { ...retry, signal: context.signal });
        const payload = attempt.value;
        retried.push(...attempt.tried);
        addUsage(usage, payload.usage);
        responseModel = payload.model ?? responseModel;
        if (payload.usage) knownRequests += 1;
        usage.usageStatus = knownRequests === usage.requests ? "measured" : knownRequests > 0 ? "partial" : "unknown";
        context.recordProviderProgress?.(usage, responseModel ?? context.agent.model ?? model);
        const content = Array.isArray(payload.content) ? payload.content : [];
        const requested = workspaceTools ? content.filter((block) => block?.type === "tool_use") : [];
        if (requested.length === 0) {
          return {
            text: textOf(content),
            raw: payload,
            model: responseModel ?? context.agent.model ?? model,
            usage: usage.usageStatus === "measured" ? (({ usageStatus: _status, ...measured }) => measured)(usage) : usage,
            ...(context.agent.effort ? { effort: context.agent.effort } : {}),
            ...(retried.length > 0 ? { retries: retried } : {}),
            ...(compactions.length > 0 ? { compactions } : {}),
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
          const result = await workspaceTools.invoke(wireTools.internal(call.name), call.input ?? {}, context);
          toolCalls.push({ tool: wireTools.internal(call.name), label: describeCall(wireTools.internal(call.name), call.input), ok: result.ok === true, ...(result.refused ? { refused: result.refused } : {}), ...(result.error ? { error: result.error } : {}), ...(result.afterWrite ? { afterWrite: result.afterWrite } : {}) });
          results.push({
            type: "tool_result",
            tool_use_id: call.id,
            ...(result.ok === true ? {} : { is_error: true }),
            // The model sees the same bounded result the receipt records.
            content: envelope.render(result),
          });
        }
        messages.push({ role: "user", content: results });
        // Before the next request, not after it fails: the provider's refusal
        // would be a 400 that reads like a provider problem.
        const bounded = compactConversation(messages, {
          maxTokens: contextTokens,
          isToolResult: (message) => Array.isArray(message.content)
            && message.content.some((block) => block?.type === "tool_result"),
          contentOf: (message) => message.content,
          replace: (message, note) => ({
            ...message,
            content: message.content.map((block) => (block?.type === "tool_result"
              ? { ...block, content: note }
              : block)),
          }),
        });
        if (bounded.compacted.length > 0) {
          messages.length = 0;
          messages.push(...bounded.messages);
          compactions.push(...bounded.compacted);
        }
      }
      throw new ProviderError("Provider tool loop did not terminate.", { code: "tool_loop_error" });
      } catch (cause) { const error = cause instanceof Error && Object.isExtensible(cause) ? cause : new ProviderError(String(cause), { cause }); error.usage = { ...usage }; error.model = responseModel ?? context.agent.model ?? model; error.toolCalls = toolCalls; throw error; }
    },
  };
}

// The models this account can currently reach. Anthropic's own /v1/models
// only lists what is currently offered — nothing retired — so unlike the
// OpenAI-compatible listing this needs no chat/non-chat filter.
export async function listModels({ baseUrl = DEFAULT_BASE_URL, apiKey, fetchImpl = globalThis.fetch } = /** @type {any} */ ({})) {
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

async function request({ endpoint, apiKey, fetchImpl, context, body, stream }) {
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
        retryAfterMs: retryAfterMs(response.headers?.get?.("retry-after")),
        // A failed call that already ran tools is not safe to replay blindly.
        safeToRetry: retryable && !bodyHasToolResults(body),
      },
    );
  }
  if (!stream) return response.json();
  try {
    return await collectAnthropicStream(response, { onDelta: context.emitDelta, onUsage: context.onStreamUsage, signal: context.signal });
  } catch (error) {
    // Same rule as a failed status: what already ran tools is not replayed blindly.
    if (error instanceof ProviderError && bodyHasToolResults(body)) error.safeToRetry = false;
    throw error;
  }
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

function buildSystemMessage(context, envelope, tools) {
  const parts = [context.agent.prompt, ...context.instructions];
  // Listed by name when the agent can open them; sent whole when it cannot,
  // because a skill it may neither see nor load would be a skill it lacks.
  const lazy = lazySkills(context, tools);
  if (lazy.length > 0) {
    parts.push(["Skills you can load with load_skill (name: what it is for):", ...lazy.map((skill) => `- ${skill.name}: ${skill.summary}`)].join("\n"));
  } else {
    for (const skill of context.skills ?? []) parts.push(skill?.content ?? String(skill));
  }
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
  // One per answer received: a turn that reads files and then answers is
  // several requests to the provider, and the provider bills and counts them so.

  total.inputTokens += (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
  total.outputTokens += usage.output_tokens ?? 0;
  total.cacheReadTokens += usage.cache_read_input_tokens ?? 0;
  total.cacheWriteTokens += usage.cache_creation_input_tokens ?? 0;
}
