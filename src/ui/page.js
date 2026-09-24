// A single self-contained page: no framework, no CDN, no build step. Every
// value from a run is inserted with textContent, never as markup, because all
// of it is text an agent controlled.
//
// It shows what the TUI shows and can do what the TUI can do: decide
// approvals, cancel and resume queue jobs, read a run's receipt, change
// settings against the same layers, start a run, and list the worktrees and
// the project's merge requests.
//
// The shape — a sidebar of views, a topbar that says where you are, panels,
// status pills, a command palette and toasts — follows the GUI draft. What it
// does not follow is the draft's screens for things that do not exist yet: a
// surface that shows an empty 'Plugins' page teaches the wrong thing.
export function renderReviewPage(token) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#0b0f13">
<title>ETNPilot Review</title>
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='12' fill='%230b0f13'/%3E%3Cpath d='M16 18h32v8H25v8h20v8H25v4h23v8H16z' fill='%233ee6c1'/%3E%3C/svg%3E">
<style>
  :root {
    color-scheme: light dark;
    --bg: #f6f7f9; --surface-0: #eef0f3; --surface-1: #ffffff; --surface-2: #f2f4f7; --surface-3: #e6e9ee;
    --line: #dde1e7; --line-strong: #c6ccd5;
    --text: #12171c; --text-soft: #3d474f; --muted: #6b757e;
    --accent: #0f8f77; --accent-strong: #0b6f5c; --accent-dim: rgba(15, 143, 119, .10);
    --amber: #9a6200; --amber-dim: rgba(154, 98, 0, .10);
    --red: #b3261e; --red-dim: rgba(179, 38, 30, .08);
    --blue: #2f5fd0;
    --sidebar: 238px; --radius: 10px;
    --shadow: 0 20px 60px rgba(15, 20, 26, .18);
    --grid: rgba(15, 20, 26, .028);
    --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
    --sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #090c0f; --surface-0: #0d1115; --surface-1: #12171c; --surface-2: #171e24; --surface-3: #1e272e;
      --line: #263139; --line-strong: #34434c;
      --text: #edf7f5; --text-soft: #aab8b6; --muted: #71807f;
      --accent: #3ee6c1; --accent-strong: #19caa7; --accent-dim: rgba(62, 230, 193, .11);
      --amber: #ffbf69; --amber-dim: rgba(255, 191, 105, .12);
      --red: #ff6b78; --red-dim: rgba(255, 107, 120, .08);
      --blue: #75a7ff;
      --shadow: 0 20px 60px rgba(0, 0, 0, .38);
      --grid: rgba(255, 255, 255, .018);
    }
  }
  * { box-sizing: border-box; }
  html { min-width: 320px; background: var(--bg); }
  body {
    margin: 0; min-height: 100vh; color: var(--text); font: 15px/1.45 var(--sans);
    background: linear-gradient(var(--grid) 1px, transparent 1px),
      linear-gradient(90deg, var(--grid) 1px, transparent 1px), var(--bg);
    background-size: 40px 40px;
  }
  button, input, select, textarea { font: inherit; color: inherit; }
  button:focus-visible, input:focus-visible, select:focus-visible, a:focus-visible {
    outline: 2px solid var(--accent); outline-offset: 2px;
  }
  .sr-only {
    position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
    overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0;
  }
  .shell { min-height: 100vh; display: grid; grid-template-columns: var(--sidebar) minmax(0, 1fr); }
  /* Collapsed, the sidebar keeps every view reachable as a rail of icons
     rather than disappearing: what is waiting for you stays countable. */
  .shell.collapsed { --sidebar: 62px; }
  .shell.collapsed .brand span:not(.brand-mark),
  .shell.collapsed .nav-label,
  .shell.collapsed .nav-item span:not(.count),
  .shell.collapsed .runtime-meta,
  .shell.collapsed #runtime-state { display: none; }
  .shell.collapsed .sidebar { padding: 18px 10px; align-items: center; }
  .shell.collapsed .brand { padding: 3px 0 18px; }
  .shell.collapsed .nav-list { width: 100%; }
  .shell.collapsed .nav-item { justify-content: center; padding: 0; position: relative; }
  .shell.collapsed .nav-item .count {
    position: absolute; top: 3px; right: 6px; margin: 0; font-size: 9px; line-height: 1;
  }
  .shell.collapsed .runtime-card { padding: 10px; display: grid; place-items: center; }
  .shell.collapsed .runtime-line { gap: 0; }

  /* Sidebar ---------------------------------------------------------- */
  .sidebar {
    position: fixed; inset: 0 auto 0 0; z-index: 20; width: var(--sidebar); padding: 18px 14px;
    display: flex; flex-direction: column; gap: 4px;
    background: var(--surface-1); border-right: 1px solid var(--line); overflow-y: auto;
  }
  .scrim { display: none; }
  .brand { display: flex; align-items: center; gap: 11px; padding: 3px 8px 18px; }
  .brand-mark {
    width: 34px; height: 34px; display: grid; place-items: center; border-radius: 8px;
    background: var(--accent); color: var(--surface-0); font: 800 14px/1 var(--mono);
    box-shadow: 0 0 0 4px var(--accent-dim);
  }
  .brand-name { font-size: 15px; font-weight: 800; letter-spacing: .015em; }
  .brand-sub { display: block; color: var(--muted); font: 10px/1.3 var(--mono); letter-spacing: .14em; text-transform: uppercase; }
  .nav-label { padding: 12px 10px 6px; color: var(--muted); font: 11px/1 var(--mono); letter-spacing: .12em; text-transform: uppercase; }
  .nav-list { display: grid; gap: 4px; }
  .nav-item {
    min-height: 42px; width: 100%; padding: 0 11px; display: flex; align-items: center; gap: 11px;
    color: var(--text-soft); background: transparent; border: 1px solid transparent; border-radius: 8px;
    cursor: pointer; text-align: left;
  }
  .nav-item:hover { color: var(--text); background: var(--surface-2); }
  .nav-item[aria-current="page"] { color: var(--text); background: var(--accent-dim); border-color: var(--accent-dim); }
  .nav-item svg { width: 18px; height: 18px; flex: 0 0 auto; }
  .nav-item[aria-current="page"] svg { color: var(--accent); }
  .nav-item .count { margin-left: auto; color: var(--muted); font: 11px var(--mono); }
  .nav-item .count.alert { color: var(--amber); }
  .sidebar-footer { margin-top: auto; padding-top: 14px; }
  .runtime-card { padding: 12px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface-2); }
  .runtime-line { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 700; }
  .runtime-meta { margin: 6px 0 0 16px; color: var(--muted); font: 11px/1.45 var(--mono); overflow-wrap: anywhere; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 4px var(--accent-dim); flex: 0 0 auto; }
  .dot.paused { background: var(--amber); box-shadow: 0 0 0 4px var(--amber-dim); }
  .dot.bad { background: var(--red); box-shadow: 0 0 0 4px var(--red-dim); }

  /* Topbar and page head --------------------------------------------- */
  .main { grid-column: 2; min-width: 0; }
  .topbar {
    min-height: 66px; position: sticky; top: 0; z-index: 12;
    display: flex; align-items: center; gap: 12px; padding: 10px 20px;
    background: var(--bg); border-bottom: 1px solid var(--line);
  }
  .narrow-only { display: none; }
  .topbar .menu-button { display: inline-flex; }
  .context { min-width: 0; }
  .eyebrow { margin: 0 0 3px; color: var(--muted); font: 10px/1 var(--mono); letter-spacing: .12em; text-transform: uppercase; }
  .context-title { margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 15px; font-weight: 750; }
  .top-actions { margin-left: auto; display: flex; align-items: center; gap: 9px; }
  .kbd {
    padding: 2px 6px; border: 1px solid var(--line-strong); border-radius: 5px;
    background: var(--surface-0); color: var(--muted); font: 10px var(--mono);
  }
  /* A grid child is 'min-width: auto' by default, so one wide table would
     stretch the whole page rather than scrolling inside its own box. Every
     grid that holds content needs this, not just the outermost one. */
  .content { padding: 20px; display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; }
  .content > *, .view, .panel-body > * { min-width: 0; }
  .page-head { display: flex; align-items: flex-start; gap: 14px; flex-wrap: wrap; }
  .page-title { margin: 0; font-size: 19px; letter-spacing: -.01em; }
  .page-description { margin: 4px 0 0; color: var(--muted); font-size: 13px; max-width: 70ch; }
  .page-actions { margin-left: auto; display: flex; gap: 8px; flex-wrap: wrap; }

  /* Cards, panels, pills --------------------------------------------- */
  .summary-strip { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
  .view { display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px; }
  /* A display declaration overrides the hidden attribute, so the views that
     are not on screen have to be told again. */
  .view[hidden] { display: none; }
  .summary-card {
    min-height: 88px; padding: 14px 15px; position: relative; overflow: hidden;
    background: var(--surface-1); border: 1px solid var(--line); border-radius: var(--radius);
  }
  .summary-card::after { content: ""; position: absolute; inset: auto 0 0; height: 2px; background: var(--card-accent, var(--line-strong)); }
  .summary-label { color: var(--muted); font: 11px var(--mono); letter-spacing: .08em; text-transform: uppercase; }
  .summary-value { margin-top: 10px; font: 750 23px/1 var(--mono); letter-spacing: -.04em; }
  .summary-value small { margin-left: 6px; color: var(--muted); font: 11px var(--mono); letter-spacing: 0; }
  .summary-hint { margin-top: 8px; color: var(--muted); font: 11px/1.4 var(--mono); }
  .panel { min-width: 0; background: var(--surface-1); border: 1px solid var(--line); border-radius: var(--radius); }
  .panel + .panel { margin-top: 12px; }
  .panel.open { border-color: var(--accent); scroll-margin-top: 84px; }
  .panel-head { min-height: 52px; padding: 10px 16px; display: flex; align-items: center; gap: 12px; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
  .panel-title { margin: 0; font-size: 14px; letter-spacing: -.01em; }
  .panel-meta { margin-left: auto; color: var(--muted); font: 11px var(--mono); }
  .panel-body { padding: 16px; display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px; }
  .panel-body > .btn, .view > .btn { justify-self: start; }
  .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  .grow { flex: 1 1 auto; min-width: 0; }
  .clip { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .wrap { overflow-wrap: anywhere; }
  .muted { color: var(--muted); font-size: 13px; }
  .mono { font-family: var(--mono); }
  .pill {
    width: max-content; display: inline-flex; align-items: center; gap: 6px; padding: 4px 8px;
    border: 1px solid var(--line); border-radius: 999px; color: var(--text-soft);
    background: var(--surface-2); font: 10px var(--mono); text-transform: uppercase; letter-spacing: .04em;
  }
  .pill::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: var(--muted); }
  .pill.ok { color: var(--accent-strong); border-color: var(--accent-dim); background: var(--accent-dim); }
  .pill.ok::before { background: var(--accent-strong); }
  .pill.warn { color: var(--amber); border-color: var(--amber-dim); background: var(--amber-dim); }
  .pill.warn::before { background: var(--amber); }
  .pill.bad { color: var(--red); border-color: var(--red-dim); background: var(--red-dim); }
  .pill.bad::before { background: var(--red); }
  .ok { color: var(--accent-strong); } .warn { color: var(--amber); } .bad { color: var(--red); }
  @media (prefers-color-scheme: dark) { .ok, .pill.ok { color: var(--accent); } }
  .empty { color: var(--muted); font-size: 14px; }
  .notice { border-left: 3px solid var(--amber); padding: 6px 0 6px 10px; margin: 0; font-size: 13px; }
  .notice.bad { border-color: var(--red); }
  pre {
    background: var(--surface-0); border: 1px solid var(--line); border-radius: 8px; padding: 10px;
    overflow-x: auto; font: 13px/1.5 var(--mono); margin: 0; white-space: pre-wrap; word-break: break-word;
  }
  .pair { display: grid; grid-template-columns: 150px minmax(0, 1fr); gap: 6px 12px; font-size: 13px; margin: 0; }
  .pair dt { color: var(--muted); font: 11px var(--mono); text-transform: uppercase; letter-spacing: .06em; padding-top: 2px; }
  .pair dd { margin: 0; word-break: break-word; }

  /* Controls ---------------------------------------------------------- */
  .btn {
    min-height: 36px; padding: 0 13px; display: inline-flex; align-items: center; gap: 7px;
    border: 1px solid var(--line-strong); border-radius: 8px; background: var(--surface-1);
    color: var(--text); cursor: pointer; font-size: 13px; font-weight: 650;
  }
  .btn:hover { border-color: var(--accent); }
  .btn:disabled { opacity: .5; cursor: not-allowed; }
  .btn.primary { background: var(--accent); border-color: var(--accent); color: var(--surface-0); }
  .btn.primary:hover { background: var(--accent-strong); border-color: var(--accent-strong); }
  .btn.danger { color: var(--red); border-color: var(--red); }
  .btn.small { min-height: 30px; padding: 0 10px; font-size: 12px; }
  .btn.icon { width: 36px; padding: 0; justify-content: center; }
  .btn.link {
    min-height: 0; padding: 0; border: 0; background: none; color: var(--accent-strong);
    text-decoration: underline; font-weight: 650;
  }
  @media (prefers-color-scheme: dark) { .btn.link { color: var(--accent); } }
  /* In a column of values the caret says 'this opens'; underlining all of
     them turns the table into a page of links. */
  .btn.link.value { color: var(--text); text-decoration: none; }
  .btn.link.value:hover, .btn.link.value:focus-visible { color: var(--accent); text-decoration: underline; }
  input, select {
    min-height: 36px; padding: 0 10px; border: 1px solid var(--line-strong); border-radius: 8px;
    background: var(--surface-0); color: var(--text); min-width: 0;
  }
  input[type="checkbox"] { min-height: 0; width: 16px; height: 16px; }
  /* In a table cell the control carries the row, so it stays compact and
     never sets the column's width. */
  select.inline { min-height: 30px; max-width: 220px; font-family: var(--mono); font-size: 12px; }
  @media (pointer: coarse) { select.inline { min-height: 38px; } }
  label.check { display: inline-flex; gap: 7px; align-items: center; color: var(--muted); font-size: 13px; }
  .field { display: grid; gap: 6px; }
  .field label { color: var(--text-soft); font-size: 12px; font-weight: 700; }

  /* Tables ------------------------------------------------------------ */
  .scroll { overflow-x: auto; max-width: 100%; }
  /* A diff reads as lines, each with the number it has on its own side. */
  .diff { min-width: max-content; font: 12px/1.6 var(--mono); }
  .diff-line { display: grid; grid-template-columns: 52px 52px 1fr; }
  .diff-gutter { padding: 0 8px; text-align: right; color: var(--muted); user-select: none; }
  .diff-text { padding: 0 10px; white-space: pre; }
  .diff-line.add { background: color-mix(in srgb, var(--accent) 12%, transparent); }
  .diff-line.add .diff-text { color: var(--accent-strong); }
  .diff-line.remove { background: color-mix(in srgb, var(--red) 10%, transparent); }
  .diff-line.remove .diff-text { color: var(--red); }
  .diff-line.hunk { background: var(--surface-0); }
  .diff-line.hunk .diff-text { color: var(--muted); }
  @media (prefers-color-scheme: dark) { .diff-line.add .diff-text { color: var(--accent); } }
  table { width: 100%; border-collapse: collapse; }
  th {
    padding: 10px 12px; color: var(--muted); background: var(--surface-0); border-bottom: 1px solid var(--line);
    text-align: left; font: 10px var(--mono); letter-spacing: .08em; text-transform: uppercase; white-space: nowrap;
  }
  td { padding: 11px 12px; border-bottom: 1px solid var(--line); color: var(--text-soft); font-size: 13px; vertical-align: middle; }
  tbody tr:last-child td { border-bottom: 0; }
  tbody tr.selected { background: var(--accent-dim); }
  td.mono { font-family: var(--mono); font-size: 12px; }
  td.actions { white-space: nowrap; text-align: right; }
  td.actions .btn + .btn { margin-left: 6px; }

  /* Modal, command palette, toasts ------------------------------------ */
  .backdrop {
    position: fixed; inset: 0; z-index: 50; display: none; place-items: center; padding: 20px;
    background: rgba(2, 5, 7, .55);
  }
  .backdrop.open { display: grid; }
  .modal {
    width: min(560px, 100%); overflow: hidden; background: var(--surface-1);
    border: 1px solid var(--line-strong); border-radius: 12px; box-shadow: var(--shadow);
  }
  .modal-head { min-height: 56px; padding: 10px 17px; display: flex; align-items: center; gap: 10px; border-bottom: 1px solid var(--line); }
  .modal-title { margin: 0; font-size: 16px; }
  .modal-body { padding: 17px; display: grid; gap: 14px; }
  .modal-footer { padding: 13px 17px; display: flex; justify-content: flex-end; gap: 8px; background: var(--surface-0); border-top: 1px solid var(--line); }
  .palette { width: min(620px, 100%); align-self: start; margin-top: min(14vh, 120px); }
  .palette-search { padding: 12px; border-bottom: 1px solid var(--line); }
  .palette-search input { width: 100%; }
  .palette-list { padding: 7px; display: grid; gap: 3px; max-height: 50vh; overflow-y: auto; }
  .palette-option {
    min-height: 42px; padding: 0 10px; display: flex; align-items: center; gap: 10px; width: 100%;
    color: var(--text-soft); background: transparent; border: 0; border-radius: 7px; cursor: pointer; text-align: left;
  }
  .palette-option:hover, .palette-option.active { color: var(--text); background: var(--surface-2); }
  .palette-option .hint { margin-left: auto; color: var(--muted); font: 10px var(--mono); }
  .toast-region { position: fixed; z-index: 80; right: 20px; bottom: 20px; display: grid; gap: 8px; max-width: min(420px, calc(100vw - 40px)); }
  .toast {
    padding: 11px 14px; background: var(--surface-1); border: 1px solid var(--line-strong);
    border-left: 3px solid var(--accent); border-radius: 9px; box-shadow: var(--shadow); font-size: 13px;
  }
  .toast.warn { border-left-color: var(--amber); }
  .toast.bad { border-left-color: var(--red); }

  /* Responsive --------------------------------------------------------- */
  @media (max-width: 1080px) { .summary-strip { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  @media (max-width: 860px) {
    .shell { display: block; }
    .sidebar { transform: translateX(-102%); transition: transform .22s ease; box-shadow: var(--shadow); }
    .sidebar.open { transform: translateX(0); }
    .scrim {
      position: fixed; inset: 0; z-index: 19; display: block; visibility: hidden; border: 0; padding: 0;
      background: rgba(2, 5, 7, .55); opacity: 0; transition: opacity .22s ease, visibility .22s ease;
    }
    .scrim.open { visibility: visible; opacity: 1; }
    .main { grid-column: auto; }
    .topbar .menu-button { display: inline-flex; }
    .content { padding: 16px; }
    .pair { grid-template-columns: 1fr; gap: 2px; }
    .pair dd { margin-bottom: 8px; }
  }
  @media (max-width: 560px) {
    .summary-strip { grid-template-columns: 1fr; }
    .topbar { padding: 8px 12px; gap: 8px; }
    /* At this width the labels are what overflows, not the controls: the
       search button becomes its icon and the primary action its verb. */
    #open-palette span:not(.narrow-only), #open-palette .kbd { display: none; }
    #open-palette { width: 40px; padding: 0; justify-content: center; }
    .narrow-only { display: inline; }
    .wide-only { display: none; }
    .content { padding: 12px; }
    .toast-region { left: 12px; right: 12px; bottom: 12px; max-width: none; }
    .backdrop { padding: 10px; align-items: end; }
    .modal { max-height: calc(100vh - 20px); overflow-y: auto; }
    .palette { margin-top: 40px; }
  }
  /* A finger is not a mouse pointer: on a touch screen every control is big
     enough to hit without aiming, which is what makes this usable on a tablet
     rather than merely readable. */
  @media (pointer: coarse) {
    .btn, input, select { min-height: 42px; }
    .btn.small { min-height: 38px; padding: 0 12px; }
    .btn.link { min-height: 32px; padding: 4px 0; }
    .nav-item, .palette-option { min-height: 48px; }
    th, td { padding: 12px; }
    input[type="checkbox"] { width: 20px; height: 20px; }
  }
  @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
</style>
</head>
<body>
<div class="shell">
  <aside class="sidebar" id="sidebar" aria-label="Views">
    <div class="brand">
      <span class="brand-mark" aria-hidden="true">E</span>
      <span>
        <span class="brand-name">ETNPilot</span>
        <span class="brand-sub">Review</span>
      </span>
    </div>
    <p class="nav-label" id="nav-label">Surface</p>
    <nav class="nav-list" id="nav" aria-labelledby="nav-label"></nav>
    <div class="sidebar-footer">
      <div class="runtime-card">
        <div class="runtime-line"><span class="dot" id="runtime-dot"></span> <span id="runtime-state">reading…</span></div>
        <p class="runtime-meta" id="runtime-meta"></p>
      </div>
    </div>
  </aside>
  <button class="scrim" id="scrim" aria-label="Close the view list" tabindex="-1"></button>

  <div class="main">
    <header class="topbar">
      <button class="btn icon menu-button" id="menu" aria-label="Collapse the view list" aria-expanded="true">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>
      </button>
      <div class="context">
        <p class="eyebrow">Project</p>
        <h1 class="context-title" id="context-title">…</h1>
      </div>
      <div class="top-actions">
        <button class="btn" id="open-palette" aria-label="Open the command palette">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
          <span>Commands</span>
          <span class="kbd">ctrl K</span>
        </button>
        <button class="btn primary" id="open-run" aria-label="Start a run">
          <span class="wide-only">Start a run</span><span class="narrow-only">Run</span>
        </button>
      </div>
    </header>

    <main class="content">
      <div class="page-head">
        <div class="grow">
          <h2 class="page-title" id="page-title">Overview</h2>
          <p class="page-description" id="page-description"></p>
        </div>
        <div class="page-actions" id="page-actions"></div>
      </div>
      <p class="notice bad" id="error" hidden></p>
      <section id="view-overview" class="view"></section>
      <section id="view-approvals" class="view" hidden></section>
      <section id="view-queue" class="view" hidden></section>
      <section id="view-runs" class="view" hidden></section>
      <section id="view-worktrees" class="view" hidden></section>
      <section id="view-merges" class="view" hidden></section>
      <section id="view-settings" class="view" hidden></section>
    </main>
  </div>
</div>

<div class="backdrop" id="run-modal" role="dialog" aria-modal="true" aria-labelledby="run-modal-title">
  <div class="modal">
    <div class="modal-head">
      <h2 class="modal-title" id="run-modal-title">Start a run</h2>
      <button class="btn icon" style="margin-left:auto" data-close="run-modal" aria-label="Close">✕</button>
    </div>
    <form id="run-form">
      <div class="modal-body">
        <div class="field">
          <label for="run-task">Task</label>
          <input id="run-task" placeholder="what the run should do" autocomplete="off">
        </div>
        <div class="field">
          <label for="run-agent">Agent</label>
          <select id="run-agent"></select>
        </div>
        <p class="muted" id="run-hint"></p>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn" data-close="run-modal">Cancel</button>
        <button type="submit" class="btn primary" id="run-submit">Start</button>
      </div>
    </form>
  </div>
</div>

<div class="backdrop" id="palette" role="dialog" aria-modal="true" aria-label="Command palette">
  <div class="modal palette">
    <div class="palette-search">
      <input id="palette-input" placeholder="Go to a view, or run a command…" autocomplete="off" aria-label="Search commands">
    </div>
    <div class="palette-list" id="palette-list" role="listbox" aria-label="Commands"></div>
  </div>
</div>

<div class="toast-region" id="toasts" role="status" aria-live="polite"></div>
<script>
const TOKEN = ${JSON.stringify(token)};
const $ = (id) => document.getElementById(id);

// What the page is showing and what the person is in the middle of doing. The
// poll below never throws either of these away.
let state;
let worktrees;
let worktreeChanges;
let worktreeDiff;
let merges;
let usage;
let agents;
let openRun;
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
    title: "Merge requests",
    description: "What a run published, and what else is queued for the same target — because what lands before ours is what breaks ours.",
    icon: "M7 3v12M7 21a3 3 0 100-6 3 3 0 000 6zM7 6a3 3 0 100-6 3 3 0 000 6zM17 21a3 3 0 100-6 3 3 0 000 6zM17 15V9a4 4 0 00-4-4h-2",
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
  const node = el("button", { class: className, text, attrs: { type: "button", ...(title ? { title } : {}) } });
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

function renderNav() {
  const nav = $("nav");
  nav.replaceChildren();
  for (const entry of VIEWS) {
    const count = navCount(entry.id);
    const node = el("button", {
      class: "nav-item",
      attrs: {
        type: "button",
        title: entry.label,
        ...(entry.id === view ? { "aria-current": "page" } : {}),
      },
    }, [
      icon(entry.icon),
      el("span", { text: entry.label }),
      ...(count === undefined ? [] : [el("span", { class: count.alert ? "count alert" : "count", text: String(count.value) })]),
    ]);
    node.addEventListener("click", () => show(entry.id));
    nav.append(node);
  }
}

function navCount(id) {
  if (!state) return undefined;
  const some = (value, alert = false) => (value > 0 ? { value, alert } : undefined);
  if (id === "approvals") {
    const pending = state.approvals.pending.length;
    return some(pending, true);
  }
  if (id === "queue") return some((state.queue.jobs ?? []).length);
  if (id === "runs") return some(state.runs.length);
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
  if (view === "worktrees" && worktrees === undefined) void loadWorktrees();
  if (view === "merges" && merges === undefined) void loadMerges();
}

function renderPageActions() {
  const host = $("page-actions");
  host.replaceChildren();
  if (view === "worktrees") host.append(button("Read again", { class: "btn", onClick: () => loadWorktrees({ notify: true }) }));
  if (view === "merges") host.append(button("Ask GitLab", { class: "btn", onClick: () => loadMerges({ notify: true }) }));
  if (view === "runs" && openRun) host.append(button("Close the receipt", { class: "btn", onClick: () => { openRun = undefined; render(); } }));
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

function render() {
  if (!state) return;
  renderNav();
  renderRuntime();
  if (view === "overview") renderOverview();
  if (view === "approvals") renderApprovals();
  if (view === "queue") renderQueue();
  if (view === "runs") renderRuns();
  if (view === "worktrees") renderWorktrees();
  if (view === "merges") renderMerges();
  if (view === "settings") renderSettings();
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
      hint: described.cost ? "from observability.pricing" : "set observability.pricing to see it",
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
    const actor = el("input", { attrs: { placeholder: "your name", "aria-label": "reviewer" } });
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
    const reject = button("Reject", { class: "btn danger", onClick: () => decide("reject") });
    body.push(el("div", { class: "row" }, [actor, reason, approve, reject]));
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
  };
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
      ["Estimated cost", described.cost ?? "not priced — set observability.pricing to see it"],
      ...(described.unpriced > 0 && described.cost ? [["Unpriced calls", String(described.unpriced)]] : []),
    ]),
  ]);
}

function openReceipt(run) {
  return button(run.runId, { class: "btn link", onClick: async () => {
    try {
      openRun = { file: run.receiptFile, run, receipt: await api("/api/runs/" + encodeURIComponent(run.receiptFile)) };
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
      ["Status", status, status === "succeeded" ? "ok" : status === "incomplete" ? "warn" : "bad"],
      ["Mode", run.mode],
      ["Branch", terminal.workspace?.branch ?? "—"],
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
  if (outcome.usage) body.push(usagePanelBody(outcome.usage));
  const rehearsal = terminal.git?.mergeRehearsal;
  if (rehearsal) {
    body.push(el("div", { class: "row" }, [
      el("span", { class: "muted", text: "Merge rehearsal" }),
      rehearsal.clean
        ? pill("clean into " + (rehearsal.targetBranch ?? "the target branch"), "ok")
        : pill("conflicts: " + (rehearsal.conflicts ?? []).join(", "), "bad"),
    ]));
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
  body.push(el("div", { class: "row" }, [button("Close", { onClick: () => { openRun = undefined; render(); renderPageActions(); } })]));
  // What the panel says about the receipt has to be what the receipt is: the
  // header claimed 'sealed' over a note saying it never was.
  return panel(run.runId, { meta: sealed ? "sealed receipt" : "receipt not sealed", body, open: true });
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

function renderWorktrees() {
  const host = $("view-worktrees");
  host.replaceChildren();
  if (worktrees === undefined) {
    host.append(panel("Worktrees", { body: [el("p", { class: "empty", text: "Reading the worktrees…" })] }));
    return;
  }
  if (worktrees.available === false) {
    host.append(panel("Worktrees", { body: [
      el("p", { class: "notice bad", text: worktrees.error ?? "The worktrees could not be listed." }),
      el("p", { class: "muted", text: "A project outside a git checkout has none; 'etnpilot run' needs one." }),
    ] }));
    return;
  }
  const entries = worktrees.entries ?? [];
  host.append(panel("On disk", {
    meta: entries.length + (entries.length === 1 ? " worktree · " : " worktrees · ")
      + (worktrees.managed ?? 0) + " from runs · "
      + (worktrees.unsaved > 0 ? worktrees.unsaved + " with unsaved work" : "nothing unsaved"),
    body: [table([
      { label: "Worktree", value: (entry) => openChanges(entry), mono: true },
      { label: "Branch", value: (entry) => entry.branch ?? (entry.detached ? "(detached)" : "—"), mono: true },
      { label: "Head", value: (entry) => (entry.head ?? "").slice(0, 8), mono: true },
      { label: "From", value: (entry) => entry.main ? "checkout" : entry.managed ? "a run" : "elsewhere" },
      { label: "State", value: (entry) => worktreeState(entry) },
      { label: "", value: (entry) => worktreeActions(entry) },
    ], entries, "No worktrees are registered.", { selected: (entry) => entry.name === worktreeChanges?.name })],
  }));
  if (worktreeChanges) host.append(renderWorktreeChanges());
  if (worktreeDiff) host.append(renderDiff());
}

function openChanges(entry) {
  return button(entry.name, { class: "btn link", onClick: async () => {
    try {
      worktreeChanges = { name: entry.name, ...await api("/api/worktrees/changes?name=" + encodeURIComponent(entry.name)) };
      worktreeDiff = undefined;
      clearError();
      renderWorktrees();
    } catch (error) {
      fail(error);
    }
  } });
}

// A number is a claim; the files are the evidence. Opening a worktree says
// exactly what removing it would throw away.
function renderWorktreeChanges() {
  const changes = worktreeChanges;
  const body = [];
  if (changes.unreadable) {
    body.push(el("p", { class: "notice bad", text: "This worktree's directory cannot be read; 'git worktree prune' clears it." }));
  } else if (changes.entries.length === 0) {
    body.push(el("p", { class: "empty", text: "Nothing changed here. Removing it throws nothing away." }));
  } else {
    body.push(table([
      { label: "File", value: (change) => openDiff(changes.name, change), mono: true },
      { label: "Change", value: (change) => ({ text: change.label, class: change.ignorable ? "muted" : "" }) },
      { label: "Lines", value: (change) => lineCount(change) },
      { label: "Counts as", value: (change) => change.ignorable
        ? { text: "ETNPilot's own state", class: "muted" }
        : { text: "unsaved work", class: "warn" } },
    ], changes.entries, "Nothing changed here.", { selected: (change) => change.path === worktreeDiff?.file }));
    if (changes.truncated) {
      body.push(el("p", { class: "muted", text: "Showing " + changes.entries.length + " of " + changes.truncated + " changes." }));
    }
    body.push(el("p", { class: "muted", text: changes.blocking === 0
      ? "None of this is a person's work, so this worktree can be removed."
      : changes.blocking + (changes.blocking === 1 ? " change is" : " changes are") + " unsaved work; removing is refused while they are here." }));
  }
  body.push(el("div", { class: "row" }, [button("Close", {
    onClick: () => { worktreeChanges = undefined; worktreeDiff = undefined; renderWorktrees(); },
  })]));
  return panel(changes.name, { meta: changes.branch ?? "", open: true, body });
}

// How much changed, per file. A rewrite and a one-character fix are the same
// row without it.
function lineCount(change) {
  if (change.binary) return { text: "binary", class: "muted" };
  if (change.large) return { text: "too large to count", class: "muted" };
  if (change.directory) return { text: "a directory", class: "muted" };
  if (change.added === undefined && change.deleted === undefined) return { text: "—", class: "muted" };
  const node = el("span", { class: "mono" });
  if (change.added) node.append(el("span", { class: "ok", text: "+" + change.added }));
  if (change.added && change.deleted) node.append(el("span", { text: " " }));
  if (change.deleted) node.append(el("span", { class: "bad", text: "−" + change.deleted }));
  if (!change.added && !change.deleted) node.append(el("span", { class: "muted", text: "no lines" }));
  return node;
}

function openDiff(name, change) {
  const label = change.renamedFrom ? change.renamedFrom + " → " + change.path : change.path;
  if (change.binary || change.large || change.directory) return el("span", { class: "mono", text: label });
  return button(label, { class: "btn link value", title: "show what changed in this file", onClick: async () => {
    try {
      worktreeDiff = await api("/api/worktrees/diff?name=" + encodeURIComponent(name) + "&file=" + encodeURIComponent(change.path));
      clearError();
      renderWorktrees();
      $("view-worktrees").querySelectorAll(".panel.open")[1]?.scrollIntoView({ block: "nearest" });
    } catch (error) {
      fail(error);
    }
  } });
}

// The lines themselves, with the number each one has on its own side.
function renderDiff() {
  const diff = worktreeDiff;
  const body = [];
  if (diff.reason) {
    body.push(el("p", { class: "muted", text: "No diff: this file is " + diff.reason + "." }));
  } else if (diff.lines.length === 0) {
    body.push(el("p", { class: "empty", text: "git reports no textual change for this file." }));
  } else {
    const rows = el("div", { class: "diff" });
    for (const line of diff.lines) {
      if (line.kind === "hunk") {
        rows.append(el("div", { class: "diff-line hunk" }, [
          el("span", { class: "diff-gutter", text: "" }),
          el("span", { class: "diff-gutter", text: "" }),
          el("span", { class: "diff-text", text: line.text }),
        ]));
        continue;
      }
      const mark = line.kind === "add" ? "+" : line.kind === "remove" ? "−" : " ";
      rows.append(el("div", { class: "diff-line " + line.kind }, [
        el("span", { class: "diff-gutter", text: line.oldLine === undefined ? "" : String(line.oldLine) }),
        el("span", { class: "diff-gutter", text: line.newLine === undefined ? "" : String(line.newLine) }),
        el("span", { class: "diff-text", text: mark + line.text }),
      ]));
    }
    body.push(el("div", { class: "scroll" }, [rows]));
    if (diff.cut || diff.truncated) {
      body.push(el("p", { class: "muted", text: "This diff is long; what is shown is cut. Read the rest with 'git diff'." }));
    }
  }
  body.push(el("div", { class: "row" }, [button("Close", { onClick: () => { worktreeDiff = undefined; renderWorktrees(); } })]));
  return panel(diff.file, {
    meta: diff.reason
      ? diff.reason
      : "+" + (diff.added ?? 0) + " −" + (diff.deleted ?? 0)
        + " in " + (diff.hunks ?? 0) + (diff.hunks === 1 ? " place" : " places"),
    open: true,
    body,
  });
}

function worktreeState(entry) {
  if (entry.locked !== undefined) return pill("locked", "warn");
  if (entry.prunable !== undefined) return pill("prunable", "bad");
  if (entry.readable === false) return pill("missing", "bad");
  if (entry.blocking > 0) return pill(entry.blocking + " unsaved", "warn");
  return pill("clean", "ok");
}

function worktreeActions(entry) {
  // Only a run's own worktree with nothing unsaved is offered; the removal
  // itself checks again, so the screen and the removal cannot disagree.
  if (!entry.removable) return [];
  return [button("Remove", { onClick: async () => {
    try {
      const removal = await api("/api/worktrees/remove", { method: "POST", body: JSON.stringify({ name: entry.name }) });
      clearError();
      toast(removal.removed
        ? entry.name + " is gone; its branch " + (entry.branch ?? "") + " still exists."
        : entry.name + " keeps unsaved work — nothing was removed.", removal.removed ? "ok" : "warn");
      await loadWorktrees();
    } catch (error) {
      fail(error);
    }
  } })];
}

async function loadUsage() {
  try {
    usage = await api("/api/usage");
  } catch (error) {
    usage = { available: false, reason: error.message };
  }
  // The usage answer can arrive before the first state does; the views are
  // drawn from both, so it waits for the other one.
  if (state && view === "overview") renderOverview();
}

async function loadMerges({ notify = false } = {}) {
  try {
    merges = await api("/api/merges");
    clearError();
    if (notify) toast("GitLab answered.");
  } catch (error) {
    merges = { configured: true, available: false, error: error.message, entries: [] };
  }
  if (!state) return;
  renderNav();
  if (view === "merges") renderMerges();
}

function renderMerges() {
  const host = $("view-merges");
  host.replaceChildren();
  if (merges === undefined) {
    host.append(panel("Merge requests", { body: [el("p", { class: "empty", text: "Asking GitLab…" })] }));
    return;
  }
  if (merges.configured === false) {
    host.append(panel("Merge requests", { body: [
      el("p", { class: "muted", text: merges.reason ?? "No GitLab project is configured." }),
      el("p", { class: "muted", text: "Everything else here works without it." }),
    ] }));
    return;
  }
  if (merges.available === false) {
    host.append(panel("Merge requests", { body: [
      el("p", { class: "notice bad", text: merges.error ?? "GitLab did not answer." }),
      el("p", { class: "muted", text: "This is the only part of the page that needs the network and a token." }),
    ] }));
    return;
  }
  const entries = [...(merges.entries ?? [])].sort((left, right) =>
    Number(right.own) - Number(left.own) || right.iid - left.iid);
  host.append(panel("Open merge requests", {
    meta: merges.project + " · " + entries.length + " " + (merges.state ?? "opened")
      + " · " + (merges.ours > 0 ? merges.ours + " ours" : "none of them ours")
      + " · target " + (merges.targetBranch ?? "main"),
    body: [table([
      { label: "MR", value: (entry) => "!" + entry.iid, mono: true },
      { label: "Title", value: (entry) => entry.title },
      { label: "Branch", value: (entry) => entry.sourceBranch, mono: true },
      { label: "Whose", value: (entry) => entry.own ? pill("ours", "ok") : el("span", { class: "muted", text: entry.author || "someone" }) },
      { label: "Merge", value: (entry) => mergeState(entry) },
      { label: "Updated", value: (entry) => when(entry.updatedAt).text },
      { label: "", value: (entry) => entry.webUrl
        ? [el("a", { class: "btn small", text: "open", attrs: { href: entry.webUrl, rel: "noreferrer noopener", target: "_blank" } })]
        : [] },
    ], entries, "Nothing is open. A published run appears here as a draft.")],
  }));
}

function mergeState(entry) {
  if (entry.hasConflicts) return pill("conflicts", "bad");
  if (entry.state && entry.state !== "opened") return pill(entry.state, entry.state === "merged" ? "ok" : "bad");
  const status = (entry.mergeStatus ?? "").replaceAll("_", " ");
  if (entry.draft) return pill(status && status !== "mergeable" ? "draft · " + status : "draft", "warn");
  return pill(status || "open", status === "mergeable" ? "ok" : "");
}

function renderSettings() {
  const host = $("view-settings");
  host.replaceChildren();
  const settings = state.settings;
  if (!settings) return;
  if (settings.error) {
    host.append(panel("Settings", { body: [
      el("p", { class: "notice bad", text: "The local settings file was refused: " + settings.error }),
      el("p", { class: "muted", text: "Fix the file, or remove the setting with 'etnpilot config unset'." }),
    ] }));
    return;
  }
  const body = [];
  // A refused local setting stops the next run. Saying so above the list is
  // the difference between a warning and a surprise an hour later.
  for (const refusal of settings.refusals ?? []) {
    body.push(el("p", { class: "notice bad", text: refusal.path + " — " + refusal.reason }));
  }
  if ((settings.refusals ?? []).length > 0) {
    body.push(el("p", { class: "muted", text: "A run will not start until those are gone." }));
  }

  const filter = el("input", { attrs: { placeholder: "filter by path", "aria-label": "filter settings", value: settingsFilter } });
  filter.addEventListener("input", () => {
    settingsFilter = filter.value;
    settingsLimit = 25;
    renderSettings();
  });
  const only = el("input", { attrs: { type: "checkbox", "aria-label": "only changed" } });
  only.checked = changedOnly;
  only.addEventListener("change", () => { changedOnly = only.checked; renderSettings(); });
  const picker = el("select", { attrs: { "aria-label": "where changes are written" } }, [
    el("option", { text: "write to this project", attrs: { value: "local" } }),
    el("option", { text: "write to ~/.config", attrs: { value: "global" } }),
  ]);
  picker.value = scope;
  picker.addEventListener("change", () => {
    scope = picker.value;
    if (openSetting) { openSetting.scope = scope; renderSettings(); }
  });
  body.push(el("div", { class: "row" }, [
    filter,
    el("label", { class: "check" }, [only, el("span", { text: "only changed" })]),
    el("span", { class: "grow muted", text: (settings.overrides ?? []).length + " changed locally" }),
    picker,
  ]));

  const matching = (settings.entries ?? [])
    .filter((entry) => entry.path.toLowerCase().includes(settingsFilter.trim().toLowerCase()))
    .filter((entry) => !changedOnly || entry.source !== "project");
  const entries = matching.slice(0, settingsLimit);
  body.push(table([
    { label: "Setting", value: (entry) => editSetting(entry), mono: true },
    { label: "Value", value: (entry) => valueControl(entry), mono: true },
    { label: "From", value: (entry) => ({ text: sourceLabel(entry.source), class: entry.source === "project" ? "" : "warn" }) },
    { label: "Change", value: (entry) => ({ text: entry.mode, class: entry.mode === "locked" ? "bad" : entry.mode === "stricter-only" ? "warn" : "" }) },
  ], entries, "Nothing matches that filter.", { selected: (entry) => entry.path === openSetting?.entry.path }));
  if (matching.length > entries.length) {
    body.push(el("div", { class: "row" }, [
      el("span", { class: "grow muted", text: "Showing " + entries.length + " of " + matching.length + " — filter to narrow them down." }),
      button("Show all " + matching.length, { onClick: () => { settingsLimit = matching.length; renderSettings(); } }),
    ]));
  }
  body.push(el("p", {
    class: "muted",
    text: "Nothing changed here is ever committed: it is written to "
      + (scope === "global" ? "~/.config/etnpilot/config.yaml, for every project." : ".etnpilot/etnpilot.local.yaml, for this project."),
  }));
  host.append(panel("Effective values", { meta: (settings.entries ?? []).length + " in effect", body }));
  if (openSetting) host.append(renderSettingEditor());
}

// The value is where a person looks, so the control lives there rather than
// behind a click on the name: a setting with a list of values is a dropdown in
// its own row, and everything else opens the editor from the value it shows.
function valueControl(entry) {
  if (entry.mode === "locked") {
    const shown = shortValue(entry.value);
    return el("span", {
      class: "muted",
      text: shown.text,
      attrs: { title: (shown.title ? shown.title + " — " : "") + "locked by the committed default; it can only change there" },
    });
  }
  if (entry.choices?.kind === "one") {
    const select = el("select", { class: "inline", attrs: { "aria-label": entry.path } });
    const current = describeValue(entry.value);
    for (const option of entry.choices.values) {
      select.append(el("option", { text: String(option), attrs: { value: JSON.stringify(option) } }));
    }
    // A value this project already has that is not in the list is still shown,
    // so opening a setting never silently changes it.
    if (![...select.options].some((option) => option.value === current)) {
      select.append(el("option", { text: shortValue(entry.value).text, attrs: { value: current } }));
    }
    select.value = current;
    select.addEventListener("change", async () => {
      const chosen = select.value;
      select.disabled = true;
      try {
        await applySetting(entry.path, chosen, scope);
      } catch (error) {
        // A refusal puts the value back: the row must not show a change that
        // did not happen.
        select.value = current;
        toast(error.message, "bad");
      } finally {
        select.disabled = false;
      }
    });
    return select;
  }
  // A set of values and free text both need more room than a cell: the value
  // opens the editor, and says so by being a control rather than plain text.
  const shown = shortValue(entry.value);
  return button(shown.text + " ▾", {
    class: "btn link mono value",
    title: shown.title ?? (entry.choices ? "choose from " + entry.choices.values.join(", ") : "edit this value"),
    onClick: () => openEditor(entry),
  });
}

// One way in for every change, so the inline control, the editor and the
// keyboard all report the same success and the same refusal.
async function applySetting(path, value, writeScope) {
  const result = await api("/api/settings/set", {
    method: "POST",
    body: JSON.stringify({ path, value, scope: writeScope }),
  });
  clearError();
  toast(result.restartRequired
    ? result.path + " is saved, but this server already opened that file — restart to use it."
    : result.path + " is now " + describeValue(result.effective) + " — " + result.scope + ", and never committed.",
    result.restartRequired ? "warn" : "ok");
  await refresh({ force: true });
  return result;
}

function sourceLabel(source) {
  if (source === "user-local") return "local";
  if (source === "user-global") return "global";
  return "committed";
}

function editSetting(entry) {
  return button(entry.path, { class: "btn link", onClick: () => openEditor(entry) });
}

function openEditor(entry) {
  if (entry.mode === "locked") {
    // A locked setting does not open at all, and says why.
    toast(entry.path + " is locked by the committed default; it can only change there.", "warn");
    return;
  }
  clearError();
  openSetting = { entry, value: describeValue(entry.value), scope };
  renderSettings();
}

function renderSettingEditor() {
  const { entry } = openSetting;
  // Where a setting only accepts certain values, they are offered rather than
  // remembered: the list is the one the configuration loader validates against.
  const value = entry.choices ? choiceControl(entry) : freeValue();
  function freeValue() {
    const input = el("input", { class: "grow mono", attrs: { "aria-label": "value as YAML", value: openSetting.value } });
    input.addEventListener("input", () => { openSetting.value = input.value; });
    return input;
  }
  const message = el("p", { class: "muted", text: entry.mode + " · default " + describeValue(entry.defaultValue)
    + " · writing " + (openSetting.scope === "global" ? "~/.config, for every project" : "this project, locally") });
  const close = () => { openSetting = undefined; renderSettings(); };
  const save = button("Save", { class: "btn primary", onClick: async () => {
    try {
      await applySetting(entry.path, openSetting.value, openSetting.scope);
      close();
    } catch (error) {
      // A refusal is shown where the change was made, and the value stays.
      message.className = "notice bad";
      message.textContent = error.message;
    }
  } });
  const reset = button("Back to the default", { class: "btn", onClick: async () => {
    try {
      const result = await api("/api/settings/unset", {
        method: "POST",
        body: JSON.stringify({ path: entry.path, scope: entry.source === "user-global" ? "global" : openSetting.scope }),
      });
      clearError();
      toast(result.path + " is back to the committed default: " + describeValue(result.effective) + ".");
      close();
      await refresh({ force: true });
    } catch (error) {
      message.className = "notice bad";
      message.textContent = error.message;
    }
  } });
  const atDefault = entry.source === "project";
  return panel(entry.path, {
    meta: entry.choices
      ? (entry.choices.kind === "set" ? "choose any of them" : "one of these values")
      : "YAML, so 4, true and ['read'] all mean what they look like",
    open: true,
    body: [
      el("div", { class: "row" }, atDefault
        ? [value, save, el("span", { class: "muted", text: "already the committed default" })]
        : [value, save, reset]),
      message,
      el("div", { class: "row" }, [button("Cancel", { onClick: close })]),
    ],
  });
}

// One of a list becomes a dropdown; a set of them becomes checkboxes. Both
// write the same YAML the free field would, so the server sees no difference.
function choiceControl(entry) {
  const { values, kind } = entry.choices;
  if (kind === "one") {
    const select = el("select", { class: "grow", attrs: { "aria-label": "value" } });
    const current = openSetting.value;
    for (const option of values) {
      select.append(el("option", { text: String(option), attrs: { value: JSON.stringify(option) } }));
    }
    // A value the project already has that is not in the list is still shown,
    // so opening a setting never silently changes it.
    if (![...select.options].some((option) => option.value === current)) {
      select.append(el("option", { text: describeValue(entry.value) + " (current)", attrs: { value: current } }));
    }
    select.value = current;
    select.addEventListener("change", () => { openSetting.value = select.value; });
    return select;
  }
  const chosen = new Set(Array.isArray(entry.value) ? entry.value : []);
  const box = el("div", { class: "row grow" });
  const update = () => { openSetting.value = JSON.stringify([...chosen]); };
  for (const option of values) {
    const check = el("input", { attrs: { type: "checkbox", "aria-label": String(option) } });
    check.checked = chosen.has(option);
    check.addEventListener("change", () => {
      if (check.checked) chosen.add(option);
      else chosen.delete(option);
      update();
    });
    box.append(el("label", { class: "check" }, [check, el("span", { text: String(option) })]));
  }
  update();
  return box;
}

// --------------------------------------------------------- start a run

function openModal(id) {
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
      class: index === paletteIndex ? "palette-option active" : "palette-option",
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

$("menu").addEventListener("click", toggleSidebar);
$("scrim").addEventListener("click", closeSidebar);
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
setInterval(refresh, 5000);
</script>
</body>
</html>
`;
}
