import { screen, shortId } from "./ansi.js";
import { parseSettingValue } from "../config/settings.js";
import { clamp, flattenAgents, mergeEntries, renderApp, settingEntries, settingLiteral, settingValue, viewList } from "./render.js";

const VIEWS = viewList();

// The interactive half: keys in, repaints out. It owns no knowledge of what a
// screen looks like — that lives in the pure renderers — and no knowledge of
// where state comes from, which lives in the shared project state.
export function createTuiApp({
  state,
  output = process.stdout,
  input = process.stdin,
  pollIntervalMs = 1000,
  worktreeIntervalMs = 5000,
  actor = process.env.USER ?? "tui",
  now = Date.now,
} = {}) {
  if (!state) throw new TypeError("The TUI requires an open project state.");
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 50) {
    throw new TypeError("pollIntervalMs must be at least 50.");
  }

  let snapshot = { approvals: { pending: [], recent: [] }, queue: { counts: {}, jobs: [] }, runs: [] };
  let view = "approvals";
  let cursor = 0;
  let detail = false;
  let message;
  let editor;
  let filtering = false;
  let filter = "";
  let scope = "local";
  let prompt;
  let help = false;
  let helpOffset = 0;
  let receipt;
  let worktrees;
  let worktreeChanges;
  let changeCursor = 0;
  let worktreeDiff;
  let diffOffset = 0;
  // Reading one agent's full reasoning, inside an open run: 'agentMode'
  // selects a row in the tree, 'agentText' is the one currently open.
  let agentMode = false;
  let agentCursor = 0;
  let agentText;
  let agentTextOffset = 0;
  let worktreesReadAt = 0;
  let merges;
  // The checks are listed from the registry once; what each one found is kept
  // per check, so a result stays on screen until it is run again. Nothing here
  // is ever run by the poll — 'scan secrets' reads the whole working tree.
  const checks = state.checks?.() ?? [];
  const checkResults = {};
  const checksRunning = new Set();
  // Whether the open receipt verifies. Read when asked, next to the receipt it
  // is about, and cleared when another run is opened.
  let verification;
  let messageTimer;
  let timer;
  let stopped = false;
  let onExit;

  const app = {
    get view() { return view; },
    get cursor() { return cursor; },
    get detail() { return detail; },
    get snapshot() { return snapshot; },
    get message() { return message; },
    get editor() { return editor; },
    get filter() { return filter; },
    get filtering() { return filtering; },
    get scope() { return scope; },
    get prompt() { return prompt; },
    get help() { return help; },
    get helpOffset() { return helpOffset; },
    get receipt() { return receipt; },
    get worktrees() { return worktrees; },
    get worktreeChanges() { return worktreeChanges; },
    get worktreeDiff() { return worktreeDiff; },
    get agentMode() { return agentMode; },
    get agentText() { return agentText; },
    get merges() { return merges; },
    get checks() { return checks; },
    get checkResults() { return checkResults; },
    get verification() { return verification; },
    // What is running is tracked in the shared state, because the page needs
    // the same answer; this is a view of it, not a second copy.
    get active() { return snapshot.active ?? []; },

    async refresh() {
      snapshot = await state.collect();
      cursor = clamp(cursor, selection().length);
      // The worktrees are local but not free — one 'git status' each — so they
      // are reread while their view is open and not more often than that.
      if (view === "worktrees" && now() - worktreesReadAt > worktreeIntervalMs) await load("worktrees", { force: true });
      return snapshot;
    },

    frame() {
      return renderApp(snapshot, {
        view,
        cursor,
        detail,
        message,
        // A pty reports 0×0 before its first resize event lands — a real
        // sequence on Android terminal apps, and '?? 100' does not catch 0,
        // which is falsy but not nullish. Rendering at that size draws
        // nothing at all, silently, with no error to say why.
        width: output.columns || 100,
        height: output.rows || 30,
        color: output.isTTY === true && !process.env.NO_COLOR,
        now: now(),
        editor,
        filter,
        filtering,
        scope,
        prompt,
        help,
        helpOffset,
        receipt,
        worktrees,
        worktreeChanges,
        changeCursor,
        worktreeDiff,
        diffOffset,
        agentMode,
        agentCursor,
        agentText,
        agentTextOffset,
        merges,
        checks,
        checkResults,
        checksRunning,
        verification,
        active: snapshot.active ?? [],
        project: state.config?.git?.project ?? "",
      });
    },

    paint() {
      output.write(screen.home + app.frame().map((line) => line + screen.eraseLine).join("\n"));
    },

    // Returns true while the app should keep running.
    async handle(key) {
      // While text is being typed, every printable key belongs to the buffer.
      // Only then do the single-letter commands mean anything again.
      if (editor) {
        await editKey(key);
        app.paint();
        return true;
      }
      if (filtering) {
        filterKey(key);
        app.paint();
        return true;
      }
      if (prompt) {
        await promptKey(key);
        app.paint();
        return true;
      }
      if (key === "q" || key === "\u0003") return false;
      if (help) {
        if (key === "?" || key === "\u001B") help = false;
        else if (key === "\u001B[B" || key === "j") helpOffset += 1;
        else if (key === "\u001B[A" || key === "k") helpOffset = Math.max(0, helpOffset - 1);
        app.paint();
        return true;
      }
      if (key === "?") {
        help = true;
        helpOffset = 0;
        app.paint();
        return true;
      }
      if (key === "n") {
        // An empty agent field runs whatever the project runs by itself, so
        // the prompt names those steps rather than leaving a blank.
        const steps = (state.config?.workflow?.steps ?? []).map((step) => step.id ?? step.agent).filter(Boolean);
        prompt = { buffer: "", agent: "", field: "task", steps };
        app.paint();
        return true;
      }
      if (key === "\t") {
        show(VIEWS[(VIEWS.indexOf(view) + 1) % VIEWS.length]);
      } else if (/^[1-9]$/.test(key) && Number(key) <= VIEWS.length) {
        show(VIEWS[Number(key) - 1]);
      } else if (view === "checks" && key === "A") {
        await runChecks(checks.map((check) => check.id));
      } else if (key === "x" && view === "worktrees") {
        await removeWorktree();
      } else if (view === "settings" && key === "/") {
        filtering = true;
      } else if (view === "settings" && (key === "\r" || key === "\n")) {
        openEditor();
      } else if (view === "settings" && key === "d") {
        await resetSetting();
      } else if (view === "settings" && key === "s") {
        scope = scope === "local" ? "global" : "local";
        note(`Changes will be written ${scope === "global" ? "to ~/.config, for every project" : "to this project, locally"}.`);
      } else if (key === "\u001B[B" || key === "j") {
        if (agentText) agentTextOffset += 1;
        else if (agentMode) agentCursor = clamp(agentCursor + 1, agentRows().length);
        else if (worktreeDiff) diffOffset += 1;
        else if (detail && view === "worktrees") changeCursor = clamp(changeCursor + 1, changeCount());
        else cursor = clamp(cursor + 1, selection().length);
      } else if (key === "\u001B[A" || key === "k") {
        if (agentText) agentTextOffset = Math.max(0, agentTextOffset - 1);
        else if (agentMode) agentCursor = clamp(agentCursor - 1, agentRows().length);
        else if (worktreeDiff) diffOffset = Math.max(0, diffOffset - 1);
        else if (detail && view === "worktrees") changeCursor = clamp(changeCursor - 1, changeCount());
        else cursor = clamp(cursor - 1, selection().length);
      } else if (key === "\r" || key === "\n") {
        if (view === "checks") await runChecks([selection()[clamp(cursor, selection().length)]?.id]);
        else if (agentMode && !agentText) openAgentText();
        else if (view === "approvals" && selection().length > 0) detail = true;
        else if (view === "runs" && !detail && selection().length > 0) await openRun();
        else if (view === "worktrees" && detail && !worktreeDiff) await openFileDiff();
        else if (view === "worktrees" && selection().length > 0) await openWorktree();
      } else if (key === "\u001B") {
        if (agentText) {
          agentText = undefined;
          agentTextOffset = 0;
        } else if (agentMode) {
          agentMode = false;
        } else if (worktreeDiff) {
          worktreeDiff = undefined;
          diffOffset = 0;
        } else {
          detail = false;
          worktreeChanges = undefined;
        }
      } else if (key === "a" && detail && view === "runs" && !agentMode && agentRows().length > 0) {
        agentMode = true;
        agentCursor = 0;
      } else if (key === "a" || key === "r") {
        await decide(key === "a" ? "approved" : "rejected");
      } else if (key === "c" && view === "queue") {
        await cancel();
      } else if (key === "R" && view === "queue") {
        await resume();
      } else if (key === "g") {
        // 'g' means 'ask again now', including the two views that are read on
        // demand — the merge requests are never fetched behind your back.
        if (view === "worktrees" || view === "merges") await load(view, { force: true });
        await app.refresh();
      }
      app.paint();
      return true;
    },

    async start() {
      output.write(screen.enter + screen.clear);
      if (input.isTTY) {
        input.setRawMode(true);
        input.resume();
        input.setEncoding("utf8");
      }
      await app.refresh();
      app.paint();
      input.on("data", onData);
      output.on?.("resize", app.paint);
      timer = setInterval(() => {
        void app.refresh().then(app.paint).catch(report);
      }, pollIntervalMs);
      timer.unref?.();
      return new Promise((resolveExit) => { onExit = resolveExit; });
    },

    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      clearTimeout(messageTimer);
      // Quitting must not leave a run half-finished in a worktree nobody is
      // watching: each one is asked to stop, and its receipt records why.
      state.stopRuns();
      input.off("data", onData);
      output.off?.("resize", app.paint);
      if (input.isTTY) {
        input.setRawMode(false);
        input.pause();
      }
      output.write(screen.leave);
      onExit?.();
    },
  };

  function onData(chunk) {
    // A terminal delivers what it has, not one key at a time: typing quickly
    // or pasting a task arrives as a single chunk. Treating that chunk as one
    // key drops every character in it.
    void (async () => {
      for (const key of splitKeys(String(chunk))) {
        if (!await app.handle(key)) {
          app.stop();
          return;
        }
      }
    })().catch(report);
  }

  function selection() {
    if (view === "runs") return snapshot.runs ?? [];
    if (view === "queue") return snapshot.queue?.jobs ?? [];
    if (view === "worktrees") return worktrees?.entries ?? [];
    if (view === "merges") return mergeEntries(merges);
    if (view === "checks") return checks;
    if (view === "settings") return settingEntries(snapshot, { filter });
    return snapshot.approvals?.pending ?? [];
  }

  function show(next) {
    view = next;
    cursor = 0;
    detail = false;
    // A view that reads on demand starts empty and says it is reading, rather
    // than showing yesterday's answer or nothing at all.
    if ((view === "worktrees" || view === "merges") && (view === "merges" ? merges : worktrees) === undefined) {
      void load(view).then(app.paint, report);
    }
  }

  async function load(which, { force = false } = {}) {
    if (which === "worktrees") {
      if (worktrees !== undefined && !force) return;
      try {
        worktrees = await state.worktrees();
      } catch (error) {
        worktrees = { available: false, error: error.message, entries: [] };
      }
      if (worktreeChanges && !(worktrees.entries ?? []).some((entry) => entry.name === worktreeChanges.name)) {
        worktreeChanges = undefined;
        worktreeDiff = undefined;
        if (view === "worktrees") detail = false;
      }
      worktreesReadAt = now();
      cursor = clamp(cursor, selection().length);
      return;
    }
    if (merges !== undefined && !force) return;
    try {
      merges = await state.mergeRequests();
    } catch (error) {
      merges = { configured: true, available: false, error: error.message, entries: [] };
    }
    cursor = clamp(cursor, selection().length);
  }

  // A check is run because somebody asked for it, one at a time and in order,
  // and the screen repaints between them: 'scan secrets' walks the tree and
  // 'doctor' talks to a secret store, so pretending they are instant would
  // leave the interface frozen with no reason on screen.
  async function runChecks(ids) {
    for (const id of ids.filter(Boolean)) {
      checksRunning.add(id);
      app.paint();
      try {
        checkResults[id] = await state.runCheck(id);
      } catch (error) {
        // runCheck reports a broken check as a result; this is for the case
        // where reaching it at all failed.
        note(error.message);
      } finally {
        checksRunning.delete(id);
      }
      app.paint();
    }
  }

  // Removing a worktree is the one destructive thing this view can do, so it
  // goes through removeIfClean: unsaved work is reported, never discarded.
  async function removeWorktree() {
    const entry = selection()[clamp(cursor, selection().length)];
    if (!entry) return;
    if (!entry.managed || entry.main) {
      note(`${entry.name} is not a worktree ETNPilot made; remove it with git where you made it.`);
      return;
    }
    if (entry.locked !== undefined) {
      note(`${entry.name} is locked${entry.locked ? `: ${entry.locked}` : ""}; unlock it with 'git worktree unlock'.`);
      return;
    }
    try {
      const result = await state.removeWorktree(entry.name);
      note(result.removed
        ? `${entry.name} is gone; its branch ${entry.branch ?? ""} still exists.`.trim()
        : `${entry.name} keeps ${entry.blocking ?? "its"} unsaved change${entry.blocking === 1 ? "" : "s"} — nothing was removed.`);
    } catch (error) {
      note(error.message);
    }
    await load("worktrees", { force: true });
  }

  function openEditor() {
    const entry = selection()[clamp(cursor, selection().length)];
    if (!entry) return;
    if (entry.mode === "locked") {
      note(`${entry.path} is locked by the committed default; it can only change there.`);
      return;
    }
    editor = { entry, buffer: settingLiteral(entry.value), scope };
  }

  async function editKey(key) {
    if (key === "\u0003" || key === "\u001B") {
      editor = undefined;
      return;
    }
    // Where a setting accepts one of a list, the arrows step through it: the
    // terminal's answer to the page's dropdown.
    const choices = editor.entry.choices?.kind === "one" ? editor.entry.choices.values : undefined;
    if (choices && (key === "\u001B[C" || key === "\u001B[D")) {
      const literals = choices.map((value) => settingLiteral(value));
      const at = literals.indexOf(editor.buffer);
      const next = key === "\u001B[C"
        ? (at + 1) % literals.length
        : (at <= 0 ? literals.length - 1 : at - 1);
      editor = { ...editor, buffer: literals[next], error: undefined };
      return;
    }
    if (key === "\r" || key === "\n") return saveSetting();
    if (key === "\u0015") {
      editor = { ...editor, buffer: "" };
      return;
    }
    if (key === "\u007F" || key === "\b") {
      editor = { ...editor, buffer: editor.buffer.slice(0, -1) };
      return;
    }
    // Arrow keys and other escape sequences are not text.
    if (key.startsWith("\u001B") || key.length !== 1 || key < " ") return;
    editor = { ...editor, buffer: editor.buffer + key };
  }

  async function saveSetting() {
    const { entry, buffer } = editor;
    let value;
    try {
      value = parseSettingValue(buffer);
    } catch (error) {
      editor = { ...editor, error: `That is not valid YAML: ${error.message}` };
      return;
    }
    try {
      const result = await state.setSetting(entry.path, value, { scope: editor.scope });
      editor = undefined;
      note(result.restartRequired
        ? `${result.path} is saved, but this session already opened that file — restart to use it.`
        : `${result.path} is now ${settingValue(result.effective)} — ${result.scope}, and never committed.`);
    } catch (error) {
      // A refusal is shown where the change was made, not swallowed.
      editor = { ...editor, error: error.message };
      return;
    }
    await app.refresh();
  }

  async function resetSetting() {
    const entry = selection()[clamp(cursor, selection().length)];
    if (!entry) return;
    if (entry.source === "project") {
      note(`${entry.path} is already the committed default.`);
      return;
    }
    try {
      const result = await state.unsetSetting(entry.path, { scope: entry.source === "user-global" ? "global" : "local" });
      note(result.restartRequired
        ? `${result.path} is back to the committed default; restart to use it.`
        : `${result.path} is back to the committed default: ${settingValue(result.effective)}.`);
    } catch (error) {
      note(error.message);
    }
    await app.refresh();
  }

  async function openRun() {
    const run = selection()[clamp(cursor, selection().length)];
    if (!run) return;
    detail = true;
    receipt = undefined;
    agentMode = false;
    agentCursor = 0;
    agentText = undefined;
    agentTextOffset = 0;
    try {
      receipt = await state.readReceipt(run.receiptFile);
    } catch (error) {
      note(error.message);
      detail = false;
    }
  }

  // The same tree the run detail shows, flattened for the cursor to move
  // over — recomputed from whatever receipt is on screen, never cached, so it
  // never drifts from what the panel above it says.
  function agentRows() {
    return flattenAgents(receipt?.outcome?.agents ?? []);
  }

  // What 'enter' opens: the full text this agent invocation produced, already
  // sitting in the receipt this session has read — nothing more to fetch.
  function openAgentText() {
    const rows = agentRows();
    const row = rows[clamp(agentCursor, rows.length)];
    if (!row) return;
    agentText = row.node;
    agentTextOffset = 0;
  }

  // What a worktree holds is read when it is opened, not in the poll: it is
  // another 'git status', and only the one on screen is worth the cost.
  async function openWorktree() {
    const entry = selection()[clamp(cursor, selection().length)];
    if (!entry) return;
    detail = true;
    worktreeChanges = undefined;
    worktreeDiff = undefined;
    changeCursor = 0;
    try {
      worktreeChanges = await state.worktreeChanges(entry.name);
    } catch (error) {
      note(error.message);
      detail = false;
    }
  }

  function changeCount() {
    return worktreeChanges?.entries?.length ?? 0;
  }

  // The lines a file changed, read from the same worktree that reported it.
  async function openFileDiff() {
    const change = worktreeChanges?.entries?.[clamp(changeCursor, changeCount())];
    if (!change) return;
    diffOffset = 0;
    try {
      worktreeDiff = await state.worktreeDiff(worktreeChanges.name, change.path);
    } catch (error) {
      note(error.message);
    }
  }

  async function resume() {
    const job = selection()[clamp(cursor, selection().length)];
    if (!job) return;
    try {
      const result = state.resumeJob(job.id);
      note(`${result.id.slice(0, 8)} is ${result.status} again.`);
    } catch (error) {
      note(error.message);
    }
    await app.refresh();
  }

  async function promptKey(key) {
    if (key === "\u0003" || key === "\u001B") {
      prompt = undefined;
      return;
    }
    if (key === "\t") {
      prompt = { ...prompt, field: prompt.field === "task" ? "agent" : "task" };
      return;
    }
    if (key === "\r" || key === "\n") return startRun();
    const field = prompt.field === "agent" ? "agent" : "buffer";
    if (key === "\u0015") {
      prompt = { ...prompt, [field]: "" };
      return;
    }
    if (key === "\u007F" || key === "\b") {
      prompt = { ...prompt, [field]: prompt[field].slice(0, -1) };
      return;
    }
    if (key.startsWith("\u001B") || key.length !== 1 || key < " ") return;
    prompt = { ...prompt, [field]: prompt[field] + key };
  }

  async function startRun() {
    const { buffer, agent } = prompt;
    if (!buffer.trim()) {
      prompt = { ...prompt, error: "A run needs a task to work on." };
      return;
    }
    const task = buffer.trim();
    let started;
    try {
      started = state.startRun({ input: task, agent: agent.trim() || undefined });
    } catch (error) {
      prompt = { ...prompt, error: error.message };
      return;
    }
    prompt = undefined;
    note(`Started: ${task}. Its approvals will appear here.`);
    // The run proceeds while the screen keeps painting; it is not awaited, or
    // the interface would freeze exactly when it is needed to answer a request.
    void started.then(
      (result) => note(`${shortId(result.runId, { kind: "run" })} ${result.summary?.status ?? result.status}.`),
      (error) => note(`The run failed: ${error.message}`),
    ).then(() => app.refresh()).then(app.paint, report);
    await app.refresh();
  }

  function filterKey(key) {
    if (key === "\u001B") {
      filter = "";
      filtering = false;
    } else if (key === "\r" || key === "\n") {
      filtering = false;
    } else if (key === "\u007F" || key === "\b") {
      filter = filter.slice(0, -1);
    } else if (key === "\u0015") {
      filter = "";
    } else if (!key.startsWith("\u001B") && key.length === 1 && key >= " ") {
      filter += key;
    }
    cursor = clamp(cursor, selection().length);
  }

  async function decide(decision) {
    if (view !== "approvals") return;
    const approval = selection()[clamp(cursor, selection().length)];
    if (!approval) return;
    try {
      const result = state.decide(approval.id, decision, { actor: `tui:${actor}` });
      note(`${result.operationKind} ${result.status} — recorded in the receipt.`);
      detail = false;
    } catch (error) {
      // Somebody may have answered the same request from the CLI or the page.
      note(error.message);
    }
    await app.refresh();
  }

  async function cancel() {
    const job = selection()[clamp(cursor, selection().length)];
    if (!job) return;
    try {
      state.cancelJob(job.id, { actor: `tui:${actor}`, reason: "Cancelled from the TUI." });
      note(`Cancellation requested for ${job.id.slice(0, 8)}.`);
    } catch (error) {
      note(error.message);
    }
    await app.refresh();
  }

  function note(text) {
    message = text;
    clearTimeout(messageTimer);
    messageTimer = setTimeout(() => {
      message = undefined;
      app.paint();
    }, 4000);
    messageTimer.unref?.();
  }

  function report(error) {
    note(error.message);
    app.paint();
  }

  return app;
}

// Splits a chunk into keys: an escape sequence stays whole, everything else is
// one code point, so a pasted word arrives as its letters.
export function splitKeys(chunk) {
  const keys = [];
  let index = 0;
  while (index < chunk.length) {
    if (chunk[index] === "\u001B") {
      const rest = chunk.slice(index + 1);
      const sequence = /^[[O][0-9;]*[A-Za-z~]/u.exec(rest);
      if (sequence) {
        keys.push(chunk.slice(index, index + 1 + sequence[0].length));
        index += 1 + sequence[0].length;
        continue;
      }
      // A lone escape, or one that has not finished arriving: on its own it
      // means 'back', which is what every view does with it.
      keys.push("\u001B");
      index += 1;
      continue;
    }
    const character = [...chunk.slice(index)][0];
    keys.push(character);
    index += character.length;
  }
  return keys;
}
