// State, the small DOM helpers and the navigation.
// Client-side code, kept as text and joined by ../page.js into one script. It
// is not a module in the browser: no imports, no build step.
export const CLIENT_CORE = `const $ = (id) => document.getElementById(id);

// What the page is showing and what the person is in the middle of doing. The
// poll below never throws either of these away.
let state;
let worktrees;
let worktreeChanges;
let worktreeDiff;
let merges;
let usage;
let agents;
// The checks this project can run on itself: the registry, what each one
// found, and which are in flight. A result stays until that check is run
// again, and the poll never starts one.
let checks;
const checkResults = new Map();
const checksRunning = new Set();
// Whether the open run's receipt verifies. Undefined means nobody has asked,
// which is not the same as 'it is fine'.
let verification;
let openRun;
// Which agent nodes are expanded, in the currently open run. Keyed by runId
// so opening a different run — or the same one again — starts collapsed.
let expandedAgents = new Set();
// A provider's models, fetched live and kept only for this page's lifetime —
// keyed by provider name. { status: "loading" } while in flight; then either
// { status: "ready", models } or { status: "error", reason }.
const modelLists = new Map();
let openSetting;
let view = "overview";
let scope = "local";
let settingsFilter = "";
let changedOnly = false;
let settingsLimit = 25;
let paletteIndex = 0;
let lastFocus;

const VIEWS = [
  {
    id: "overview",
    label: "Overview",
    title: "Overview",
    description: "What is waiting for you, what is running, and how the last runs ended.",
    icon: "M4 13h6V4H4zM14 20h6v-9h-6zM4 20h6v-4H4zM14 8h6V4h-6z",
  },
  {
    id: "chat",
    label: "Chat",
    title: "Chat",
    description: "Talk to an agent in this project. Every write and command still asks you first, here, with what it would change.",
    icon: "M4 5h16v11H8l-4 4z",
  },
  {
    id: "approvals",
    label: "Approvals",
    title: "Pending approvals",
    description: "The whole command, file, tool arguments or URL, and the rule that stopped it. A reviewer can only approve what they can read.",
    icon: "M9 12l2 2 4-4M12 3l7 4v5c0 4.4-3 8.3-7 9-4-0.7-7-4.6-7-9V7z",
  },
  {
    id: "queue",
    label: "Queue",
    title: "Workflow queue",
    description: "Durable jobs with their attempts. Cancel and resume are offered only where the queue would accept them.",
    icon: "M4 6h16M4 12h16M4 18h10",
  },
  {
    id: "runs",
    label: "Runs",
    title: "Runs",
    description: "Read from their receipt files, so this is what was sealed rather than a summary kept somewhere else.",
    icon: "M5 12l4 4L19 6M5 20h14",
  },
  {
    id: "worktrees",
    label: "Worktrees",
    title: "Worktrees",
    description: "Where a run's changes physically are. Removing one never discards unsaved work.",
    icon: "M6 3v12a3 3 0 003 3h6M6 21a3 3 0 100-6 3 3 0 000 6zM18 9a3 3 0 100-6 3 3 0 000 6zM18 21a3 3 0 100-6 3 3 0 000 6z",
  },
  {
    id: "merges",
    label: "Merge requests",
    // What the rail and the bottom bar use: 80dp of width printed
    // 'Merge reque' over the edge of the rail.
    short: "Merges",
    title: "Merge requests",
    description: "What a run published, and what else is queued for the same target — because what lands before ours is what breaks ours.",
    icon: "M7 3v12M7 21a3 3 0 100-6 3 3 0 000 6zM7 6a3 3 0 100-6 3 3 0 000 6zM17 21a3 3 0 100-6 3 3 0 000 6zM17 15V9a4 4 0 00-4-4h-2",
  },
  {
    id: "checks",
    label: "Checks",
    title: "Checks",
    description: "What this project can check about itself. Nothing here runs on its own: 'scan secrets' reads every tracked file, and doctor talks to a secret store.",
    icon: "M9 11l3 3L22 4M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11",
  },
  {
    id: "settings",
    label: "Settings",
    title: "Settings",
    description: "The same layers the CLI and the terminal interface use. Nothing changed here is ever committed.",
    icon: "M12 15a3 3 0 100-6 3 3 0 000 6zM4 12h2m12 0h2M12 4v2m0 12v2M6.3 6.3l1.4 1.4m8.6 8.6l1.4 1.4m0-11.4l-1.4 1.4M7.7 16.3l-1.4 1.4",
  },
];

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "x-etnpilot-token": TOKEN, ...(options.body ? { "content-type": "application/json" } : {}) },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error ?? ("request failed (" + response.status + ")"));
  return payload;
}

function el(tag, options = {}, children = []) {
  const node = document.createElement(tag);
  if (options.class) node.className = options.class;
  // Always text, never markup: this content came from an agent.
  if (options.text !== undefined) node.textContent = String(options.text);
  for (const [key, value] of Object.entries(options.attrs ?? {})) node.setAttribute(key, value);
  for (const child of children) node.append(child);
  return node;
}

function icon(path) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("aria-hidden", "true");
  const shape = document.createElementNS("http://www.w3.org/2000/svg", "path");
  shape.setAttribute("d", path);
  svg.append(shape);
  return svg;
}

function button(text, { class: className = "btn small", onClick, title, disabled = false } = {}) {
  // 'state' on every one: the hover, focus and pressed layers are part of
  // what a Material button is, not decoration to be applied case by case.
  const node = el("button", {
    class: className.includes("state") ? className : className + " state",
    text,
    attrs: { type: "button", ...(title ? { title } : {}) },
  });
  node.disabled = disabled;
  if (onClick) node.addEventListener("click", onClick);
  return node;
}

function panel(title, { meta, body = [], open = false } = {}) {
  const head = el("div", { class: "panel-head" }, [el("h3", { class: "panel-title", text: title })]);
  if (meta !== undefined) head.append(meta instanceof Node ? meta : el("span", { class: "panel-meta", text: meta }));
  return el("section", { class: open ? "panel open" : "panel" }, [head, el("div", { class: "panel-body" }, body)]);
}

function pill(text, tone = "") {
  return el("span", { class: tone ? "pill " + tone : "pill", text });
}

function toast(message, tone = "ok") {
  const node = el("div", { class: tone === "ok" ? "toast" : "toast " + tone, text: message });
  $("toasts").append(node);
  setTimeout(() => node.remove(), 6000);
}

function fail(error) {
  const box = $("error");
  box.textContent = error.message;
  box.hidden = false;
}

function clearError() {
  $("error").hidden = true;
}

// Timestamps are read by a person deciding now, so they are shown as a
// distance from now with the exact value kept in the tooltip.
function when(iso) {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return { text: String(iso ?? "—"), title: "" };
  const seconds = Math.round((time - Date.now()) / 1000);
  const past = seconds < 0;
  const units = [["d", 86400], ["h", 3600], ["m", 60], ["s", 1]];
  let magnitude = Math.abs(seconds);
  let text = "now";
  for (const [suffix, size] of units) {
    if (magnitude >= size) { text = Math.floor(magnitude / size) + suffix; break; }
  }
  if (text !== "now") text = past ? text + " ago" : "in " + text;
  return { text, title: new Date(time).toISOString() };
}

function timeSpan(label, iso) {
  const moment = when(iso);
  return el("span", { class: "muted", text: label + " " + moment.text, attrs: { title: moment.title } });
}

function detailBlock(label, value) {
  return el("div", {}, [el("div", { class: "muted mono", text: label }), el("pre", { text: value })]);
}

function pairs(rows) {
  const list = el("dl", { class: "pair" });
  for (const [label, value, className] of rows) {
    if (value === undefined || value === "") continue;
    list.append(el("dt", { text: label }), el("dd", { class: className ?? "", text: value }));
  }
  return list;
}

function describeValue(value) {
  if (value === undefined) return "—";
  return JSON.stringify(value);
}

// A policy block is hundreds of characters on one line. Showing all of it in a
// cell stretches the table over everything else, so the cell is short and the
// whole value is in the tooltip.
function shortValue(value, limit = 70) {
  const text = describeValue(value);
  return text.length <= limit ? { text } : { text: text.slice(0, limit) + "…", title: text };
}

function table(columns, rows, emptyText, options = {}) {
  if (rows.length === 0) return el("p", { class: "empty", text: emptyText });
  const head = el("tr", {}, columns.map((column) => el("th", { text: column.label })));
  const body = rows.map((row) => el("tr", { class: options.selected?.(row) ? "selected" : "" }, columns.map((column) => {
    const value = column.value(row);
    if (value instanceof Node || Array.isArray(value)) {
      // A cell that holds a control is still that column's cell: only the
      // nameless column at the end is the one for actions, which is what
      // 'actions' means — right-aligned and never wrapped.
      const nodes = Array.isArray(value) ? value : [value];
      const kind = column.label === "" ? "actions" : (column.mono ? "mono" : "");
      return el("td", { class: kind }, nodes);
    }
    return el("td", {
      class: column.mono ? "mono" : (value.class ?? ""),
      text: value.text ?? value,
      attrs: value.title ? { title: value.title } : {},
    });
  })));
  return el("div", { class: "scroll" }, [el("table", {}, [el("thead", {}, [head]), el("tbody", {}, body)])]);
}

function summaryCard(label, value, { hint, unit, accent } = {}) {
  return el("article", { class: "summary-card", attrs: accent ? { style: "--card-accent: var(--" + accent + ")" } : {} }, [
    el("div", { class: "summary-label", text: label }),
    el("div", { class: "summary-value", text: String(value) }, unit ? [el("small", { text: unit })] : []),
    ...(hint ? [el("div", { class: "summary-hint", text: hint })] : []),
  ]);
}

async function act(call, message) {
  try {
    await call();
    clearError();
    if (message) toast(message);
    await refresh({ force: true });
  } catch (error) {
    fail(error);
    toast(error.message, "bad");
  }
}

// ------------------------------------------------------------- navigation

// The drawer and the bottom navigation bar are filled from one list, so the
// two cannot disagree about which views exist. Material's active indicator is
// a shape behind the icon, which is why the icon gets a box of its own.
function renderNav() {
  const nav = $("nav");
  const bar = $("nav-bar");
  nav.replaceChildren();
  bar.replaceChildren();
  for (const entry of VIEWS) {
    const count = navCount(entry.id);
    const badge = (extra) => (count === undefined
      ? []
      : [el("span", { class: count.alert ? "count alert" + extra : "count" + extra, text: String(count.value) })]);
    const item = el("button", {
      class: "nav-item state",
      attrs: {
        type: "button",
        title: entry.label,
        ...(entry.id === view ? { "aria-current": "page" } : {}),
      },
    }, [
      el("span", { class: "nav-icon" }, [icon(entry.icon), ...badge("")]),
      el("span", { class: "nav-text", text: entry.label }),
      // The rail is 80dp wide and shows this one instead; the full label
      // stays in the DOM for the drawer and for the accessible name.
      el("span", { class: "nav-text-short", text: entry.short ?? entry.label }),
      ...badge(""),
    ]);
    item.addEventListener("click", () => show(entry.id));
    nav.append(item);

    if (!BAR_VIEWS.includes(entry.id)) continue;
    const tab = el("button", {
      class: "nav-bar-item state",
      attrs: {
        type: "button",
        ...(entry.id === view ? { "aria-current": "page" } : {}),
      },
    }, [
      el("span", { class: "nav-icon" }, [icon(entry.icon), ...badge("")]),
      el("span", { class: "nav-text", text: entry.short ?? entry.label }),
    ]);
    tab.addEventListener("click", () => show(entry.id));
    bar.append(tab);
  }
  // Material's bottom bar holds three to five destinations. Seven of them at
  // phone width printed 'Merge reques' over the next label — so the rest sit
  // behind 'More', which opens the drawer and is itself marked as the current
  // destination while one of them is open.
  const rest = VIEWS.filter((entry) => !BAR_VIEWS.includes(entry.id));
  const restCounts = rest.reduce((total, entry) => total + (navCount(entry.id)?.value ?? 0), 0);
  const alert = rest.some((entry) => navCount(entry.id)?.alert);
  const more = el("button", {
    class: "nav-bar-item state",
    attrs: {
      type: "button",
      "aria-label": "More views: " + rest.map((entry) => entry.label).join(", "),
      ...(rest.some((entry) => entry.id === view) ? { "aria-current": "page" } : {}),
    },
  }, [
    el("span", { class: "nav-icon" }, [
      icon("M6 12h.01M12 12h.01M18 12h.01"),
      ...(restCounts > 0 ? [el("span", { class: alert ? "count alert" : "count", text: String(restCounts) })] : []),
    ]),
    el("span", { class: "nav-text", text: "More" }),
  ]);
  more.addEventListener("click", openSidebar);
  bar.append(more);
}

// The destinations that fit across the bottom of a phone. The rest stay one
// tap away, in the drawer, and the drawer always lists every one of them.
const BAR_VIEWS = ["overview", "chat", "approvals", "runs"];

function navCount(id) {
  if (!state) return undefined;
  const some = (value, alert = false) => (value > 0 ? { value, alert } : undefined);
  if (id === "approvals") {
    const pending = state.approvals.pending.length;
    return some(pending, true);
  }
  if (id === "queue") return some((state.queue.jobs ?? []).length);
  if (id === "runs") return some(state.runsTotal ?? state.runs.length);
  if (id === "worktrees") return some(worktrees?.entries?.length ?? 0);
  if (id === "merges") return some(merges?.entries?.length ?? 0);
  if (id === "settings") {
    const refusals = (state.settings?.refusals ?? []).length;
    if (refusals > 0) return { value: refusals, alert: true };
    return some(state.settings?.overrides?.length ?? 0);
  }
  return undefined;
}

function show(next) {
  const entry = VIEWS.find((candidate) => candidate.id === next) ?? VIEWS[0];
  view = entry.id;
  document.body.classList.toggle("view-chat", view === "chat");
  if (location.hash !== "#" + view) history.replaceState(null, "", "#" + view);
  $("page-title").textContent = entry.title;
  $("page-description").textContent = entry.description;
  for (const candidate of VIEWS) $("view-" + candidate.id).hidden = candidate.id !== view;
  closeSidebar();
  renderNav();
  renderPageActions();
  render();
  // These two are read on demand: one runs 'git status' per worktree, the
  // other crosses the network, so neither belongs in the poll.
  if (view === "chat") void syncChat();
  if (view === "worktrees" && worktrees === undefined) void loadWorktrees();
  if (view === "merges" && merges === undefined) void loadMerges();
}

function renderPageActions() {
  const host = $("page-actions");
  host.replaceChildren();
  if (view === "worktrees") host.append(button("Read again", { class: "btn", onClick: () => loadWorktrees({ notify: true }) }));
  if (view === "merges") host.append(button("Ask GitLab", { class: "btn", onClick: () => loadMerges({ notify: true }) }));
  if (view === "runs" && openRun) host.append(button("Close the receipt", { class: "btn", onClick: () => { openRun = undefined; expandedAgents = new Set(); render(); } }));
  host.append(button("Refresh", { class: "btn", onClick: () => refresh({ force: true }) }));
}

// Two jobs for one button, because they are the same job at two widths: wide,
// it collapses the sidebar to its icons; narrow, where the sidebar is a
// drawer, it opens and closes that.
function drawerWidth() {
  return window.matchMedia("(max-width: 860px)").matches;
}

function toggleSidebar() {
  if (drawerWidth()) {
    if ($("sidebar").classList.contains("open")) closeSidebar();
    else openSidebar();
    return;
  }
  const shell = document.querySelector(".shell");
  const collapsed = shell.classList.toggle("collapsed");
  $("menu").setAttribute("aria-expanded", String(!collapsed));
  $("menu").setAttribute("aria-label", collapsed ? "Expand the view list" : "Collapse the view list");
  // A per-viewer preference, so it survives a reload; it is not state anyone
  // else shares.
  try {
    localStorage.setItem("etnpilot.sidebar", collapsed ? "collapsed" : "open");
  } catch {
    // Private windows and blocked storage are not an error here.
  }
  renderNav();
}

function restoreSidebar() {
  let collapsed = false;
  try {
    collapsed = localStorage.getItem("etnpilot.sidebar") === "collapsed";
  } catch {
    collapsed = false;
  }
  if (!collapsed) return;
  document.querySelector(".shell").classList.add("collapsed");
  $("menu").setAttribute("aria-expanded", "false");
  $("menu").setAttribute("aria-label", "Expand the view list");
}

function openSidebar() {
  $("sidebar").classList.add("open");
  $("scrim").classList.add("open");
  $("menu").setAttribute("aria-expanded", "true");
}

function closeSidebar() {
  $("sidebar").classList.remove("open");
  $("scrim").classList.remove("open");
  // Choosing a view closes the drawer. At a width where the sidebar is not a
  // drawer, that must not contradict whether it is collapsed.
  if (drawerWidth()) $("menu").setAttribute("aria-expanded", "false");
}

// ------------------------------------------------------------- the views

// Drawing replaces the view's elements, and a replaced element starts at
// scroll 0: a table scrolled sideways, a long receipt, the page itself all
// jumped back to the origin on every refresh. What was scrolled is noted by
// its place in the tree and put back where it was after the new one is drawn.
let renderedView;

function scrollPath(node) {
  const parts = [];
  for (let at = node; at && at !== document.body; at = at.parentElement) {
    parts.push(at.tagName + ":" + Array.prototype.indexOf.call(at.parentElement?.children ?? [], at));
  }
  return parts.join("/");
}

function render() {
  if (!state) return;
  const page = { x: window.scrollX, y: window.scrollY };
  const kept = [];
  for (const node of document.body.querySelectorAll("*")) {
    if (node.scrollTop > 0 || node.scrollLeft > 0) kept.push({ path: scrollPath(node), top: node.scrollTop, left: node.scrollLeft });
  }
  const sameView = renderedView === view;
  renderedView = view;
  draw();
  if (sameView && kept.length > 0) {
    const byPath = new Map();
    for (const node of document.body.querySelectorAll("*")) {
      if (node.scrollHeight > node.clientHeight || node.scrollWidth > node.clientWidth) byPath.set(scrollPath(node), node);
    }
    for (const entry of kept) {
      const node = byPath.get(entry.path);
      if (node) { node.scrollTop = entry.top; node.scrollLeft = entry.left; }
    }
  }
  if (sameView && (window.scrollX !== page.x || window.scrollY !== page.y)) window.scrollTo(page.x, page.y);
}

function draw() {
  renderNav();
  renderRuntime();
  if (view === "overview") renderOverview();
  if (view === "chat") renderChat();
  if (view === "approvals") renderApprovals();
  if (view === "queue") renderQueue();
  if (view === "runs") renderRuns();
  if (view === "worktrees") renderWorktrees();
  if (view === "merges") renderMerges();
  if (view === "checks") renderChecks();
  if (view === "settings") renderSettings();
}
`;
