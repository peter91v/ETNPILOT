// Worktrees, diffs, merge requests and settings.
// Client-side code, kept as text and joined by ../page.js into one script. It
// is not a module in the browser: no imports, no build step.
export const CLIENT_WORKTREES = `function renderWorktrees() {
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
// A unified diff as it arrives in an approval: already text, so it is read by
// its leading characters rather than by a second copy of the git parser. The
// line numbers come from the '@@' header, walked forward, which is all this
// shape needs — it is one hunk written by src/providers/text-diff.js.
function unifiedDiffView(text) {
  const rows = el("div", { class: "diff" });
  let oldLine = 0;
  let newLine = 0;
  // Doubled on purpose: this file is one template literal, so an escape here
  // is consumed when the page is rendered unless it is escaped twice.
  for (const line of String(text).split("\\n")) {
    // The '---' and '+++' headers name the file, which the panel says above.
    if (line.startsWith("---") || line.startsWith("+++")) continue;
    if (line.startsWith("@@")) {
      const position = /^@@ -(\\d+)(?:,\\d+)? \\+(\\d+)/.exec(line);
      if (position) {
        oldLine = Number(position[1]);
        newLine = Number(position[2]);
      }
      rows.append(el("div", { class: "diff-line hunk" }, [
        el("span", { class: "diff-gutter", text: "" }),
        el("span", { class: "diff-gutter", text: "" }),
        el("span", { class: "diff-text", text: line }),
      ]));
      continue;
    }
    const kind = line.startsWith("+") ? "add" : line.startsWith("-") ? "remove" : "context";
    const body = line.slice(1);
    const left = kind === "add" ? "" : String(oldLine++);
    const right = kind === "remove" ? "" : String(newLine++);
    rows.append(el("div", { class: "diff-line " + kind }, [
      el("span", { class: "diff-gutter", text: left }),
      el("span", { class: "diff-gutter", text: right }),
      el("span", { class: "diff-text", text: (kind === "add" ? "+" : kind === "remove" ? "−" : " ") + body }),
    ]));
  }
  return el("div", { class: "scroll" }, [rows]);
}

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
        ? "known price: USD " + chosen.knownPrice.inputPerMillion + "/" + chosen.knownPrice.outputPerMillion + " per M, as of " + chosen.knownPrice.asOf + " · " + chosen.knownPrice.status + " · " + chosen.knownPrice.source
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
              ...(model.knownPrice.cacheWritePerMillion !== undefined ? { cacheWritePerMillion: model.knownPrice.cacheWritePerMillion } : {}),
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
`;
