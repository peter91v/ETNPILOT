// Checks, overview, approvals, the queue and runs.
// Client-side code, kept as text and joined by ../page.js into one script. It
// is not a module in the browser: no imports, no build step.
export const CLIENT_RUNS = `// The same registry the terminal interface lists, over the same read path.
// Each row says which of four states it is in — never run, running, what it
// found, or no verdict to give — because three of those look identical on a
// surface that only knows 'ok'.
function renderChecks() {
  const host = $("view-checks");
  host.replaceChildren();
  if (checks === undefined) {
    host.append(panel("Checks", { body: [el("p", { class: "empty", text: "Reading the list…" })] }));
    void loadChecks();
    return;
  }
  const ran = checks.filter((check) => checkResults.has(check.id)).length;
  const failing = checks.filter((check) => checkResults.get(check.id)?.ok === false).length;
  const meta = [
    checks.length + " checks",
    ran === 0 ? "none run yet" : ran + " run",
    failing > 0 ? failing + " failing" : ran > 0 ? "none failing" : "nothing to report",
  ].join(" · ");
  const rows = table([
    { label: "Check", value: (check) => check.title },
    { label: "Result", value: (check) => checkPill(check) },
    { label: "What it found", value: (check) => checkResults.get(check.id)?.summary ?? check.about },
    { label: "Ran", value: (check) => (checkResults.has(check.id) ? when(checkResults.get(check.id).ranAt) : { text: "—" }) },
    { label: "", value: (check) => button(checksRunning.has(check.id) ? "Running…" : "Run", {
      class: "btn small",
      disabled: checksRunning.has(check.id),
      onClick: () => runChecks([check.id]),
    }), actions: true },
  ], checks, "No checks are registered.");
  const head = el("div", { class: "row" }, [
    button("Run them all", {
      class: "btn tonal",
      disabled: checksRunning.size > 0,
      onClick: () => runChecks(checks.map((check) => check.id)),
    }),
    el("span", { class: "muted", text: "Each one reads the project as it is on disk now." }),
  ]);
  host.append(panel("Checks", { meta, body: [head, rows] }));
  for (const check of checks) {
    const result = checkResults.get(check.id);
    if (!result) continue;
    const body = [el("p", {
      class: result.ok === false ? "notice bad" : result.ok === true ? "muted" : "notice",
      text: result.summary,
    })];
    if ((result.findings ?? []).length === 0) {
      body.push(el("p", { class: "empty", text: result.ok === true ? "Nothing to look at." : "It reported no individual findings." }));
    } else {
      body.push(table([
        { label: "", value: (finding) => ({ text: finding.label ?? "", class: finding.tone === "bad" ? "bad" : finding.tone === "warn" ? "warn" : "" }) },
        { label: "Finding", value: (finding) => finding.text },
      ], result.findings, "None."));
    }
    host.append(panel(check.title, { meta: "ran " + when(result.ranAt).text, body }));
  }
}

function checkPill(check) {
  if (checksRunning.has(check.id)) return pill("running", "warn");
  const result = checkResults.get(check.id);
  if (!result) return pill("not run");
  if (result.ok === true) return pill("ok", "ok");
  if (result.ok === false) return pill("findings", "bad");
  return pill("no verdict", "warn");
}

async function loadChecks() {
  try {
    checks = (await api("/api/checks")).checks;
    render();
  } catch (error) {
    fail(error);
  }
}

// One at a time and in order, repainting between them: a check walks the
// working tree, and pretending it is instant would leave the page still.
async function runChecks(ids) {
  for (const id of ids) {
    checksRunning.add(id);
    render();
    try {
      checkResults.set(id, await api("/api/checks/run", { method: "POST", body: JSON.stringify({ id }) }));
      clearError();
    } catch (error) {
      fail(error);
    } finally {
      checksRunning.delete(id);
    }
    render();
  }
}

function renderRuntime() {
  const running = (state?.active ?? []).length;
  const refused = state?.settings?.refusals?.length ?? 0;
  const dot = $("runtime-dot");
  dot.className = refused > 0 ? "dot bad" : running > 0 ? "dot" : holding ? "dot paused" : "dot";
  $("runtime-state").textContent = refused > 0
    ? refused + (refused === 1 ? " setting refused" : " settings refused")
    : running > 0
      ? running + (running === 1 ? " run working" : " runs working")
      : holding ? "holding while you type" : "watching";
  $("runtime-meta").textContent = state
    ? "updated " + new Date(state.generatedAt).toLocaleTimeString() + " · polls every 5s"
    : "";
}

function renderOverview() {
  const host = $("view-overview");
  host.replaceChildren();
  const pending = state.approvals.pending;
  const counts = state.queue.counts ?? {};
  const queued = Object.values(counts).reduce((total, value) => total + value, 0);
  const signed = state.runs.filter((run) => run.signed).length;
  host.append(el("div", { class: "summary-strip" }, [
    summaryCard("Waiting for you", pending.length, {
      accent: pending.length > 0 ? "amber" : "accent",
      hint: pending.length > 0 ? "oldest " + when(pending.at(-1).createdAt).text : "nothing pending",
    }),
    summaryCard("Queue", queued, {
      accent: "blue",
      hint: Object.entries(counts).filter(([, total]) => total > 0).map(([status, total]) => total + " " + status).join(", ") || "empty",
    }),
    summaryCard("Runs", state.runs.length, { accent: "accent", hint: signed + (signed === 1 ? " signed receipt" : " signed receipts") }),
    summaryCard("Working now", (state.active ?? []).length, {
      accent: "amber",
      hint: (state.active ?? [])[0]?.task ?? "nothing started here",
    }),
  ]));
  host.append(el("div", { class: "summary-strip" }, usageCards()));

  // A run that is working says where it is, not just that it is.
  for (const run of state.active ?? []) host.append(runningPanel(run));

  const decisions = panel("Needs your decision", {
    meta: pending.length > 0 ? pending.length + " open" : "clear",
    body: pending.length === 0
      ? [el("p", { class: "empty", text: "Nothing is waiting. A run that needs you will appear here." })]
      : [
          ...pending.slice(0, 4).map((approval) => el("div", { class: "row" }, [
            pill(approval.operationKind, "warn"),
            el("span", { class: "grow mono clip", text: subject(approval), attrs: { title: subject(approval) } }),
            timeSpan("asked", approval.createdAt),
          ])),
          button("Decide them", { class: "btn primary", onClick: () => show("approvals") }),
        ],
  });

  const runs = panel("Recent runs", {
    meta: state.runs.length + " on disk",
    body: [table([
      { label: "Run", value: (run) => run.runId, mono: true },
      { label: "Status", value: (run) => ({ text: run.status, class: run.status === "succeeded" ? "ok" : "bad" }) },
      { label: "Took", value: (run) => run.durationMs === undefined ? "—" : (run.durationMs / 1000).toFixed(1) + "s" },
      { label: "Receipt", value: (run) => run.signed ? "signed" : "unsigned" },
    ], state.runs.slice(0, 5), "No runs have been recorded yet.")],
  });

  host.append(decisions, runs);

  for (const failure of state.recentRunErrors ?? []) {
    host.append(el("p", { class: "notice bad", text: failure.task + " — " + failure.error }));
  }
  if ((state.settings?.refusals ?? []).length > 0) {
    host.append(el("p", { class: "notice bad", text: (state.settings.refusals.length === 1
      ? "1 local setting is refused; a run will not start until it is gone."
      : state.settings.refusals.length + " local settings are refused; a run will not start until they are gone.") }));
  }
}

function usageCards() {
  const described = describeUsage(usage);
  if (!usage || usage.available === false) {
    return [summaryCard("Usage", "—", { hint: usage?.reason ?? "reading…", accent: "line-strong" })];
  }
  if (!described) return [summaryCard("Usage", "0", { unit: "calls", hint: "nothing recorded yet", accent: "line-strong" })];
  return [
    summaryCard("Tokens", described.tokens.toLocaleString(), {
      accent: "blue",
      hint: described.input.toLocaleString() + " in · " + described.output.toLocaleString() + " out",
    }),
    summaryCard("From cache", described.cached.toLocaleString(), { accent: "accent", hint: "read rather than sent again" }),
    summaryCard("Provider calls", described.invocations.toLocaleString(), { accent: "accent", hint: "across every run on disk" }),
    summaryCard("Estimated cost", described.cost ?? "not priced", {
      accent: "amber",
      hint: pricingHint(described),
    }),
  ];
}

// What a run is doing right now: the step, the agent inside it, and how far
// along the plan it is.
function runningPanel(run) {
  const steps = run.steps ?? [];
  const position = steps.length > 0 ? " · step " + Math.min(steps.length, (run.done ?? 0) + 1) + " of " + steps.length : "";
  const body = [
    el("div", { class: "row" }, [
      pill(run.step ? "in " + run.step : "starting", "warn"),
      el("span", { class: "grow", text: run.stepAgent ? "agent " + run.stepAgent : (run.agent ? "agent " + run.agent : "the project's own workflow") }),
      timeSpan("since", run.stepSince ?? run.startedAt),
    ]),
  ];
  if (steps.length > 0) {
    body.push(el("div", { class: "row" }, steps.map((step, index) => pill(
      step,
      run.step === step ? "warn" : index < (run.done ?? 0) ? "ok" : "",
    ))));
  }
  if (run.error) body.push(el("p", { class: "notice bad", text: run.failedStep + ": " + run.error }));
  return panel(run.task, { meta: "working" + position, open: true, body });
}

function subject(approval) {
  const details = approval.details ?? {};
  return details.command ?? details.url ?? details.file ?? details.tool ?? "(no detail recorded)";
}

function renderApprovals() {
  const host = $("view-approvals");
  host.replaceChildren();
  const list = state.approvals.pending;
  if (list.length === 0) {
    host.append(panel("Nothing is waiting", { body: [el("p", { class: "empty", text: "Runs continue until one of them needs a decision." })] }));
    return;
  }
  for (const approval of list) {
    const details = approval.details ?? {};
    const actor = el("input", {
      class: "inline",
      attrs: { placeholder: "your name", "aria-label": "reviewer", title: "Recorded in the receipt as you typed it: this page never checked who you are." },
    });
    // Remembered per device, because typing your name into a phone for every
    // decision is how people stop typing it at all. It is still self-asserted;
    // nothing here authenticates anybody.
    actor.value = reviewerName();
    actor.addEventListener("change", () => rememberReviewer(actor.value));
    const reason = el("input", { class: "grow", attrs: { placeholder: "reason (optional)", "aria-label": "reason" } });
    const decide = (decision) => act(
      () => api("/api/approvals/decide", {
        method: "POST",
        body: JSON.stringify({ id: approval.id, decision, actor: actor.value, reason: reason.value }),
      }),
      approval.operationKind + " " + (decision === "approve" ? "approved" : "rejected") + " — recorded in the receipt.",
    );
    const body = [];
    if (details.command) body.push(detailBlock("Command", details.command));
    if (details.file) body.push(detailBlock("File", details.file));
    if (details.url) body.push(detailBlock("URL", details.url));
    if (details.tool) body.push(detailBlock("Tool", details.tool));
    if (details.arguments) body.push(detailBlock("Arguments", details.arguments));
    // What the change is, not how big it is. Rendered with the same reader the
    // worktree view uses, so a diff looks like a diff wherever it appears.
    if (details.diff) {
      body.push(el("p", { class: "muted", text: "Changes" }));
      body.push(unifiedDiffView(details.diff));
    }
    if (details.truncated) {
      body.push(el("p", { class: "muted", text: "Truncated for display; see 'etnpilot approval show " + approval.id + "'." }));
    }
    if (details.redacted) {
      body.push(el("p", { class: "muted", text: "Credential-looking text was masked by approval.inbox.redactSecrets." }));
    }
    // Why the run is asking at all: the rule that stopped the operation,
    // recorded with the approval and shown wherever it is answered.
    if (approval.policy) {
      const effect = approval.policy.effect ?? "human";
      body.push(el("p", { class: "row" }, [
        pill(effect, effect === "deny" ? "bad" : effect === "allow" ? "ok" : "warn"),
        el("span", { class: "muted", text: "← " + (approval.policy.rule ? "rule '" + approval.policy.rule + "'" : "the section default") }),
      ]));
    }
    const approve = button("Approve once", { class: "btn primary", onClick: () => decide("approve") });
    // The same yes, with a reach: this operation and others like it until the
    // run ends. Offered only where a scope means something — twelve writes
    // under one directory were twelve identical questions, and a tool that
    // asks twelve times is one people switch off.
    const forRun = ["write", "shell"].includes(approval.operationKind)
      ? [button("Approve for this run", {
        class: "btn tonal",
        title: "Covers operations like this one until the run ends. A page fetched from outside cancels it.",
        onClick: () => decide("approve-for-run"),
      })]
      : [];
    const reject = button("Reject", { class: "btn danger", onClick: () => decide("reject") });
    body.push(el("div", { class: "row" }, [actor, reason, approve, ...forRun, reject]));
    const fingerprint = details.fingerprint ?? "";
    body.push(el("p", {
      class: "muted mono",
      text: "fingerprint " + (fingerprint ? fingerprint.slice(0, 16) + "…" : "—"),
      attrs: { title: fingerprint },
    }));
    const meta = el("span", { class: "panel-meta" }, [
      el("span", { text: "agent " + (approval.agent ?? "unknown") + " · run " + (approval.runId ?? "—") + " · " }),
      el("span", { text: when(approval.expiresAt).text, attrs: { title: when(approval.expiresAt).title } }),
    ]);
    const card = panel(approval.operationKind.toUpperCase(), { meta, body });
    host.append(card);
  }
}

const RESUMABLE = ["failed", "canceled", "orphaned"];
const CANCELABLE = ["queued", "retry_scheduled", "running", "cancel_requested"];

function renderQueue() {
  const host = $("view-queue");
  host.replaceChildren();
  const counts = state.queue.counts ?? {};
  const summary = Object.entries(counts).map(([status, total]) => status + " " + total).join(" · ");
  host.append(panel("Jobs", {
    meta: summary || "empty",
    body: [table([
      { label: "Job", value: (job) => job.id.slice(0, 8), mono: true },
      { label: "Kind", value: (job) => job.kind },
      { label: "Status", value: (job) => pill(job.status, queueTone(job.status)) },
      { label: "Attempts", value: (job) => (job.attempts ?? 0) + " of " + (job.maxAttempts ?? 1) },
      { label: "Updated", value: (job) => when(job.updatedAt).text },
      { label: "", value: (job) => jobActions(job) },
    ], state.queue.jobs ?? [], "No jobs have been queued.")],
  }));
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

function queueTone(status) {
  if (status === "succeeded") return "ok";
  if (status === "failed" || status === "orphaned") return "bad";
  if (status === "running") return "warn";
  return "";
}

function renderRuns() {
  const host = $("view-runs");
  host.replaceChildren();
  host.append(panel("All runs", {
    meta: state.runs.length + " on disk",
    body: [table([
      { label: "Run", value: (run) => openReceipt(run), mono: true },
      { label: "Status", value: (run) => pill(run.status, run.status === "succeeded" ? "ok" : "bad") },
      { label: "Mode", value: (run) => run.mode },
      { label: "Sealed", value: (run) => ({ text: run.terminal ? "yes" : "no", class: run.terminal ? "ok" : "warn" }) },
      { label: "Signed", value: (run) => run.signed ? "yes" : "no" },
      { label: "Approvals", value: (run) => String(run.approvals) },
      { label: "Took", value: (run) => run.durationMs === undefined ? "—" : (run.durationMs / 1000).toFixed(1) + "s" },
      { label: "Receipt", value: (run) => (run.hash ?? "—").slice(0, 12), mono: true },
    ], state.runs, "No runs have been recorded yet.", { selected: (run) => run.receiptFile === openRun?.file })],
  }));
  if (openRun) host.append(renderRunDetail());
}

function stepDuration(step) {
  const from = Date.parse(step.startedAt);
  const to = Date.parse(step.finishedAt);
  if (Number.isNaN(from) || Number.isNaN(to)) return "—";
  return ((to - from) / 1000).toFixed(1) + "s";
}

// Tokens and cost, in the same words everywhere they are shown.
function describeUsage(summary) {
  if (!summary || summary.invocations === undefined) return undefined;
  const cost = summary.estimatedCost === undefined
    ? undefined
    : (summary.currency ? summary.currency + " " : "") + summary.estimatedCost.toFixed(4);
  return {
    tokens: (summary.inputTokens ?? 0) + (summary.outputTokens ?? 0),
    input: summary.inputTokens ?? 0,
    output: summary.outputTokens ?? 0,
    cached: summary.cacheReadTokens ?? 0,
    invocations: summary.invocations ?? 0,
    cost,
    unpriced: summary.unpricedInvocations ?? 0,
    unpricedModels: summary.unpricedModels ?? [],
  };
}

// A cost is written into the receipt when the call happens, so a rate added
// afterwards never reaches a call already on disk. Saying only 'not priced'
// sends someone to set a rate they may already have set.
function pricingHint(described) {
  const models = described.unpricedModels;
  if (models.length === 0) return described.cost ? "from observability.pricing" : "set observability.pricing to see it";
  const named = models.slice(0, 2).map((row) => "'" + row.model + "'").join(", ");
  const more = models.length > 2 ? " and " + (models.length - 2) + " more" : "";
  const calls = described.unpriced + (described.unpriced === 1 ? " call has" : " calls have");
  return models.every((row) => row.pricedSince)
    ? calls + " no cost: they ran before the rate for " + named + " was set"
    : calls + " no rate: set observability.pricing.models for " + named + more;
}

// One row per agent invocation, indented by how deep it was spawned. Each
// row is a button: opening it does not navigate anywhere, it reveals the full
// text this agent produced — the receipt already holds it, untruncated, so
// there is nothing left to fetch.
function agentTreeRows(nodes, depth) {
  const rows = [];
  for (const node of nodes) {
    const expanded = expandedAgents.has(node.runId);
    const label = (node.workflowStep ? node.workflowStep + " · " : "") + node.agent
      + (node.provider ? " (" + node.provider + ")" : "");
    const row = el("div", { class: "agent-row", attrs: { style: "padding-left:" + (depth * 20) + "px" } }, [
      button((expanded ? "▾ " : "▸ ") + label, {
        class: "btn link agent-toggle",
        onClick: () => {
          if (expanded) expandedAgents.delete(node.runId); else expandedAgents.add(node.runId);
          render();
        },
      }),
      pill(node.status, node.status === "succeeded" ? "ok" : node.status === "failed" ? "bad" : "warn"),
      el("span", { class: "muted", text: agentDuration(node.durationMs) }),
    ]);
    rows.push(row);
    if (expanded) rows.push(agentDetail(node, depth));
    if (node.children.length > 0) rows.push(...agentTreeRows(node.children, depth + 1));
  }
  return rows;
}

function agentDuration(durationMs) {
  return typeof durationMs === "number" ? (durationMs / 1000).toFixed(1) + "s" : "—";
}

// The full reasoning, exactly as the agent produced it and the receipt holds
// it — not a preview, not a truncation. What it called and what came back
// from each call sits right beside it.
function agentDetail(node, depth) {
  const parts = [];
  parts.push(node.text
    ? el("pre", { class: "agent-text", text: node.text })
    : el("p", { class: "muted", text: node.error ? "It produced no text; see the error below." : "It produced no text." }));
  if (node.error) parts.push(el("p", { class: "notice bad", text: node.error }));
  if (node.toolCalls?.length > 0) {
    parts.push(table([
      { label: "Tool", value: (call) => call.tool ?? "—", mono: true },
      { label: "Result", value: (call) => pill(call.ok === false ? "refused" : "ran", call.ok === false ? "bad" : "ok") },
      { label: "Reason", value: (call) => ({ text: call.error ?? "", class: "bad" }) },
    ], node.toolCalls, "No tool calls."));
  }
  if (node.usage) parts.push(usagePanelBody(node.usage));
  return el("div", {
    class: "agent-detail",
    attrs: { style: "padding-left:" + (depth * 20 + 20) + "px" },
  }, parts);
}

function usagePanelBody(summary) {
  const described = describeUsage(summary);
  if (!described) return el("p", { class: "muted", text: "No provider usage was recorded for this run." });
  return el("div", {}, [
    el("p", { class: "muted", text: "Usage" }),
    pairs([
      ["Tokens", described.tokens.toLocaleString() + " (" + described.input.toLocaleString() + " in, " + described.output.toLocaleString() + " out)"],
      ["Cached", described.cached > 0 ? described.cached.toLocaleString() + " read from cache" : "none"],
      ["Provider calls", String(described.invocations)],
      ["Estimated cost", described.cost ? described.cost : "not priced"],
      ...(described.unpricedModels.length > 0 || !described.cost ? [["", pricingHint(described)]] : []),
      ...(described.unpriced > 0 && described.cost ? [["Unpriced calls", String(described.unpriced)]] : []),
    ]),
  ]);
}

async function verifyOpenReceipt(file) {
  verification = { file: undefined, pending: true };
  render();
  try {
    verification = await api("/api/verify/" + encodeURIComponent(file));
    clearError();
  } catch (error) {
    verification = undefined;
    fail(error);
  }
  render();
}

function openReceipt(run) {
  return button(run.runId, { class: "btn link", onClick: async () => {
    try {
      openRun = { file: run.receiptFile, run, receipt: await api("/api/runs/" + encodeURIComponent(run.receiptFile)) };
      // One run's verdict must never be left attached to another run's file.
      verification = undefined;
      expandedAgents = new Set();
      clearError();
      render();
      renderPageActions();
      $("view-runs").querySelector(".panel.open")?.scrollIntoView({ block: "nearest" });
    } catch (error) {
      fail(error);
    }
  } });
}

// What was sealed, not a summary kept somewhere else: the branch and sandbox,
// the merge rehearsal, who decided each approval, and which settings layers
// were in effect.
function renderRunDetail() {
  const { run, receipt } = openRun;
  const terminal = receipt.terminal ?? {};
  const sealed = Boolean(receipt.terminal);
  const status = receipt.outcome?.status ?? run.status;
  const body = [
    pairs([
      ["Status", status, status === "succeeded" ? "ok" : status === "incomplete" || status === "running" ? "warn" : "bad"],
      ["Mode", run.mode],
      ["Branch", terminal.workspace?.branch ?? "—"],
      // Where the files are. A run in a worktree writes them there, uncommitted
      // unless it published, and the checkout shows nothing.
      ["Workspace", terminal.workspace?.path ?? (terminal.workspace?.managed === false ? "the checkout itself" : "—"), "mono"],
      ["Sandbox", terminal.workspace?.sandbox?.image ?? "—"],
      ["Receipt", receipt.file],
      ["Entries", String(receipt.entries.length)],
      ["Signature", run.signed ? "signed" : "unsigned", run.signed ? "ok" : "warn"],
      // A receipt that was never sealed has no hash of its own; the last
      // entry's chain hash is not the run's, and showing it as one would be a
      // claim about evidence that does not exist.
      ["Hash", sealed ? (run.hash ?? "—") : "—", "mono"],
    ]),
  ];
  // Why it ended, before anything else: a reviewer opening a failed run is
  // asking exactly this.
  const outcome = openRun.receipt.outcome ?? { reasons: [], steps: [] };
  if (outcome.reasons.length > 0) {
    body.push(el("p", { class: "muted", text: status === "succeeded" ? "Worth knowing" : "Why it ended" }));
    for (const reason of outcome.reasons) {
      body.push(el("p", {
        class: reason.kind === "publication" || reason.kind === "blocked" ? "notice" : "notice bad",
        text: (reason.step ? reason.step + ": " : "") + reason.text
          + (reason.attempts > 1 ? " (after " + reason.attempts + " attempts)" : ""),
      }));
    }
  }
  if (outcome.steps.length > 0) {
    body.push(el("p", { class: "muted", text: "Steps" }));
    body.push(table([
      { label: "Step", value: (step) => step.id, mono: true },
      { label: "Status", value: (step) => pill(step.status, step.status === "succeeded" ? "ok" : step.status === "failed" ? "bad" : "warn") },
      { label: "Attempts", value: (step) => String(step.attempts ?? 0) },
      { label: "Took", value: (step) => stepDuration(step) },
      { label: "Error", value: (step) => ({ text: step.error ?? "", class: "bad" }) },
    ], outcome.steps, "None recorded."));
  }
  // The agents that ran, as the tree they ran in: each row is what one agent
  // invocation actually did, click it open to read the full text rather than
  // the one-line summary above.
  if (outcome.agents?.length > 0) {
    body.push(el("p", { class: "muted", text: "Agents" }));
    body.push(el("div", { class: "agent-tree" }, agentTreeRows(outcome.agents, 0)));
  }
  // What it did, not only that it succeeded: a run told to write a file that
  // wrote none is a run whose 'succeeded' needs reading twice.
  if (outcome.tools) {
    body.push(el("p", { class: "muted", text: "Tools it used" }));
    body.push(table([
      { label: "Tool", value: (row) => row.tool, mono: true },
      { label: "Ran", value: (row) => String(row.ok) },
      { label: "Refused", value: (row) => ({ text: String(row.failed), class: row.failed > 0 ? "bad" : "" }) },
      { label: "First reason", value: (row) => ({ text: row.error ?? "", class: "bad" }) },
    ], outcome.tools, "None."));
  }
  if (outcome.usage) body.push(usagePanelBody(outcome.usage));
  // Clean, conflicting, or never attempted: three answers, and the reader
  // gives the same one here, in the terminal, and on the command line.
  const rehearsal = receipt.outcome?.rehearsal;
  if (rehearsal) {
    body.push(el("div", { class: "row" }, [
      el("span", { class: "muted", text: "Merge rehearsal" }),
      pill(rehearsal.text, rehearsal.state === "clean" ? "ok" : rehearsal.state === "conflicts" ? "bad" : "warn"),
    ]));
    if (rehearsal.error) body.push(el("p", { class: "muted mono", text: rehearsal.error }));
  }
  const train = terminal.git?.mergeTrain;
  for (const collision of train?.conflicts ?? []) {
    body.push(el("p", { class: "notice", text: "Would collide with !" + collision.iid + " " + collision.title + " — " + (collision.files ?? []).join(", ") }));
  }
  const approvals = receipt.entries.flatMap((entry) => entry.approvals ?? []);
  if (approvals.length > 0) {
    body.push(el("p", { class: "muted", text: "Approvals (" + approvals.length + ")" }));
    body.push(table([
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
    body.push(el("p", { class: "muted", text: "Settings in effect" }));
    body.push(el("p", { class: "mono", text: (terminal.settings.layers ?? []).map((layer) => layer.source).join(" → ") }));
    body.push(overrides.length === 0
      ? el("p", { class: "ok", text: "the committed default, unchanged" })
      : el("p", { class: "warn", text: overrides.length + " changed locally: " + overrides.join(", ") }));
  }
  if (terminal.error) body.push(detailBlock("Error", terminal.error));
  // Whether the receipt is what it claims is a different question from what
  // it says, so it is asked for rather than assumed — and until it is asked,
  // the panel offers the button instead of implying either answer.
  body.push(el("p", { class: "muted", text: "Is this receipt what it claims?" }));
  if (verification === undefined || verification.file !== receipt.file) {
    body.push(el("div", { class: "row" }, [
      button("Verify", {
        class: "btn tonal",
        disabled: verification !== undefined && verification.pending === true,
        onClick: () => verifyOpenReceipt(receipt.file),
      }),
      el("span", { class: "muted", text: verification?.pending ? "Checking…" : "Rereads the file and rebuilds its hash chain." }),
    ]));
  } else {
    body.push(el("div", { class: "row" }, [
      pill(verification.valid ? "verified" : "does not verify", verification.tone),
      ...(verification.encoding ? [el("span", { class: "muted", text: verification.encoding + " hashing" })] : []),
    ]));
    body.push(el("p", { class: verification.valid ? "muted" : "notice bad", text: verification.text }));
  }
  body.push(el("div", { class: "row" }, [button("Close", { onClick: () => { openRun = undefined; verification = undefined; expandedAgents = new Set(); render(); renderPageActions(); } })]));
  // What the panel says about the receipt has to be what the receipt is: the
  // header claimed 'sealed' over a note saying it never was.
  const meta = sealed ? "sealed receipt" : status === "running" ? "still running" : "receipt not sealed";
  return panel(run.runId, { meta, body, open: true });
}

async function loadWorktrees({ notify = false } = {}) {
  try {
    worktrees = await api("/api/worktrees");
    if (worktreeChanges && !(worktrees.entries ?? []).some((entry) => entry.name === worktreeChanges.name)) {
      worktreeChanges = undefined;
      worktreeDiff = undefined;
    }
    clearError();
    if (notify) toast("The worktrees were read again.");
  } catch (error) {
    worktrees = { available: false, error: error.message, entries: [] };
  }
  if (!state) return;
  renderNav();
  if (view === "worktrees") renderWorktrees();
}
`;
