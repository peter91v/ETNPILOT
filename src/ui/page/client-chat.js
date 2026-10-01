// The Chat view: a conversation with an agent, in the page.
// Client-side code, kept as text and joined by ../page.js into one script. It
// is not a module in the browser: no imports, no build step.
//
// Everything here is a view of what the server keeps. The conversation is the
// session file and the receipts of its turns; a question from the agent is an
// approval in the same inbox the Approvals view reads, shown here where it is
// asked. Nothing about a turn is decided in the browser.
import { parseMarkdown } from "../markdown.js";

export const CLIENT_CHAT = `${parseMarkdown.toString()}

let chatBuilt = false;
let chatSession;
let chatTurns = [];
let chatCompactions = [];
// What the model has written of the answer so far, when its provider streams.
let chatPartial = "";
let chatRunning = false;
// The message just sent, shown at once and until the server's record of the
// turn arrives. { text, attached, refused, since } or undefined.
let chatPending;
let chatSessions = [];
let chatMention;
let chatMentionTimer;
let chatSignature;
let chatApprovalSignature;

function chatControl(id) { return document.getElementById(id); }

function buildChat() {
  const host = $("view-chat");
  host.replaceChildren();
  chatBuilt = true;

  const thread = el("div", { class: "chat-thread", attrs: { id: "chat-thread", role: "log", "aria-live": "polite", "aria-label": "Conversation" } });
  const approvals = el("div", { class: "chat-approvals", attrs: { id: "chat-approvals" } });
  const history = el("select", { class: "inline", attrs: { id: "chat-history", "aria-label": "Conversation" } });
  history.addEventListener("change", () => {
    if (history.value === "") return startNewChat();
    chatSession = history.value;
    chatTurns = [];
    chatPending = undefined;
    void syncChat();
  });
  const fresh = button("New conversation", { class: "btn tonal", onClick: startNewChat });
  const undo = button("Undo last turn", {
    class: "btn small",
    title: "Put back the files the last turn changed. A file you changed since is left alone.",
    onClick: () => void undoChat(),
  });
  const compact = button("Compact", {
    class: "btn small",
    title: "Carry the older turns as a summary the model writes. Asks the model once; the turns stay on disk.",
    onClick: () => void compactChat(),
  });
  const head = el("div", { class: "row chat-head" }, [history, fresh, undo, compact, el("span", { class: "muted", attrs: { id: "chat-note" } })]);

  const agent = el("select", { class: "inline", attrs: { id: "chat-agent", "aria-label": "Agent" } });
  const provider = el("select", { class: "inline", attrs: { id: "chat-provider", "aria-label": "Provider" } });
  const model = el("input", {
    class: "inline",
    attrs: { id: "chat-model", "aria-label": "Model", placeholder: "model (the agent's own)", list: "chat-models", autocomplete: "off" },
  });
  const models = el("datalist", { attrs: { id: "chat-models" } });
  const fetchModels = button("Models", {
    class: "btn small",
    title: "Ask the provider which models it offers",
    onClick: () => void loadChatModels(),
  });
  const effort = el("select", { class: "inline", attrs: { id: "chat-effort", "aria-label": "Thinking effort" } }, [
    el("option", { text: "effort: the agent's own", attrs: { value: "" } }),
    ...["low", "medium", "high"].map((level) => el("option", { text: "effort: " + level, attrs: { value: level } })),
  ]);

  const text = el("textarea", {
    attrs: {
      id: "chat-text",
      rows: "3",
      "aria-label": "Message",
      placeholder: "Message. @ attaches a file. Enter sends, Shift+Enter adds a line.",
    },
  });
  text.addEventListener("input", () => scheduleMention());
  text.addEventListener("keydown", chatKey);
  text.addEventListener("blur", () => setTimeout(closeMention, 150));

  const attach = button("@ File", { class: "btn small", title: "Attach a file of this project", onClick: () => {
    text.focus();
    const at = text.selectionStart ?? text.value.length;
    text.setRangeText(at > 0 && !/\\s$/.test(text.value.slice(0, at)) ? " @" : "@", at, at, "end");
    scheduleMention();
  } });
  const sendButton = button("Send", { class: "btn primary", onClick: () => void sendChat() });
  sendButton.id = "chat-send";
  const stopButton = button("Stop", { class: "btn danger", onClick: () => void stopChat() });
  stopButton.id = "chat-stop";
  stopButton.hidden = true;

  // Behind a disclosure: four controls open all the time would take the
  // conversation's place on a phone, and most messages change none of them.
  const controls = el("details", { class: "composer-options" }, [
    el("summary", { text: "Agent, model and effort" }),
    el("div", { class: "composer-controls" }, [agent, provider, model, fetchModels, models, effort]),
  ]);
  const actions = el("div", { class: "composer-controls" }, [attach, el("span", { class: "grow" }), stopButton, sendButton]);
  const mentions = el("div", { class: "mention-list", attrs: { id: "chat-mentions", role: "listbox", "aria-label": "Files" } });
  mentions.hidden = true;
  const composer = el("div", { class: "composer" }, [mentions, text, controls, actions]);

  host.append(el("div", { class: "chat" }, [panel("Conversation", { meta: head, body: [thread] }), approvals, composer]));
  void loadChatChoices();
  void loadChatSessions();
  // While a turn runs the answer may be forming: read it once a second rather
  // than on the page's slower beat.
  setInterval(() => { if (view === "chat" && chatSession && (chatRunning || chatPending)) void syncChat(); }, 1000);
}

async function loadChatChoices() {
  try {
    agents = await api("/api/agents");
  } catch (error) {
    agents = { agents: [], error: error.message };
  }
  const agent = chatControl("chat-agent");
  const provider = chatControl("chat-provider");
  if (!agent || !provider) return;
  const keep = agent.value;
  agent.replaceChildren(el("option", { text: "agent: the project's default", attrs: { value: "" } }));
  for (const entry of agents.agents ?? []) {
    if (entry.error) continue;
    agent.append(el("option", { text: "agent: " + entry.name, attrs: { value: entry.name, title: entry.description ?? "" } }));
  }
  agent.value = keep;
  provider.replaceChildren(el("option", { text: "provider: the agent's own", attrs: { value: "" } }));
  for (const name of agents.providers ?? []) provider.append(el("option", { text: "provider: " + name, attrs: { value: name } }));
}

async function loadChatSessions() {
  try {
    chatSessions = (await api("/api/chat/sessions")).sessions;
  } catch {
    chatSessions = [];
  }
  const history = chatControl("chat-history");
  if (!history) return;
  history.replaceChildren(el("option", { text: chatSession ? "Switch conversation…" : "Earlier conversations…", attrs: { value: "" } }));
  for (const entry of chatSessions) {
    const label = entry.turns + " · " + (entry.preview || entry.id);
    history.append(el("option", { text: label, attrs: { value: entry.id } }));
  }
  history.value = chatSession && chatSessions.some((entry) => entry.id === chatSession) ? chatSession : "";
}

async function loadChatModels() {
  const provider = chatControl("chat-provider").value
    || (agents.agents ?? []).find((entry) => entry.name === (chatControl("chat-agent").value || agents.defaultAgent))?.provider;
  if (!provider) return toast("Choose a provider first.", "bad");
  try {
    const result = await api("/api/providers/" + encodeURIComponent(provider) + "/models");
    const list = chatControl("chat-models");
    list.replaceChildren();
    if (!result.available) return toast(result.reason ?? "That provider offers no list.", "bad");
    for (const entry of result.models) list.append(el("option", { attrs: { value: entry.id } }));
    toast(result.models.length + " models from " + provider + ".");
  } catch (error) {
    toast(error.message, "bad");
  }
}

function startNewChat() {
  chatSession = undefined;
  chatTurns = [];
  chatCompactions = [];
  chatPending = undefined;
  chatRunning = false;
  void loadChatSessions();
  renderChat();
  chatControl("chat-text")?.focus();
}

// --- sending

async function sendChat() {
  const text = chatControl("chat-text");
  const message = text.value.trim();
  if (message === "" || chatRunning) return;
  const body = { text: message, sessionId: chatSession };
  for (const [field, id] of [["agent", "chat-agent"], ["provider", "chat-provider"], ["model", "chat-model"], ["effort", "chat-effort"]]) {
    const value = chatControl(id).value.trim();
    if (value !== "") body[field] = value;
  }
  chatControl("chat-send").disabled = true;
  try {
    const started = await api("/api/chat/send", { method: "POST", body: JSON.stringify(body) });
    chatSession = started.sessionId;
    chatPending = { text: message, attached: started.attached ?? [], refused: started.refused ?? [], since: chatTurns.length };
    chatRunning = true;
    text.value = "";
    clearError();
    renderChat();
    void loadChatSessions();
    void refresh({ force: true });
  } catch (error) {
    // Kept in the box: a message the server refused is not a message lost.
    fail(error);
    toast(error.message, "bad");
  } finally {
    chatControl("chat-send").disabled = false;
  }
}

async function undoChat() {
  if (!chatSession) return toast("There is no conversation yet.", "bad");
  try {
    const result = await api("/api/chat/undo", { method: "POST", body: JSON.stringify({ sessionId: chatSession }) });
    toast(result.message, result.ok ? "ok" : "bad");
    await syncChat();
  } catch (error) {
    toast(error.message, "bad");
  }
}

async function compactChat() {
  if (!chatSession) return toast("There is no conversation yet.", "bad");
  const body = { sessionId: chatSession };
  for (const [field, id] of [["agent", "chat-agent"], ["provider", "chat-provider"], ["model", "chat-model"], ["effort", "chat-effort"]]) {
    const value = chatControl(id).value.trim();
    if (value !== "") body[field] = value;
  }
  try {
    const result = await api("/api/chat/compact", { method: "POST", body: JSON.stringify(body) });
    toast(result.message, result.ok ? "ok" : "bad");
    void refresh({ force: true });
  } catch (error) {
    toast(error.message, "bad");
  }
}

async function stopChat() {
  if (!chatSession) return;
  try {
    const result = await api("/api/chat/stop", { method: "POST", body: JSON.stringify({ sessionId: chatSession }) });
    toast(result.stopped > 0 ? "Stopped." : "Nothing was running.");
  } catch (error) {
    toast(error.message, "bad");
  }
}

// Read the conversation from the server: what the poll does while this view is open.
async function syncChat() {
  if (!chatSession) return renderChat();
  try {
    const session = await api("/api/chat/session?id=" + encodeURIComponent(chatSession));
    chatTurns = session.turns ?? [];
    chatCompactions = session.compactions ?? [];
    chatRunning = session.running === true;
    chatPartial = session.partial ?? "";
    if (chatPending && chatTurns.length > chatPending.since) chatPending = undefined;
    // A turn that ended without a record (the run could not even start) must
    // not leave the message hanging as though it were still being answered.
    if (chatPending && !chatRunning && Date.now() - (chatPending.startedAt ??= Date.now()) > 4000) {
      chatPending.lost = true;
    }
  } catch (error) {
    fail(error);
  }
  renderChat();
}

// --- files

function currentMention() {
  const text = chatControl("chat-text");
  const caret = text.selectionStart ?? text.value.length;
  const match = /(^|\\s)@([^\\s]*)$/.exec(text.value.slice(0, caret));
  return match ? { query: match[2], from: caret - match[2].length - 1, to: caret } : undefined;
}

function scheduleMention() {
  clearTimeout(chatMentionTimer);
  chatMentionTimer = setTimeout(async () => {
    const found = currentMention();
    if (!found) return closeMention();
    try {
      const result = await api("/api/chat/files?q=" + encodeURIComponent(found.query));
      chatMention = { ...found, files: result.files, index: 0 };
      renderMention();
    } catch {
      closeMention();
    }
  }, 120);
}

function renderMention() {
  const list = chatControl("chat-mentions");
  list.replaceChildren();
  if (!chatMention || chatMention.files.length === 0) {
    list.hidden = true;
    return;
  }
  chatMention.files.forEach((path, index) => {
    const item = button(path, { class: "mention-item mono", onClick: () => pickMention(index) });
    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", index === chatMention.index ? "true" : "false");
    // The text box keeps focus: choosing a file must not take the caret away.
    item.addEventListener("mousedown", (event) => event.preventDefault());
    list.append(item);
  });
  list.hidden = false;
}

function closeMention() {
  chatMention = undefined;
  const list = chatControl("chat-mentions");
  if (list) list.hidden = true;
}

function pickMention(index) {
  if (!chatMention) return;
  const text = chatControl("chat-text");
  const path = chatMention.files[index];
  text.setRangeText("@" + path + " ", chatMention.from, chatMention.to, "end");
  closeMention();
  text.focus();
}

function chatKey(event) {
  if (chatMention && !chatControl("chat-mentions").hidden) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const count = chatMention.files.length;
      chatMention.index = (chatMention.index + (event.key === "ArrowDown" ? 1 : count - 1)) % count;
      renderMention();
      return;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      pickMention(chatMention.index);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeMention();
      return;
    }
  }
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    void sendChat();
  }
}

// --- drawing

function message(who, text, { tone = "", meta, extra = [], markdown = false } = {}) {
  const said = markdown ? renderMarkdown(text) : el("p", { class: "said", text });
  return el("div", { class: "msg " + tone }, [
    el("span", { class: "who", text: who }),
    said,
    ...extra,
    ...(meta ? [el("span", { class: "meta", text: meta })] : []),
  ]);
}

// A reply as the structure parseMarkdown found in it, built from text nodes and
// elements only. A link opens in a new tab and carries no opener.
function markdownInline(nodes) {
  return nodes.map((node) => {
    if (node.code !== undefined) return el("code", { text: node.code });
    if (node.bold) return el("strong", {}, markdownInline(node.bold));
    if (node.italic) return el("em", {}, markdownInline(node.italic));
    if (node.link) {
      return el("a", { attrs: { href: node.link, target: "_blank", rel: "noopener noreferrer" } }, markdownInline(node.children));
    }
    return document.createTextNode(node.text);
  });
}

function renderMarkdown(text) {
  const body = el("div", { class: "said md" });
  for (const block of parseMarkdown(text)) {
    if (block.type === "code") body.append(el("pre", { attrs: block.language ? { "data-language": block.language } : {} }, [el("code", { text: block.text })]));
    else if (block.type === "heading") body.append(el("h" + Math.min(6, block.level + 2), {}, markdownInline(block.children)));
    else if (block.type === "list") body.append(el(block.ordered ? "ol" : "ul", {}, block.items.map((item) => el("li", {}, markdownInline(item)))));
    else if (block.type === "quote") body.append(el("blockquote", {}, markdownInline(block.children)));
    else body.append(el("p", {}, markdownInline(block.children)));
  }
  return body;
}

// What the agent did, from the record and not from its own account of it. A
// refusal by policy shows here even when the reply says only that it could not.
function callChips(calls = []) {
  if (calls.length === 0) return [];
  return [el("div", { class: "attach-row calls" }, calls.map((call) => pill(
    (call.ok ? "did " : call.refused ? "refused " : "failed ") + call.label + (call.ok ? "" : " — " + (call.error ?? "no reason recorded")),
    call.ok ? "" : "warn",
  )))];
}

function attachmentChips(files, refused = []) {
  const chips = files.map((file) => pill(
    file.path + (file.kind === "directory" ? "/" : "") + (file.truncated ? " (cut)" : ""),
    "ok",
  ));
  for (const entry of refused) chips.push(pill(entry.path + " — not attached: " + entry.reason, "warn"));
  return chips.length > 0 ? [el("div", { class: "attach-row" }, chips)] : [];
}

function renderChat() {
  if (!chatBuilt) buildChat();
  const thread = chatControl("chat-thread");
  const approvals = chatControl("chat-approvals");
  if (!thread || !approvals) return;

  // Redrawn only when it changed: the poll runs every few seconds, and a
  // conversation being read or selected must not be rebuilt under the reader.
  const signature = JSON.stringify([chatSession, chatTurns.length, chatCompactions.length, chatTurns.at(-1)?.status, Boolean(chatPending), chatPending?.lost, chatRunning, chatPartial.length]);
  if (signature !== chatSignature) {
    chatSignature = signature;
    drawThread(thread);
  }

  // The questions this project's runs are asking, here where they are asked.
  // Not rebuilt while a decision is being typed.
  const pending = state?.approvals?.pending ?? [];
  const approvalSignature = (chatRunning || chatPending ? pending : []).map((entry) => entry.id).join(",");
  if (approvalSignature !== chatApprovalSignature && !busy()) {
    chatApprovalSignature = approvalSignature;
    approvals.replaceChildren();
    if (approvalSignature !== "") {
      approvals.append(el("p", { class: "muted", text: pending.length === 1 ? "The agent is waiting for you:" : pending.length + " decisions are waiting for you:" }));
      for (const approval of pending) approvals.append(approvalCard(approval));
    }
  }

  chatControl("chat-stop").hidden = !(chatRunning || chatPending);
  chatControl("chat-text").closest(".composer").classList.toggle("waiting", Boolean(chatRunning || chatPending));
  chatControl("chat-note").textContent = chatSession ? chatSession : "";
}

function drawThread(thread) {
  thread.replaceChildren();
  if (chatTurns.length === 0 && !chatPending) {
    thread.append(el("p", { class: "empty", text: "Say what you want done. The agent works in this project's directory, and every write and command still asks you first." }));
  }
  for (const turn of chatTurns) {
    thread.append(message("You", turn.input, { tone: "you", extra: attachmentChips(turn.attachments ?? []) }));
    if (turn.status === "succeeded") {
      thread.append(message(turn.agent ?? "agent", turn.reply ?? "", {
        tone: "agent",
        markdown: true,
        extra: callChips(turn.calls),
        meta: (turn.undone ? "undone · " : "") + "turn " + turn.turn + (turn.runId ? " · run " + turn.runId.slice(0, 8) : "") + (turn.usage ? " · " + (turn.usage.inputTokens + turn.usage.outputTokens) + " tokens" : "") + (turn.historyOmitted ? " · " + turn.historyOmitted + " earlier exchange(s) left out" : ""),
      }));
    } else {
      thread.append(message(turn.agent ?? "agent", turn.error ?? "The turn ended " + turn.status + ".", { tone: "failed", meta: "turn " + turn.turn + " · " + turn.status }));
    }
    const summary = chatCompactions.find((entry) => entry.upToTurn === turn.turn);
    if (summary) thread.append(el("p", { class: "muted chat-rule", text: "Turns up to " + summary.upToTurn + " are carried as a summary from here on." }));
  }
  if (chatPending) {
    thread.append(message("You", chatPending.text, { tone: "you", extra: attachmentChips(chatPending.attached, chatPending.refused) }));
    thread.append(chatPending.lost
      ? message("agent", "This turn left no record. Check Runs for why it stopped.", { tone: "failed" })
      : chatPartial !== ""
        ? message("agent", chatPartial, { tone: "agent", markdown: true, meta: "writing…" })
        : message("agent", "Working…", { tone: "agent", meta: "waiting for the agent" }));
  }

  const last = thread.lastElementChild;
  if (last && (chatRunning || chatPending)) last.scrollIntoView({ block: "nearest" });
}
`;
