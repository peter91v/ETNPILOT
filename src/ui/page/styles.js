// The page's stylesheet: Material Design 3 tokens first, then components.
// Below the token block there are no colour literals; see test/ui-material.test.js.
export const STYLES = `
.markdown p { margin: .4em 0; }
.markdown pre { overflow-x: auto; white-space: pre; padding: .8em; border-radius: 8px; background: var(--surface-container); }
.markdown code { font-family: monospace; }
.markdown a { overflow-wrap: anywhere; }
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
  /* The floating button sits over the corner; the last thing on a page has to
     be able to scroll clear of it, or a button there cannot be pressed. */
  @media (max-width: 900px) { .view:not(#view-chat) { padding-bottom: 88px; } }
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
  .card { display: grid; gap: 8px; padding: 12px 16px; border: 1px solid var(--md-outline-variant); border-radius: var(--md-shape-md); background: var(--md-surface); min-width: 0; }
  .card.open { background: var(--md-surface-container-low); }
  .card-head, .content-row {
    display: flex; align-items: center; gap: 12px; width: 100%; min-height: 48px; padding: 0; border: 0; background: transparent;
    text-align: left; cursor: pointer; color: inherit;
  }
  .content-row { padding: 8px 4px; border-bottom: 1px solid var(--md-outline-variant); }
  .content-row:last-child { border-bottom: 0; }
  .card-main { display: grid; gap: 4px; min-width: 0; flex: 1; }
  .card-title { margin: 0; font: var(--md-title-medium); overflow-wrap: anywhere; }
  .card-sub { color: var(--md-on-surface-variant); font: var(--md-body-medium); overflow-wrap: anywhere; }
  .card-chev { color: var(--md-on-surface-variant); font-size: 18px; }
  .card-h { margin: 8px 0 0; font: var(--md-label-large); color: var(--md-on-surface-variant); text-transform: uppercase; letter-spacing: .5px; }
  .card-detail { display: grid; gap: 8px; min-width: 0; }
  .card-actions { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; }
  .chips { display: flex; flex-wrap: wrap; gap: 8px; min-width: 0; }
  .filters .btn[aria-pressed="true"] { font-weight: 600; }
  .scroll-pre { max-height: 320px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
  .scroll-pre.tall { max-height: 60vh; }
  .modal.wide { width: min(640px, 100%); }
  .flow { list-style: none; margin: 0; padding: 0; display: grid; gap: 0; }
  .flow-step {
    display: grid; grid-template-columns: minmax(0, 1fr); gap: 2px; padding: 6px 0 6px 16px; position: relative;
    border-left: 2px solid var(--md-outline-variant); margin-left: 6px;
  }
  .flow-step::before { content: ""; position: absolute; left: -7px; top: 12px; width: 12px; height: 12px; border-radius: 50%; background: var(--md-primary); }
  .flow-step.gate::before { background: var(--md-warning); }
  .flow-step.check::before { background: var(--md-secondary); }
  .flow-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; }
  .flow-id { font: var(--md-label-large); }
  .flow-type { color: var(--md-on-surface-variant); font: var(--md-label-medium); }
  .flow-what, .flow-needs { color: var(--md-on-surface-variant); font: var(--md-body-small); overflow-wrap: anywhere; }
  .builder-step { display: grid; gap: 12px; padding: 12px; border: 1px solid var(--md-outline-variant); border-radius: var(--md-shape-md); }
  .builder-head { display: grid; grid-template-columns: 32px minmax(0, 1fr) auto; gap: 8px; align-items: end; }
  .builder-num { display: grid; place-items: center; width: 32px; height: 32px; border-radius: 50%; background: var(--md-primary-container); color: var(--md-on-primary-container); font: var(--md-label-large); }
  .banner {
    display: grid; grid-template-columns: 24px minmax(0, 1fr); gap: 4px 16px; align-items: start;
    padding: 16px; border-radius: var(--md-shape-md); background: var(--md-error-container); color: var(--md-on-error-container);
  }
  .banner.info { background: var(--md-secondary-container); color: var(--md-on-secondary-container); }
  .banner[hidden] { display: none; }
  .banner > svg { width: 24px; height: 24px; margin-top: 2px; }
  .banner-title { margin: 0 0 4px; font: var(--md-title-small); font-weight: 600; }
  .banner-text > p { margin: 0 0 6px; font: var(--md-body-medium); overflow-wrap: anywhere; }
  .banner-code {
    margin: 4px 0 0; padding: 8px 12px; border-radius: var(--md-shape-sm); white-space: pre-wrap; overflow-wrap: anywhere;
    font: 12px/1.6 var(--mono); background: color-mix(in srgb, currentColor 10%, transparent);
  }
  .banner-code:empty { display: none; }
  .banner-actions { grid-column: 2; display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; }
  .check { display: grid; grid-template-columns: 24px minmax(0, 1fr); gap: 12px; align-items: start; font: var(--md-body-medium); cursor: pointer; min-height: 48px; }
  .check[hidden] { display: none; }
  .check input { width: 20px; height: 20px; margin: 2px; accent-color: var(--md-primary); }
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
  /* Chat ----------------------------------------------------------------
     A conversation reads top to bottom; the composer stays within reach. Only
     tokens, like everything else here. */
  .chat { display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; align-content: start; }
  .chat-head { margin-left: auto; justify-content: flex-end; }
  .chat-thread { display: grid; gap: 16px; align-content: start; min-height: 120px; }
  .msg { display: grid; grid-template-columns: minmax(0, 1fr); gap: 4px; max-width: min(760px, 100%); min-width: 0; }
  .msg.you { justify-self: end; }
  .msg .who { color: var(--md-on-surface-variant); font: var(--md-label-medium); letter-spacing: .5px; }
  .msg.you .who { justify-self: end; }
  .msg .said {
    margin: 0; padding: 12px 16px; border-radius: var(--md-shape-lg); white-space: pre-wrap;
    overflow-wrap: anywhere; font: var(--md-body-large); letter-spacing: .5px;
  }
  .msg.you .said { background: var(--md-primary-container); color: var(--md-on-primary-container); border-bottom-right-radius: var(--md-shape-xs); }
  .msg.agent .said { background: var(--md-surface-container-high); color: var(--md-on-surface); border-bottom-left-radius: var(--md-shape-xs); }
  .msg.failed .said { background: var(--md-error-container); color: var(--md-on-error-container); }
  .msg .meta { color: var(--md-on-surface-variant); font: var(--md-label-small); letter-spacing: .5px; }
  .chat-rule { margin: 0; text-align: center; font: var(--md-label-medium); }
  .attach-row { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; }
  .attach-row.calls { justify-content: flex-start; }
  .attach-row.calls .pill {
    width: auto; max-width: 100%; height: auto; min-height: 32px; padding: 6px 12px; white-space: normal;
    overflow-wrap: anywhere; align-items: flex-start; text-align: left;
  }
  .attach-row.calls .pill::before { flex: none; margin-top: 5px; }
  .chat-approvals { display: grid; gap: 16px; }
  .composer {
    position: sticky; bottom: 0; z-index: 4; display: grid; gap: 12px; padding: 16px;
    background: var(--md-surface-container-low); border: 1px solid var(--md-outline-variant);
    border-radius: var(--md-shape-lg); box-shadow: var(--md-elevation-1);
  }
  /* While a turn is running the box cannot send, and a decision may be waiting
     above it: it must not float over the buttons that answer it. */
  .composer.waiting { position: static; }
  .view-chat .fab { display: none; }
  .composer textarea {
    width: 100%; min-height: 72px; max-height: 240px; resize: vertical; padding: 12px 16px;
    border: 1px solid var(--md-outline); border-radius: var(--md-shape-xs); background: transparent;
    color: var(--md-on-surface); font: var(--md-body-large); letter-spacing: .5px;
  }
  .composer textarea:focus { border-color: var(--md-primary); box-shadow: 0 0 0 1px var(--md-primary); outline: 0; }
  .composer textarea::placeholder { color: var(--md-on-surface-variant); }
  .composer-options summary {
    min-height: 40px; display: flex; align-items: center; cursor: pointer;
    color: var(--md-on-surface-variant); font: var(--md-label-large); letter-spacing: .1px;
  }
  .composer-options[open] summary { margin-bottom: 8px; }
  .composer-controls { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  .composer-controls .grow { flex: 1 1 auto; }
  .composer-controls select.inline, .composer-controls input.inline { flex: 1 1 160px; max-width: 260px; }
  .btn[hidden] { display: none; }
  @media (max-width: 600px) {
    /* Above the bottom navigation bar, which is 80px tall. */
    .composer { bottom: 88px; }
    .composer-controls select.inline, .composer-controls input.inline { flex: 1 1 100%; max-width: none; }
  }
  .mention-list {
    position: absolute; left: 16px; right: 16px; bottom: calc(100% + 4px); max-height: 240px; overflow-y: auto;
    background: var(--md-surface-container-high); border-radius: var(--md-shape-md); box-shadow: var(--md-elevation-3);
    padding: 8px 0; z-index: 6;
  }
  .mention-list[hidden] { display: none; }
  .mention-item {
    display: block; width: 100%; padding: 10px 16px; border: 0; text-align: left; background: transparent;
    color: var(--md-on-surface); font: var(--md-body-medium); letter-spacing: .25px; overflow-wrap: anywhere;
  }
  .mention-item[aria-selected="true"] { background: var(--md-secondary-container); color: var(--md-on-secondary-container); }
  /* A finger is not a pointer: Material asks for 48dp of target, whatever
     the control looks like. */
  @media (pointer: coarse) {
    .btn, .btn.small, .btn.link { min-height: 48px; }
    .btn.icon, #open-palette, #menu { width: 48px; min-height: 48px; }
    .btn { min-width: 48px; }
    summary, .composer-options summary { min-height: 48px; display: flex; align-items: center; }
    label:has(> input[type="checkbox"]) { min-height: 48px; display: inline-flex; align-items: center; gap: 8px; }
    select.inline, input.inline { min-height: 48px; }
    th, td { height: 56px; }
    input[type="checkbox"] { width: 22px; height: 22px; }
  }
  @media (prefers-reduced-motion: reduce) {
    *, *::after { transition-duration: 1ms !important; animation-duration: 1ms !important; }
  }`;
