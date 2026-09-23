import { createStyle, displayWidth, duration, pad, padStart, shortId, since, truncate, until } from "./ansi.js";

// Every view is a pure function of state and viewport: state in, lines out.
// The runtime below only paints what these return, which is what makes the
// interface testable without a terminal.

const VIEWS = Object.freeze(["approvals", "runs", "queue"]);

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
  } = options;
  const style = createStyle({ color });
  const body = height - 3;
  const lines = [
    header(state, { style, width, view, project }),
    "",
  ];

  const rendered = detail && view === "approvals"
    ? renderApprovalDetail(state, { style, width, height: body, cursor })
    : renderView(view, state, { style, width, height: body, cursor, now });
  for (const line of rendered.slice(0, body)) lines.push(truncate(line, width));
  while (lines.length < height - 1) lines.push("");
  lines.push(footer({ style, width, view, detail, message }));
  return lines.slice(0, height).map((line) => truncate(line, width));
}

function renderView(view, state, context) {
  if (view === "runs") return renderRuns(state, context);
  if (view === "queue") return renderQueue(state, context);
  return renderApprovals(state, context);
}

function header(state, { style, width, view, project }) {
  const pending = state.approvals?.pending?.length ?? 0;
  const counts = state.queue?.counts ?? {};
  const running = counts.running ?? 0;
  const tabs = VIEWS.map((name) => {
    const label = name === "approvals" && pending > 0 ? `${name} ${pending}` : name;
    return name === view ? style.bold(style.accent(label)) : style.dim(label);
  }).join(style.dim("  ·  "));
  const left = `${style.bold(style.accent("ETNPILOT"))}  ${tabs}`;
  const right = style.dim(`${project}${project ? "  " : ""}${running} running`);
  const gap = Math.max(1, width - displayWidth(left) - displayWidth(right));
  return left + " ".repeat(gap) + right;
}

function footer({ style, width, view, detail, message }) {
  if (message) return truncate(style.warn(message), width);
  const keys = detail
    ? [["a", "approve"], ["r", "reject"], ["esc", "back"], ["q", "quit"]]
    : view === "approvals"
      ? [["↑↓", "move"], ["enter", "open"], ["a", "approve"], ["r", "reject"], ["tab", "view"], ["q", "quit"]]
      : view === "queue"
        ? [["↑↓", "move"], ["c", "cancel"], ["tab", "view"], ["q", "quit"]]
        : [["↑↓", "move"], ["tab", "view"], ["?", "help"], ["q", "quit"]];
  return truncate(keys.map(([key, label]) => `${style.accent(key)} ${style.dim(label)}`).join(style.dim("  ")), width);
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

