// Keeping a tool loop inside a context window.
//
// The loop appended: up to twelve iterations, each carrying a whole file or a
// whole command's output, and nothing ever shortened it. A long run therefore
// ended as a 400 from the provider — which reads like a provider problem and
// is in fact this project spending its own budget until there was none left.
//
// What is dropped is the *oldest tool output*, never a message and never the
// task. The model keeps knowing what it did and what it was asked; it loses
// the middle of a file it read eight steps ago. And what was dropped is said
// in place, both to the model and in the receipt, because a compacted run
// that looks complete is worse than one that ran out.

// Tokens are counted by the provider, not here, and asking costs a request.
// Four characters to a token is the usual rule of thumb for English and for
// code; it is used only to decide when to compact, and being wrong by a fifth
// changes when that happens, not whether the result is correct.
const CHARACTERS_PER_TOKEN = 4;

export function estimateTokens(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  return Math.ceil(text.length / CHARACTERS_PER_TOKEN);
}

// Replaces the content of the oldest tool results until the conversation fits.
// 'isToolResult' and 'replace' differ per API shape, so the caller supplies
// them and this owns the policy.
export function compactConversation(messages, {
  maxTokens,
  isToolResult,
  contentOf,
  replace,
  // Never touch the most recent exchanges: the model is working in them.
  keepRecent = 4,
}) {
  let total = estimateTokens(messages);
  if (total <= maxTokens) return { messages, compacted: [] };

  const compacted = [];
  const next = [...messages];
  const untouchable = Math.max(0, next.length - keepRecent);
  for (let index = 0; index < untouchable && total > maxTokens; index += 1) {
    const message = next[index];
    if (!isToolResult(message)) continue;
    const content = contentOf(message);
    const before = estimateTokens(content);
    // Dropping something already tiny costs a line of explanation and saves
    // nothing.
    if (before < 64) continue;
    const note = `[compacted: ${before} tokens of tool output removed to stay inside the context window;`
      + " read the file or run the command again if you still need it]";
    next[index] = replace(message, note);
    total -= before - estimateTokens(note);
    compacted.push({ index, tokens: before });
  }
  return { messages: next, compacted, estimatedTokens: total };
}
