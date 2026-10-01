// The Accounts view: who ETNPilot is signed in as, and the ways to sign in.
// The page never holds a credential after sending it: a key goes to the server
// once and the answer says whose it is; a browser sign-in shows a code and then
// asks the server, every few seconds, whether it was confirmed.
export const CLIENT_ACCOUNTS = `let accountsData;
let accountsError;
let accountDrafts = {};
let accountBusy = {};
let deviceSignIn;
let deviceTimer;

async function loadAccounts({ notify = false } = {}) {
  try {
    accountsData = await api("/api/auth");
    accountsError = undefined;
    if (notify) toast("Read again.");
  } catch (error) {
    accountsError = error.message;
    if (error.network) fail(error);
  }
  if (view === "accounts") render();
}

function accountDraft(id) {
  if (!accountDrafts[id]) accountDrafts[id] = { value: "", clientId: "", host: "" };
  return accountDrafts[id];
}

function renderAccounts() {
  const host = $("view-accounts");
  host.replaceChildren();
  if (accountsError && !accountsData) host.append(el("p", { class: "notice bad", text: accountsError }));
  if (!accountsData) {
    host.append(el("p", { class: "empty", text: "Reading who is signed in…" }));
    return;
  }
  host.append(el("div", { class: "banner info" }, [
    icon("M12 3a9 9 0 100 18 9 9 0 000-18z M12 11v5 M12 7.5v.01"),
    el("div", { class: "banner-text" }, [
      el("p", { class: "banner-title", text: "Sign in once, then run" }),
      el("p", { text: "GitHub and GitLab offer a browser sign-in. Anthropic and OpenAI sell access by key and do not let other tools sign in for you, so there the key is entered once, checked, and kept in a file only you can read, outside every project. A variable set in the environment is used first." }),
    ]),
  ]));
  for (const service of accountsData.services) host.append(accountCard(service));
}

function accountCard(service) {
  const draft = accountDraft(service.id);
  const busy = accountBusy[service.id] === true;
  const stored = service.stored;
  let state = pill("Not connected", "warn");
  if (service.source === "environment") state = pill("From the environment", "ok");
  else if (stored) state = pill(stored.kind === "oauth" ? "Signed in" : (stored.verified ? "Key stored" : "Key stored, not verified"), stored.verified ? "ok" : "warn");
  const lines = [];
  if (service.source === "environment") {
    lines.push(el("p", { class: "muted", text: service.environmentVariable + " is set, so a run uses it. A stored login is used only when it is not." }));
  }
  if (stored) {
    const who = stored.account ? "as " + stored.account : "";
    const since = stored.savedAt ? " " + when(stored.savedAt).text : "";
    lines.push(el("p", { text: (stored.kind === "oauth" ? "Signed in " : "Key kept ") + who + since }));
    if (stored.expiresAt) lines.push(el("p", { class: "muted", text: "Renewed by itself before it runs out." }));
  }
  const body = [...lines];
  const activeFlow = deviceSignIn && deviceSignIn.service === service.id ? deviceSignIn : undefined;
  if (activeFlow) body.push(deviceBox(service, activeFlow));
  else if (service.method === "device") body.push(...deviceControls(service, draft, busy));
  else body.push(...keyControls(service, draft, busy));
  if (stored) {
    body.push(el("div", { class: "card-actions" }, [
      button("Sign out", { class: "btn", disabled: busy, onClick: () => signOut(service) }),
    ]));
  }
  return panel(service.label, { meta: state, body, open: true });
}

function keyControls(service, draft, busy) {
  const input = el("input", { attrs: { id: "key-" + service.id, type: "password", autocomplete: "off", placeholder: service.stored ? "A new key replaces the stored one" : "Paste the key", value: draft.value } });
  input.addEventListener("input", () => { draft.value = input.value; });
  return [
    el("div", { class: "field" }, [el("label", { text: service.label + " API key", attrs: { for: "key-" + service.id } }), input]),
    el("p", { class: "muted", text: service.help }),
    el("div", { class: "card-actions" }, [button("Check and save", { class: "btn tonal", disabled: busy, onClick: () => saveAccountKey(service) })]),
  ];
}

function deviceControls(service, draft, busy) {
  const controls = [];
  if (!service.clientId) {
    controls.push(field("client-" + service.id, "OAuth application id", draft.clientId, (value) => { draft.clientId = value; }, "Needed once"));
    controls.push(el("p", { class: "muted", text: service.appHelp }));
  }
  if (service.id === "gitlab") {
    controls.push(field("host-gitlab", "GitLab address", draft.host, (value) => { draft.host = value; }, accountsData.projectGitLabHost || service.defaultHost));
  }
  controls.push(el("div", { class: "card-actions" }, [
    button(service.stored ? "Sign in again" : "Sign in with " + service.label, { class: "btn tonal", disabled: busy, onClick: () => startDeviceSignIn(service) }),
  ]));
  const token = el("input", { attrs: { id: "token-" + service.id, type: "password", autocomplete: "off", placeholder: "Paste a token", value: draft.value } });
  token.addEventListener("input", () => { draft.value = token.value; });
  controls.push(el("details", { class: "fold" }, [
    el("summary", { text: "Use a token instead" }),
    el("div", { class: "field" }, [el("label", { text: service.label + " token", attrs: { for: "token-" + service.id } }), token]),
    el("p", { class: "muted", text: service.help }),
    el("div", { class: "card-actions" }, [button("Check and save", { class: "btn", disabled: busy, onClick: () => saveAccountKey(service) })]),
  ]));
  return controls;
}

function deviceBox(service, flow) {
  const seconds = Math.max(0, Math.round((flow.expiresAt - Date.now()) / 1000));
  const link = el("a", { class: "btn tonal state", text: "Open " + flow.verificationUri.split("//").pop(), attrs: { href: flow.verificationUriComplete || flow.verificationUri, target: "_blank", rel: "noopener noreferrer" } });
  return el("div", { class: "device-box", attrs: { role: "status" } }, [
    el("p", { text: "Open the page below, sign in there if asked, and enter this code:" }),
    el("p", { class: "device-code mono", text: flow.userCode }),
    el("div", { class: "card-actions" }, [link, button("Cancel", { class: "btn", onClick: cancelDeviceSignIn })]),
    el("p", { class: "muted", text: "Waiting for you to confirm… the code works for about " + Math.ceil(seconds / 60) + " minutes." }),
  ]);
}

async function saveAccountKey(service) {
  const draft = accountDraft(service.id);
  accountBusy[service.id] = true;
  render();
  try {
    const result = await api("/api/auth/key", { method: "POST", body: JSON.stringify({ service: service.id, value: draft.value, host: draft.host || undefined }) });
    draft.value = "";
    toast(result.verified ? "Saved. It works" + (result.account ? " as " + result.account : "") + "." : "Saved, but not verified: " + (result.note || "the check did not run."), result.verified ? "ok" : "warn");
    await loadAccounts();
  } catch (error) {
    toast(error.message, "bad");
  } finally {
    accountBusy[service.id] = false;
    render();
  }
}

async function signOut(service) {
  if (!(await askConfirm({ title: "Sign out of " + service.label + "?", text: "The stored login is removed from this device. Anything set in the environment stays.", yes: "Sign out" }))) return;
  try {
    await api("/api/auth/" + service.id, { method: "DELETE" });
    toast("Signed out of " + service.label + ".");
    await loadAccounts();
  } catch (error) {
    toast(error.message, "bad");
  }
}

async function startDeviceSignIn(service) {
  const draft = accountDraft(service.id);
  accountBusy[service.id] = true;
  render();
  try {
    const flow = await api("/api/auth/device/start", { method: "POST", body: JSON.stringify({ service: service.id, clientId: draft.clientId || undefined, host: draft.host || undefined }) });
    deviceSignIn = flow;
    schedulePoll(flow.interval);
  } catch (error) {
    toast(error.message, "bad");
  } finally {
    accountBusy[service.id] = false;
    render();
  }
}

function schedulePoll(seconds) {
  clearTimeout(deviceTimer);
  deviceTimer = setTimeout(pollDeviceSignIn, Math.max(1, seconds) * 1000);
}

async function pollDeviceSignIn() {
  const flow = deviceSignIn;
  if (!flow) return;
  try {
    const result = await api("/api/auth/device/poll", { method: "POST", body: JSON.stringify({ flowId: flow.flowId }) });
    if (deviceSignIn !== flow) return;
    if (result.status === "pending") {
      render();
      return schedulePoll(flow.interval + (result.slowDown ? 5 : 0));
    }
    deviceSignIn = undefined;
    if (result.status === "done") toast("Signed in" + (result.account ? " as " + result.account : "") + ".");
    else toast(result.status === "denied" ? "The sign-in was declined." : "The code ran out. Start again.", "warn");
    await loadAccounts();
  } catch (error) {
    deviceSignIn = undefined;
    toast(error.message, "bad");
    render();
  }
}

function cancelDeviceSignIn() {
  clearTimeout(deviceTimer);
  deviceSignIn = undefined;
  render();
}
`;
