// The page is written in English. When the person's language is German, the
// text the page draws is translated where it lands in the document: text
// nodes and the attributes a person reads. Anything the catalog does not know
// stays English, so a new string is never blank. The choice is kept in this
// browser only.
const LANG = (() => {
  try {
    const saved = localStorage.getItem("etnpilot-lang");
    if (saved === "de" || saved === "en") return saved;
  } catch (error) {
    // Storage that cannot be read falls back to the browser's language.
  }
  return String(navigator.language || "en").toLowerCase().startsWith("de") ? "de" : "en";
})();

const TRANSLATED_ATTRIBUTES = ["title", "aria-label", "placeholder"];

function translateText(text) {
  const trimmed = text.trim();
  if (!trimmed) return text;
  if (Object.hasOwn(DE, trimmed)) return text.replace(trimmed, DE[trimmed]);
  for (const [pattern, build] of DE_PATTERNS) {
    const match = pattern.exec(trimmed);
    if (match) return text.replace(trimmed, build(...match));
  }
  // Parts drawn as one line: "title — explanation", "a · b · c".
  for (const separator of [" — ", " · "]) {
    if (!trimmed.includes(separator)) continue;
    const parts = trimmed.split(separator);
    const translated = parts.map((part) => translateText(part));
    if (translated.some((part, index) => part !== parts[index])) return text.replace(trimmed, translated.join(separator));
  }
  return text;
}

function translateTree(root) {
  if (root.nodeType === Node.TEXT_NODE) {
    const next = translateText(root.nodeValue);
    if (next !== root.nodeValue) root.nodeValue = next;
    return;
  }
  if (root.nodeType !== Node.ELEMENT_NODE) return;
  for (const name of TRANSLATED_ATTRIBUTES) {
    if (root.hasAttribute(name)) {
      const current = root.getAttribute(name);
      const next = translateText(current);
      if (next !== current) root.setAttribute(name, next);
    }
  }
  for (const child of root.childNodes) translateTree(child);
}

function startTranslation() {
  document.documentElement.lang = LANG;
  if (LANG !== "de") return;
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "characterData") translateTree(record.target);
      else if (record.type === "attributes") translateTree(record.target);
      else for (const node of record.addedNodes) translateTree(node);
    }
  });
  translateTree(document.body);
  observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: TRANSLATED_ATTRIBUTES });
}

function addLanguageSwitch() {
  const footer = document.querySelector(".sidebar-footer");
  if (!footer) return;
  const label = document.createElement("label");
  label.className = "runtime-meta";
  label.textContent = "Language";
  const select = document.createElement("select");
  select.id = "language";
  for (const [value, name] of [["en", "English"], ["de", "Deutsch"]]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = name;
    select.append(option);
  }
  select.value = LANG;
  select.addEventListener("change", () => {
    try {
      localStorage.setItem("etnpilot-lang", select.value);
    } catch (error) {
      // Without storage the choice lasts until the page is closed.
    }
    location.reload();
  });
  label.append(" ", select);
  footer.append(label);
}

addLanguageSwitch();
startTranslation();
