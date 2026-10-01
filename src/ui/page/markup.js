// The static markup of the page: the sidebar, the top bar, the modals.
export const MARKUP = `</head>
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
      <button class="btn icon state menu-button" id="menu" aria-label="Collapse the view list" aria-expanded="true">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>
      </button>
      <div class="context">
        <p class="eyebrow">Project</p>
        <h1 class="context-title" id="context-title">…</h1>
      </div>
      <div class="top-actions">
        <button class="btn state" id="open-palette" aria-label="Open the command palette">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
          <span>Commands</span>
          <span class="kbd">ctrl K</span>
        </button>
        <button class="btn state" id="install" hidden>Install</button>
        <button class="btn primary state" id="open-run" aria-label="Start a run">
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
      <div class="banner" id="error" role="alert" hidden></div>
      <section id="view-overview" class="view"></section>
      <section id="view-chat" class="view" hidden></section>
      <section id="view-approvals" class="view" hidden></section>
      <section id="view-agents" class="view" hidden></section>
      <section id="view-queue" class="view" hidden></section>
      <section id="view-runs" class="view" hidden></section>
      <section id="view-content" class="view" hidden></section>
      <section id="view-worktrees" class="view" hidden></section>
      <section id="view-merges" class="view" hidden></section>
      <section id="view-checks" class="view" hidden></section>
      <section id="view-settings" class="view" hidden></section>
    </main>
  </div>
</div>

<div class="backdrop" id="run-modal" role="dialog" aria-modal="true" aria-labelledby="run-modal-title">
  <div class="modal">
    <div class="modal-head">
      <h2 class="modal-title" id="run-modal-title">Start a run</h2>
      <button class="btn icon state" style="margin-left:auto" data-close="run-modal" aria-label="Close">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
      </button>
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
        <div class="field" id="run-workflow-field" hidden>
          <label for="run-workflow">Workflow</label>
          <select id="run-workflow"></select>
        </div>
        <p class="muted" id="run-hint"></p>
        <div class="banner" id="run-banner" role="alert" hidden>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l10 18H2z"/><path d="M12 10v4M12 17.5v.01"/></svg>
          <div class="banner-text">
            <p class="banner-title" id="run-banner-title"></p>
            <p id="run-banner-text"></p>
            <pre class="banner-code" id="run-banner-commands" tabindex="0"></pre>
          </div>
          <div class="banner-actions">
            <button type="button" class="btn link state" id="run-copy">Copy commands</button>
            <button type="button" class="btn tonal state" id="run-inplace">Work in this directory instead</button>
          </div>
        </div>
        <label class="check" id="run-inplace-row" hidden>
          <input type="checkbox" id="run-inplace-box">
          <span>Work directly in this directory, without a worktree. Changes land in your checkout; every write and command still asks first.</span>
        </label>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn link state" data-close="run-modal">Cancel</button>
        <button type="submit" class="btn primary state" id="run-submit">Start</button>
      </div>
    </form>
  </div>
</div>

<div class="backdrop" id="workflow-modal" role="dialog" aria-modal="true" aria-labelledby="workflow-modal-title">
  <div class="modal wide">
    <div class="modal-head">
      <h2 class="modal-title" id="workflow-modal-title">New workflow</h2>
      <button class="btn icon state" style="margin-left:auto" data-close="workflow-modal" aria-label="Close">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
      </button>
    </div>
    <div class="modal-body" id="workflow-body"></div>
    <div class="modal-footer">
      <button type="button" class="btn link state" data-close="workflow-modal">Cancel</button>
      <button type="button" class="btn primary state" id="workflow-save">Save workflow</button>
    </div>
  </div>
</div>

<div class="backdrop" id="agent-modal" role="dialog" aria-modal="true" aria-labelledby="agent-modal-title">
  <div class="modal wide">
    <div class="modal-head">
      <h2 class="modal-title" id="agent-modal-title">New agent</h2>
      <button class="btn icon state" style="margin-left:auto" data-close="agent-modal" aria-label="Close">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
      </button>
    </div>
    <div class="modal-body" id="agent-body"></div>
    <div class="modal-footer">
      <button type="button" class="btn link state" data-close="agent-modal">Cancel</button>
      <button type="button" class="btn primary state" id="agent-save">Save agent</button>
    </div>
  </div>
</div>

<div class="backdrop" id="file-modal" role="dialog" aria-modal="true" aria-labelledby="file-title">
  <div class="modal wide">
    <div class="modal-head">
      <h2 class="modal-title mono" id="file-title"></h2>
      <button class="btn icon state" style="margin-left:auto" data-close="file-modal" aria-label="Close">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
      </button>
    </div>
    <div class="modal-body">
      <div class="chips" id="file-status"></div>
      <pre class="scroll-pre tall" id="file-body" tabindex="0"></pre>
    </div>
  </div>
</div>

<div class="backdrop" id="lock-modal" role="dialog" aria-modal="true" aria-labelledby="lock-modal-title">
  <div class="modal">
    <div class="modal-head"><h2 class="modal-title" id="lock-modal-title">Lock this content?</h2></div>
    <div class="modal-body">
      <p>You are saying you have read this. From now on a run uses exactly this content, and refuses it if it changes.</p>
      <ul id="lock-summary"></ul>
    </div>
    <div class="modal-footer">
      <button type="button" class="btn link state" data-close="lock-modal">Not yet</button>
      <button type="button" class="btn primary state" id="lock-confirm">Lock it</button>
    </div>
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

<nav class="nav-bar" id="nav-bar" aria-label="Views"></nav>
<button class="fab state" id="fab-run" aria-label="Start a run">
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
</button>

<div class="toast-region" id="toasts" role="status" aria-live="polite"></div>`;
