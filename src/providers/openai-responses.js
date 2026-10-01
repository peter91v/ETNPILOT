import { compactConversation } from "./compaction.js";
import { ProviderError } from "./router.js";
import { withRetry } from "./retry.js";
import { accountRequest } from "./usage-meter.js";
import { describeCall } from "./workspace-tools.js";

// OpenAI's newer models answer function tools only on '/v1/responses'. On
// '/v1/chat/completions' they refuse them next to reasoning, and say so in
// their own words ("use /v1/responses or set reasoning_effort to 'none'").
// Turning the reasoning off is a worse model; this speaks the other API.
//
// Stateless on purpose: nothing is kept on the server ('store: false'), the
// whole conversation travels with every request, and the reasoning a model did
// between two tool calls comes back as encrypted items that are handed back
// as they arrived. That is also why a tool loop works without the server
// remembering anything.

export function responsesToolSchema(definitions) {
  return definitions.map((definition) => ({
    type: "function",
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
  }));
}

export function responseText(payload) {
  if (typeof payload?.output_text === "string") return payload.output_text;
  return (payload?.output ?? [])
    .filter((item) => item?.type === "message")
    .flatMap((item) => item.content ?? [])
    .filter((part) => part?.type === "output_text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

// Chat-shaped history ({role, content}) is valid input here as it stands.
export async function runResponsesTurn({
  context, workspaceTools, envelope, wireTools, system, model, maxToolIterations, retry, contextTokens, extraBody = {}, post, addUsage, stream = false,
}) {
  const input = [
    ...(context.history ?? []).map((entry) => ({ role: entry.role, content: entry.content })),
    { role: "user", content: String(context.input) },
  ];
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 0 };
  const toolCalls = [];
  const retried = [];
  const compactions = [];
  const { reasoning_effort: configuredEffort, ...passthrough } = extraBody;
  const effort = context.agent.effort ?? configuredEffort;
  let responseModel;
  let payload;
  let knownRequests = 0;
  try {
    for (let iteration = 0; iteration <= maxToolIterations; iteration += 1) {
      const body = {
        ...passthrough,
        model: context.agent.model ?? model,
        instructions: system,
        input,
        store: false,
        include: ["reasoning.encrypted_content"],
        ...(stream ? { stream: true } : {}),
        ...(effort ? { reasoning: { effort } } : {}),
        ...(wireTools && wireTools.definitions.length > 0 ? { tools: responsesToolSchema(wireTools.definitions), tool_choice: "auto" } : {}),
      };
      const attempt = await withRetry(() => accountRequest(context, usage, responseModel ?? body.model, addUsage, (requestContext) => post(body, requestContext)), { ...retry, signal: context.signal });
      payload = attempt.value;
      retried.push(...attempt.tried);
      addUsage(usage, payload.usage);
      responseModel = payload.model ?? responseModel;
      if (payload.usage) knownRequests += 1;
      usage.usageStatus = knownRequests === usage.requests ? "measured" : knownRequests > 0 ? "partial" : "unknown";
      context.recordProviderProgress?.(usage, responseModel ?? body.model);

      const output = Array.isArray(payload.output) ? payload.output : [];
      const calls = workspaceTools ? output.filter((item) => item?.type === "function_call") : [];
      if (calls.length === 0) {
        return {
          text: responseText(payload),
          raw: payload,
          model: responseModel ?? body.model,
          usage: usage.usageStatus === "measured" ? (({ usageStatus: _status, ...measured }) => measured)(usage) : usage,
          ...(effort ? { effort } : {}),
          ...(retried.length > 0 ? { retries: retried } : {}),
          ...(compactions.length > 0 ? { compactions } : {}),
          ...(workspaceTools ? { toolCalls } : {}),
        };
      }
      if (iteration === maxToolIterations) {
        throw new ProviderError(`Provider exceeded ${maxToolIterations} tool iterations.`, { code: "tool_iteration_limit", retryable: false, safeToRetry: false });
      }
      // Everything the model produced goes back, reasoning items included.
      input.push(...output);
      for (const call of calls) {
        context.signal?.throwIfAborted();
        const toolName = wireTools.internal(call.name);
        const result = await workspaceTools.invoke(toolName, call.arguments, context);
        toolCalls.push({
          tool: toolName,
          label: describeCall(toolName, call.arguments),
          ok: result.ok === true,
          ...(result.refused ? { refused: result.refused } : {}),
          ...(result.error ? { error: result.error } : {}),
          ...(result.afterWrite ? { afterWrite: result.afterWrite } : {}),
        });
        input.push({ type: "function_call_output", call_id: call.call_id, output: envelope.render(result) });
      }
      const bounded = compactConversation(input, {
        maxTokens: contextTokens,
        isToolResult: (item) => item?.type === "function_call_output",
        contentOf: (item) => item.output,
        replace: (item, note) => ({ ...item, output: note }),
      });
      if (bounded.compacted.length > 0) {
        input.length = 0;
        input.push(...bounded.messages);
        compactions.push(...bounded.compacted);
      }
    }
    throw new ProviderError("Provider tool loop did not terminate.", { code: "tool_loop_error" });
  } catch (cause) {
    const error = cause instanceof Error && Object.isExtensible(cause) ? cause : new ProviderError(String(cause), { cause });
    error.usage = { ...usage };
    error.model = responseModel ?? context.agent.model ?? model;
    error.toolCalls = toolCalls;
    throw error;
  }
}
