// A combobox: a text field that is also a list to choose from. The person can
// pick (the chevron opens the whole list) or type any value the list does not
// have, which is why a model field is one: a provider offers a list, a newer
// model may not be on it yet. Options can arrive later (`setOptions`) or be
// fetched the first time the list is opened (`load`).

function combobox({ id, label, value = "", options = [], load, onInput, placeholder = "", inline = false } = /** @type {any} */ ({})) {
  const listId = id + "-list";
  let items = options.slice();
  let loaded = !load;
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
      list.append(el("li", { class: "combo-empty", text: loaded ? "No match: your text is used as it is." : "Reading the list…", attrs: { role: "presentation" } }));
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
    if (!loaded) {
      loaded = true;
      Promise.resolve(load()).then((fresh) => { items = Array.isArray(fresh) ? fresh : items; draw(); }, () => { draw(); });
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

// The ids a provider offers, asked for once per provider and kept for the
// life of the page; a provider that cannot list (no key, no list) offers none.
const providerModelIds = new Map();
async function modelIdsFor(provider) {
  if (!provider) return [];
  if (providerModelIds.has(provider)) return providerModelIds.get(provider);
  let ids = [];
  try {
    const result = await api("/api/providers/" + encodeURIComponent(provider) + "/models");
    if (result.available) ids = result.models.map((entry) => entry.id);
  } catch { /* a courtesy: typing a model still works */ }
  providerModelIds.set(provider, ids);
  return ids;
}

// A combobox with its label, the way `field` draws a text field.
function comboField(id, label, value, { load, onInput, placeholder } = /** @type {any} */ ({})) {
  return el("div", { class: "field" }, [el("label", { text: label, attrs: { for: id } }), combobox({ id, label, value, load, onInput, placeholder })]);
}
