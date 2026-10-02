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

// Starts the resumption the plan describes. The server plans again first, so a
// plan that has gone stale is refused with its reasons, not started.
async function startResume(file, { resetPartial = false } = {}) {
  try {
    const started = await api("/api/runs/resume", { method: "POST", body: JSON.stringify({ file, ...(resetPartial ? { resetPartial: true } : {}) }) });
    clearError();
    toast("Resuming " + started.resumedFrom + ": it appears under working now.");
    resumePlan = undefined;
    openRun = undefined;
    await refresh({ force: true });
    show("overview");
  } catch (error) {
    fail(error);
    resumePlan = undefined;
  }
  render();
}

// The worktree holds what the step that stopped had written. Going on from how
// the last finished step left it means discarding that, which is the one
// irreversible thing resuming can do, so it is listed and asked.
async function discardAndResume(file, offer) {
  const shown = offer.files.slice(0, 12).map((entry) => entry.status + " " + entry.path);
  const more = offer.files.length > shown.length ? " … and " + (offer.files.length - shown.length) + " more" : "";
  const yes = await askConfirm({
    title: "Discard what the stopped step left?",
    text: "These " + offer.files.length + " files in the run's worktree go back to how the last finished step left them: " + shown.join("; ") + more + ". This cannot be undone.",
    yes: "Discard and resume",
  });
  if (yes) await startResume(file, { resetPartial: true });
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
    el("span", { class: "muted", text: resumePlan.resumable ? "Nothing has been started yet." : "This is the plan; nothing was changed." }),
    ...(resumePlan.resumable ? [button("Resume", { class: "btn primary", onClick: () => startResume(receipt.file) })] : []),
  ]));
  if (resumePlan.failure) {
    rows.push(el("p", { class: "muted", text: "It stopped" + (resumePlan.failure.step ? " in '" + resumePlan.failure.step + "'" : "") + (resumePlan.failure.error ? ": " + resumePlan.failure.error : "") }));
  }
  for (const note of resumePlan.notes ?? []) rows.push(el("p", { class: "muted", text: note }));
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
  if (resumePlan.resetOffer) {
    rows.push(el("div", { class: "row" }, [
      el("span", { class: "muted", text: resumePlan.resetOffer.files.length + " files were left by the step that stopped." }),
      button("Discard them and resume", { class: "btn tonal", onClick: () => discardAndResume(receipt.file, resumePlan.resetOffer) }),
    ]));
  }
  return rows;
}
