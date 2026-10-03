// Drafting an agent, skill, instruction or a better prompt with a model's
// help. The page shows the draft (or a diff) first; accepting it asks the
// server to write that draft by its id, so the page never sends text to be
// written. Nothing is written without the click.

const authorState = { open: false, mode: "new", kind: "agent", name: "", names: undefined, request: "", change: "", whole: false, busy: false, draft: undefined, error: undefined, last: undefined };

function authorPanel() {
  const s = authorState;
  if (!s.open) {
    return panel("Draft with AI", {
      meta: button("Open", { class: "btn tonal", onClick: () => { s.open = true; render(); void loadLastWrite(); } }),
      body: [el("p", { class: "muted", text: "Describe an agent, skill or instruction, or what to change in an existing prompt, and a model drafts it. You read it before anything is written." })],
    });
  }
  const kinds = s.mode === "new" ? ["agent", "skill", "instruction", "prompt"] : ["agent", "prompt", "skill", "instruction"];
  if (!kinds.includes(s.kind)) s.kind = kinds[0];
  if (s.mode === "improve" && s.names === undefined) loadAuthorNames();
  const body = [
    selectField("author-mode", "What do you want", s.mode, [["new", "Something new"], ["improve", "Improve an existing one"]], (value) => { s.mode = value; s.draft = undefined; s.names = undefined; s.name = ""; render(); }),
    selectField("author-kind", "Kind", s.kind, kinds.map((kind) => [kind, kind]), (value) => { s.kind = value; s.draft = undefined; s.names = undefined; s.name = ""; render(); }),
    ...(s.mode === "improve" ? [existingPicker()] : []),
    field("author-request", s.mode === "new" ? "What should it do" : "What should change", s.request, (value) => { s.request = value; }, ""),
    el("div", { class: "card-actions" }, [
      button(s.busy ? "Drafting…" : "Draft it", { class: "btn", disabled: s.busy, onClick: requestDraft }),
      button("Close", { class: "btn", onClick: () => { s.open = false; s.draft = undefined; render(); } }),
    ]),
  ];
  if (s.last && !s.draft) {
    body.push(el("div", { class: "row" }, [
      el("span", { class: "muted grow", text: "Last written: " + s.last.label + " (" + s.last.paths.join(", ") + ")" }),
      button("Undo", { class: "btn small", disabled: s.busy, title: "Put back what that write replaced. A file changed since is left alone and nothing is undone.", onClick: undoWrite }),
    ]));
  }
  if (s.error) body.push(el("p", { class: "notice bad", attrs: { role: "alert" }, text: s.error }));
  if (s.draft) body.push(...draftView(s.draft));
  return panel("Draft with AI", { open: true, body });
}

// Which existing one: chosen from what is there, not typed.
function existingPicker() {
  const s = authorState;
  const label = { agent: "Which agent", prompt: "Which prompt", skill: "Which skill" }[s.kind] ?? "Which instruction";
  if (s.names === undefined || s.names === null) return el("p", { class: "muted", text: "Reading what exists…" });
  if (s.names.length === 0) return el("p", { class: "muted", text: "There is nothing of this kind to improve yet." });
  if (!s.names.includes(s.name)) s.name = s.names[0];
  return selectField("author-name", label, s.name, s.names.map((name) => [name, name]), (value) => { s.name = value; });
}

async function loadAuthorNames() {
  const s = authorState;
  s.names = null;
  try {
    s.names = (await api("/api/author/items", { method: "POST", body: JSON.stringify({ kind: s.kind }) })).names;
  } catch (error) {
    s.names = [];
    s.error = error.message;
  }
  render();
}

function draftView(draft) {
  const who = draft.provider ? "Drafted with " + draft.provider.name + (draft.provider.model ? " (" + draft.provider.model + ")" : "") + "." : "";
  const parts = [el("p", { class: "muted", text: who })];
  if (draft.provider?.preferred) parts.push(el("p", { class: "muted", text: "forge.provider is " + draft.provider.preferred + ", which has no key here." }));
  if (draft.mode === "new") {
    parts.push(el("pre", { class: "mono draft", text: draft.preview.join("\n") }));
    for (const note of draft.notes) parts.push(el("p", { class: "muted", text: note }));
    parts.push(el("pre", { class: "mono draft", text: draft.text }));
  } else {
    parts.push(el("p", { text: draft.path + (draft.summary ? " — " + draft.summary : "") }));
    parts.push(el("pre", { class: "mono draft", text: draft.diff.join("\n") }));
    parts.push(checkField("author-whole", "Show the whole new text", authorState.whole, (on) => { authorState.whole = on; render(); }));
    if (authorState.whole) for (const file of draft.files) parts.push(el("p", { class: "muted mono", text: file.path }), el("pre", { class: "mono draft", text: file.text }));
  }
  // Not what was wanted? Say what to change; the draft is made again from it.
  parts.push(field("author-change", "Change something about the draft", authorState.change, (value) => { authorState.change = value; }, "e.g. shorter, or read-only"));
  parts.push(el("div", { class: "card-actions" }, [button("Change the draft", { class: "btn tonal", disabled: authorState.busy, onClick: refineDraftOnPage })]));
  parts.push(el("div", { class: "card-actions" }, [
    button("Write this", { class: "btn", disabled: authorState.busy, onClick: acceptDraft }),
    button("Discard", { class: "btn", onClick: discardDraft }),
  ]));
  return parts;
}

async function requestDraft() {
  const s = authorState;
  s.busy = true; s.error = undefined; s.draft = undefined;
  render();
  try {
    s.draft = await api("/api/author/draft", { method: "POST", body: JSON.stringify({ mode: s.mode, kind: s.kind, name: s.name, request: s.request }) });
  } catch (error) {
    s.error = error.message;
  } finally {
    s.busy = false;
    render();
  }
}

async function acceptDraft() {
  const s = authorState;
  s.busy = true; render();
  try {
    const result = await api("/api/author/apply", { method: "POST", body: JSON.stringify({ id: s.draft.id }) });
    authorState.last = result.undoable ? await api("/api/author").then((info) => info.last ?? undefined, () => undefined) : undefined;
    for (const path of result.written) toast("Wrote " + path + ". It is not reviewed yet: read it, then lock it under Content.");
    for (const skipped of result.skipped) toast("Skipped " + skipped.name + ": " + skipped.reason + ".", "warn");
    s.draft = undefined; s.request = "";
    await refresh({ force: true });
  } catch (error) {
    s.error = error.message;
  } finally {
    s.busy = false;
    render();
  }
}

async function refineDraftOnPage() {
  const s = authorState;
  if (s.change.trim() === "") { s.error = "Say what should be different about the draft."; render(); return; }
  s.busy = true; s.error = undefined;
  render();
  try {
    s.draft = await api("/api/author/refine", { method: "POST", body: JSON.stringify({ id: s.draft.id, request: s.change }) });
    s.change = "";
  } catch (error) {
    s.error = error.message;
  } finally {
    s.busy = false;
    render();
  }
}

async function undoWrite() {
  const s = authorState;
  s.busy = true; s.error = undefined;
  render();
  try {
    const result = await api("/api/author/undo", { method: "POST", body: JSON.stringify({}) });
    toast("Took back " + result.label + ": " + [...result.restored, ...result.removed].join(", ") + ".");
    s.last = (await api("/api/author")).last ?? undefined;
    await refresh({ force: true });
  } catch (error) {
    s.error = error.message;
  } finally {
    s.busy = false;
    render();
  }
}

async function discardDraft() {
  const id = authorState.draft?.id;
  authorState.draft = undefined;
  render();
  if (id) api("/api/author/discard", { method: "POST", body: JSON.stringify({ id }) }).catch(() => {});
}

async function loadLastWrite() {
  try {
    authorState.last = (await api("/api/author")).last ?? undefined;
  } catch {
    authorState.last = undefined;
  }
  render();
}
