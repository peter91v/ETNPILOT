// Modals, the run form, the palette, the poll and start-up.
// Client-side code, kept as text and joined by ../page.js into one script. It
// is not a module in the browser: no imports, no build step.
export const CLIENT_SHELL = `function openModal(id) {
  lastFocus = document.activeElement;
  $(id).classList.add("open");
  document.body.style.overflow = "hidden";
  setTimeout(() => $(id).querySelector("input, button")?.focus(), 20);
}

function closeModal(id) {
  $(id).classList.remove("open");
  document.body.style.overflow = "";
  lastFocus?.focus?.();
}

// The agents are the project's own, read when the dialog opens: a name typed
// by hand is a run that fails a minute later.
// Whether a run started now can get past its first step. Asked while the person
// is still choosing, so the way out is offered instead of an error afterwards.
let runReadiness = { ready: true };

function showRunReadiness(readiness) {
  runReadiness = readiness;
  const banner = $("run-banner");
  const row = $("run-inplace-row");
  $("run-inplace-box").checked = false;
  row.hidden = true;
  if (readiness.ready) {
    banner.hidden = true;
    $("run-submit").disabled = false;
    return;
  }
  banner.className = "banner";
  banner.hidden = false;
  const titles = { "not-a-checkout": "This is not a git checkout", "content-not-locked": "Read the project content, then lock it" };
  $("run-banner-title").textContent = titles[readiness.code] ?? "The project is not committed yet";
  $("run-banner-text").textContent = readiness.message + ((readiness.fixes ?? []).includes("in-place")
    ? " Commit it, or work in this directory instead."
    : " Run the command below in the project's terminal, then start again.");
  $("run-banner-commands").textContent = (readiness.commands ?? []).join("\\n");
  $("run-copy").hidden = (readiness.commands ?? []).length === 0;
  $("run-inplace").hidden = !(readiness.fixes ?? []).includes("in-place");
  // Starting would only fail, so it waits for one of the two ways out.
  $("run-submit").disabled = true;
}

function chooseInPlace() {
  $("run-banner").className = "banner info";
  // An information mark, not the warning triangle: nothing is wrong any more.
  $("run-banner").querySelector("svg").innerHTML = '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.5v.01"/>';
  $("run-banner-title").textContent = "Working in this directory";
  $("run-banner-text").textContent = "The run changes your checkout directly. Every write and command still asks you first, and the receipt records where it ran.";
  $("run-banner-commands").textContent = "";
  $("run-copy").hidden = true;
  $("run-inplace").hidden = true;
  $("run-inplace-box").checked = true;
  $("run-submit").disabled = false;
  describeRunChoice();
}

async function copyRunCommands() {
  const text = $("run-banner-commands").textContent;
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied. Run it in the project's terminal, then start the run again.");
  } catch {
    // No clipboard here (plain http on a phone): select the text so it can be copied by hand.
    const range = document.createRange();
    range.selectNodeContents($("run-banner-commands"));
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    toast("Select and copy the commands shown.", "warn");
  }
}

async function prepareRunModal() {
  api("/api/runs/readiness").then(showRunReadiness, () => showRunReadiness({ ready: true }));
  const select = $("run-agent");
  select.replaceChildren(el("option", { text: "the project's own workflow", attrs: { value: "" } }));
  describeRunChoice();
  try {
    agents = await api("/api/agents");
  } catch (error) {
    agents = { agents: [], error: error.message };
  }
  for (const agent of agents.agents ?? []) {
    select.append(el("option", {
      text: agent.error ? agent.name + " (this manifest does not parse)" : agent.name,
      attrs: { value: agent.name, ...(agent.error ? { disabled: "disabled" } : {}) },
    }));
  }
  // Named workflows the project has, when it has any; choosing an agent
  // instead makes the choice of workflow moot, so the field steps aside.
  const named = (workflowData ?? (await api("/api/workflows").catch(() => ({ workflows: [] })))).workflows.filter((workflow) => (workflow.errors ?? []).length === 0);
  const flows = $("run-workflow");
  flows.replaceChildren(el("option", { text: "the project's own workflow", attrs: { value: "" } }));
  for (const workflow of named) flows.append(el("option", { text: workflow.name, attrs: { value: workflow.name } }));
  $("run-workflow-field").hidden = named.length === 0;
  describeRunChoice();
}

function describeRunChoice() {
  $("run-workflow").disabled = $("run-agent").value !== "";
  const chosen = $("run-agent").value;
  const agent = (agents?.agents ?? []).find((candidate) => candidate.name === chosen);
  const steps = agents?.steps ?? [];
  const hint = $("run-hint");
  if (!chosen) {
    hint.textContent = (steps.length > 0
      ? "The project's own workflow runs: " + steps.join(" → ")
      : agents?.defaultAgent
        ? "The project's default agent is '" + agents.defaultAgent + "'"
        : "The project runs its default agent")
      + (($("run-inplace-box").checked ? ". The run works directly in this directory" : ". The run works in its own worktree")
        + " and asks this page for anything it needs approved.");
    return;
  }
  hint.textContent = "Runs '" + chosen + "' instead of the configured steps"
    + (agent?.provider
      ? " · provider " + agent.provider + (agent.inheritedProvider ? " (the project's default)" : "")
      : "")
    + (agent?.requires?.length ? " · needs " + agent.requires.join(", ") : "")
    + (agent?.description ? " · " + agent.description : "") + ".";
}

async function startRun(event) {
  event.preventDefault();
  const task = $("run-task").value.trim();
  if (task === "") {
    toast("A run needs a task to work on.", "warn");
    return;
  }
  const submit = $("run-submit");
  submit.disabled = true;
  try {
    const started = await api("/api/runs/start", {
      method: "POST",
      body: JSON.stringify({ task, agent: $("run-agent").value, ...($("run-agent").value === "" && $("run-workflow").value !== "" ? { workflow: $("run-workflow").value } : {}), ...($("run-inplace-box").checked ? { worktree: false } : {}) }),
    });
    $("run-task").value = "";
    clearError();
    closeModal("run-modal");
    toast("Started: " + started.task + ". Whatever it needs approved appears under Approvals.");
    await refresh({ force: true });
    // A run needs a moment to plan itself and enter its first step. Waiting a
    // whole poll to say where it is makes it look like nothing happened.
    for (const delay of [800, 2000, 4000]) setTimeout(() => refresh(), delay);
  } catch (error) {
    // The server refused with a way out: show it where the choice is made.
    if (error.details?.code) showRunReadiness({ ready: false, message: error.message, ...error.details });
    else {
      fail(error);
      toast(error.message, "bad");
    }
  } finally {
    submit.disabled = !runReadiness.ready && !$("run-inplace-box").checked;
  }
}

// ------------------------------------------------------ command palette

function paletteCommands() {
  const commands = VIEWS.map((entry) => ({
    label: "Go to " + entry.label,
    hint: entry.id,
    run: () => show(entry.id),
  }));
  commands.push(
    { label: "Start a run", hint: "run", run: () => { openModal("run-modal"); void prepareRunModal(); } },
    { label: "Refresh now", hint: "state", run: () => refresh({ force: true }) },
    { label: "Read the worktrees again", hint: "git", run: () => loadWorktrees({ notify: true }) },
    { label: "Ask GitLab for merge requests", hint: "gitlab", run: () => loadMerges({ notify: true }) },
    { label: "Show only changed settings", hint: "settings", run: () => {
      changedOnly = true;
      show("settings");
    } },
  );
  const query = $("palette-input").value.trim().toLowerCase();
  return query === "" ? commands : commands.filter((command) => (command.label + " " + command.hint).toLowerCase().includes(query));
}

function renderPalette() {
  const host = $("palette-list");
  host.replaceChildren();
  const commands = paletteCommands();
  if (commands.length === 0) {
    host.append(el("p", { class: "empty", text: "No command matches." }));
    return;
  }
  paletteIndex = Math.min(paletteIndex, commands.length - 1);
  commands.forEach((command, index) => {
    const node = el("button", {
      class: index === paletteIndex ? "palette-option state active" : "palette-option state",
      attrs: { type: "button", role: "option" },
    }, [el("span", { text: command.label }), el("span", { class: "hint", text: command.hint })]);
    node.addEventListener("click", () => {
      closeModal("palette");
      command.run();
    });
    host.append(node);
  });
}

function paletteKey(event) {
  const commands = paletteCommands();
  if (event.key === "ArrowDown") {
    event.preventDefault();
    paletteIndex = Math.min(commands.length - 1, paletteIndex + 1);
    renderPalette();
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    paletteIndex = Math.max(0, paletteIndex - 1);
    renderPalette();
  } else if (event.key === "Enter") {
    event.preventDefault();
    const command = commands[paletteIndex];
    closeModal("palette");
    command?.run();
  }
}

// --------------------------------------------------------------- the poll

let holding = false;

// Typing must not be thrown away by the poll. While a field has focus or an
// editor or dialog is open, the page keeps what is on screen and says so.
function busy() {
  const active = document.activeElement;
  const typing = active && (active.tagName === "INPUT" || active.tagName === "SELECT");
  return Boolean(typing || openSetting || document.querySelector(".backdrop.open"));
}

async function refresh({ force = false } = {}) {
  if (busy() && !force) {
    holding = true;
    renderRuntime();
    return;
  }
  holding = false;
  try {
    const fetched = await api("/api/state?runs=" + runLimit);
    // Nothing new: leave the page as it is. Redrawing identical content every
    // few seconds is what reset a scrolled table or a half-typed field.
    const { generatedAt: _stamp, ...content } = fetched;
    const signature = JSON.stringify(content) + "|" + view;
    const unchanged = state !== undefined && signature === lastStateSignature && !force;
    lastStateSignature = signature;
    state = fetched;
    const root = state.root ?? "";
    const title = $("context-title");
    title.textContent = root.split("/").filter(Boolean).at(-1) ?? "this project";
    title.title = root;
    if (!unchanged) render();
    clearError();
    // The conversation lives on the server; while this view is open it is read
    // on the same beat as everything else.
    if (view === "chat" && chatSession) void syncChat();
    // Usage is the whole telemetry file, so it is read when it can have
    // changed: at the start, and whenever a run has finished since last time.
    const finished = (state.runsTotal ?? state.runs.length) + "/" + (state.active ?? []).length;
    if (usageSignature !== finished) {
      usageSignature = finished;
      void loadUsage();
    }
    // Once at the start, so the overview can say content waits to be reviewed.
    if (contentData === undefined && !projectLoading) {
      projectLoading = true;
      void loadProjectViews().finally(() => { projectLoading = false; });
    }
  } catch (error) {
    fail(error);
  }
}

let usageSignature;
let lastStateSignature;
let projectLoading = false;
// How many receipts the list asks for; 'Show more' raises it.
let runLimit = 20;

// The app: the page is installed as it stands, which is the only way there is
// one surface rather than two. The worker caches the shell and never the
// evidence — see src/ui/app.js for why, and for the two other decisions this
// took (loopback only, and no claim to know who you are).
if ("serviceWorker" in navigator && location.protocol !== "file:") {
  addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
      // An install that cannot be offered is not a failure worth a toast:
      // everything on this page works without it.
    });
  });
}

let installPrompt;
addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  installPrompt = event;
  $("install").hidden = false;
});
$("install").addEventListener("click", async () => {
  if (!installPrompt) return;
  $("install").hidden = true;
  const offered = installPrompt;
  installPrompt = undefined;
  await offered.prompt();
});
addEventListener("appinstalled", () => { $("install").hidden = true; });

// The reviewer's name lives on the device, never on the server: it is what
// they call themselves, and the receipt records it as exactly that.
function reviewerName() {
  try {
    return localStorage.getItem("etnpilot.reviewer") ?? "";
  } catch {
    return "";
  }
}

function rememberReviewer(name) {
  try {
    localStorage.setItem("etnpilot.reviewer", name.trim());
  } catch {
    // A browser with storage switched off still decides approvals; it just
    // asks for the name again.
  }
}

// Material's 'on-scroll' app bar: raised only while something is behind it.
const topbar = document.querySelector(".topbar");
const markScrolled = () => topbar.classList.toggle("scrolled", window.scrollY > 4);
addEventListener("scroll", markScrolled, { passive: true });
markScrolled();

$("menu").addEventListener("click", toggleSidebar);
$("scrim").addEventListener("click", closeSidebar);
$("fab-run").addEventListener("click", () => { openModal("run-modal"); void prepareRunModal(); });
$("open-run").addEventListener("click", () => { openModal("run-modal"); void prepareRunModal(); });
$("run-form").addEventListener("submit", startRun);
$("run-inplace").addEventListener("click", chooseInPlace);
$("workflow-save").addEventListener("click", () => { void saveWorkflow(); });
$("agent-save").addEventListener("click", () => { void saveAgent(); });
$("lock-confirm").addEventListener("click", () => { void confirmLock(); });
$("run-agent").addEventListener("change", describeRunChoice);
$("run-copy").addEventListener("click", () => { void copyRunCommands(); });
$("open-palette").addEventListener("click", () => {
  $("palette-input").value = "";
  paletteIndex = 0;
  renderPalette();
  openModal("palette");
});
$("palette-input").addEventListener("input", () => { paletteIndex = 0; renderPalette(); });
$("palette-input").addEventListener("keydown", paletteKey);
for (const node of document.querySelectorAll("[data-close]")) {
  node.addEventListener("click", () => closeModal(node.dataset.close));
}
for (const backdrop of document.querySelectorAll(".backdrop")) {
  backdrop.addEventListener("mousedown", (event) => { if (event.target === backdrop) closeModal(backdrop.id); });
}
document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    $("palette-input").value = "";
    paletteIndex = 0;
    renderPalette();
    openModal("palette");
    return;
  }
  if (event.key === "Escape") {
    const open = document.querySelector(".backdrop.open");
    if (open) closeModal(open.id);
    else closeSidebar();
  }
});
window.addEventListener("hashchange", () => show(location.hash.slice(1)));

restoreSidebar();
renderNav();
show(location.hash.slice(1) || "overview");
refresh();
loadUsage();
setInterval(refresh, 5000);`;
