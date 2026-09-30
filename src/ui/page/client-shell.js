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
async function prepareRunModal() {
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
  describeRunChoice();
}

function describeRunChoice() {
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
      + ". The run works in its own worktree and asks this page for anything it needs approved.";
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
      body: JSON.stringify({ task, agent: $("run-agent").value }),
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
    fail(error);
    toast(error.message, "bad");
  } finally {
    submit.disabled = false;
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
    state = await api("/api/state");
    const root = state.root ?? "";
    const title = $("context-title");
    title.textContent = root.split("/").filter(Boolean).at(-1) ?? "this project";
    title.title = root;
    render();
    clearError();
    // The conversation lives on the server; while this view is open it is read
    // on the same beat as everything else.
    if (view === "chat" && chatSession) void syncChat();
    // Usage is the whole telemetry file, so it is read when it can have
    // changed: at the start, and whenever a run has finished since last time.
    const finished = state.runs.length + "/" + (state.active ?? []).length;
    if (usageSignature !== finished) {
      usageSignature = finished;
      void loadUsage();
    }
  } catch (error) {
    fail(error);
  }
}

let usageSignature;

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
$("run-agent").addEventListener("change", describeRunChoice);
$("run-form").addEventListener("submit", startRun);
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
