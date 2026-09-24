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
  sandbox,
  maxToolIterations = DEFAULT_MAX_TOOL_ITERATIONS,
  fetchImpl = globalThis.fetch,
  toolsImpl,
  // Fields this adapter never sets itself but a particular server needs.
  // 'reasoningEffort' is the one people hit first: a reasoning model applies
  // its own default, and OpenAI rejects that default together with function
  // tools on /v1/chat/completions ("set reasoning_effort to 'none'"). It is a
  // real behavioural choice — 'none' turns the model's reasoning off — so it
  // is configured, never guessed at here.
  reasoningEffort,
  requestBody,
  // Which environment variable and which secret this provider was wired to,
  // so a message about a missing key names the one to set rather than the
  // adapter's generic default.
  apiKeySource,
}) {
  if (!baseUrl) throw new TypeError("baseUrl is required.");
  if (tools && !workingDirectory && !toolsImpl) {
    throw new TypeError("Tool support requires a workingDirectory.");
  }
  if (!Number.isInteger(maxToolIterations) || maxToolIterations < 1) {
    throw new TypeError("maxToolIterations must be a positive integer.");
  }
  if (reasoningEffort !== undefined && typeof reasoningEffort !== "string") {
    throw new TypeError("reasoningEffort must be a string, such as 'none', 'low', 'medium' or 'high'.");
  }
  const extraBody = normalizeExtraBody(requestBody, reasoningEffort);
  const endpoint = `${baseUrl.replace(/\/$/, "")}/chat/completions`;
  // A model server on this machine needs no key; a hosted one always does,
  // and a 401 says less about a missing key than this does.
  const needsApiKey = !apiKey && !isLoopback(baseUrl);

  return {
    name,
    capabilities: tools ? ["chat", "tools"] : ["chat"],
    async invoke(context) {
      context.signal?.throwIfAborted();
      if (needsApiKey) throw missingApiKey(name, apiKeySource, "ETNPILOT_PROVIDER_API_KEY");
      const workspaceTools = tools
        ? toolsImpl ?? createWorkspaceTools({
          workingDirectory,
          limits: toolLimits,
          signal: context.signal,
          sandbox,
        })
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
          name,
          // The configured fields go in first: what this adapter needs to
          // work — the model, the conversation, the tool declarations — is
          // never overwritten by a passthrough.
          body: {
            ...extraBody,
            model: context.agent.model ?? model,
            messages,
            ...(workspaceTools ? { tools: toolSchema(workspaceTools.definitions), tool_choice: "auto" } : {}),
          },
          reasoningEffortConfigured: extraBody.reasoning_effort !== undefined,
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

// Only these may be passed through: everything else in the body is either
// this adapter's own mechanics or a shape it would then have to parse.
const RESERVED_BODY_KEYS = Object.freeze(["model", "messages", "tools", "tool_choice", "stream"]);

function normalizeExtraBody(requestBody, reasoningEffort) {
  const body = {};
  if (requestBody !== undefined) {
    if (!requestBody || typeof requestBody !== "object" || Array.isArray(requestBody)) {
      throw new TypeError("requestBody must be a mapping of request fields.");
    }
    for (const key of RESERVED_BODY_KEYS) {
      if (key in requestBody) {
        throw new TypeError(
          `requestBody must not set '${key}': it is this provider's own`
          + (key === "model" ? " field — use 'model' on the provider or the agent." : " mechanics."),
        );
      }
    }
    Object.assign(body, structuredClone(requestBody));
  }
  if (reasoningEffort !== undefined) body.reasoning_effort = reasoningEffort;
  return body;
}

async function request({ endpoint, apiKey, fetchImpl, context, body, name, reasoningEffortConfigured }) {
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
    // The cause is what a person needs — a refused connection names the host
    // and port they typed into 'providers.<name>.baseUrl'.
    // fetch's own message is 'fetch failed'; what a person needs is one level
    // below it, where the host and port they configured are named.
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
    // The body is the half that says what to do: a rejected key, a model the
    // account cannot reach, and a proxy in the way all arrive as a status
    // code alone, and the status alone tells them apart for nobody.
    const detail = await errorDetail(response);
    throw new ProviderError(
      `Provider request failed (${response.status})${detail ? `: ${detail}` : "."}`
      + reasoningEffortAdvice({ status: response.status, detail, body, name, reasoningEffortConfigured }),
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

// A 400 that names 'reasoning_effort' next to function tools is the one
// provider rejection with a single configurable answer, and the server states
// it in its own terms rather than this project's. Naming the setting turns a
// dead end into one command — but only when it is not already set, because
// repeating advice that was taken sends people in a circle.
function reasoningEffortAdvice({ status, detail, body, name, reasoningEffortConfigured }) {
  if (status !== 400 || reasoningEffortConfigured) return "";
  if (!/reasoning_effort/i.test(detail ?? "")) return "";
  if (!Array.isArray(body?.tools) || body.tools.length === 0) return "";
  return `\nThis provider sends no reasoning_effort, so that is the server's own default for`
    + ` '${body.model}'. To keep the workspace tools, set 'providers.${name}.reasoningEffort'`
    + ` to 'none' (etnpilot config set providers.${name}.reasoningEffort none — that stays local),`
    + ` which turns this model's reasoning off. The other route the server names,`
    + ` /v1/responses, is a different API shape this adapter does not speak.`;
}

// Every id this endpoint returns, including embedding, image, audio and
// moderation models it never separates out — 'GET /v1/models' has no
// chat/non-chat field. This name list is this project's own judgment call,
// not something the API states, and it is applied by the caller, not here,
// so a project whose server names its chat models differently is not
// silently emptied.
const NON_CHAT_MODEL_PATTERN = /embed|whisper|tts|dall-e|image|moderation|davinci|curie|babbage|instruct$|realtime|audio|transcribe|speech/i;

export function looksLikeChatModel(id) {
  return typeof id === "string" && !NON_CHAT_MODEL_PATTERN.test(id);
}

// The models an OpenAI-compatible endpoint currently offers. Read live, on
// request — never cached here — because the answer changes on the server's
// own schedule, not this project's.
export async function listModels({ baseUrl, apiKey, fetchImpl = globalThis.fetch } = {}) {
  if (!baseUrl) throw new TypeError("baseUrl is required.");
  const endpoint = `${baseUrl.replace(/\/$/, "")}/models`;
  let response;
  try {
    response = await fetchImpl(endpoint, {
      headers: { ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
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
    .map((entry) => ({ id: entry.id, ownedBy: entry.owned_by, created: entry.created }))
    .filter((entry) => typeof entry.id === "string")
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function missingApiKey(name, source, fallbackEnv) {
  const secret = source?.secret;
  // A named secret with nothing behind it is a different problem from an
  // unset variable, and sending someone to the wrong file costs an hour.
  if (source && !source.env) {
    return new ProviderError(
      `Provider '${name}' has no API key: its secret '${secret}' is not mapped under 'secrets.values'.`
      + ` Map it to an environment variable there, or remove`
      + ` 'providers.${name}.apiKeySecret' to use the default.`,
      { code: "missing_api_key", retryable: false, safeToRetry: false },
    );
  }
  const variable = source?.env ?? fallbackEnv;
  return new ProviderError(
    `Provider '${name}' has no API key. Set ${variable} in the environment`
    + (secret ? ` (secret '${secret}', allowed under 'secrets.providers.env.allow')` : "")
    + `, or point 'providers.${name}.apiKeySecret' at a configured secret.`,
    { code: "missing_api_key", retryable: false, safeToRetry: false },
  );
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

function isLoopback(baseUrl) {
  try {
    const { hostname } = new URL(baseUrl);
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
  } catch {
    return false;
  }
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
