import { createStyle, pad, screen, truncate } from "./ansi.js";
import { clamp, wrap } from "./render.js";
import { splitKeys } from "./app.js";
import { createProject, describeProject } from "../runtime/first-run.js";

// The screen for a directory with no project in it. It is a screen of its own
// rather than a seventh tab, because there is nothing else to look at yet: no
// approvals, no runs, no settings. One decision, then the real interface.
//
// Pure renderer, same rule as every other view: state and viewport in, lines
// out.
export function renderFirstRun(status, {
  width = 100,
  height = 30,
  cursor = 0,
  color = true,
  message,
  busy = false,
} = {}) {
  const style = createStyle({ color });
  const templates = status.templates ?? [];
  const lines = [
    `${style.bold(style.accent("ETNPILOT"))}  ${style.dim("no project here yet")}`,
    "",
    style.ink("This directory has no '.etnpilot/etnpilot.yaml', so there is nothing to review."),
    style.dim(status.root),
    "",
  ];
  if (!status.checkout.inside) {
    // Not a reason to refuse, but the next wall they would walk into.
    lines.push(
      style.warn("This is not a git checkout."),
      style.dim("A project can still be created; a run needs one, because it works in a worktree"),
      style.dim("and rehearses its merge. 'git init' is enough."),
      "",
    );
  } else if (status.checkout.top && status.checkout.top !== status.root) {
    lines.push(style.dim(`Inside the checkout at ${status.checkout.top}.`), "");
  }
  lines.push(style.dim("Choose what to create — enter creates it, q leaves without touching anything."), "");
  const selected = clamp(cursor, templates.length);
  for (const [index, template] of templates.entries()) {
    const marker = index === selected ? style.accent("›") : " ";
    const name = index === selected ? style.bold(style.ink(pad(template.id, 12))) : style.muted(pad(template.id, 12));
    lines.push(`${marker} ${name} ${style.dim(truncate(template.about, Math.max(20, width - 18)))}`);
    if (index === selected && template.changes.length > 0) {
      for (const change of template.changes) {
        lines.push(`    ${style.muted(pad(change.path, 34))} ${style.ink(JSON.stringify(change.value))}`);
      }
    }
  }
  lines.push("", style.dim("It writes '.etnpilot/': the configuration, one agent manifest and its prompt."));
  lines.push(style.dim("Nothing outside that directory is touched, and nothing is committed for you."));
  if (busy) lines.push("", style.warn("Creating…"));
  if (message) {
    lines.push("");
    for (const piece of wrap(message, width - 2)) lines.push(style.warn(piece));
  }
  while (lines.length < height - 1) lines.push("");
  const keys = [["↑↓", "choose"], ["enter", "create it"], ["q", "leave"]];
  lines.push(keys.map(([key, label]) => `${style.accent(key)} ${style.dim(label)}`).join(style.dim("  ")));
  return lines.slice(0, height).map((line) => truncate(line, width));
}

// The interactive half. It ends by handing back what it created, so the caller
// can open the real interface on it — the person asked for a project, not for
// a screen that says they now have one.
export function createFirstRunApp({
  root = process.cwd(),
  output = process.stdout,
  input = process.stdin,
} = {}) {
  let status;
  let cursor = 0;
  let message;
  let busy = false;
  let created;
  let stopped = false;
  let onExit;

  const app = {
    get status() { return status; },
    get cursor() { return cursor; },
    get created() { return created; },

    async refresh() {
      status = await describeProject({ root });
      return status;
    },

    frame() {
      return renderFirstRun(status, {
        width: output.columns || 100,
        height: output.rows || 30,
        color: output.isTTY === true && !process.env.NO_COLOR,
        cursor,
        message,
        busy,
      });
    },

    paint() {
      output.write(screen.home + app.frame().map((line) => line + screen.eraseLine).join("\n"));
    },

    // Returns true while this screen should stay up.
    async handle(key) {
      if (busy) return true;
      if (key === "q" || key === "\u0003") return false;
      const templates = status.templates ?? [];
      if (key === "\u001B[B" || key === "j") cursor = clamp(cursor + 1, templates.length);
      else if (key === "\u001B[A" || key === "k") cursor = clamp(cursor - 1, templates.length);
      else if (key === "\r" || key === "\n") {
        const template = templates[clamp(cursor, templates.length)];
        if (!template) return true;
        busy = true;
        app.paint();
        try {
          created = await createProject({ root, template: template.id });
          return false;
        } catch (error) {
          // A refusal belongs on the screen that asked, with the reason.
          message = error.message;
          created = undefined;
        } finally {
          busy = false;
        }
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
      return new Promise((resolveExit) => { onExit = resolveExit; });
    },

    stop() {
      if (stopped) return;
      stopped = true;
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
    void (async () => {
      for (const key of splitKeys(String(chunk))) {
        if (!await app.handle(key)) {
          app.stop();
          return;
        }
      }
    })().catch((error) => {
      message = error.message;
      app.paint();
    });
  }

  return app;
}
