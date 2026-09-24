// The page for a directory with no project in it. It is a page of its own
// rather than an eighth view, for the same reason the terminal interface makes
// it a screen of its own: there is nothing else to look at yet.
//
// Same rules as the review page: no framework, no build step, nothing loaded
// from a network, every value inserted as text. Material Design 3 throughout,
// from the same tokens — a second design system for one screen would be a
// second design system.
export function renderSetupPage(token, status) {
  const data = JSON.stringify({
    root: status.root,
    configFile: status.configFile,
    checkout: status.checkout,
    templates: status.templates,
  });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#f5fbf8" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0e1513" media="(prefers-color-scheme: dark)">
<title>ETNPilot — no project here yet</title>
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='12' fill='%230b0f13'/%3E%3Cpath d='M16 18h32v8H25v8h20v8H25v4h23v8H16z' fill='%233ee6c1'/%3E%3C/svg%3E">
<style>
  :root {
    color-scheme: light dark;
    --md-primary: #00695c; --md-on-primary: #ffffff;
    --md-primary-container: #85f6e0; --md-on-primary-container: #002019;
    --md-secondary-container: #cce8e3; --md-on-secondary-container: #051f1c;
    --md-error: #b3261e; --md-error-container: #f9dedc; --md-on-error-container: #410e0b;
    --md-warning-container: #ffddb0; --md-on-warning-container: #271900;
    --md-surface: #f5fbf8; --md-on-surface: #171d1b; --md-on-surface-variant: #3f4946;
    --md-outline: #6f7977; --md-outline-variant: #bfc9c6;
    --md-surface-container-low: #eff5f2; --md-surface-container-high: #e3eae7;
    --md-shape-sm: 8px; --md-shape-md: 12px; --md-shape-lg: 16px; --md-shape-full: 999px;
    --md-elevation-1: 0 1px 2px rgba(0,0,0,.30), 0 1px 3px 1px rgba(0,0,0,.15);
    --md-ease-standard: cubic-bezier(.2, 0, 0, 1);
    --md-state-hover: .08; --md-state-focus: .10; --md-state-press: .10;
    --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
    --sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    --md-headline-small: 400 24px/32px var(--sans);
    --md-title-medium: 500 16px/24px var(--sans);
    --md-body-medium: 400 14px/20px var(--sans);
    --md-body-small: 400 12px/16px var(--sans);
    --md-label-large: 500 14px/20px var(--sans);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --md-primary: #66d9c4; --md-on-primary: #003730;
      --md-primary-container: #005046; --md-on-primary-container: #85f6e0;
      --md-secondary-container: #324b48; --md-on-secondary-container: #cce8e3;
      --md-error: #ffb4ab; --md-error-container: #93000a; --md-on-error-container: #ffdad6;
      --md-warning-container: #5e4100; --md-on-warning-container: #ffddb0;
      --md-surface: #0e1513; --md-on-surface: #dee4e1; --md-on-surface-variant: #bfc9c6;
      --md-outline: #899390; --md-outline-variant: #3f4946;
      --md-surface-container-low: #171d1b; --md-surface-container-high: #262b2a;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; padding: 24px 16px; display: grid; align-content: start;
    justify-items: center; background: var(--md-surface); color: var(--md-on-surface);
    font: var(--md-body-medium); letter-spacing: .25px;
  }
  button, input { font: inherit; color: inherit; }
  :is(button, input):focus-visible { outline: 3px solid var(--md-primary); outline-offset: 2px; }
  .state { position: relative; isolation: isolate; }
  .state::after {
    content: ""; position: absolute; inset: 0; border-radius: inherit; background: currentColor;
    opacity: 0; pointer-events: none; transition: opacity 200ms var(--md-ease-standard);
  }
  .state:hover::after { opacity: var(--md-state-hover); }
  .state:focus-visible::after { opacity: var(--md-state-focus); }
  .state:active::after { opacity: var(--md-state-press); }
  .sheet { width: min(640px, 100%); display: grid; gap: 16px; }
  .brand { display: flex; align-items: center; gap: 12px; }
  .brand-mark {
    width: 40px; height: 40px; display: grid; place-items: center; border-radius: var(--md-shape-full);
    background: var(--md-primary-container); color: var(--md-on-primary-container); font: var(--md-title-medium);
  }
  h1 { margin: 0; font: var(--md-headline-small); }
  p { margin: 0; }
  .path { font: 12px/1.5 var(--mono); color: var(--md-on-surface-variant); overflow-wrap: anywhere; }
  .notice {
    padding: 12px 16px; border-radius: var(--md-shape-sm);
    background: var(--md-warning-container); color: var(--md-on-warning-container);
  }
  .notice.bad { background: var(--md-error-container); color: var(--md-on-error-container); }
  .templates { display: grid; gap: 8px; }
  /* Each template is a card you choose, so it is one control, and the chosen
     one carries the secondary container rather than an extra tick. */
  .template {
    width: 100%; padding: 16px; display: grid; gap: 8px; text-align: left; cursor: pointer;
    background: var(--md-surface); color: var(--md-on-surface);
    border: 1px solid var(--md-outline-variant); border-radius: var(--md-shape-md);
  }
  .template[aria-pressed="true"] {
    background: var(--md-secondary-container); color: var(--md-on-secondary-container);
    border-color: transparent;
  }
  .template-name { font: var(--md-title-medium); letter-spacing: .15px; }
  .template-about { font: var(--md-body-medium); letter-spacing: .25px; }
  .template-changes { margin: 0; font: 12px/1.7 var(--mono); }
  .actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .btn {
    min-height: 40px; padding: 0 24px; display: inline-flex; align-items: center; justify-content: center;
    border: 0; border-radius: var(--md-shape-full); background: var(--md-primary); color: var(--md-on-primary);
    cursor: pointer; font: var(--md-label-large); letter-spacing: .1px;
  }
  .btn:disabled { opacity: .38; cursor: not-allowed; }
  .footnote { color: var(--md-on-surface-variant); font: var(--md-body-small); letter-spacing: .4px; }
  @media (pointer: coarse) { .btn { min-height: 48px; } }
  @media (prefers-reduced-motion: reduce) { *, *::after { transition-duration: 1ms !important; } }
</style>
</head>
<body>
<main class="sheet">
  <div class="brand">
    <span class="brand-mark" aria-hidden="true">E</span>
    <h1>No project here yet</h1>
  </div>
  <p>This directory has no <code>.etnpilot/etnpilot.yaml</code>, so there is nothing to review.</p>
  <p class="path" id="root"></p>
  <p class="notice" id="checkout" hidden></p>
  <p>Choose what to create. It writes <code>.etnpilot/</code> — the configuration, one agent manifest
     and its prompt. Nothing outside that directory is touched, and nothing is committed for you.</p>
  <div class="templates" id="templates"></div>
  <div class="actions">
    <button class="btn state" id="create">Create it</button>
    <span class="footnote" id="status"></span>
  </div>
  <p class="notice bad" id="error" hidden></p>
  <p class="footnote"><code>etnpilot init --template &lt;name&gt;</code> does the same thing from the terminal.</p>
</main>
<script>
const TOKEN = ${JSON.stringify(token)};
const STATUS = ${data};
let chosen = STATUS.templates[0]?.id;

document.getElementById("root").textContent = STATUS.root;
if (!STATUS.checkout.inside) {
  const box = document.getElementById("checkout");
  box.textContent = "This is not a git checkout. A project can still be created; a run needs one, "
    + "because it works in a worktree and rehearses its merge. 'git init' is enough.";
  box.hidden = false;
}

function renderTemplates() {
  const host = document.getElementById("templates");
  host.replaceChildren();
  for (const template of STATUS.templates) {
    const node = document.createElement("button");
    node.className = "template state";
    node.type = "button";
    node.setAttribute("aria-pressed", String(template.id === chosen));
    const name = document.createElement("span");
    name.className = "template-name";
    name.textContent = template.id;
    const about = document.createElement("span");
    about.className = "template-about";
    about.textContent = template.about;
    node.append(name, about);
    // What it changes from the documented default, read from the template
    // itself: a description kept beside one goes wrong.
    if (template.changes.length > 0) {
      const list = document.createElement("dl");
      list.className = "template-changes";
      for (const change of template.changes) {
        const term = document.createElement("dt");
        term.textContent = change.path + ": " + JSON.stringify(change.value);
        list.append(term);
      }
      node.append(list);
    }
    node.addEventListener("click", () => { chosen = template.id; renderTemplates(); });
    host.append(node);
  }
}

async function create() {
  const button = document.getElementById("create");
  const status = document.getElementById("status");
  const error = document.getElementById("error");
  button.disabled = true;
  status.textContent = "Creating…";
  error.hidden = true;
  try {
    const response = await fetch("/api/project/create", {
      method: "POST",
      headers: { "x-etnpilot-token": TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ template: chosen }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error ?? ("request failed (" + response.status + ")"));
    // The server is serving the review page now; this one has nothing left
    // to say, so it gets out of the way.
    status.textContent = "Created " + payload.configFile + ". Opening the review page…";
    location.reload();
  } catch (failure) {
    // A refusal belongs on the page that asked, with the reason on it.
    error.textContent = failure.message;
    error.hidden = false;
    status.textContent = "";
    button.disabled = false;
  }
}

document.getElementById("create").addEventListener("click", () => { void create(); });
renderTemplates();
</script>
</body>
</html>`;
}
