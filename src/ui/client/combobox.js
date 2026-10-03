// A combobox: a text field that is also a list to choose from. The person can
// pick (the chevron opens the whole list) or type any value the list does not
// have, which is why a model field is one: a provider offers a list, a newer
// model may not be on it yet. Options can arrive later (`setOptions`) or be
// fetched the first time the list is opened (`load`).

function combobox({ id, label, value = "", options = [], load, emptyNote, onInput, placeholder = "", inline = false } = /** @type {any} */ ({})) {
  const listId = id + "-list";
  let items = options.slice();
  let loaded = !load;
  let loading = false;
  let active = -1;
  // Opened with the chevron: the whole list, whatever is typed, until typing resumes.
  let everything = false;
  let choosing = false;
  const input = el("input", {
    class: inline ? "inline" : "",
    attrs: { id, role: "combobox", "aria-expanded": "false", "aria-controls": listId, "aria-autocomplete": "list", autocomplete: "off", placeholder, value, ...(inline ? { "aria-label": label } : {}) },
  });
  const toggle = el("button", { class: "combo-toggle", attrs: { type: "button", "aria-label": label + ": show the list", tabindex: "-1" } });
  toggle.append(icon("M6 9l6 6 6-6"));
  const list = el("ul", { class: "combo-list", attrs: { id: listId, role: "listbox", "aria-label": label } });
  list.hidden = true;
  const box = el("div", { class: "combo" + (inline ? " inline" : "") }, [input, toggle, list]);

  function shown() {
    const needle = input.value.trim().toLowerCase();
    return everything || needle === "" ? items : items.filter((item) => item.toLowerCase().includes(needle));
  }
  function draw() {
    const visible = shown();
    list.replaceChildren();
    if (visible.length === 0) {
      // Why there is nothing to pick, in the list's own words, when the list is
      // empty because the provider offered none rather than because of the filter.
      const why = items.length === 0 ? emptyNote?.() : undefined;
      list.append(el("li", { class: "combo-empty", text: loading ? "Reading the list…" : why ?? "No match: your text is used as it is.", attrs: { role: "presentation" } }));
    }
    visible.forEach((item, index) => {
      const row = el("li", { class: "combo-option" + (index === active ? " active" : "") + (item === input.value ? " chosen" : ""), text: item, attrs: { role: "option", id: listId + "-" + index, "aria-selected": String(item === input.value) } });
      // mousedown, not click: the field loses focus first, and that closes the list.
      row.addEventListener("mousedown", (event) => { event.preventDefault(); choose(item); });
      list.append(row);
    });
  }
  function open(all) {
    everything = all;
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
    draw();
    if (!loaded && !loading) {
      loading = true;
      Promise.resolve(load()).then((fresh) => {
        items = Array.isArray(fresh) ? fresh : items;
        // A list that came back empty is asked for again next time: the key may have been added since.
        loaded = items.length > 0;
        loading = false;
        draw();
      }, () => { loading = false; draw(); });
    }
  }
  function close() {
    list.hidden = true;
    active = -1;
    input.setAttribute("aria-expanded", "false");
  }
  function choose(item) {
    input.value = item;
    close();
    // Told like a typed value, but picking must not open the list again.
    choosing = true;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    choosing = false;
  }

  input.addEventListener("input", () => { onInput?.(input.value); if (!choosing && (!list.hidden || document.activeElement === input)) { active = -1; open(false); } });
  input.addEventListener("focus", () => open(false));
  input.addEventListener("blur", () => setTimeout(close, 120));
  input.addEventListener("keydown", (event) => {
    const visible = shown();
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (list.hidden) open(true);
      active = Math.max(0, Math.min(visible.length - 1, active + (event.key === "ArrowDown" ? 1 : -1)));
      draw();
      list.children[active]?.scrollIntoView?.({ block: "nearest" });
    } else if (event.key === "Enter" && !list.hidden && active >= 0 && visible[active] !== undefined) {
      event.preventDefault();
      choose(visible[active]);
    } else if (event.key === "Escape" && !list.hidden) {
      event.preventDefault();
      close();
    }
  });
  toggle.addEventListener("mousedown", (event) => {
    event.preventDefault();
    if (list.hidden) { input.focus(); open(true); } else close();
  });

  box.setOptions = (fresh) => { items = fresh.slice(); loaded = true; if (!list.hidden) draw(); };
  return box;
}

// The ids a provider offers, asked for per provider and kept for the life of the
// page, but only when it answered: a provider that could not list (no key yet, no
// list) is asked again the next time, and says why.
const providerModelIds = new Map();
const providerModelNotes = new Map();
async function modelIdsFor(provider) {
  if (!provider) {
    providerModelNotes.set("", "No provider is chosen, so there is no list. Type a model id.");
    return [];
  }
  if (providerModelIds.has(provider)) return providerModelIds.get(provider);
  try {
    const result = await api("/api/providers/" + encodeURIComponent(provider) + "/models");
    if (result.available) {
      const ids = result.models.map((entry) => entry.id);
      providerModelIds.set(provider, ids);
      providerModelNotes.delete(provider);
      return ids;
    }
    providerModelNotes.set(provider, "'" + provider + "' offers no list: " + (result.reason ?? "no reason given") + ". Type a model id.");
  } catch (error) {
    providerModelNotes.set(provider, "The list of '" + provider + "' could not be read: " + error.message + ". Type a model id.");
  }
  return [];
}

// The note for the provider a field is about, for `emptyNote`.
function modelNoteFor(provider) {
  return providerModelNotes.get(provider ?? "");
}

// A combobox with its label, the way `field` draws a text field.
function comboField(id, label, value, { load, emptyNote, onInput, placeholder } = /** @type {any} */ ({})) {
  return el("div", { class: "field" }, [el("label", { text: label, attrs: { for: id } }), combobox({ id, label, value, load, emptyNote, onInput, placeholder })]);
}
