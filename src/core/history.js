import { estimateTokens } from "../providers/compaction.js";

// The earlier turns of a conversation, as a provider needs them: plain text,
// alternating between the person and the agent. Tool calls and their results
// are not carried between turns — the workspace is where their effect lives,
// and re-sending a file the agent read three turns ago is the most expensive
// way there is to remember it.

export const MAX_HISTORY_TOKENS = 24_000;

export function normalizeHistory(history) {
  if (history === undefined) return [];
  if (!Array.isArray(history)) throw new TypeError("history must be a list of { role, content } messages.");
  return history.map((message, index) => {
    if (!message || (message.role !== "user" && message.role !== "assistant") || typeof message.content !== "string") {
      throw new TypeError(`history[${index}] must be { role: 'user' | 'assistant', content: string }.`);
    }
    return { role: message.role, content: message.content };
  });
}

// Drops the oldest whole exchanges until the rest fits, and says so in the
// text the model reads and in what is returned — a conversation that lost its
// beginning must not look like one that has it. Summarising instead of
// dropping is a later step; this one never invents what was said.
export function boundHistory(history, maxTokens = MAX_HISTORY_TOKENS) {
  const messages = normalizeHistory(history);
  let start = 0;
  const cost = (from) => messages.slice(from).reduce((sum, message) => sum + estimateTokens(message.content), 0);
  while (start < messages.length - 1 && cost(start) > maxTokens) start += 2;
  if (start === 0) return { history: messages, omitted: 0 };
  const kept = messages.slice(start);
  const note = `[${start / 2} earlier exchange${start / 2 === 1 ? "" : "s"} of this conversation ${start / 2 === 1 ? "was" : "were"} left out to fit.]`;
  if (kept.length > 0 && kept[0].role === "user") {
    kept[0] = { ...kept[0], content: `${note}\n\n${kept[0].content}` };
  }
  return { history: kept, omitted: start / 2 };
}
