// A single self-contained page: no framework, no CDN, no build step. Every
// value from a run is inserted with textContent, never as markup, because all
// of it is text an agent controlled.
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
  }
  h1 { font-size: 17px; margin: 0; letter-spacing: -0.01em; }
  main { padding: 16px; max-width: 980px; margin: 0 auto; display: grid; gap: 24px; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); margin: 0 0 10px; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 14px; margin-bottom: 10px; }
  .row { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; }
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
  button.approve { border-color: var(--ok); color: var(--ok); }
  button.reject { border-color: var(--bad); color: var(--bad); }
  input {
    font: inherit; padding: 6px 9px; border-radius: 7px;
    border: 1px solid var(--line); background: var(--bg); color: var(--ink); min-width: 0;
  }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { color: var(--muted); font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; }
  td.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
  .ok { color: var(--ok); } .warn { color: var(--warn); } .bad { color: var(--bad); }
  .empty { color: var(--muted); font-size: 14px; padding: 6px 0; }
  #error { color: var(--bad); font-size: 13px; }
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
    <h2>Pending approvals</h2>
    <div id="approvals"></div>
  </section>
  <section>
    <h2>Workflow queue</h2>
    <div id="queue"></div>
  </section>
  <section>
    <h2>Runs</h2>
    <div id="runs"></div>
  </section>
</main>
<script>
const TOKEN = ${JSON.stringify(token)};
const $ = (id) => document.getElementById(id);

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

function renderApprovals(list) {
  const host = $("approvals");
  host.replaceChildren();
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
        await refresh();
      } catch (error) {
        $("error").textContent = error.message;
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

function table(columns, rows, emptyText) {
  if (rows.length === 0) return el("p", { class: "empty", text: emptyText });
  const head = el("tr", {}, columns.map((column) => el("th", { text: column.label })));
  const body = rows.map((row) => el("tr", {}, columns.map((column) => {
    const value = column.value(row);
    return el("td", { class: column.mono ? "mono" : (value.class ?? ""), text: value.text ?? value });
  })));
  return el("table", {}, [el("thead", {}, [head]), el("tbody", {}, body)]);
}

function renderQueue(queue) {
  const host = $("queue");
  host.replaceChildren();
  const counts = Object.entries(queue.counts ?? {}).map(([status, total]) => status + " " + total).join(" · ");
  host.append(el("p", { class: "muted", text: counts || "empty" }));
  host.append(table([
    { label: "Job", value: (job) => job.id.slice(0, 8), mono: true },
    { label: "Kind", value: (job) => job.kind },
    { label: "Status", value: (job) => job.status },
    { label: "Attempts", value: (job) => String(job.attempts ?? 0) },
    { label: "Updated", value: (job) => when(job.updatedAt).text },
  ], queue.jobs ?? [], "No jobs have been queued."));
}

function renderRuns(runs) {
  const host = $("runs");
  host.replaceChildren();
  host.append(table([
    { label: "Run", value: (run) => run.runId, mono: true },
    { label: "Status", value: (run) => ({ text: run.status, class: run.status === "succeeded" ? "ok" : "bad" }) },
    { label: "Mode", value: (run) => run.mode },
    { label: "Sealed", value: (run) => ({ text: run.terminal ? "yes" : "no", class: run.terminal ? "ok" : "warn" }) },
    { label: "Signed", value: (run) => run.signed ? "yes" : "no" },
    { label: "Approvals", value: (run) => String(run.approvals) },
    { label: "Duration", value: (run) => run.durationMs === undefined ? "—" : (run.durationMs / 1000).toFixed(1) + "s" },
    { label: "Receipt", value: (run) => (run.hash ?? "—").slice(0, 12), mono: true },
  ], runs, "No runs have been recorded yet."));
}

async function refresh() {
  try {
    const state = await api("/api/state");
    renderApprovals(state.approvals.pending);
    renderQueue(state.queue);
    renderRuns(state.runs);
    $("status").textContent = "updated " + new Date(state.generatedAt).toLocaleTimeString();
    $("error").textContent = "";
  } catch (error) {
    $("error").textContent = error.message;
  }
}

refresh();
setInterval(refresh, 5000);
</script>
</body>
</html>
`;
}
