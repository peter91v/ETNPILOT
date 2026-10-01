// The list of all runs, and the filter above it.

// What the list is narrowed to. It lives here, not in the table, so typing in
// the box does not rebuild the box.
const runFilter = { text: "", status: "", open: false };

function filteredRuns() {
  const text = runFilter.text.trim().toLowerCase();
  return state.runs.filter((run) => {
    if (runFilter.status === "unsealed" && run.terminal) return false;
    if (runFilter.status && runFilter.status !== "unsealed" && run.status !== runFilter.status) return false;
    if (!text) return true;
    return [run.runId, run.status, run.mode, run.branch, run.receiptFile].some((field) => String(field ?? "").toLowerCase().includes(text));
  });
}

function runTable() {
  const rows = filteredRuns();
  const empty = state.runs.length > 0 ? "No loaded run matches. Clear the filter to see all " + state.runs.length + "." : "No runs have been recorded yet.";
  return table([
    { label: "Run", value: (run) => openReceipt(run), mono: true },
    { label: "Status", value: (run) => pill(run.status, run.status === "succeeded" ? "ok" : "bad") },
    { label: "Mode", value: (run) => run.mode },
    { label: "Sealed", value: (run) => ({ text: run.terminal ? "yes" : "no", class: run.terminal ? "ok" : "warn" }) },
    { label: "Signed", value: (run) => run.signed ? "yes" : "no" },
    { label: "Approvals", value: (run) => String(run.approvals) },
    { label: "Took", value: (run) => run.durationMs === undefined ? "—" : (run.durationMs / 1000).toFixed(1) + "s" },
    { label: "Receipt", value: (run) => (run.hash ?? "—").slice(0, 12), mono: true },
  ], rows, empty, { selected: (run) => run.receiptFile === openRun?.file });
}

function runFilterBar(tableHost, count) {
  const search = el("input", { attrs: { type: "search", id: "run-filter", placeholder: "Filter by id, branch or status", "aria-label": "Filter runs", autocomplete: "off", value: runFilter.text } });
  search.value = runFilter.text;
  const status = el("select", { attrs: { id: "run-status", "aria-label": "Filter runs by status" } },
    [["", "Any status"], ["succeeded", "Succeeded"], ["failed", "Failed"], ["incomplete", "Incomplete"], ["unsealed", "Not sealed"]]
      .map(([value, label]) => el("option", { text: label, attrs: { value } })));
  status.value = runFilter.status;
  const counter = el("span", { class: "muted", attrs: { "aria-live": "polite" }, text: count() });
  const redraw = () => {
    tableHost.replaceChildren(runTable());
    counter.textContent = count();
  };
  search.addEventListener("input", () => { runFilter.text = search.value; redraw(); });
  status.addEventListener("change", () => { runFilter.status = status.value; redraw(); });
  return el("div", { class: "chips", attrs: { role: "search" } }, [search, status, counter]);
}

function renderRuns() {
  const host = $("view-runs");
  host.replaceChildren();
  const tableHost = el("div", {}, [runTable()]);
  const count = () => filteredRuns().length === state.runs.length ? "" : filteredRuns().length + " of " + state.runs.length + " loaded";
  host.append(panel("All runs", {
    meta: runsMeta(),
    body: [runFilterBar(tableHost, count), tableHost,
      ...(runsHidden() > 0 && runLimit < 500 ? [button("Show " + Math.min(50, runsHidden()) + " more", { class: "btn tonal", onClick: () => { runLimit = Math.min(500, runLimit + 50); refresh({ force: true }); } })] : [])],
  }));
  if (openRun) host.append(renderRunDetail());
}
