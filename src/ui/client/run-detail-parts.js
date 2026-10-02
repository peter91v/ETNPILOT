// The sections of a run's detail, each the nodes for one question a reader asks.
function reasonRows(outcome, status) {
  const body = [];
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
  return body;
}

function stepRows(outcome) {
  const body = [];
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
  return body;
}

function toolRows(outcome) {
  const body = [];
  if (outcome.tools) {
    body.push(el("p", { class: "muted", text: "Tools it used" }));
    body.push(table([
      { label: "Tool", value: (row) => row.tool, mono: true },
      { label: "Ran", value: (row) => String(row.ok) },
      { label: "Failed", value: (row) => ({ text: String(row.failed), class: row.failed > 0 ? "warn" : "" }) },
      { label: "Refused", value: (row) => ({ text: String(row.refused ?? 0), class: row.refused > 0 ? "bad" : "" }) },
      { label: "First reason", value: (row) => ({ text: row.error ?? "", class: "bad" }) },
    ], outcome.tools, "None."));
  }
  return body;
}

function approvalRows(receipt) {
  const body = [];
  const approvals = receipt.entries.flatMap((entry) => entry.approvals ?? []);
  if (approvals.length > 0) {
    body.push(el("p", { class: "muted", text: "Approvals (" + approvals.length + ")" }));
    body.push(table([
      { label: "Operation", value: (approval) => String(approval.operationKind ?? "—") },
      { label: "What", value: (approval) => ({ text: String(approval.subject ?? ""), class: "mono" }) },
      { label: "Decision", value: (approval) => ({
        text: String(approval.decision ?? "—"),
        class: approval.decision === "approve-once" ? "ok" : "bad",
      }) },
      // A person, or the rule that decided without asking one.
      { label: "Decided by", value: (approval) => decidedBy(approval) },
      { label: "Why", value: (approval) => ({ text: String(approval.reason ?? ""), class: approval.decision === "approve-once" ? "" : "bad" }) },
      { label: "At", value: (approval) => when(approval.at ?? approval.evidence?.decidedAt).text },
    ], approvals, "None."));
  }
  return body;
}

function settingsRows(settings) {
  const body = [];
  if (settings) {
    const overrides = settings.overrides ?? [];
    body.push(el("p", { class: "muted", text: "Settings in effect" }));
    body.push(el("p", { class: "mono", text: (settings.layers ?? []).map((layer) => layer.source).join(" → ") }));
    body.push(overrides.length === 0
      ? el("p", { class: "ok", text: "the committed default, unchanged" })
      : el("p", { class: "warn", text: overrides.length + " changed locally: " + overrides.join(", ") }));
  }
  return body;
}
