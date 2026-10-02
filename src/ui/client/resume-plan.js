// "Could this run be resumed?" for a run that did not succeed: the plan, read
// only. Nothing here starts anything.

let resumePlan;

async function loadResumePlan(file) {
  resumePlan = { file, pending: true };
  render();
  try {
    resumePlan = { file, ...(await api("/api/resume-plan?file=" + encodeURIComponent(file))) };
    clearError();
  } catch (error) {
    resumePlan = undefined;
    fail(error);
  }
  render();
}

function resumePlanRows(receipt, run) {
  if (run.status === "succeeded" || run.status === "running") return [];
  const rows = [el("p", { class: "muted", text: "Could this run be continued?" })];
  if (resumePlan === undefined || resumePlan.file !== receipt.file) {
    rows.push(el("div", { class: "row" }, [
      button("Check", { class: "btn tonal", onClick: () => loadResumePlan(receipt.file) }),
      el("span", { class: "muted", text: "Reads the receipt and the workspace; changes and runs nothing." }),
    ]));
    return rows;
  }
  if (resumePlan.pending) {
    rows.push(el("p", { class: "muted", text: "Checking…" }));
    return rows;
  }
  rows.push(el("div", { class: "row" }, [
    pill(resumePlan.resumable ? "could be resumed" : "cannot be resumed", resumePlan.resumable ? "ok" : "warn"),
    el("span", { class: "muted", text: "Resuming itself is not available yet; this is the plan." }),
  ]));
  for (const step of resumePlan.steps ?? []) {
    rows.push(el("div", { class: "row" }, [
      pill(step.action === "reuse" ? "reuse" : "run again", step.action === "reuse" ? "ok" : "warn"),
      el("span", { class: "grow mono", text: step.id }),
      el("span", { class: "muted", text: step.action === "reuse" ? (step.effect ?? "") : (step.reason ?? "") }),
    ]));
  }
  for (const refusal of resumePlan.refusals ?? []) {
    rows.push(el("p", { class: "notice bad", text: refusal.message }));
  }
  return rows;
}
