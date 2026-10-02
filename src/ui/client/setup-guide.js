// The first-time setup, one step after the other, on the overview: which
// provider runs by default (and its key), and where the work is published
// (GitLab address, project, user name, token). Each step is read from the
// server, so it can only say "done" about something that is; the answers go to
// the same module the terminal's 'etnpilot init' asks.

let setupData;
let setupError;
let setupStarted = false;
let setupBusy = false;
const setupDraft = { provider: "", key: "", host: "", project: "", user: "", token: "" };

function setupHidden() {
  try { return localStorage.getItem("etnpilot-setup-hidden") === "1"; } catch { return false; }
}

async function loadSetup() {
  try {
    setupData = await api("/api/setup");
    setupError = undefined;
  } catch (error) {
    setupError = error.message;
  }
  if (view === "overview") render();
}

async function setupPost(path, body, done) {
  setupBusy = true;
  render();
  try {
    const result = await api(path, { method: "POST", body: JSON.stringify(body) });
    done?.(result);
    await loadSetup();
    if (typeof loadAccounts === "function") await loadAccounts();
  } catch (error) {
    toast(error.message, "bad");
  } finally {
    setupBusy = false;
    render();
  }
}

function setupGuide() {
  if (setupHidden()) return [];
  if (!setupStarted) {
    setupStarted = true;
    loadSetup();
  }
  if (!setupData) return [];
  const providers = setupData.providers.options.filter((option) => !option.unavailable);
  const current = providers.find((option) => option.id === setupData.providers.current);
  const gitlab = setupData.gitlab;
  const providerDone = Boolean(current?.ready);
  const gitlabDone = Boolean(gitlab.baseUrl && gitlab.project && gitlab.connected);
  if (providerDone && gitlabDone) return [];
  const chosen = providers.find((option) => option.id === (setupDraft.provider || setupData.providers.current)) ?? providers[0];
  if (setupDraft.host === "" && gitlab.baseUrl) setupDraft.host = gitlab.baseUrl;
  if (setupDraft.project === "" && gitlab.project) setupDraft.project = gitlab.project;
  if (setupDraft.user === "" && gitlab.account) setupDraft.user = gitlab.account;

  const steps = [];
  if (providers.length > 0 && chosen) {
    const parts = [
      selectField("setup-provider", "Default provider", chosen.id,
        providers.map((option) => [option.id, option.id + " — " + (option.ready ? "ready" : "no login yet")]),
        (value) => { setupDraft.provider = value; render(); }),
      el("p", { class: "muted", text: "Needs " + (chosen.note || "nothing more") + "." }),
    ];
    if (!chosen.ready && chosen.method === "key") {
      const input = el("input", { attrs: { id: "setup-key", type: "password", autocomplete: "off", placeholder: "Paste the key" } });
      input.value = setupDraft.key;
      input.addEventListener("input", () => { setupDraft.key = input.value; });
      parts.push(el("div", { class: "field" }, [el("label", { text: "API key", attrs: { for: "setup-key" } }), input]));
    }
    parts.push(el("div", { class: "card-actions" }, [
      button(chosen.ready || chosen.method !== "key" ? "Use this provider" : "Use it and save the key", {
        class: "btn", disabled: setupBusy,
        onClick: async () => {
          const key = setupDraft.key;
          if (!chosen.ready && chosen.method === "key" && key) {
            setupBusy = true; render();
            try {
              await api("/api/auth/key", { method: "POST", body: JSON.stringify({ service: chosen.service, value: key }) });
              setupDraft.key = "";
            } catch (error) { setupBusy = false; render(); toast(error.message, "bad"); return; }
          }
          await setupPost("/api/setup/provider", { id: chosen.id }, () => toast("Default provider: " + chosen.id + "."));
        },
      }),
      ...(!chosen.ready && chosen.method === "device" ? [button("Sign in on the Accounts page", { class: "btn tonal", onClick: () => show("accounts") })] : []),
    ]));
    steps.push(el("div", { class: "setup-step" }, [
      el("div", { class: "row" }, [pill(providerDone ? "done" : "to do", providerDone ? "ok" : "warn"), el("strong", { text: "1. Which provider answers by default" })]),
      ...parts,
    ]));
  }

  const tokenInput = el("input", { attrs: { id: "setup-token", type: "password", autocomplete: "off", placeholder: gitlab.connected ? "A token is stored; leave empty to keep it" : "Paste a token (scope api)" } });
  tokenInput.value = setupDraft.token;
  tokenInput.addEventListener("input", () => { setupDraft.token = tokenInput.value; });
  steps.push(el("div", { class: "setup-step" }, [
    el("div", { class: "row" }, [pill(gitlabDone ? "done" : "optional", gitlabDone ? "ok" : ""), el("strong", { text: "2. Publish to GitLab" })]),
    field("setup-host", "GitLab address", setupDraft.host, (value) => { setupDraft.host = value; }, "The web address of your GitLab"),
    field("setup-project", "Project (group/project, or its web address)", setupDraft.project, (value) => { setupDraft.project = value; }, "group/project"),
    field("setup-user", "GitLab user name", setupDraft.user, (value) => { setupDraft.user = value; }, ""),
    el("div", { class: "field" }, [el("label", { text: "GitLab token", attrs: { for: "setup-token" } }), tokenInput]),
    el("p", { class: "muted", text: "Stored once on this machine. git in this project then uses it, so a push asks for nothing." }),
    el("div", { class: "card-actions" }, [button("Connect GitLab", {
      class: "btn", disabled: setupBusy,
      onClick: () => setupPost("/api/setup/gitlab", { host: setupDraft.host, project: setupDraft.project, user: setupDraft.user, token: setupDraft.token }, (result) => {
        setupDraft.token = "";
        for (const line of result.done) toast(line);
      }),
    })]),
  ]));

  return [panel("Guided setup", {
    meta: button("Hide", { class: "btn small", onClick: () => { try { localStorage.setItem("etnpilot-setup-hidden", "1"); } catch { /* the guide just stays */ } render(); } }),
    open: true,
    body: steps,
  })];
}
