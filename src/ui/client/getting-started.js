// A short list for a project that has not run anything yet: what is left
// before the first run, each with the place to do it. It disappears once a
// run exists, and each step's state is read, not remembered, so it can never
// say "done" about something that is not.

let startedAccounts = false;

function gettingStarted() {
  if ((state.runsTotal ?? state.runs.length) > 0) return [];
  // The provider step needs to know who is signed in; read it once, then draw again.
  if (!startedAccounts && !accountsData) {
    startedAccounts = true;
    loadAccounts().then(() => { if (view === "overview") render(); });
  }
  const signedIn = (accountsData?.services ?? []).some((service) => service.connected && ["anthropic", "openai"].includes(service.id));
  const steps = [
    { done: signedIn, unknown: !accountsData, text: "Give ETNPilot a provider key", hint: "Sign in on the Accounts page, or set the key in the environment.", view: "accounts", label: "Accounts" },
    { done: runReadiness.ready, text: "Commit the project once", hint: runReadiness.ready ? "Runs work in a separate worktree." : runReadiness.message, view: "checks", label: "Checks" },
    { done: false, text: "Start a first run", hint: "Ask a question in Chat, or give an agent a task.", view: "chat", label: "Chat" },
  ];
  const done = steps.filter((step) => step.done).length;
  return [panel("Getting started", {
    meta: done + " of " + steps.length,
    body: steps.map((step) => el("div", { class: "row" }, [
      pill(step.unknown ? "…" : step.done ? "done" : "to do", step.done ? "ok" : "warn"),
      el("span", { class: "grow", text: step.text + " — " + step.hint }),
      ...(step.done ? [] : [button(step.label, { class: "btn small", onClick: () => show(step.view) })]),
    ])),
  })];
}
