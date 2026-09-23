import { screen } from "./ansi.js";
import { parseSettingValue } from "../config/settings.js";
import { clamp, renderApp, settingEntries, settingLiteral, settingValue, viewList } from "./render.js";

const VIEWS = viewList();

// The interactive half: keys in, repaints out. It owns no knowledge of what a
// screen looks like — that lives in the pure renderers — and no knowledge of
// where state comes from, which lives in the shared project state.
export function createTuiApp({
  state,
  output = process.stdout,
  input = process.stdin,
  pollIntervalMs = 1000,
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

    async refresh() {
      snapshot = await state.collect();
      cursor = clamp(cursor, selection().length);
      return snapshot;
    },

    frame() {
      return renderApp(snapshot, {
        view,
        cursor,
        detail,
        message,
        width: output.columns ?? 100,
        height: output.rows ?? 30,
        color: output.isTTY === true && !process.env.NO_COLOR,
        now: now(),
        editor,
        filter,
        filtering,
        scope,
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
      if (key === "q" || key === "\u0003") return false;
      if (key === "\t") {
        view = VIEWS[(VIEWS.indexOf(view) + 1) % VIEWS.length];
        cursor = 0;
        detail = false;
      } else if (/^[1-9]$/.test(key) && Number(key) <= VIEWS.length) {
        view = VIEWS[Number(key) - 1];
        cursor = 0;
        detail = false;
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
        cursor = clamp(cursor + 1, selection().length);
      } else if (key === "\u001B[A" || key === "k") {
        cursor = clamp(cursor - 1, selection().length);
      } else if (key === "\r" || key === "\n") {
        if (view === "approvals" && selection().length > 0) detail = true;
      } else if (key === "\u001B") {
        detail = false;
      } else if (key === "a" || key === "r") {
        await decide(key === "a" ? "approved" : "rejected");
      } else if (key === "c" && view === "queue") {
        await cancel();
      } else if (key === "g") {
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
    void app.handle(String(chunk)).then((keepGoing) => {
      if (!keepGoing) app.stop();
    }).catch(report);
  }

  function selection() {
    if (view === "runs") return snapshot.runs ?? [];
    if (view === "queue") return snapshot.queue?.jobs ?? [];
    if (view === "settings") return settingEntries(snapshot, { filter });
    return snapshot.approvals?.pending ?? [];
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
