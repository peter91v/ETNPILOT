// A single self-contained page: no framework, no CDN, no build step. Every
// value from a run is inserted with textContent, never as markup, because all
// of it is text an agent controlled.
//
// It shows what the TUI shows and can do what the TUI can do: decide
// approvals, cancel and resume queue jobs, read a run's receipt, change
// settings against the same layers, start a run, and list the worktrees and
// the project's merge requests.
export function renderReviewPage(token) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ETNPilot Review</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #fbfbfd; --panel: #ffffff; --ink: #14161a; --muted: #5c6370;
    --line: #e2e5ea; --accent: #2f5fd0; --ok: #1c7c45; --warn: #9a6200; --bad: #b3261e;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #14161a; --panel: #1c1f25; --ink: #eceff4; --muted: #9aa3b2;
      --line: #2b3039; --accent: #7ba1f0; --ok: #62c08a; --warn: #e0b060; --bad: #f08a80;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
  }
  header {
    padding: 16px; border-bottom: 1px solid var(--line);
    display: flex; gap: 12px; align-items: baseline; flex-wrap: wrap;
    position: sticky; top: 0; background: var(--bg); z-index: 2;
  }
  h1 { font-size: 17px; margin: 0; letter-spacing: -0.01em; }
  main {
    padding: 16px; max-width: 980px; margin: 0 auto;
    display: grid; grid-template-columns: minmax(0, 1fr); gap: 24px;
  }
  /* Without this a wide table stretches the page instead of scrolling inside
     its own box, and every other section is dragged off screen with it. */
  section, .card, .row { min-width: 0; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); margin: 0 0 10px; }
  h2 .count { text-transform: none; letter-spacing: 0; color: var(--ink); font-weight: 600; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 14px; margin-bottom: 10px; }
  .card.open { border-color: var(--accent); scroll-margin-top: 72px; }
  .row { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; }
  .row.tight { gap: 6px; }
  .grow { flex: 1 1 auto; }
  .muted { color: var(--muted); font-size: 13px; }
  .kind {
    font-weight: 600; text-transform: uppercase; font-size: 11px; letter-spacing: 0.06em;
    padding: 2px 7px; border-radius: 999px; border: 1px solid var(--line);
  }
  pre {
    background: color-mix(in srgb, var(--ink) 6%, transparent);
    border: 1px solid var(--line); border-radius: 8px; padding: 10px; overflow-x: auto;
    font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    margin: 10px 0 0; white-space: pre-wrap; word-break: break-word;
  }
  button {
    font: inherit; padding: 6px 13px; border-radius: 7px; border: 1px solid var(--line);
    background: var(--panel); color: var(--ink); cursor: pointer;
  }
  button:hover { border-color: var(--accent); }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  button.approve { border-color: var(--ok); color: var(--ok); }
  button.reject { border-color: var(--bad); color: var(--bad); }
  button.small { padding: 3px 9px; font-size: 13px; }
  button.link {
    border: 0; padding: 0; background: none; color: var(--accent);
    text-align: left; text-decoration: underline; cursor: pointer;
  }
  input, select {
    font: inherit; padding: 6px 9px; border-radius: 7px;
    border: 1px solid var(--line); background: var(--bg); color: var(--ink); min-width: 0;
  }
  input.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px; }
  label.check { display: inline-flex; gap: 6px; align-items: center; font-size: 13px; color: var(--muted); }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { color: var(--muted); font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; }
  td.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
  td.actions { white-space: nowrap; }
  tr.selected td { background: color-mix(in srgb, var(--accent) 12%, transparent); }
  .scroll { overflow-x: auto; max-width: 100%; }
  .ok { color: var(--ok); } .warn { color: var(--warn); } .bad { color: var(--bad); }
  .empty { color: var(--muted); font-size: 14px; padding: 6px 0; }
  .notice { border-left: 3px solid var(--warn); padding: 4px 0 4px 10px; margin: 0 0 10px; font-size: 13px; }
  .notice.bad { border-color: var(--bad); }
  .field { display: grid; gap: 4px; }
  .field .label { font-size: 12px; color: var(--muted); }
  .pair { display: grid; grid-template-columns: 140px 1fr; gap: 6px 12px; font-size: 13px; }
  .pair dt { color: var(--muted); }
  .pair dd { margin: 0; word-break: break-word; }
  #error { color: var(--bad); font-size: 13px; }
  @media (max-width: 560px) {
    .pair { grid-template-columns: 1fr; gap: 2px; }
    .pair dd { margin-bottom: 6px; }
    th, td { padding: 6px; }
  }
</style>
</head>
<body>
<header>
  <h1>ETNPilot Review</h1>
  <span class="grow muted" id="status">loading…</span>
  <span id="error"></span>
</header>
<main>
  <section>
    <h2>Start a run</h2>
    <div id="start"></div>
  </section>
  <section>
    <h2>Pending approvals <span class="count" id="approvals-count"></span></h2>
    <div id="approvals"></div>
  </section>
  <section>
    <h2>Workflow queue</h2>
    <div id="queue"></div>
  </section>
  <section>
    <h2>Runs</h2>
    <div id="runs"></div>
    <div id="run-detail"></div>
  </section>
  <section>
    <h2>Worktrees</h2>
    <div id="worktrees"></div>
  </section>
  <section>
    <h2>Merge requests</h2>
    <div id="merges"></div>
  </section>
  <section>
    <h2>Settings</h2>
    <div id="settings"></div>
    <div id="setting-editor"></div>
  </section>
</main>
<script>
const TOKEN = ${JSON.stringify(token)};
const $ = (id) => document.getElementById(id);

// What the page is showing and what the person is in the middle of doing. The
// poll below never throws either of these away.
let state;
let openRun;
let openSetting;
let scope = "local";
let settingsFilter = "";
let changedOnly = false;
let settingsLimit = 25;

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "x-etnpilot-token": TOKEN, ...(options.body ? { "content-type": "application/json" } : {}) },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error ?? ("request failed (" + response.status + ")"));
  return payload;
}

function el(tag, options = {}, children = []) {
  const node = document.createElement(tag);
  if (options.class) node.className = options.class;
  // Always text, never markup: this content came from an agent.
  if (options.text !== undefined) node.textContent = String(options.text);
  for (const [key, value] of Object.entries(options.attrs ?? {})) node.setAttribute(key, value);
  for (const child of children) node.append(child);
  return node;
}

function button(text, { class: className = "small", onClick, title, disabled = false }) {
  const node = el("button", { class: className, text, attrs: title ? { title } : {} });
  node.disabled = disabled;
  if (onClick) node.addEventListener("click", onClick);
  return node;
}

function fail(error) {
  $("error").textContent = error.message;
}

function clearError() {
  $("error").textContent = "";
}

// Timestamps are read by a person deciding now, so they are shown as a
// distance from now with the exact value kept in the tooltip.
function when(iso) {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return { text: String(iso ?? "—"), title: "" };
  const seconds = Math.round((time - Date.now()) / 1000);
  const past = seconds < 0;
  const units = [["d", 86400], ["h", 3600], ["m", 60], ["s", 1]];
  let magnitude = Math.abs(seconds);
  let text = "now";
  for (const [suffix, size] of units) {
    if (magnitude >= size) { text = Math.floor(magnitude / size) + suffix; break; }
  }
  if (text !== "now") text = past ? text + " ago" : "in " + text;
  return { text, title: new Date(time).toISOString() };
}

function timeSpan(label, iso) {
  const moment = when(iso);
  return el("span", { class: "muted", text: label + " " + moment.text, attrs: { title: moment.title } });
}

function detailBlock(label, value) {
  return el("div", {}, [el("div", { class: "muted", text: label }), el("pre", { text: value })]);
}

function pairs(rows) {
  const list = el("dl", { class: "pair" });
  for (const [label, value, className] of rows) {
    if (value === undefined || value === "") continue;
    list.append(el("dt", { text: label }), el("dd", { class: className ?? "", text: value }));
  }
  return list;
}

function describeValue(value) {
  if (value === undefined) return "—";
  return JSON.stringify(value);
}

// A policy block is hundreds of characters on one line. Showing all of it in a
// cell stretches the table over everything else, so the cell is short and the
// whole value is in the tooltip.
function shortValue(value, limit = 70) {
  const text = describeValue(value);
  return text.length <= limit
    ? { text }
    : { text: text.slice(0, limit) + "…", title: text };
}

function table(columns, rows, emptyText, options = {}) {
  if (rows.length === 0) return el("p", { class: "empty", text: emptyText });
  const head = el("tr", {}, columns.map((column) => el("th", { text: column.label })));
  const body = rows.map((row) => {
    const cells = columns.map((column) => {
      const value = column.value(row);
      if (value instanceof Node) return el("td", { class: "actions" }, [value]);
      if (Array.isArray(value)) return el("td", { class: "actions" }, value);
      return el("td", {
        class: column.mono ? "mono" : (value.class ?? ""),
        text: value.text ?? value,
        attrs: value.title ? { title: value.title } : {},
      });
    });
    const line = el("tr", { class: options.selected?.(row) ? "selected" : "" }, cells);
    return line;
  });
  return el("div", { class: "scroll" }, [el("table", {}, [el("thead", {}, [head]), el("tbody", {}, body)])]);
}

// ------------------------------------------------------------- start a run

function renderStart() {
  const host = $("start");
  host.replaceChildren();
  const task = el("input", { class: "grow", attrs: { placeholder: "what the run should do", "aria-label": "task" } });
  const agent = el("input", { attrs: { placeholder: "agent (optional)", "aria-label": "agent" } });
  const steps = (state?.settings?.entries ?? []).find((entry) => entry.path === "workflow.steps");
  const start = button("Start", { class: "", onClick: async () => {
    if (task.value.trim() === "") { fail(new Error("A run needs a task to work on.")); return; }
    start.disabled = true;
    try {
      const started = await api("/api/runs/start", {
        method: "POST",
        body: JSON.stringify({ task: task.value, agent: agent.value }),
      });
      task.value = "";
      clearError();
      note("Started: " + started.task + ". Whatever it needs approved appears above.");
      await refresh({ force: true });
    } catch (error) {
      fail(error);
    } finally {
      start.disabled = false;
    }
  } });
  const card = el("div", { class: "card" }, [
    el("div", { class: "row" }, [task, agent, start]),
    el("p", {
      class: "muted",
      text: "An empty agent runs what the project runs by itself"
        + (steps?.value ? ": " + describeValue(steps.value) : "")
        + ". The run works in its own worktree and asks this page for anything it needs approved.",
    }),
  ]);
  const active = state?.active ?? [];
  for (const run of active) {
    card.append(el("p", { class: "row tight" }, [
      el("span", { class: "kind warn", text: "running" }),
      el("span", { class: "grow", text: run.task }),
      timeSpan("started", run.startedAt),
    ]));
  }
  for (const failure of state?.recentRunErrors ?? []) {
    card.append(el("p", { class: "notice bad", text: failure.task + " — " + failure.error }));
  }
  host.append(card);
}

let noteUntil = 0;
function note(text) {
  $("status").textContent = text;
  noteUntil = Date.now() + 8000;
  setTimeout(() => { if (Date.now() >= noteUntil) $("status").textContent = statusText(); }, 8000);
}

function showStatus(text) {
  if (Date.now() < noteUntil) return;
  $("status").textContent = text;
}

// ------------------------------------------------------------- approvals

function renderApprovals(list) {
  const host = $("approvals");
  host.replaceChildren();
  $("approvals-count").textContent = list.length > 0 ? String(list.length) : "";
  if (list.length === 0) {
    host.append(el("p", { class: "empty", text: "Nothing is waiting for a decision." }));
    return;
  }
  for (const approval of list) {
    const details = approval.details ?? {};
    const actor = el("input", { attrs: { placeholder: "your name", "aria-label": "reviewer" } });
    const reason = el("input", { class: "grow", attrs: { placeholder: "reason (optional)", "aria-label": "reason" } });
    const decide = async (decision) => {
      try {
        await api("/api/approvals/decide", {
          method: "POST",
          body: JSON.stringify({ id: approval.id, decision, actor: actor.value, reason: reason.value }),
        });
        clearError();
        await refresh({ force: true });
      } catch (error) {
        fail(error);
      }
    };
    const card = el("div", { class: "card" }, [
      el("div", { class: "row" }, [
        el("span", { class: "kind", text: approval.operationKind }),
        el("span", { class: "grow muted", text: "agent " + (approval.agent ?? "unknown") + " · run " + (approval.runId ?? "—") }),
        timeSpan("expires", approval.expiresAt),
      ]),
    ]);
    if (details.command) card.append(detailBlock("Command", details.command));
    if (details.file) card.append(detailBlock("File", details.file));
    if (details.url) card.append(detailBlock("URL", details.url));
    if (details.tool) card.append(detailBlock("Tool", details.tool));
    if (details.arguments) card.append(detailBlock("Arguments", details.arguments));
    if (details.truncated) {
      card.append(el("p", { class: "muted", text: "Truncated for display; see 'etnpilot approval show " + approval.id + "'." }));
    }
    if (details.redacted) {
      card.append(el("p", { class: "muted", text: "Credential-looking text was masked by approval.inbox.redactSecrets." }));
    }
    // Why the run is asking at all: the rule that stopped the operation,
    // recorded with the approval and shown wherever it is answered.
    if (approval.policy) {
      const effect = approval.policy.effect ?? "human";
      card.append(el("p", { class: "muted" }, [
        el("span", { class: effect === "deny" ? "bad" : effect === "allow" ? "ok" : "warn", text: effect }),
        el("span", { text: " ← " + (approval.policy.rule ? "rule '" + approval.policy.rule + "'" : "the section default") }),
      ]));
    }
    const approve = el("button", { class: "approve", text: "Approve once" });
    const reject = el("button", { class: "reject", text: "Reject" });
    approve.addEventListener("click", () => decide("approve"));
    reject.addEventListener("click", () => decide("reject"));
    card.append(el("div", { class: "row", }, [actor, reason, approve, reject]));
    // The fingerprint is for recognising the same operation again, so a
    // readable prefix is enough; the full value is in the tooltip.
    const fingerprint = details.fingerprint ?? "";
    card.append(el("p", {
      class: "muted",
      text: "fingerprint " + (fingerprint ? fingerprint.slice(0, 16) + "…" : "—"),
      attrs: { title: fingerprint },
    }));
    host.append(card);
  }
}

// ----------------------------------------------------------------- queue

const RESUMABLE = ["failed", "canceled", "orphaned"];
const CANCELABLE = ["queued", "retry_scheduled", "running", "cancel_requested"];

function renderQueue(queue) {
  const host = $("queue");
  host.replaceChildren();
  const counts = Object.entries(queue.counts ?? {}).map(([status, total]) => status + " " + total).join(" · ");
  host.append(el("p", { class: "muted", text: counts || "empty" }));
  host.append(table([
    { label: "Job", value: (job) => job.id.slice(0, 8), mono: true },
    { label: "Kind", value: (job) => job.kind },
    { label: "Status", value: (job) => ({ text: job.status, class: queueClass(job.status) }) },
    { label: "Attempts", value: (job) => String(job.attempts ?? 0) },
    { label: "Updated", value: (job) => when(job.updatedAt).text },
    // A button is only offered where the queue would accept it, so nothing on
    // screen teaches an action that cannot happen.
    { label: "", value: (job) => jobActions(job) },
  ], queue.jobs ?? [], "No jobs have been queued."));
}

function jobActions(job) {
  const actions = [];
  if (CANCELABLE.includes(job.status)) {
    actions.push(button("Cancel", { onClick: () => act(() => api("/api/queue/cancel", {
      method: "POST",
      body: JSON.stringify({ id: job.id, reason: "Cancelled from the review page." }),
    }), "Cancellation requested for " + job.id.slice(0, 8) + ".") }));
  }
  if (RESUMABLE.includes(job.status)) {
    // An orphaned job may already have had an effect, so resuming it is a
    // second, explicit decision — exactly as '--force' is in the CLI.
    const force = job.status === "orphaned";
    actions.push(button(force ? "Resume anyway" : "Resume", {
      title: force ? "This job may have produced side effects; inspect it first." : undefined,
      onClick: () => act(() => api("/api/queue/resume", {
        method: "POST",
        body: JSON.stringify({ id: job.id, force }),
      }), job.id.slice(0, 8) + " is queued again."),
    }));
  }
  return actions;
}

async function act(call, message) {
  try {
    await call();
    clearError();
    if (message) note(message);
    await refresh({ force: true });
  } catch (error) {
    fail(error);
  }
}

function queueClass(status) {
  if (status === "succeeded") return "ok";
  if (status === "failed" || status === "orphaned") return "bad";
  if (status === "running") return "warn";
  return "";
}

// ------------------------------------------------------------------ runs

function renderRuns(runs) {
  const host = $("runs");
  host.replaceChildren();
  host.append(table([
    { label: "Run", value: (run) => openReceipt(run), mono: true },
    { label: "Status", value: (run) => ({ text: run.status, class: run.status === "succeeded" ? "ok" : "bad" }) },
    { label: "Mode", value: (run) => run.mode },
    { label: "Sealed", value: (run) => ({ text: run.terminal ? "yes" : "no", class: run.terminal ? "ok" : "warn" }) },
    { label: "Signed", value: (run) => run.signed ? "yes" : "no" },
    { label: "Approvals", value: (run) => String(run.approvals) },
    { label: "Duration", value: (run) => run.durationMs === undefined ? "—" : (run.durationMs / 1000).toFixed(1) + "s" },
    { label: "Receipt", value: (run) => (run.hash ?? "—").slice(0, 12), mono: true },
  ], runs, "No runs have been recorded yet.", { selected: (run) => run.receiptFile === openRun?.file }));
}

function openReceipt(run) {
  return button(run.runId, { class: "link", onClick: async () => {
    try {
      openRun = { file: run.receiptFile, run, receipt: await api("/api/runs/" + encodeURIComponent(run.receiptFile)) };
      clearError();
      renderRuns(state.runs);
      renderRunDetail();
      $("run-detail").scrollIntoView({ block: "nearest" });
    } catch (error) {
      fail(error);
    }
  } });
}

// What was sealed, not a summary kept somewhere else: the branch and sandbox,
// the merge rehearsal, who decided each approval, and which settings layers
// were in effect.
function renderRunDetail() {
  const host = $("run-detail");
  host.replaceChildren();
  if (!openRun) return;
  const { run, receipt } = openRun;
  const terminal = receipt.terminal ?? {};
  const card = el("div", { class: "card open" }, [
    el("div", { class: "row" }, [
      el("span", { class: "kind", text: run.status }),
      el("span", { class: "grow mono", text: run.runId }),
      button("Close", { onClick: () => { openRun = undefined; renderRuns(state.runs); renderRunDetail(); } }),
    ]),
    pairs([
      ["Mode", run.mode],
      ["Branch", terminal.workspace?.branch ?? "—"],
      ["Sandbox", terminal.workspace?.sandbox?.image ?? "—"],
      ["Receipt", receipt.file],
      ["Entries", String(receipt.entries.length)],
      ["Signature", run.signed ? "signed" : "unsigned", run.signed ? "ok" : "warn"],
      ["Hash", run.hash ?? "—", "mono"],
    ]),
  ]);

  const rehearsal = terminal.git?.mergeRehearsal;
  if (rehearsal) {
    card.append(el("p", { class: "muted", text: "Merge rehearsal" }));
    card.append(rehearsal.clean
      ? el("p", { class: "ok", text: "clean into " + (rehearsal.targetBranch ?? "the target branch") })
      : el("p", { class: "bad", text: "conflicts: " + (rehearsal.conflicts ?? []).join(", ") }));
  }
  const train = terminal.git?.mergeTrain;
  if (train?.conflicts?.length > 0) {
    card.append(el("p", { class: "muted", text: "Would collide with" }));
    for (const collision of train.conflicts) {
      card.append(el("p", { class: "warn", text: "!" + collision.iid + " " + collision.title + " — " + (collision.files ?? []).join(", ") }));
    }
  }

  const approvals = receipt.entries.flatMap((entry) => entry.approvals ?? []);
  if (approvals.length > 0) {
    card.append(el("p", { class: "muted", text: "Approvals (" + approvals.length + ")" }));
    card.append(table([
      { label: "Operation", value: (approval) => String(approval.operationKind ?? "—") },
      { label: "Decision", value: (approval) => ({
        text: String(approval.decision ?? "—"),
        class: approval.decision === "approve-once" ? "ok" : "bad",
      }) },
      { label: "Decided by", value: (approval) => String(approval.evidence?.decidedBy ?? "—") },
      { label: "At", value: (approval) => when(approval.at ?? approval.evidence?.decidedAt).text },
    ], approvals, "None."));
  }

  // Which settings were in effect is evidence, so it belongs next to the run
  // rather than only in the file.
  if (terminal.settings) {
    const overrides = terminal.settings.overrides ?? [];
    card.append(el("p", { class: "muted", text: "Settings in effect" }));
    card.append(el("p", { text: (terminal.settings.layers ?? []).map((layer) => layer.source).join(" → ") }));
    card.append(overrides.length === 0
      ? el("p", { class: "ok", text: "the committed default, unchanged" })
      : el("p", { class: "warn", text: overrides.length + " changed locally: " + overrides.join(", ") }));
  }
  if (terminal.error) card.append(detailBlock("Error", terminal.error));
  host.append(card);
}

// ------------------------------------------------------------- worktrees

async function loadWorktrees() {
  const host = $("worktrees");
  try {
    renderWorktrees(await api("/api/worktrees"));
    clearError();
  } catch (error) {
    host.replaceChildren(el("p", { class: "notice bad", text: error.message }));
  }
}

function renderWorktrees(worktrees) {
  const host = $("worktrees");
  host.replaceChildren();
  const reread = button("Read again", { onClick: loadWorktrees });
  if (worktrees.available === false) {
    host.append(el("p", { class: "notice bad", text: worktrees.error ?? "The worktrees could not be listed." }));
    host.append(el("p", { class: "muted", text: "A project outside a git checkout has none; 'etnpilot run' needs one." }));
    host.append(reread);
    return;
  }
  const entries = worktrees.entries ?? [];
  host.append(el("div", { class: "row" }, [
    el("span", { class: "grow muted", text: entries.length + (entries.length === 1 ? " worktree · " : " worktrees · ")
      + (worktrees.managed ?? 0) + " from runs · "
      + (worktrees.unsaved > 0 ? worktrees.unsaved + " with unsaved work" : "nothing unsaved") }),
    reread,
  ]));
  host.append(table([
    { label: "Worktree", value: (entry) => entry.name, mono: true },
    { label: "Branch", value: (entry) => entry.branch ?? (entry.detached ? "(detached)" : "—"), mono: true },
    { label: "Head", value: (entry) => (entry.head ?? "").slice(0, 8), mono: true },
    { label: "From", value: (entry) => entry.main ? "checkout" : entry.managed ? "a run" : "elsewhere" },
    { label: "State", value: (entry) => worktreeState(entry) },
    { label: "", value: (entry) => worktreeActions(entry) },
  ], entries, "No worktrees are registered."));
}

function worktreeState(entry) {
  if (entry.locked !== undefined) return { text: "locked", class: "warn" };
  if (entry.prunable !== undefined) return { text: "prunable", class: "bad" };
  if (entry.readable === false) return { text: "missing", class: "bad" };
  if (entry.blocking > 0) return { text: entry.blocking + " unsaved", class: "warn" };
  return { text: "clean", class: "ok" };
}

function worktreeActions(entry) {
  // Only a run's own worktree with nothing unsaved is offered; the removal
  // itself checks again, so the screen and the removal cannot disagree.
  if (!entry.removable) return [];
  return [button("Remove", { onClick: async () => {
    try {
      const removal = await api("/api/worktrees/remove", { method: "POST", body: JSON.stringify({ name: entry.name }) });
      clearError();
      note(removal.removed
        ? entry.name + " is gone; its branch " + (entry.branch ?? "") + " still exists."
        : entry.name + " keeps unsaved work — nothing was removed.");
      await loadWorktrees();
    } catch (error) {
      fail(error);
    }
  } })];
}

// --------------------------------------------------------- merge requests

async function loadMerges() {
  try {
    renderMerges(await api("/api/merges"));
    clearError();
  } catch (error) {
    $("merges").replaceChildren(el("p", { class: "notice bad", text: error.message }));
  }
}

function renderMerges(merges) {
  const host = $("merges");
  host.replaceChildren();
  const reread = button("Ask GitLab", { onClick: loadMerges });
  if (merges.configured === false) {
    host.append(el("p", { class: "muted", text: merges.reason ?? "No GitLab project is configured." }));
    host.append(el("p", { class: "muted", text: "Everything else here works without it." }));
    return;
  }
  if (merges.available === false) {
    host.append(el("p", { class: "notice bad", text: merges.error ?? "GitLab did not answer." }));
    host.append(el("p", { class: "muted", text: "This is the only part of the page that needs the network and a token." }));
    host.append(reread);
    return;
  }
  const entries = [...(merges.entries ?? [])].sort((left, right) =>
    Number(right.own) - Number(left.own) || right.iid - left.iid);
  host.append(el("div", { class: "row" }, [
    el("span", { class: "grow muted", text: merges.project + " · " + entries.length + " " + (merges.state ?? "opened")
      + " · " + (merges.ours > 0 ? merges.ours + " ours" : "none of them ours")
      + " · target " + (merges.targetBranch ?? "main") }),
    reread,
  ]));
  host.append(table([
    { label: "MR", value: (entry) => "!" + entry.iid, mono: true },
    { label: "Title", value: (entry) => entry.title },
    { label: "Branch", value: (entry) => entry.sourceBranch, mono: true },
    { label: "Whose", value: (entry) => ({ text: entry.own ? "ours" : (entry.author || "someone"), class: entry.own ? "ok" : "" }) },
    { label: "Merge", value: (entry) => mergeState(entry) },
    { label: "Updated", value: (entry) => when(entry.updatedAt).text },
    { label: "", value: (entry) => entry.webUrl
      ? [el("a", { text: "open", attrs: { href: entry.webUrl, rel: "noreferrer noopener", target: "_blank" } })]
      : [] },
  ], entries, "Nothing is open. A published run appears here as a draft."));
}

function mergeState(entry) {
  if (entry.hasConflicts) return { text: "conflicts", class: "bad" };
  if (entry.state && entry.state !== "opened") return { text: entry.state, class: entry.state === "merged" ? "ok" : "bad" };
  const status = (entry.mergeStatus ?? "").replaceAll("_", " ");
  if (entry.draft) return { text: status && status !== "mergeable" ? "draft · " + status : "draft", class: "warn" };
  return { text: status || "open", class: status === "mergeable" ? "ok" : "" };
}

// -------------------------------------------------------------- settings

function renderSettings(settings) {
  const host = $("settings");
  host.replaceChildren();
  if (!settings) return;
  if (settings.error) {
    host.append(el("p", { class: "notice bad", text: "The local settings file was refused: " + settings.error }));
    host.append(el("p", { class: "muted", text: "Fix the file, or remove the setting with 'etnpilot config unset'." }));
    return;
  }
  // A refused local setting stops the next run. Saying so above the list is
  // the difference between a warning and a surprise an hour later.
  for (const refusal of settings.refusals ?? []) {
    host.append(el("p", { class: "notice bad", text: refusal.path + " — " + refusal.reason }));
  }
  if ((settings.refusals ?? []).length > 0) {
    host.append(el("p", { class: "muted", text: "A run will not start until those are gone." }));
  }

  const filter = el("input", { attrs: { placeholder: "filter by path", "aria-label": "filter settings", value: settingsFilter } });
  filter.addEventListener("input", () => {
    settingsFilter = filter.value;
    settingsLimit = 25;
    renderSettings(state.settings);
  });
  const only = el("input", { attrs: { type: "checkbox", "aria-label": "only changed" } });
  only.checked = changedOnly;
  only.addEventListener("change", () => { changedOnly = only.checked; renderSettings(state.settings); });
  const picker = el("select", { attrs: { "aria-label": "where changes are written" } }, [
    el("option", { text: "write to this project", attrs: { value: "local" } }),
    el("option", { text: "write to ~/.config", attrs: { value: "global" } }),
  ]);
  picker.value = scope;
  picker.addEventListener("change", () => {
    scope = picker.value;
    if (openSetting) { openSetting.scope = scope; renderSettingEditor(); }
  });
  host.append(el("div", { class: "row" }, [
    filter,
    el("label", { class: "check" }, [only, el("span", { text: "only changed" })]),
    el("span", { class: "grow muted", text: (settings.overrides ?? []).length + " changed locally" }),
    picker,
  ]));

  const matching = (settings.entries ?? [])
    .filter((entry) => entry.path.toLowerCase().includes(settingsFilter.trim().toLowerCase()))
    .filter((entry) => !changedOnly || entry.source !== "project");
  const entries = matching.slice(0, settingsLimit);
  host.append(table([
    { label: "Setting", value: (entry) => editSetting(entry), mono: true },
    { label: "Value", value: (entry) => shortValue(entry.value), mono: true },
    { label: "From", value: (entry) => ({ text: sourceLabel(entry.source), class: entry.source === "project" ? "" : "warn" }) },
    { label: "Change", value: (entry) => ({ text: entry.mode, class: entry.mode === "locked" ? "bad" : entry.mode === "stricter-only" ? "warn" : "" }) },
  ], entries, "Nothing matches that filter.", { selected: (entry) => entry.path === openSetting?.entry.path }));
  if (matching.length > entries.length) {
    const more = el("div", { class: "row" }, [
      el("span", { class: "grow muted", text: "Showing " + entries.length + " of " + matching.length + " — filter to narrow them down." }),
      button("Show all " + matching.length, { onClick: () => { settingsLimit = matching.length; renderSettings(state.settings); } }),
    ]);
    host.append(more);
  }
  host.append(el("p", {
    class: "muted",
    text: "Nothing changed here is ever committed: it is written to "
      + (scope === "global" ? "~/.config/etnpilot/config.yaml, for every project." : ".etnpilot/etnpilot.local.yaml, for this project."),
  }));
}

function sourceLabel(source) {
  if (source === "user-local") return "local";
  if (source === "user-global") return "global";
  return "committed";
}

function editSetting(entry) {
  return button(entry.path, { class: "link", onClick: () => {
    if (entry.mode === "locked") {
      // A locked setting does not open at all, and says why.
      fail(new Error(entry.path + " is locked by the committed default; it can only change there."));
      return;
    }
    clearError();
    openSetting = { entry, value: describeValue(entry.value), scope };
    renderSettings(state.settings);
    renderSettingEditor();
  } });
}

function renderSettingEditor() {
  const host = $("setting-editor");
  host.replaceChildren();
  if (!openSetting) return;
  const { entry } = openSetting;
  const value = el("input", { class: "grow mono", attrs: { "aria-label": "value as YAML", value: openSetting.value } });
  value.addEventListener("input", () => { openSetting.value = value.value; });
  const message = el("p", { class: "muted", text: entry.mode + " · default " + describeValue(entry.defaultValue)
    + " · writing " + (openSetting.scope === "global" ? "~/.config, for every project" : "this project, locally") });
  const close = () => { openSetting = undefined; renderSettings(state.settings); renderSettingEditor(); };
  const save = button("Save", { class: "", onClick: async () => {
    try {
      const result = await api("/api/settings/set", {
        method: "POST",
        body: JSON.stringify({ path: entry.path, value: openSetting.value, scope: openSetting.scope }),
      });
      clearError();
      note(result.restartRequired
        ? result.path + " is saved, but this server already opened that file — restart to use it."
        : result.path + " is now " + describeValue(result.effective) + " — " + result.scope + ", and never committed.");
      close();
      await refresh({ force: true });
    } catch (error) {
      // A refusal is shown where the change was made, and the value stays.
      message.className = "notice bad";
      message.textContent = error.message;
    }
  } });
  const reset = button("Back to the default", { onClick: async () => {
    try {
      const result = await api("/api/settings/unset", {
        method: "POST",
        body: JSON.stringify({ path: entry.path, scope: entry.source === "user-global" ? "global" : openSetting.scope }),
      });
      clearError();
      note(result.path + " is back to the committed default: " + describeValue(result.effective) + ".");
      close();
      await refresh({ force: true });
    } catch (error) {
      message.className = "notice bad";
      message.textContent = error.message;
    }
  } });
  const atDefault = entry.source === "project";
  host.append(el("div", { class: "card open" }, [
    el("div", { class: "row" }, [el("span", { class: "grow mono", text: entry.path }), button("Cancel", { onClick: close })]),
    el("div", { class: "row" }, atDefault
      ? [value, save, el("span", { class: "muted", text: "already the committed default" })]
      : [value, save, reset]),
    message,
    el("p", { class: "muted", text: "The value is YAML, so 4, true and ['read'] all mean what they look like." }),
  ]));
}

// --------------------------------------------------------------- the poll

function statusText() {
  if (!state) return "loading…";
  const running = (state.active ?? []).length;
  return "updated " + new Date(state.generatedAt).toLocaleTimeString()
    + (running > 0 ? " · " + running + " running" : "");
}

// Typing must not be thrown away by the poll. While a field has focus or an
// editor is open, the page keeps what is on screen and says it is holding.
function busy() {
  const active = document.activeElement;
  const typing = active && (active.tagName === "INPUT" || active.tagName === "SELECT");
  return Boolean(typing || openSetting);
}

async function refresh({ force = false } = {}) {
  if (busy() && !force) {
    showStatus(statusText() + " · holding while you type");
    return;
  }
  try {
    state = await api("/api/state");
    renderStart();
    renderApprovals(state.approvals.pending);
    renderQueue(state.queue);
    renderRuns(state.runs);
    renderSettings(state.settings);
    renderSettingEditor();
    if (openRun) {
      // A receipt is sealed: what was read stays valid, so it is not refetched.
      renderRunDetail();
    }
    showStatus(statusText());
  } catch (error) {
    fail(error);
  }
}

refresh();
loadWorktrees();
loadMerges();
setInterval(refresh, 5000);
</script>
</body>
</html>
`;
}
