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
<meta name="theme-color" content="#f5fbf8" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0e1513" media="(prefers-color-scheme: dark)">
<title>ETNPilot Review</title>
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='12' fill='%230b0f13'/%3E%3Cpath d='M16 18h32v8H25v8h20v8H25v4h23v8H16z' fill='%233ee6c1'/%3E%3C/svg%3E">
<style>
  /* Material Design 3, implemented rather than approximated -------------
     Tokens first: a colour scheme built from tonal palettes, the type
     scale, the shape scale, elevation, motion, and the state-layer
     opacities. Every rule below reads these; nothing hard-codes a colour.

     Two honest departures, because inventing a token silently is worse
     than naming the gap:
     - Material 3 has no 'warning' role. ETNPilot needs one — a run that is
       still going, a setting that is stricter-only, a rehearsal that never
       ran — so there is one extra pair, built to the same recipe as the
       others and marked as not being Material's.
     - The type scale uses the system sans, not Roboto: this page loads
       nothing from a network, which is a security property of the review
       surface and outranks the typeface. */
  :root {
    color-scheme: light dark;

    /* Colour — light scheme */
    --md-primary: #00695c; --md-on-primary: #ffffff;
    --md-primary-container: #85f6e0; --md-on-primary-container: #002019;
    --md-secondary: #4a635f; --md-on-secondary: #ffffff;
    --md-secondary-container: #cce8e3; --md-on-secondary-container: #051f1c;
    --md-tertiary: #3b5f9e; --md-on-tertiary: #ffffff;
    --md-tertiary-container: #d7e3ff; --md-on-tertiary-container: #001b3d;
    --md-error: #b3261e; --md-on-error: #ffffff;
    --md-error-container: #f9dedc; --md-on-error-container: #410e0b;
    --md-warning: #7a4f00; --md-on-warning: #ffffff;
    --md-warning-container: #ffddb0; --md-on-warning-container: #271900;
    --md-surface: #f5fbf8; --md-on-surface: #171d1b;
    --md-on-surface-variant: #3f4946; --md-outline: #6f7977; --md-outline-variant: #bfc9c6;
    --md-surface-container-lowest: #ffffff;
    --md-surface-container-low: #eff5f2;
    --md-surface-container: #e9efec;
    --md-surface-container-high: #e3eae7;
    --md-surface-container-highest: #dee4e1;
    --md-inverse-surface: #2b3230; --md-inverse-on-surface: #eff5f2; --md-inverse-primary: #66d9c4;
    --md-scrim: #000000;

    /* Shape */
    --md-shape-xs: 4px; --md-shape-sm: 8px; --md-shape-md: 12px;
    --md-shape-lg: 16px; --md-shape-xl: 28px; --md-shape-full: 999px;

    /* Elevation */
    --md-elevation-1: 0 1px 2px rgba(0,0,0,.30), 0 1px 3px 1px rgba(0,0,0,.15);
    --md-elevation-2: 0 1px 2px rgba(0,0,0,.30), 0 2px 6px 2px rgba(0,0,0,.15);
    --md-elevation-3: 0 1px 3px rgba(0,0,0,.30), 0 4px 8px 3px rgba(0,0,0,.15);
    --md-elevation-4: 0 2px 3px rgba(0,0,0,.30), 0 6px 10px 4px rgba(0,0,0,.15);
    --md-elevation-5: 0 4px 4px rgba(0,0,0,.30), 0 8px 12px 6px rgba(0,0,0,.15);

    /* Motion */
    --md-ease-standard: cubic-bezier(.2, 0, 0, 1);
    --md-ease-decelerate: cubic-bezier(.05, .7, .1, 1);
    --md-ease-accelerate: cubic-bezier(.3, 0, .8, .15);
    --md-duration-short: 200ms; --md-duration-medium: 300ms; --md-duration-long: 500ms;

    /* State layers */
    --md-state-hover: .08; --md-state-focus: .10; --md-state-press: .10;

    --md-nav-drawer: 280px; --md-nav-rail: 80px;
    --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
    --sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --md-primary: #66d9c4; --md-on-primary: #003730;
      --md-primary-container: #005046; --md-on-primary-container: #85f6e0;
      --md-secondary: #b0ccc7; --md-on-secondary: #1c3532;
      --md-secondary-container: #324b48; --md-on-secondary-container: #cce8e3;
      --md-tertiary: #abc7ff; --md-on-tertiary: #002f65;
      --md-tertiary-container: #21457f; --md-on-tertiary-container: #d7e3ff;
      --md-error: #ffb4ab; --md-on-error: #690005;
      --md-error-container: #93000a; --md-on-error-container: #ffdad6;
      --md-warning: #ffb95c; --md-on-warning: #422c00;
      --md-warning-container: #5e4100; --md-on-warning-container: #ffddb0;
      --md-surface: #0e1513; --md-on-surface: #dee4e1;
      --md-on-surface-variant: #bfc9c6; --md-outline: #899390; --md-outline-variant: #3f4946;
      --md-surface-container-lowest: #090f0e;
      --md-surface-container-low: #171d1b;
      --md-surface-container: #1b211f;
      --md-surface-container-high: #262b2a;
      --md-surface-container-highest: #313735;
      --md-inverse-surface: #dee4e1; --md-inverse-on-surface: #2b3230; --md-inverse-primary: #00695c;
    }
  }

  /* Type scale. Each role is one custom property applied with 'font:', so a
     component names the role instead of repeating three numbers. */
  :root {
    --md-headline-small: 400 24px/32px var(--sans);
    --md-title-large: 400 22px/28px var(--sans);
    --md-title-medium: 500 16px/24px var(--sans);
    --md-title-small: 500 14px/20px var(--sans);
    --md-body-large: 400 16px/24px var(--sans);
    --md-body-medium: 400 14px/20px var(--sans);
    --md-body-small: 400 12px/16px var(--sans);
    --md-label-large: 500 14px/20px var(--sans);
    --md-label-medium: 500 12px/16px var(--sans);
    --md-label-small: 500 11px/16px var(--sans);
  }

  * { box-sizing: border-box; }
  html { min-width: 320px; background: var(--md-surface); }
  body {
    margin: 0; min-height: 100vh; background: var(--md-surface);
    color: var(--md-on-surface); font: var(--md-body-medium); letter-spacing: .25px;
  }
  button, input, select, textarea { font: inherit; color: inherit; letter-spacing: inherit; }
  /* Material's focus indicator: a 3px ring in the primary colour, outside
     the component's own shape, on every focusable thing. */
  :is(button, input, select, a, [tabindex]):focus-visible {
    outline: 3px solid var(--md-primary); outline-offset: 2px;
  }
  .sr-only {
    position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
    overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0;
  }

  /* The state layer is what makes a Material control feel like one: the
     component's own colour, over its surface, at a fixed opacity per state.
     It is a pseudo-element so it tints the whole shape without touching the
     text on top of it. */
  .state { position: relative; isolation: isolate; }
  .state::after {
    content: ""; position: absolute; inset: 0; border-radius: inherit;
    background: currentColor; opacity: 0; pointer-events: none;
    transition: opacity var(--md-duration-short) var(--md-ease-standard);
  }
  .state:hover::after { opacity: var(--md-state-hover); }
  .state:focus-visible::after { opacity: var(--md-state-focus); }
  .state:active::after { opacity: var(--md-state-press); }
  .state:disabled::after { opacity: 0; }

  /* Layout ------------------------------------------------------------- */
  .shell { min-height: 100vh; display: grid; grid-template-columns: var(--md-nav-drawer) minmax(0, 1fr); }
  .shell.collapsed { --md-nav-drawer: var(--md-nav-rail); }
  .shell.collapsed .brand span:not(.brand-mark),
  .shell.collapsed .nav-label,
  .shell.collapsed .runtime-meta,
  .shell.collapsed #runtime-state { display: none; }
  /* Collapsed, the drawer becomes a navigation rail: 80dp, icon over label,
     the active item marked by a pill behind the icon. Every view stays
     reachable and what is waiting stays countable. */
  .shell.collapsed .sidebar { padding: 12px 0; align-items: center; }
  .shell.collapsed .brand { padding: 4px 0 12px; justify-content: center; }
  .shell.collapsed .nav-list { width: 100%; gap: 8px; }
  .shell.collapsed .nav-item {
    flex-direction: column; gap: 4px; height: auto; padding: 0; border-radius: 0;
    background: none; justify-content: center;
  }
  .shell.collapsed .nav-item .nav-icon {
    width: 56px; height: 32px; display: grid; place-items: center; border-radius: var(--md-shape-full);
  }
  .shell.collapsed .nav-item[aria-current="page"] .nav-icon { background: var(--md-secondary-container); }
  .shell.collapsed .nav-item .nav-text { font: var(--md-label-medium); letter-spacing: .5px; }
  .shell.collapsed .nav-item .count {
    position: absolute; top: -2px; right: 6px; margin: 0; min-width: 16px; height: 16px; padding: 0 4px;
    display: grid; place-items: center; border-radius: var(--md-shape-full);
    background: var(--md-error); color: var(--md-on-error); font: var(--md-label-small);
  }
  .shell.collapsed .nav-item .nav-text { display: none; }
  .shell.collapsed .nav-item .nav-text-short {
    display: block; max-width: 100%; padding: 0 4px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font: var(--md-label-medium); letter-spacing: .5px; text-align: center;
  }
  .shell.collapsed .runtime-card { padding: 8px; display: grid; place-items: center; }

  /* Navigation drawer -------------------------------------------------- */
  .sidebar {
    position: fixed; inset: 0 auto 0 0; z-index: 20; width: var(--md-nav-drawer); padding: 12px;
    display: flex; flex-direction: column; gap: 4px; overflow-y: auto;
    background: var(--md-surface-container-low); color: var(--md-on-surface-variant);
  }
  .scrim { display: none; }
  .brand { display: flex; align-items: center; gap: 12px; padding: 4px 16px 16px; }
  .brand-mark {
    width: 40px; height: 40px; display: grid; place-items: center; border-radius: var(--md-shape-full);
    background: var(--md-primary-container); color: var(--md-on-primary-container); font: var(--md-title-medium);
  }
  .brand-name { font: var(--md-title-medium); color: var(--md-on-surface); }
  .brand-sub { display: block; font: var(--md-label-small); letter-spacing: .5px; text-transform: uppercase; }
  .nav-label { padding: 16px 16px 8px; font: var(--md-title-small); letter-spacing: .1px; }
  .nav-list { display: grid; gap: 4px; }
  /* Drawer item: 56dp tall, fully rounded, the active one carried by the
     secondary container rather than by a border. */
  .nav-item {
    height: 56px; width: 100%; padding: 0 16px 0 16px; display: flex; align-items: center; gap: 12px;
    color: var(--md-on-surface-variant); background: transparent; border: 0;
    border-radius: var(--md-shape-full); cursor: pointer; text-align: left;
    font: var(--md-label-large); letter-spacing: .1px;
  }
  .nav-item[aria-current="page"] { background: var(--md-secondary-container); color: var(--md-on-secondary-container); }
  .nav-item .nav-icon { position: relative; display: grid; place-items: center; flex: 0 0 auto; }
  .nav-item svg { width: 24px; height: 24px; }
  .nav-item .nav-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .nav-item .nav-text-short { display: none; }
  /* The same count twice: on the icon, where the rail and the bottom bar
     need it, and at the end of the row, where the drawer does. One of the
     two is on screen at a time. */
  .nav-item .count { margin-left: auto; font: var(--md-label-large); letter-spacing: .1px; }
  .nav-item .nav-icon .count { display: none; }
  .shell.collapsed .nav-item > .count { display: none; }
  .shell.collapsed .nav-item .nav-icon .count { display: grid; }
  .nav-item .count.alert { color: var(--md-error); }
  .sidebar-footer { margin-top: auto; padding-top: 12px; }
  .runtime-card {
    padding: 12px 16px; border-radius: var(--md-shape-md);
    background: var(--md-surface-container-high); color: var(--md-on-surface-variant);
  }
  .runtime-line { display: flex; align-items: center; gap: 8px; font: var(--md-title-small); color: var(--md-on-surface); }
  .runtime-meta { margin: 8px 0 0; font: var(--md-body-small); letter-spacing: .4px; overflow-wrap: anywhere; }
  .dot { width: 10px; height: 10px; border-radius: 50%; background: var(--md-primary); flex: 0 0 auto; }
  .dot.paused { background: var(--md-warning); }
  .dot.bad { background: var(--md-error); }

  /* Bottom navigation bar: what Material uses below 600dp, instead of
     hiding every view behind a hamburger. Filled in from the same list as
     the drawer, so the two cannot disagree about what exists. */
  .nav-bar { display: none; }

  /* Top app bar -------------------------------------------------------- */
  .main { grid-column: 2; min-width: 0; }
  .topbar {
    height: 64px; position: sticky; top: 0; z-index: 12;
    display: flex; align-items: center; gap: 8px; padding: 8px 16px;
    background: var(--md-surface); color: var(--md-on-surface);
  }
  /* Material raises the app bar's container only once the page is scrolled
     under it, which is also the only moment a person needs the boundary. */
  .topbar.scrolled { background: var(--md-surface-container); box-shadow: var(--md-elevation-2); }
  .narrow-only { display: none; }
  .context { min-width: 0; }
  .eyebrow { margin: 0; font: var(--md-label-small); letter-spacing: .5px; text-transform: uppercase; color: var(--md-on-surface-variant); }
  .context-title { margin: 0; font: var(--md-title-large); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .top-actions { margin-left: auto; display: flex; align-items: center; gap: 8px; }
  .kbd {
    padding: 2px 6px; border-radius: var(--md-shape-xs);
    background: var(--md-surface-container-highest); color: var(--md-on-surface-variant);
    font: var(--md-label-small); letter-spacing: .5px;
  }
  /* A grid child is 'min-width: auto' by default, so one wide table would
     stretch the whole page rather than scrolling inside its own box. Every
     grid that holds content needs this, not just the outermost one. */
  .content { padding: 16px; display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; }
  .content > *, .view, .panel-body > * { min-width: 0; }
  .page-head { display: flex; align-items: flex-start; gap: 16px; flex-wrap: wrap; }
  .page-title { margin: 0; font: var(--md-headline-small); }
  .page-description { margin: 4px 0 0; color: var(--md-on-surface-variant); font: var(--md-body-medium); letter-spacing: .25px; max-width: 70ch; }
  .page-actions { margin-left: auto; display: flex; gap: 8px; flex-wrap: wrap; }

  /* Cards -------------------------------------------------------------- */
  .summary-strip { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px; }
  .view { display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; }
  /* A display declaration overrides the hidden attribute, so the views that
     are not on screen have to be told again. */
  .view[hidden] { display: none; }
  /* Filled card. */
  .summary-card {
    min-height: 96px; padding: 16px; position: relative; overflow: hidden;
    background: var(--md-surface-container-highest); border-radius: var(--md-shape-md);
  }
  .summary-card::after {
    content: ""; position: absolute; inset: auto 0 0; height: 4px;
    background: var(--card-accent, var(--md-outline-variant));
  }
  .summary-label { color: var(--md-on-surface-variant); font: var(--md-label-medium); letter-spacing: .5px; text-transform: uppercase; }
  .summary-value { margin-top: 12px; font: var(--md-headline-small); font-variant-numeric: tabular-nums; }
  .summary-value small { margin-left: 6px; color: var(--md-on-surface-variant); font: var(--md-label-medium); }
  .summary-hint { margin-top: 8px; color: var(--md-on-surface-variant); font: var(--md-body-small); letter-spacing: .4px; }
  /* Outlined card. */
  .panel {
    min-width: 0; background: var(--md-surface); border: 1px solid var(--md-outline-variant);
    border-radius: var(--md-shape-md);
  }
  .panel + .panel { margin-top: 16px; }
  .panel.open { border-color: var(--md-primary); scroll-margin-top: 80px; }
  .panel-head {
    min-height: 56px; padding: 12px 16px; display: flex; align-items: center; gap: 12px;
    border-bottom: 1px solid var(--md-outline-variant); flex-wrap: wrap;
  }
  .panel-title { margin: 0; font: var(--md-title-medium); letter-spacing: .15px; }
  .panel-meta { margin-left: auto; color: var(--md-on-surface-variant); font: var(--md-body-small); letter-spacing: .4px; }
  .panel-body { padding: 16px; display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; }
  .panel-body > .btn, .view > .btn { justify-self: start; }
  .row { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  .agent-tree { display: grid; gap: 4px; }
  .agent-row { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; min-width: 0; }
  .agent-toggle { text-align: left; }
  .agent-detail {
    display: grid; gap: 12px; padding: 4px 0 12px; margin-left: 8px;
    border-left: 2px solid var(--md-outline-variant);
  }
  .agent-text {
    white-space: pre-wrap; overflow-wrap: anywhere; font: 12px/1.6 var(--mono); margin: 0; padding: 12px;
    background: var(--md-surface-container-low); border-radius: var(--md-shape-sm);
    max-height: 420px; overflow: auto;
  }
  .grow { flex: 1 1 auto; min-width: 0; }
  .clip { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .wrap { overflow-wrap: anywhere; }
  .muted { color: var(--md-on-surface-variant); font: var(--md-body-medium); letter-spacing: .25px; }
  .mono { font-family: var(--mono); }
  .ok { color: var(--md-primary); } .warn { color: var(--md-warning); } .bad { color: var(--md-error); }
  .empty { color: var(--md-on-surface-variant); font: var(--md-body-medium); letter-spacing: .25px; }
  .notice {
    margin: 0; padding: 12px 16px; border-radius: var(--md-shape-sm);
    background: var(--md-warning-container); color: var(--md-on-warning-container);
    font: var(--md-body-medium); letter-spacing: .25px;
  }
  .notice.bad { background: var(--md-error-container); color: var(--md-on-error-container); }
  pre {
    margin: 0; padding: 12px; overflow-x: auto; white-space: pre-wrap; word-break: break-word;
    background: var(--md-surface-container-low); border-radius: var(--md-shape-sm); font: 13px/1.5 var(--mono);
  }
  .pair { display: grid; grid-template-columns: 160px minmax(0, 1fr); gap: 8px 16px; margin: 0; }
  .pair dt { color: var(--md-on-surface-variant); font: var(--md-label-medium); letter-spacing: .5px; text-transform: uppercase; padding-top: 2px; }
  .pair dd { margin: 0; word-break: break-word; font: var(--md-body-medium); letter-spacing: .25px; }

  /* Chips — what the status pills are: 32dp, 8dp corners, a label and a
     leading dot. */
  .pill {
    width: max-content; height: 32px; display: inline-flex; align-items: center; gap: 8px;
    padding: 0 12px; border: 1px solid var(--md-outline); border-radius: var(--md-shape-sm);
    color: var(--md-on-surface-variant); background: transparent;
    font: var(--md-label-large); letter-spacing: .1px;
  }
  .pill::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: currentColor; }
  .pill.ok { color: var(--md-on-primary-container); background: var(--md-primary-container); border-color: transparent; }
  .pill.warn { color: var(--md-on-warning-container); background: var(--md-warning-container); border-color: transparent; }
  .pill.bad { color: var(--md-on-error-container); background: var(--md-error-container); border-color: transparent; }

  /* Buttons ------------------------------------------------------------ */
  /* Outlined button is the default here; '.primary' is the filled one.
     40dp tall, fully rounded, label-large, with the state layer above. */
  .btn {
    min-height: 40px; padding: 0 16px; display: inline-flex; align-items: center; justify-content: center; gap: 8px;
    border: 1px solid var(--md-outline); border-radius: var(--md-shape-full); background: transparent;
    color: var(--md-primary); cursor: pointer; font: var(--md-label-large); letter-spacing: .1px;
    transition: box-shadow var(--md-duration-short) var(--md-ease-standard);
  }
  .btn:disabled { color: var(--md-on-surface); border-color: var(--md-on-surface); opacity: .38; cursor: not-allowed; }
  .btn.primary { padding: 0 24px; border-color: transparent; background: var(--md-primary); color: var(--md-on-primary); }
  .btn.primary:hover { box-shadow: var(--md-elevation-1); }
  .btn.primary:disabled { background: var(--md-on-surface); color: var(--md-surface); border-color: transparent; }
  /* Filled tonal: the middle weight, for an action that is expected but not
     the page's one purpose. */
  .btn.tonal { border-color: transparent; background: var(--md-secondary-container); color: var(--md-on-secondary-container); }
  .btn.danger { color: var(--md-error); border-color: var(--md-error); }
  .btn.small { min-height: 32px; padding: 0 12px; font: var(--md-label-medium); letter-spacing: .5px; }
  /* Icon button: a 40dp circle around a 24dp icon, its own state layer. */
  .btn.icon { width: 40px; min-height: 40px; padding: 0; border-color: transparent; color: var(--md-on-surface-variant); }
  .btn.icon svg { width: 24px; height: 24px; }
  /* Text button. */
  .btn.link {
    min-height: 32px; padding: 0 8px; border: 0; background: none; color: var(--md-primary);
    font: var(--md-label-large); letter-spacing: .1px;
  }
  /* In a column of values the control carries the row rather than reading as
     a link: same target size, no colour until it is pointed at. */
  .btn.link.value { color: var(--md-on-surface); justify-content: flex-start; text-align: left; }
  .btn.link.value:hover, .btn.link.value:focus-visible { color: var(--md-primary); }
  /* Floating action button: on a phone the page's one purpose is not an item
     in a crowded app bar. 56dp, 16dp corners, primary container, level 3. */
  .fab {
    display: none; position: fixed; z-index: 15; right: 16px; bottom: 96px;
    width: 56px; height: 56px; align-items: center; justify-content: center;
    border: 0; border-radius: var(--md-shape-lg);
    background: var(--md-primary-container); color: var(--md-on-primary-container);
    box-shadow: var(--md-elevation-3); cursor: pointer;
  }
  .fab svg { width: 24px; height: 24px; }

  /* Text fields — outlined, with the label sitting on the outline. Every
     field on this page always shows its label, so the label is drawn in the
     notch rather than animating into it. */
  .field { position: relative; display: grid; gap: 0; padding-top: 8px; }
  .field > label {
    position: absolute; top: 0; left: 12px; z-index: 1; padding: 0 4px;
    background: var(--md-surface); color: var(--md-on-surface-variant);
    font: var(--md-body-small); letter-spacing: .4px;
  }
  .field:focus-within > label { color: var(--md-primary); }
  input, select {
    min-height: 56px; padding: 0 16px; width: 100%;
    border: 1px solid var(--md-outline); border-radius: var(--md-shape-xs);
    background: transparent; color: var(--md-on-surface); min-width: 0;
    font: var(--md-body-large); letter-spacing: .5px;
  }
  input:focus, select:focus { border-color: var(--md-primary); border-width: 2px; padding: 0 15px; outline: 0; }
  input::placeholder { color: var(--md-on-surface-variant); }
  input[type="checkbox"] {
    min-height: 0; width: 18px; height: 18px; padding: 0; accent-color: var(--md-primary);
  }
  /* In a table cell or a filter row the control carries the row, so it stays
     compact and never sets the column's width. */
  select.inline, input.inline {
    min-height: 40px; width: auto; max-width: 260px; padding: 0 12px;
    font: var(--md-body-medium); letter-spacing: .25px;
  }
  select.inline:focus, input.inline:focus { padding: 0 11px; }
  label.check {
    min-height: 40px; display: inline-flex; gap: 12px; align-items: center;
    color: var(--md-on-surface-variant); font: var(--md-body-medium); letter-spacing: .25px;
  }

  /* Tables — Material's list, in rows: 48dp of height, a divider between,
     no vertical rules. */
  .scroll { overflow-x: auto; max-width: 100%; }
  /* A diff reads as lines, each with the number it has on its own side. */
  .diff { min-width: max-content; font: 12px/1.6 var(--mono); }
  .diff-line { display: grid; grid-template-columns: 52px 52px 1fr; }
  .diff-gutter { padding: 0 8px; text-align: right; color: var(--md-on-surface-variant); user-select: none; }
  .diff-text { padding: 0 12px; white-space: pre; }
  .diff-line.add { background: var(--md-primary-container); }
  .diff-line.add .diff-text { color: var(--md-on-primary-container); }
  .diff-line.remove { background: var(--md-error-container); }
  .diff-line.remove .diff-text { color: var(--md-on-error-container); }
  .diff-line.hunk { background: var(--md-surface-container); }
  .diff-line.hunk .diff-text { color: var(--md-on-surface-variant); }
  table { width: 100%; border-collapse: collapse; }
  th {
    height: 48px; padding: 0 16px; color: var(--md-on-surface-variant);
    border-bottom: 1px solid var(--md-outline-variant); text-align: left;
    font: var(--md-title-small); letter-spacing: .1px; white-space: nowrap;
  }
  td {
    height: 52px; padding: 8px 16px; border-bottom: 1px solid var(--md-outline-variant);
    color: var(--md-on-surface); font: var(--md-body-medium); letter-spacing: .25px; vertical-align: middle;
  }
  tbody tr:last-child td { border-bottom: 0; }
  tbody tr.selected { background: var(--md-secondary-container); }
  tbody tr.selected td { color: var(--md-on-secondary-container); }
  td.mono { font-family: var(--mono); font-size: 13px; }
  td.actions { white-space: nowrap; text-align: right; }
  td.actions .btn + .btn { margin-left: 8px; }

  /* Dialogs, command palette, snackbars -------------------------------- */
  .backdrop {
    position: fixed; inset: 0; z-index: 50; display: none; place-items: center; padding: 24px;
    background: color-mix(in srgb, var(--md-scrim) 32%, transparent);
  }
  .backdrop.open { display: grid; }
  /* Basic dialog: 28dp corners, level 3, 24dp of padding, its actions at the
     bottom right. */
  .modal {
    width: min(560px, 100%); overflow: hidden; border-radius: var(--md-shape-xl);
    background: var(--md-surface-container-high); color: var(--md-on-surface);
    box-shadow: var(--md-elevation-3);
  }
  .modal-head { min-height: 56px; padding: 24px 24px 0; display: flex; align-items: center; gap: 12px; }
  .modal-title { margin: 0; font: var(--md-headline-small); }
  .modal-body { padding: 16px 24px 24px; display: grid; gap: 20px; }
  .modal-footer { padding: 0 24px 24px; display: flex; justify-content: flex-end; gap: 8px; }
  .modal .field > label { background: var(--md-surface-container-high); }
  .palette { width: min(640px, 100%); align-self: start; margin-top: min(14vh, 112px); }
  .palette-search { padding: 16px 16px 8px; }
  .palette-list { padding: 8px; display: grid; gap: 4px; max-height: 50vh; overflow-y: auto; }
  /* List item, 56dp, fully rounded when it is the one the keyboard is on. */
  .palette-option {
    min-height: 56px; padding: 0 16px; display: flex; align-items: center; gap: 16px; width: 100%;
    color: var(--md-on-surface); background: transparent; border: 0; border-radius: var(--md-shape-full);
    cursor: pointer; text-align: left; font: var(--md-body-large); letter-spacing: .5px;
  }
  .palette-option.active { background: var(--md-secondary-container); color: var(--md-on-secondary-container); }
  .palette-option .hint { margin-left: auto; font: var(--md-label-medium); letter-spacing: .5px; color: var(--md-on-surface-variant); }
  /* Snackbar: the inverse surface, 4dp corners, level 3, one line where it
     fits. Material puts it at the bottom start on a wide screen and across
     the bottom on a narrow one. */
  /* Bottom start of the body region, not of the window: the drawer is fixed
     over the left edge, and a snackbar printed across it covers the one line
     that says whether this page is still polling. */
  .toast-region {
    position: fixed; z-index: 80; left: calc(var(--md-nav-drawer) + 16px); bottom: 16px;
    display: grid; gap: 8px; max-width: min(560px, calc(100vw - var(--md-nav-drawer) - 32px));
  }
  .toast {
    min-height: 48px; padding: 14px 16px; display: flex; align-items: center;
    border-radius: var(--md-shape-xs); background: var(--md-inverse-surface);
    color: var(--md-inverse-on-surface); box-shadow: var(--md-elevation-3);
    font: var(--md-body-medium); letter-spacing: .25px;
  }
  .toast.warn { color: var(--md-warning); }
  .toast.bad { color: var(--md-error); }

  /* Window size classes ------------------------------------------------- */
  @media (max-width: 1080px) { .summary-strip { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  /* Medium: the drawer becomes modal, over a scrim, as Material specifies. */
  @media (max-width: 900px) {
    .shell { display: block; }
    .sidebar {
      width: min(320px, 90vw); border-radius: 0 var(--md-shape-lg) var(--md-shape-lg) 0;
      background: var(--md-surface-container-low); box-shadow: var(--md-elevation-1);
      transform: translateX(-102%); transition: transform var(--md-duration-medium) var(--md-ease-decelerate);
    }
    .sidebar.open { transform: translateX(0); box-shadow: var(--md-elevation-3); }
    .scrim {
      position: fixed; inset: 0; z-index: 19; display: block; visibility: hidden; border: 0; padding: 0;
      background: color-mix(in srgb, var(--md-scrim) 32%, transparent); opacity: 0;
      transition: opacity var(--md-duration-medium) var(--md-ease-standard), visibility var(--md-duration-medium);
    }
    .scrim.open { visibility: visible; opacity: 1; }
    .main { grid-column: auto; }
    /* The drawer is over the page here, not beside it. */
    .toast-region { left: 16px; max-width: min(560px, calc(100vw - 32px)); }
    .pair { grid-template-columns: 1fr; gap: 4px; }
    .pair dd { margin-bottom: 12px; }
  }
  /* Compact: a bottom navigation bar and a FAB. The drawer is still there
     for the runtime card and the view list, but nothing important is only
     behind it. */
  @media (max-width: 600px) {
    .summary-strip { grid-template-columns: 1fr; }
    .topbar { padding: 8px 4px 8px 4px; gap: 4px; }
    .context-title { font: var(--md-title-medium); }
    #open-palette span:not(.narrow-only), #open-palette .kbd { display: none; }
    #open-palette { width: 40px; min-height: 40px; padding: 0; border-color: transparent; color: var(--md-on-surface-variant); }
    /* The primary action moves to the FAB, so the app bar keeps its title. */
    #open-run { display: none; }
    .fab { display: flex; }
    .narrow-only { display: inline; }
    .wide-only { display: none; }
    .content { padding: 16px 16px 96px; }
    .nav-bar {
      position: fixed; inset: auto 0 0 0; z-index: 18; height: 80px; display: flex;
      align-items: stretch; padding: 0 4px; overflow-x: auto;
      background: var(--md-surface-container); box-shadow: var(--md-elevation-2);
    }
    .nav-bar-item {
      flex: 1 0 auto; min-width: 64px; padding: 12px 0 16px; display: grid; gap: 4px;
      justify-items: center; align-content: start; border: 0; background: transparent;
      color: var(--md-on-surface-variant); cursor: pointer;
      font: var(--md-label-medium); letter-spacing: .5px;
    }
    .nav-bar-item .nav-icon {
      position: relative; width: 64px; height: 32px; display: grid; place-items: center;
      border-radius: var(--md-shape-full);
    }
    .nav-bar-item svg { width: 24px; height: 24px; }
    .nav-bar-item[aria-current="page"] { color: var(--md-on-secondary-container); }
    .nav-bar-item[aria-current="page"] .nav-icon { background: var(--md-secondary-container); }
    .nav-bar-item .count {
      position: absolute; top: -2px; right: 8px; min-width: 16px; height: 16px; padding: 0 4px;
      display: grid; place-items: center; border-radius: var(--md-shape-full);
      background: var(--md-error); color: var(--md-on-error); font: var(--md-label-small);
    }
    .toast-region { left: 16px; right: 16px; bottom: 96px; max-width: none; }
    .backdrop { padding: 12px; align-items: end; }
    .modal { max-height: calc(100vh - 24px); overflow-y: auto; }
    .palette { margin-top: 32px; }
  }
  /* A finger is not a pointer: Material asks for 48dp of target, whatever
     the control looks like. */
  @media (pointer: coarse) {
    .btn { min-height: 48px; }
    .btn.small { min-height: 40px; }
    .btn.icon { width: 48px; min-height: 48px; }
    .btn.link { min-height: 40px; }
    select.inline, input.inline { min-height: 48px; }
    th, td { height: 56px; }
    input[type="checkbox"] { width: 22px; height: 22px; }
  }
  @media (prefers-reduced-motion: reduce) {
    *, *::after { transition-duration: 1ms !important; animation-duration: 1ms !important; }
  }
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
      <p class="notice bad" id="error" hidden></p>
      <section id="view-overview" class="view"></section>
      <section id="view-approvals" class="view" hidden></section>
      <section id="view-queue" class="view" hidden></section>
      <section id="view-runs" class="view" hidden></section>
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
        <p class="muted" id="run-hint"></p>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn link state" data-close="run-modal">Cancel</button>
        <button type="submit" class="btn primary state" id="run-submit">Start</button>
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

<nav class="nav-bar" id="nav-bar" aria-label="Views"></nav>
<button class="fab state" id="fab-run" aria-label="Start a run">
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
</button>

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
const BAR_VIEWS = ["overview", "approvals", "queue", "runs"];

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
  if (view === "checks") renderChecks();
  if (view === "settings") renderSettings();
}

// The same registry the terminal interface lists, over the same read path.
// Each row says which of four states it is in — never run, running, what it
// found, or no verdict to give — because three of those look identical on a
// surface that only knows 'ok'.
function renderChecks() {
  const host = $("view-checks");
  host.replaceChildren();
  if (checks === undefined) {
    host.append(panel("Checks", { body: [el("p", { class: "empty", text: "Reading the list…" })] }));
    void loadChecks();
    return;
  }
  const ran = checks.filter((check) => checkResults.has(check.id)).length;
  const failing = checks.filter((check) => checkResults.get(check.id)?.ok === false).length;
  const meta = [
    checks.length + " checks",
    ran === 0 ? "none run yet" : ran + " run",
    failing > 0 ? failing + " failing" : ran > 0 ? "none failing" : "nothing to report",
  ].join(" · ");
  const rows = table([
    { label: "Check", value: (check) => check.title },
    { label: "Result", value: (check) => checkPill(check) },
    { label: "What it found", value: (check) => checkResults.get(check.id)?.summary ?? check.about },
    { label: "Ran", value: (check) => (checkResults.has(check.id) ? when(checkResults.get(check.id).ranAt) : { text: "—" }) },
    { label: "", value: (check) => button(checksRunning.has(check.id) ? "Running…" : "Run", {
      class: "btn small",
      disabled: checksRunning.has(check.id),
      onClick: () => runChecks([check.id]),
    }), actions: true },
  ], checks, "No checks are registered.");
  const head = el("div", { class: "row" }, [
    button("Run them all", {
      class: "btn tonal",
      disabled: checksRunning.size > 0,
      onClick: () => runChecks(checks.map((check) => check.id)),
    }),
    el("span", { class: "muted", text: "Each one reads the project as it is on disk now." }),
  ]);
  host.append(panel("Checks", { meta, body: [head, rows] }));
  for (const check of checks) {
    const result = checkResults.get(check.id);
    if (!result) continue;
    const body = [el("p", {
      class: result.ok === false ? "notice bad" : result.ok === true ? "muted" : "notice",
      text: result.summary,
    })];
    if ((result.findings ?? []).length === 0) {
      body.push(el("p", { class: "empty", text: result.ok === true ? "Nothing to look at." : "It reported no individual findings." }));
    } else {
      body.push(table([
        { label: "", value: (finding) => ({ text: finding.label ?? "", class: finding.tone === "bad" ? "bad" : finding.tone === "warn" ? "warn" : "" }) },
        { label: "Finding", value: (finding) => finding.text },
      ], result.findings, "None."));
    }
    host.append(panel(check.title, { meta: "ran " + when(result.ranAt).text, body }));
  }
}

function checkPill(check) {
  if (checksRunning.has(check.id)) return pill("running", "warn");
  const result = checkResults.get(check.id);
  if (!result) return pill("not run");
  if (result.ok === true) return pill("ok", "ok");
  if (result.ok === false) return pill("findings", "bad");
  return pill("no verdict", "warn");
}

async function loadChecks() {
  try {
    checks = (await api("/api/checks")).checks;
    render();
  } catch (error) {
    fail(error);
  }
}

// One at a time and in order, repainting between them: a check walks the
// working tree, and pretending it is instant would leave the page still.
async function runChecks(ids) {
  for (const id of ids) {
    checksRunning.add(id);
    render();
    try {
      checkResults.set(id, await api("/api/checks/run", { method: "POST", body: JSON.stringify({ id }) }));
      clearError();
    } catch (error) {
      fail(error);
    } finally {
      checksRunning.delete(id);
    }
    render();
  }
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
      hint: pricingHint(described),
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
    unpricedModels: summary.unpricedModels ?? [],
  };
}

// A cost is written into the receipt when the call happens, so a rate added
// afterwards never reaches a call already on disk. Saying only 'not priced'
// sends someone to set a rate they may already have set.
function pricingHint(described) {
  const models = described.unpricedModels;
  if (models.length === 0) return described.cost ? "from observability.pricing" : "set observability.pricing to see it";
  const named = models.slice(0, 2).map((row) => "'" + row.model + "'").join(", ");
  const more = models.length > 2 ? " and " + (models.length - 2) + " more" : "";
  const calls = described.unpriced + (described.unpriced === 1 ? " call has" : " calls have");
  return models.every((row) => row.pricedSince)
    ? calls + " no cost: they ran before the rate for " + named + " was set"
    : calls + " no rate: set observability.pricing.models for " + named + more;
}

// One row per agent invocation, indented by how deep it was spawned. Each
// row is a button: opening it does not navigate anywhere, it reveals the full
// text this agent produced — the receipt already holds it, untruncated, so
// there is nothing left to fetch.
function agentTreeRows(nodes, depth) {
  const rows = [];
  for (const node of nodes) {
    const expanded = expandedAgents.has(node.runId);
    const label = (node.workflowStep ? node.workflowStep + " · " : "") + node.agent
      + (node.provider ? " (" + node.provider + ")" : "");
    const row = el("div", { class: "agent-row", attrs: { style: "padding-left:" + (depth * 20) + "px" } }, [
      button((expanded ? "▾ " : "▸ ") + label, {
        class: "btn link agent-toggle",
        onClick: () => {
          if (expanded) expandedAgents.delete(node.runId); else expandedAgents.add(node.runId);
          render();
        },
      }),
      pill(node.status, node.status === "succeeded" ? "ok" : node.status === "failed" ? "bad" : "warn"),
      el("span", { class: "muted", text: agentDuration(node.durationMs) }),
    ]);
    rows.push(row);
    if (expanded) rows.push(agentDetail(node, depth));
    if (node.children.length > 0) rows.push(...agentTreeRows(node.children, depth + 1));
  }
  return rows;
}

function agentDuration(durationMs) {
  return typeof durationMs === "number" ? (durationMs / 1000).toFixed(1) + "s" : "—";
}

// The full reasoning, exactly as the agent produced it and the receipt holds
// it — not a preview, not a truncation. What it called and what came back
// from each call sits right beside it.
function agentDetail(node, depth) {
  const parts = [];
  parts.push(node.text
    ? el("pre", { class: "agent-text", text: node.text })
    : el("p", { class: "muted", text: node.error ? "It produced no text; see the error below." : "It produced no text." }));
  if (node.error) parts.push(el("p", { class: "notice bad", text: node.error }));
  if (node.toolCalls?.length > 0) {
    parts.push(table([
      { label: "Tool", value: (call) => call.tool ?? "—", mono: true },
      { label: "Result", value: (call) => pill(call.ok === false ? "refused" : "ran", call.ok === false ? "bad" : "ok") },
      { label: "Reason", value: (call) => ({ text: call.error ?? "", class: "bad" }) },
    ], node.toolCalls, "No tool calls."));
  }
  if (node.usage) parts.push(usagePanelBody(node.usage));
  return el("div", {
    class: "agent-detail",
    attrs: { style: "padding-left:" + (depth * 20 + 20) + "px" },
  }, parts);
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
      ["Estimated cost", described.cost ? described.cost : "not priced"],
      ...(described.unpricedModels.length > 0 || !described.cost ? [["", pricingHint(described)]] : []),
      ...(described.unpriced > 0 && described.cost ? [["Unpriced calls", String(described.unpriced)]] : []),
    ]),
  ]);
}

async function verifyOpenReceipt(file) {
  verification = { file: undefined, pending: true };
  render();
  try {
    verification = await api("/api/verify/" + encodeURIComponent(file));
    clearError();
  } catch (error) {
    verification = undefined;
    fail(error);
  }
  render();
}

function openReceipt(run) {
  return button(run.runId, { class: "btn link", onClick: async () => {
    try {
      openRun = { file: run.receiptFile, run, receipt: await api("/api/runs/" + encodeURIComponent(run.receiptFile)) };
      // One run's verdict must never be left attached to another run's file.
      verification = undefined;
      expandedAgents = new Set();
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
      ["Status", status, status === "succeeded" ? "ok" : status === "incomplete" || status === "running" ? "warn" : "bad"],
      ["Mode", run.mode],
      ["Branch", terminal.workspace?.branch ?? "—"],
      // Where the files are. A run in a worktree writes them there, uncommitted
      // unless it published, and the checkout shows nothing.
      ["Workspace", terminal.workspace?.path ?? (terminal.workspace?.managed === false ? "the checkout itself" : "—"), "mono"],
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
  // The agents that ran, as the tree they ran in: each row is what one agent
  // invocation actually did, click it open to read the full text rather than
  // the one-line summary above.
  if (outcome.agents?.length > 0) {
    body.push(el("p", { class: "muted", text: "Agents" }));
    body.push(el("div", { class: "agent-tree" }, agentTreeRows(outcome.agents, 0)));
  }
  // What it did, not only that it succeeded: a run told to write a file that
  // wrote none is a run whose 'succeeded' needs reading twice.
  if (outcome.tools) {
    body.push(el("p", { class: "muted", text: "Tools it used" }));
    body.push(table([
      { label: "Tool", value: (row) => row.tool, mono: true },
      { label: "Ran", value: (row) => String(row.ok) },
      { label: "Refused", value: (row) => ({ text: String(row.failed), class: row.failed > 0 ? "bad" : "" }) },
      { label: "First reason", value: (row) => ({ text: row.error ?? "", class: "bad" }) },
    ], outcome.tools, "None."));
  }
  if (outcome.usage) body.push(usagePanelBody(outcome.usage));
  // Clean, conflicting, or never attempted: three answers, and the reader
  // gives the same one here, in the terminal, and on the command line.
  const rehearsal = receipt.outcome?.rehearsal;
  if (rehearsal) {
    body.push(el("div", { class: "row" }, [
      el("span", { class: "muted", text: "Merge rehearsal" }),
      pill(rehearsal.text, rehearsal.state === "clean" ? "ok" : rehearsal.state === "conflicts" ? "bad" : "warn"),
    ]));
    if (rehearsal.error) body.push(el("p", { class: "muted mono", text: rehearsal.error }));
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
  // Whether the receipt is what it claims is a different question from what
  // it says, so it is asked for rather than assumed — and until it is asked,
  // the panel offers the button instead of implying either answer.
  body.push(el("p", { class: "muted", text: "Is this receipt what it claims?" }));
  if (verification === undefined || verification.file !== receipt.file) {
    body.push(el("div", { class: "row" }, [
      button("Verify", {
        class: "btn tonal",
        disabled: verification !== undefined && verification.pending === true,
        onClick: () => verifyOpenReceipt(receipt.file),
      }),
      el("span", { class: "muted", text: verification?.pending ? "Checking…" : "Rereads the file and rebuilds its hash chain." }),
    ]));
  } else {
    body.push(el("div", { class: "row" }, [
      pill(verification.valid ? "verified" : "does not verify", verification.tone),
      ...(verification.encoding ? [el("span", { class: "muted", text: verification.encoding + " hashing" })] : []),
    ]));
    body.push(el("p", { class: verification.valid ? "muted" : "notice bad", text: verification.text }));
  }
  body.push(el("div", { class: "row" }, [button("Close", { onClick: () => { openRun = undefined; verification = undefined; expandedAgents = new Set(); render(); renderPageActions(); } })]));
  // What the panel says about the receipt has to be what the receipt is: the
  // header claimed 'sealed' over a note saying it never was.
  const meta = sealed ? "sealed receipt" : status === "running" ? "still running" : "receipt not sealed";
  return panel(run.runId, { meta, body, open: true });
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
  // Which model a provider uses: offered as a live dropdown once fetched,
  // because typing a model id by hand is how a stale, retired, or misspelled
  // one ends up configured with nothing to say so until a run fails.
  const modelMatch = entry.mode !== "locked" && /^providers\.([^.]+)\.model$/.exec(entry.path);
  if (modelMatch) return modelValueControl(entry, modelMatch[1]);
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

// The model row for one provider. Free text until fetched — this project has
// no source for a model list except the provider's own API, so nothing is
// offered before that call returns.
function modelValueControl(entry, providerName) {
  const state = modelLists.get(providerName);
  const current = describeValue(entry.value);

  if (!state || state.status === "error") {
    const parts = [
      button(shortValue(entry.value).text + " ▾", {
        class: "btn link mono value",
        title: "edit this value",
        onClick: () => openEditor(entry),
      }),
      button(state ? "retry" : "fetch models", {
        class: "btn small",
        onClick: () => fetchProviderModels(providerName),
      }),
    ];
    if (state?.status === "error") parts.push(el("span", { class: "muted wrap", text: state.reason }));
    return el("span", { class: "row" }, parts);
  }
  if (state.status === "loading") {
    return el("span", { class: "row" }, [
      shortValue(entry.value).text ? el("span", { class: "mono muted", text: shortValue(entry.value).text }) : null,
      el("span", { class: "muted", text: "reading models…" }),
    ].filter(Boolean));
  }

  // Ready: the live list, as a dropdown — the same control every other
  // constrained setting uses, so picking a model works the same way here.
  const select = el("select", { class: "inline", attrs: { "aria-label": entry.path } });
  for (const model of state.models) {
    select.append(el("option", { text: model.id, attrs: { value: JSON.stringify(model.id) } }));
  }
  if (![...select.options].some((option) => option.value === current)) {
    select.append(el("option", { text: shortValue(entry.value).text, attrs: { value: current } }));
  }
  select.value = current;
  const priceNote = el("span", { class: "muted" });
  const setPriceNote = () => {
    const chosen = state.models.find((model) => JSON.stringify(model.id) === select.value);
    priceNote.textContent = !chosen
      ? ""
      : chosen.knownPrice
        ? "known price: USD " + chosen.knownPrice.inputPerMillion + "/" + chosen.knownPrice.outputPerMillion + " per M, as of " + chosen.knownPrice.asOf
        : "no known price for this model — set observability.pricing.models by hand";
  };
  setPriceNote();
  select.addEventListener("change", async () => {
    const chosenId = JSON.parse(select.value);
    const model = state.models.find((candidate) => candidate.id === chosenId);
    select.disabled = true;
    try {
      await applySetting(entry.path, select.value, scope);
      // Automatic, and never silent about where the number came from: a
      // price nobody can trace back is not something to spend real money on.
      if (model?.knownPrice) {
        // A model id is an external string and often has a dot in it
        // ('gpt-5.4'), and every settings path is itself dot-separated — so
        // 'observability.pricing.models.gpt-5.4' would split into 'gpt-5'
        // then '4', not the one key it looks like. The whole map is one
        // setting for exactly this reason; it is read back and rewritten
        // whole rather than addressed by a path that could collide with it.
        const table = (state.settings?.entries ?? []).find((row) => row.path === "observability.pricing.models")?.value ?? {};
        await applySetting(
          "observability.pricing.models",
          JSON.stringify({
            ...table,
            [chosenId]: {
              inputPerMillion: model.knownPrice.inputPerMillion,
              outputPerMillion: model.knownPrice.outputPerMillion,
              // Only where the source actually separated it — writing it
              // equal to the input rate would claim a discount nobody
              // published.
              ...(model.knownPrice.cacheReadPerMillion !== undefined
                ? { cacheReadPerMillion: model.knownPrice.cacheReadPerMillion }
                : {}),
            },
          }),
          scope,
        );
        toast(
          "Priced '" + chosenId + "' at USD " + model.knownPrice.inputPerMillion + "/" + model.knownPrice.outputPerMillion
            + " per M, from " + model.knownPrice.source + " (as of " + model.knownPrice.asOf + ") — verify against the provider.",
          "ok",
        );
      }
    } catch (error) {
      select.value = current;
      toast(error.message, "bad");
    } finally {
      select.disabled = false;
      setPriceNote();
    }
  });
  return el("span", { class: "row" }, [select, priceNote]);
}

async function fetchProviderModels(providerName) {
  modelLists.set(providerName, { status: "loading" });
  renderSettings();
  try {
    const result = await api("/api/providers/" + encodeURIComponent(providerName) + "/models");
    modelLists.set(providerName, result.available
      ? { status: "ready", models: result.models }
      : { status: "error", reason: result.reason });
  } catch (error) {
    modelLists.set(providerName, { status: "error", reason: error.message });
  }
  renderSettings();
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
setInterval(refresh, 5000);
</script>
</body>
</html>
`;
}
