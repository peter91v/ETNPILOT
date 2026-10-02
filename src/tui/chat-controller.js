// @ts-check
import { PolicyEngine } from "../policy/engine.js";
import { createChoice, runChatCommand } from "../runtime/chat-commands.js";

// The conversation as the terminal window holds it: what the server keeps about
// it, the choices made for the next turn, and the line being typed. Keys that
// edit the line, file suggestions for '@', sending, and keeping in step with
// the server live here so the window's main file is about screens and keys.
//
// `note` shows a short message; `paint` redraws; both are the window's.
export function createChatController({ state, now, note, paint }) {
  const chat = /** @type {any} */ ({ sessionId: undefined, turns: [], compactions: [], running: false, pending: undefined, choice: createChoice(undefined), scroll: 0, notes: [], known: undefined });
  let compose;

async function prepareChat() {
  if (chat.known) return;
  chat.known = await state.agents();
  chat.choice.agent ??= chat.known.defaultAgent ?? "orchestrator";
}

async function startCompose() {
  await prepareChat().catch((error) => note(error.message));
  compose = { buffer: "", suggestions: [], index: 0 };
}

async function composeKey(key) {
  if (key === "\u0003" || key === "\u001B") {
    compose = undefined;
    return;
  }
  if (key === "\r" || key === "\n") return submitCompose();
  if (key === "\t") return completeMention();
  if (key === "\u0015") {
    compose = { ...compose, buffer: "", suggestions: [], error: undefined };
    return;
  }
  if (key === "\u007F" || key === "\b") {
    compose = { ...compose, buffer: [...compose.buffer].slice(0, -1).join(""), error: undefined };
    void suggestFiles();
    return;
  }
  // Arrow keys and other escape sequences are not text.
  if (key.startsWith("\u001B") || [...key].length !== 1 || key < " ") return;
  compose = { ...compose, buffer: compose.buffer + key, error: undefined };
  void suggestFiles();
}

// The file a '@' at the end of the line could mean, offered the way the page
// offers it: only what git tracks and the read policy allows.
async function suggestFiles() {
  const match = /(^|\s)@([^\s]*)$/.exec(compose?.buffer ?? "");
  if (!match) {
    if (compose) compose = { ...compose, suggestions: [], index: 0 };
    return;
  }
  const buffer = compose.buffer;
  try {
    const files = await state.chat.files(match[2]);
    if (compose && compose.buffer === buffer) {
      compose = { ...compose, suggestions: files, index: 0 };
      paint();
    }
  } catch (error) {
    note(error.message);
  }
}

function completeMention() {
  if (!compose?.suggestions?.length) return;
  const path = compose.suggestions[compose.index % compose.suggestions.length];
  compose = {
    ...compose,
    buffer: compose.buffer.replace(/@[^\s]*$/, `@${path} `),
    suggestions: [],
    index: 0,
  };
}

async function submitCompose() {
  const text = compose.buffer.trim();
  if (text === "") return;
  if (text.startsWith("/")) {
    const known = chat.known ?? await state.agents();
    const result = await runChatCommand(text, {
      choice: chat.choice,
      known,
      config: state.config,
      policy: new PolicyEngine(state.config.policy),
      root: state.root,
      sessionId: chat.sessionId,
      undo: () => state.chat.undo(chat.sessionId),
      compact: () => state.chat.compact(chat.sessionId, chat.choice),
    });
    chat.notes = result.lines.flatMap((line) => String(line).split("\n"));
    if (result.action === "clear") resetChat();
    if (result.action === "exit") {
      chat.notes = ["q leaves the interface; enter writes another message."];
      compose = undefined;
      return;
    }
    compose = { ...compose, buffer: "", suggestions: [], index: 0, error: undefined };
    return;
  }
  try {
    const { model, provider, effort, agent } = chat.choice;
    const started = await state.chat.send({ sessionId: chat.sessionId, text, agent, model, provider, effort });
    chat.sessionId = started.sessionId;
    chat.pending = { text, attached: started.attached ?? [], refused: started.refused ?? [], since: chat.turns.length };
    chat.running = true;
    chat.notes = [];
    chat.scroll = 0;
    // Out of the message line, so the keys that answer the agent work: a
    // decision cannot be given while every letter is going into a message.
    compose = undefined;
  } catch (error) {
    // Kept in the line: a message the server refused is not a message lost.
    compose = { ...compose, error: error.message };
  }
}

function resetChat() {
  chat.sessionId = undefined;
  chat.turns = [];
  chat.compactions = [];
  chat.pending = undefined;
  chat.running = false;
  chat.scroll = 0;
}

async function syncChat() {
  const session = await state.chat.read(chat.sessionId);
  chat.turns = session.turns ?? [];
  chat.compactions = session.compactions ?? [];
  chat.running = session.running === true;
  chat.partial = session.partial ?? "";
  if (chat.pending && chat.turns.length > chat.pending.since) chat.pending = undefined;
  // A turn that ended without a record must not hang as though it were being
  // answered: after a few quiet seconds it says so.
  if (chat.pending && !chat.running) {
    chat.pending.idleSince ??= now();
    if (now() - chat.pending.idleSince > 4000) chat.pending.lost = true;
  }
}

function stopTurn() {
  if (!chat.sessionId) return;
  note(state.chat.stop(chat.sessionId) > 0 ? "Stopped." : "Nothing is running here.");
}

  return {
    chat,
    get compose() { return compose; },
    prepare: prepareChat,
    startCompose,
    composeKey,
    submit: submitCompose,
    reset: resetChat,
    sync: syncChat,
    stop: stopTurn,
  };
}
