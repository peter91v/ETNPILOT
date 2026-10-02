// @ts-check
import { DE, DE_PATTERNS } from "./de.js";
import { DE_TUI, DE_TUI_PATTERNS } from "./de-tui.js";

// The terminal interface's side of translation. The page has its own copy of
// this logic in src/ui/client/i18n.js (it is a script, not a module); the two
// are kept alike by a test.

/** @param {Record<string, string | undefined>} [env] */
export function languageFrom(env = process.env) {
  const value = env.ETNPILOT_LANG ?? env.LC_ALL ?? env.LC_MESSAGES ?? env.LANG ?? "";
  return String(value).toLowerCase().startsWith("de") ? "de" : "en";
}

const CATALOG = { ...DE, ...DE_TUI };
const PATTERNS = [...DE_TUI_PATTERNS, ...DE_PATTERNS];

/** The German text for a trimmed English one, or undefined. */
export function lookup(trimmed) {
  const key = trimmed.replace(/\s+/g, " ");
  if (Object.hasOwn(CATALOG, key)) return CATALOG[key];
  for (const [pattern, build] of PATTERNS) {
    const match = pattern.exec(key);
    if (match) return build(...match);
  }
  for (const separator of [" — ", " · "]) {
    if (!key.includes(separator)) continue;
    const parts = key.split(separator);
    const translated = parts.map((part) => lookup(part) ?? part);
    if (translated.some((part, index) => part !== parts[index])) return translated.join(separator);
  }
  return undefined;
}

/**
 * One piece of text. Space around it is kept, and it keeps its width where it
 * can: a table column is padded to a width before it is drawn, so a German word
 * takes the room the English one left, and gives back what it does not need.
 * @param {unknown} text
 * @param {string} language
 */
export function translateSegment(text, language) {
  const source = String(text);
  if (language !== "de") return source;
  const trimmed = source.trim();
  if (!trimmed) return source;
  const german = lookup(trimmed);
  if (german === undefined) return source;
  const lead = source.slice(0, source.length - source.trimStart().length);
  const trail = source.slice(source.trimEnd().length);
  const difference = german.length - trimmed.length;
  const room = difference > 0 ? trail.slice(Math.min(difference, Math.max(0, trail.length - 1))) : `${trail}${" ".repeat(-difference)}`;
  return `${lead}${german}${room}`;
}
