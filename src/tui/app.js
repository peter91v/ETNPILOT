import { screen } from "./ansi.js";
import { clamp, renderApp, viewList } from "./render.js";

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
        project: state.config?.git?.project ?? "",
      });
    },

    paint() {
      output.write(screen.home + app.frame().map((line) => line + screen.eraseLine).join("\n"));
    },

    // Returns true while the app should keep running.
    async handle(key) {
      if (key === "q" || key === "\u0003") return false;
      if (key === "\t") {
        view = VIEWS[(VIEWS.indexOf(view) + 1) % VIEWS.length];
        cursor = 0;
        detail = false;
      } else if (key === "1" || key === "2" || key === "3") {
        view = VIEWS[Number(key) - 1];
        cursor = 0;
        detail = false;
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
    return snapshot.approvals?.pending ?? [];
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
