import { createStyle, displayWidth, duration, pad, padStart, shortId, since, truncate, until } from "./ansi.js";

// Every view is a pure function of state and viewport: state in, lines out.
// The runtime below only paints what these return, which is what makes the
// interface testable without a terminal.

const VIEWS = Object.freeze(["approvals", "runs", "queue", "settings"]);

export function viewList() {
  return [...VIEWS];
}

export function renderApp(state, options = {}) {
  const {
    view = "approvals",
    cursor = 0,
    detail = false,
    width = 100,
    height = 30,
    now = Date.now(),
    color = true,
    message,
    project = "",
    editor,
    filter = "",
    filtering = false,
    scope = "local",
    prompt,
    help = false,
    helpOffset = 0,
    receipt,
    active = [],
  } = options;
  const style = createStyle({ color });
  // Typing happens on the bottom line, the way a terminal tool has always done
  // it, so whatever you were looking at stays on screen while you type.
  const input = inputState({ prompt, editor, filtering, filter });
  const body = height - (input ? 4 : 3);
  const lines = [
    header(state, { style, width, view, project, active }),
    "",
  ];

  const context = { style, width, height: body, cursor, now, editor, filter, filtering, scope, receipt, active };
  const rendered = help
    ? renderHelp({ style, width, height: body, offset: helpOffset })
    : detail && view === "approvals"
      ? renderApprovalDetail(state, context)
      : detail && view === "runs"
        ? renderRunDetail(state, context)
        : renderView(view, state, context);
  for (const line of rendered.slice(0, body)) lines.push(truncate(line, width));
  while (lines.length < height - (input ? 2 : 1)) lines.push("");
  if (input) {
    lines.push(truncate(input.bad ? style.bad(input.hint) : style.dim(input.hint), width));
    lines.push(inputLine(input, { style, width }));
  } else {
    lines.push(footer({ style, width, view, detail, message, editor, prompt, help }));
  }
  return lines.slice(0, height).map((line) => truncate(line, width));
}

function renderView(view, state, context) {
  if (view === "runs") return renderRuns(state, context);
  if (view === "queue") return renderQueue(state, context);
  if (view === "settings") {
    return renderSettings(state, context);
  }
  return renderApprovals(state, context);
}

function header(state, { style, width, view, project, active = [] }) {
  const pending = state.approvals?.pending?.length ?? 0;
  const counts = state.queue?.counts ?? {};
  // Runs this window started count too, or a run you are watching would not
  // appear in the one place that claims to say how many are running.
  const running = (counts.running ?? 0) + active.length;
  const tabs = VIEWS.map((name) => {
    const label = name === "approvals" && pending > 0 ? `${name} ${pending}` : name;
    return name === view ? style.bold(style.accent(label)) : style.dim(label);
  }).join(style.dim("  ·  "));
  const left = `${style.bold(style.accent("ETNPILOT"))}  ${tabs}`;
  const right = style.dim(`${project}${project ? "  " : ""}${running} running`);
  const gap = Math.max(1, width - displayWidth(left) - displayWidth(right));
  return left + " ".repeat(gap) + right;
}

function footer({ style, width, view, detail, message, editor, prompt, help }) {
  if (message) return truncate(style.warn(message), width);
  const keys = footerKeys({ view, detail, editor, prompt, help });
  return truncate(keys.map(([key, label]) => `${style.accent(key)} ${style.dim(label)}`).join(style.dim("  ")), width);
}

// Whatever is on screen decides which keys the footer promises. A key it names
// has to do something here, or the footer is teaching the wrong thing.
function footerKeys({ view, detail, editor, prompt, help }) {
  if (help) return [["↑↓", "scroll"], ["?", "close"], ["esc", "close"], ["q", "quit"]];
  if (prompt) return [["enter", "start"], ["tab", "agent"], ["esc", "cancel"], ["^u", "clear"]];
  if (editor) return [["enter", "save"], ["esc", "cancel"], ["^u", "clear"]];
  if (detail && view === "runs") return [["esc", "back"], ["↑↓", "move"], ["n", "run"], ["q", "quit"]];
  if (detail) return [["a", "approve"], ["r", "reject"], ["esc", "back"], ["q", "quit"]];
  if (view === "approvals") {
    return [["↑↓", "move"], ["enter", "open"], ["a", "approve"], ["r", "reject"], ["n", "run"], ["tab", "view"], ["q", "quit"]];
  }
  if (view === "queue") {
    return [["↑↓", "move"], ["c", "cancel"], ["R", "resume"], ["n", "run"], ["tab", "view"], ["q", "quit"]];
  }
  if (view === "settings") {
    return [["↑↓", "move"], ["enter", "edit"], ["d", "default"], ["s", "scope"], ["/", "filter"], ["tab", "view"], ["q", "quit"]];
  }
  return [["↑↓", "move"], ["enter", "open"], ["n", "run"], ["tab", "view"], ["?", "help"], ["q", "quit"]];
}

function renderApprovals(state, { style, width, height, cursor, now }) {
  const pending = state.approvals?.pending ?? [];
  if (pending.length === 0) {
    return [style.dim("Nothing is waiting for a decision."), "", style.dim("Runs continue until one of them needs you.")];
  }
  const lines = [style.dim(`${pending.length} waiting · oldest ${since(pending.at(-1).createdAt, now)}`), ""];
  const rows = Math.max(1, Math.floor((height - 2) / 3));
  for (const [index, approval] of window(pending, cursor, rows).entries()) {
    const selected = pending.indexOf(approval) === clamp(cursor, pending.length);
    const marker = selected ? style.accent("›") : " ";
    const kind = kindLabel(approval.operationKind, style);
    const origin = style.dim(`${approval.agent ?? "unknown"} · ${shortId(approval.runId, { kind: "run" })}`);
    const age = style.dim(since(approval.createdAt, now));
    const head = `${marker} ${kind} ${origin}`;
    lines.push(pad(head, width - displayWidth(age) - 1) + age);
    lines.push(`   ${selected ? style.ink(subject(approval)) : style.dim(subject(approval))}`);
    if (index < rows - 1) lines.push("");
  }
  return lines;
}

function renderApprovalDetail(state, { style, width, height, cursor }) {
  const pending = state.approvals?.pending ?? [];
  const approval = pending[clamp(cursor, pending.length)];
  if (!approval) return [style.dim("That approval is gone — it was decided elsewhere.")];
  const details = approval.details ?? {};
  const lines = [
    `${kindLabel(approval.operationKind, style)} ${style.dim(`${approval.agent ?? "unknown"} · run ${approval.runId ?? "—"}`)}`,
    "",
  ];
  const field = (label, value) => {
    if (!value) return;
    lines.push(style.dim(label));
    for (const piece of wrap(String(value), width - 2)) lines.push(`  ${style.ink(piece)}`);
    lines.push("");
  };
  field("Command", details.command);
  field("File", details.file);
  field("URL", details.url);
  field("Tool", details.tool);
  field("Arguments", details.arguments);
  if (details.truncated) lines.push(style.warn("Shown up to the display limit; the full text is in the receipt."), "");
  if (approval.policy) {
    lines.push(style.dim("Why you are being asked"));
    const effect = approval.policy.effect ?? "human";
    const tone = effect === "deny" ? "bad" : effect === "allow" ? "ok" : "warn";
    const rule = approval.policy.rule ? `rule '${approval.policy.rule}'` : "the section default";
    lines.push(`  ${style.tone(effect, tone)} ${style.muted(`← ${rule}`)}`, "");
  }
  lines.push(style.dim("Fingerprint"), `  ${style.muted(details.fingerprint ?? "—")}`, "");
  lines.push(style.dim(`Expires in ${until(approval.expiresAt)}`));
  return lines.slice(0, height);
}

function renderRuns(state, { style, width, height, cursor, now }) {
  const runs = state.runs ?? [];
  if (runs.length === 0) return [style.dim("No runs have been recorded yet.")];
  const columns = [
    { label: "RUN", width: 26, value: (run) => run.runId },
    { label: "STATUS", width: 14, value: (run) => run.status, tone: (run) => statusTone(run.status) },
    { label: "MODE", width: 9, value: (run) => run.mode },
    { label: "SEALED", width: 7, value: (run) => (run.terminal ? "yes" : "no"), tone: (run) => (run.terminal ? "ok" : "warn") },
    { label: "SIGNED", width: 7, value: (run) => (run.signed ? "yes" : "no") },
    { label: "APPR", width: 5, value: (run) => String(run.approvals ?? 0) },
    { label: "TOOK", width: 9, value: (run) => duration(run.durationMs) },
  ];
  return table(runs, columns, { style, width, height, cursor, now });
}

function renderQueue(state, { style, width, height, cursor, now }) {
  const jobs = state.queue?.jobs ?? [];
  const counts = state.queue?.counts ?? {};
  const summary = Object.entries(counts).map(([status, total]) => `${status} ${total}`).join(" · ");
  if (jobs.length === 0) return [style.dim(summary || "The queue is empty.")];
  const columns = [
    { label: "JOB", width: 12, value: (job) => shortId(job.id) },
    { label: "KIND", width: 16, value: (job) => job.kind },
    { label: "STATUS", width: 18, value: (job) => job.status, tone: (job) => queueTone(job.status) },
    { label: "TRIES", width: 6, value: (job) => String(job.attempts ?? 0) },
    { label: "UPDATED", width: 10, value: (job) => since(job.updatedAt, now) },
  ];
  return [style.dim(summary), "", ...table(jobs, columns, { style, width, height: height - 2, cursor, now })];
}

function table(rows, columns, { style, width, height, cursor }) {
  const heading = columns.map((column) => style.dim(pad(column.label, column.width))).join(" ");
  const lines = [`  ${heading}`];
  const visibleRows = Math.max(1, height - 1);
  const selectedIndex = clamp(cursor, rows.length);
  for (const row of window(rows, cursor, visibleRows)) {
    const selected = rows.indexOf(row) === selectedIndex;
    const cells = columns.map((column) => {
      const text = pad(String(column.value(row) ?? ""), column.width);
      return column.tone ? style.tone(text, column.tone(row)) : (selected ? style.ink(text) : style.muted(text));
    }).join(" ");
    lines.push(`${selected ? style.accent("›") : " "} ${cells}`);
  }
  return lines.map((line) => truncate(line, width));
}

// Keeps the selected row on screen without redrawing the world around it.
export function window(items, cursor, size) {
  if (items.length <= size) return items;
  const selected = clamp(cursor, items.length);
  const start = Math.min(Math.max(0, selected - Math.floor(size / 2)), items.length - size);
  return items.slice(start, start + size);
}

export function clamp(cursor, length) {
  if (length === 0) return 0;
  return Math.min(Math.max(0, cursor), length - 1);
}

export function wrap(text, width) {
  if (width <= 0) return [text];
  const lines = [];
  for (const paragraph of String(text).split("\n")) {
    let current = "";
    for (const word of paragraph.split(" ")) {
      if (current === "") current = word;
      else if (current.length + 1 + word.length <= width) current += ` ${word}`;
      else {
        lines.push(current);
        current = word;
      }
      while (current.length > width) {
        lines.push(current.slice(0, width));
        current = current.slice(width);
      }
    }
    lines.push(current);
  }
  return lines;
}

function subject(approval) {
  const details = approval.details ?? {};
  return details.command ?? details.url ?? details.file ?? details.tool ?? "(no detail recorded)";
}

function kindLabel(kind, style) {
  const text = String(kind ?? "unknown").toUpperCase();
  const tone = kind === "shell" ? "warn" : kind === "write" ? "accent" : kind === "network" ? "bad" : "muted";
  return style.tone(padStart(text, 7), tone);
}

function statusTone(status) {
  if (status === "succeeded") return "ok";
  if (status === "failed") return "bad";
  return "warn";
}

function queueTone(status) {
  if (status === "succeeded") return "ok";
  if (status === "failed" || status === "orphaned") return "bad";
  if (status === "running") return "warn";
  return "muted";
}

function renderRunDetail(state, { style, width, height, cursor, receipt }) {
  const runs = state.runs ?? [];
  const run = runs[clamp(cursor, runs.length)];
  if (!run) return [style.dim("No runs have been recorded yet.")];
  const lines = [
    `${style.bold(style.ink(run.runId))} ${style.tone(run.status, statusTone(run.status))} ${style.dim(`${run.mode} · ${duration(run.durationMs)}`)}`,
    "",
  ];
  if (!receipt || receipt.file !== run.receiptFile) return [...lines, style.dim("Reading the receipt…")];
  const terminal = receipt.terminal ?? {};
  const field = (label, value) => {
    if (value === undefined || value === "") return;
    lines.push(style.dim(label));
    for (const piece of wrap(String(value), width - 2)) lines.push(`  ${style.ink(piece)}`);
    lines.push("");
  };
  field("Branch", terminal.workspace?.branch);
  field("Sandbox", terminal.workspace?.sandbox?.image);
  if (terminal.git?.mergeRehearsal) {
    const rehearsal = terminal.git.mergeRehearsal;
    lines.push(style.dim("Merge rehearsal"));
    lines.push(rehearsal.clean
      ? `  ${style.ok("clean")} ${style.muted(`into ${rehearsal.targetBranch ?? "the target branch"}`)}`
      : `  ${style.bad("conflicts")} ${style.muted((rehearsal.conflicts ?? []).join(", "))}`);
    lines.push("");
  }
  // Which settings were in effect is evidence, so it belongs next to the run
  // rather than only in the file.
  if (terminal.settings) {
    lines.push(style.dim("Settings in effect"));
    lines.push(`  ${style.muted(terminal.settings.layers.map((layer) => layer.source).join(" → "))}`);
    const overrides = terminal.settings.overrides ?? [];
    lines.push(overrides.length === 0
      ? `  ${style.ok("the committed default, unchanged")}`
      : `  ${style.warn(`${overrides.length} changed locally`)} ${style.muted(overrides.join(", "))}`);
    lines.push("");
  }
  const approvals = receipt.entries.flatMap((entry) => entry.approvals ?? []);
  if (approvals.length > 0) {
    lines.push(style.dim(`Approvals (${approvals.length})`));
    // Three lines are held back for the receipt below. A count that disagrees
    // with the rows under it is worse than a list that says it is short.
    const room = Math.max(1, height - lines.length - 3);
    for (const approval of approvals.slice(0, room)) {
      const tone = approval.decision === "approve-once" ? "ok" : "bad";
      lines.push(`  ${style.tone(padStart(String(approval.operationKind).toUpperCase(), 7), tone)} ${style.muted(approval.decision)} ${style.dim(approval.evidence?.decidedBy ?? "")}`);
    }
    if (approvals.length > room) lines.push(style.dim(`  … ${approvals.length - room} more, in the receipt`));
    lines.push("");
  }
  lines.push(style.dim("Receipt"));
  lines.push(`  ${style.muted(run.receiptFile)} · ${run.entries} entries · ${run.signed ? style.ok("signed") : style.warn("unsigned")}`);
  if (terminal.error) {
    lines.push("", style.dim("Error"));
    for (const piece of wrap(terminal.error, width - 2)) lines.push(`  ${style.bad(piece)}`);
  }
  return lines.slice(0, height);
}

function renderHelp({ style, width, height, offset = 0 }) {
  const sections = HELP_SECTIONS;
  const render = ([title, keys], columnWidth) => [
    style.dim(title),
    ...keys.map(([key, label]) => truncate(`  ${style.accent(pad(key, 10))} ${style.ink(label)}`, columnWidth)),
    "",
  ];
  const single = sections.flatMap((section) => render(section, width));
  const rows = single.length <= height ? single : twoColumns(sections, render, width);
  if (rows.length <= height) return rows;

  // Below a certain height nothing lays out. Help that scrolls off the bottom
  // without saying so teaches the wrong keys, so the cut is on screen.
  const start = Math.min(Math.max(0, offset), rows.length - (height - 1));
  const visible = rows.slice(start, start + height - 1);
  const more = rows.length - start - visible.length;
  visible.push(style.dim(more > 0 ? `↑↓ scroll · ${more} more lines` : "↑↓ scroll · the end"));
  return visible;
}

export function helpLength(width, height) {
  const measure = ([title, keys], columnWidth) => [title, ...keys.map(([key]) => key), ""].length;
  const single = HELP_SECTIONS.reduce((total, section) => total + measure(section), 0);
  if (single <= height) return single;
  const half = Math.ceil(HELP_SECTIONS.length / 2);
  const left = HELP_SECTIONS.slice(0, half).reduce((total, section) => total + measure(section), 0);
  const right = HELP_SECTIONS.slice(half).reduce((total, section) => total + measure(section), 0);
  return Math.max(left, right);
}

function twoColumns(sections, render, width) {
  const columnWidth = Math.floor((width - 2) / 2);
  const half = Math.ceil(sections.length / 2);
  const left = sections.slice(0, half).flatMap((section) => render(section, columnWidth));
  const right = sections.slice(half).flatMap((section) => render(section, columnWidth));
  const rows = [];
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    rows.push(`${pad(left[index] ?? "", columnWidth)}  ${right[index] ?? ""}`);
  }
  return rows;
}

const HELP_SECTIONS = Object.freeze([
  ["Everywhere", [
    ["tab / 1-4", "switch view"],
    ["↑ ↓ / k j", "move the cursor"],
    ["n", "start a run"],
    ["g", "refresh now"],
    ["?", "this help"],
    ["q / ^c", "quit"],
  ]],
  ["Approvals", [
    ["enter", "open in full, with the rule"],
    ["a / r", "approve once / reject"],
    ["esc", "back to the list"],
  ]],
  ["Runs", [["enter", "open the receipt"]]],
  ["Queue", [["c", "request cancellation"], ["R", "resume a failed job"]]],
  ["Settings", [
    ["enter", "edit"],
    ["d", "back to the default"],
    ["s", "local or ~/.config"],
    ["/", "filter"],
  ]],
]);

// The settings list and its editor. Which entries are on screen is a pure
// function of the filter, so the app selects exactly what a person can see.
export function settingEntries(state, { filter = "" } = {}) {
  const entries = state.settings?.entries ?? [];
  const needle = filter.trim().toLowerCase();
  if (!needle) return entries;
  return entries.filter((entry) => entry.path.toLowerCase().includes(needle));
}

function renderSettings(state, { style, width, height, cursor, filter, filtering, scope }) {
  const settings = state.settings;
  if (settings?.error) {
    return [
      style.bad("The local settings file was refused."),
      "",
      ...wrap(settings.error, width - 2).map((line) => `  ${style.ink(line)}`),
      "",
      style.dim("Fix the file, or remove the setting with 'etnpilot config unset'."),
    ];
  }
  const entries = settingEntries(state, { filter });
  const changed = settings?.overrides?.length ?? 0;
  const summary = [
    `${entries.length} ${entries.length === 1 ? "setting" : "settings"}`,
    changed > 0 ? `${changed} changed locally` : "none changed",
    `writing to ${scope}`,
  ].join(" · ");
  // While the filter is being typed the input line at the bottom carries it,
  // caret and all. Repeating it here would put two carets on one screen.
  const head = [style.dim(summary) + (!filtering && filter ? style.dim(`  ·  filter '${filter}'`) : ""), ""];
  // A refused setting would stop the next run. Saying so here, above the list,
  // is the difference between a warning and a surprise an hour later.
  const refusals = settings?.refusals ?? [];
  if (refusals.length > 0) {
    head.unshift(
      style.bad(refusals.length === 1
        ? "1 local setting is refused; a run will not start until it is gone:"
        : `${refusals.length} local settings are refused; a run will not start until they are gone:`),
      ...refusals.slice(0, 3).flatMap((refusal) => wrap(`${refusal.path} — ${refusal.reason}`, width - 4)
        .map((line) => `  ${style.muted(line)}`)),
      "",
    );
  }
  if (entries.length === 0) return [...head, style.dim("Nothing matches that filter.")];
  const columns = [
    { label: "SETTING", width: Math.max(24, Math.floor(width * 0.4)), value: (entry) => entry.path },
    { label: "VALUE", width: Math.max(14, Math.floor(width * 0.25)), value: (entry) => settingValue(entry.value) },
    { label: "FROM", width: 12, value: (entry) => sourceLabel(entry.source), tone: (entry) => (entry.source === "project" ? "muted" : "accent") },
    { label: "CHANGE", width: 14, value: (entry) => entry.mode, tone: (entry) => modeTone(entry.mode) },
  ];
  return [...head, ...table(entries, columns, { style, width, height: height - head.length, cursor })];
}

// What the editor starts from: JSON is valid YAML, so a value round-trips
// through the prompt unchanged unless the person edits it.
export function settingLiteral(value) {
  return value === undefined ? "" : JSON.stringify(value);
}

export function settingValue(value) {
  if (value === undefined) return "—";
  if (Array.isArray(value) && value.some((entry) => entry && typeof entry === "object")) {
    return `${value.length} entries`;
  }
  return JSON.stringify(value);
}

function sourceLabel(source) {
  if (source === "user-local") return "local";
  if (source === "user-global") return "global";
  return "committed";
}

function modeTone(mode) {
  if (mode === "locked") return "bad";
  if (mode === "stricter-only") return "warn";
  return "muted";
}

// One line at the bottom of the screen, the way every terminal tool does it:
// a prefix that says what is being typed, the text, and the caret. What was on
// screen stays there, which is the point — you can read the list you are
// filtering, or the approval you are about to answer, while you type.
function inputState({ prompt, editor, filtering, filter }) {
  if (editor) {
    return {
      prefix: `set ${editor.entry.path}`,
      value: editor.buffer,
      bad: Boolean(editor.error),
      hint: editor.error ?? [
        editor.entry.mode,
        `default ${settingValue(editor.entry.defaultValue)}`,
        `writing ${editor.scope === "global" ? "~/.config" : "this project, locally"}`,
        "enter saves · esc cancels",
      ].join(" · "),
    };
  }
  if (prompt) {
    const agent = prompt.agent
      || (prompt.steps?.length > 0 ? `the project's workflow: ${prompt.steps.join(" → ")}` : "the project's default agent");
    return prompt.field === "agent"
      ? {
          prefix: "agent",
          value: prompt.agent,
          bad: Boolean(prompt.error),
          hint: prompt.error ?? `task: ${prompt.buffer || "(none yet)"} · tab back to the task · enter starts`,
        }
      : {
          prefix: "run",
          value: prompt.buffer,
          bad: Boolean(prompt.error),
          hint: prompt.error ?? `agent: ${agent} · tab to name one · enter starts · esc cancels`,
        };
  }
  if (filtering) {
    return { prefix: "/", bare: true, value: filter, hint: "enter keeps the filter · esc clears it" };
  }
  return undefined;
}

function inputLine(input, { style, width }) {
  const prefix = input.bare
    ? style.accent(input.prefix)
    : `${style.accent(input.prefix)}${style.dim("> ")}`;
  // The caret has to stay visible even where the text is longer than the line,
  // so a long value is cut at the front rather than the end.
  const room = Math.max(1, width - displayWidth(prefix) - 1);
  const value = input.value.length > room ? `…${input.value.slice(-(room - 1))}` : input.value;
  return prefix + style.ink(value) + style.invert(" ");
}
