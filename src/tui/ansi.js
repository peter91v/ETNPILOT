// Terminal primitives as plain strings. Nothing here touches a real terminal,
// so the renderers built on it stay pure and testable without a TTY.

const ESCAPE = /\u001B\[[0-9;]*[A-Za-z]/g;

// The same palette the web surface uses, mapped onto the 256-colour cube.
export const COLORS = Object.freeze({
  accent: 111,
  ok: 78,
  warn: 179,
  bad: 210,
  muted: 246,
  dim: 243,
  ink: 252,
});

export function createStyle({ color = true } = {}) {
  const paint = (text, code) => (color ? `\u001B[38;5;${code}m${text}\u001B[39m` : String(text));
  return {
    enabled: color,
    accent: (text) => paint(text, COLORS.accent),
    ok: (text) => paint(text, COLORS.ok),
    warn: (text) => paint(text, COLORS.warn),
    bad: (text) => paint(text, COLORS.bad),
    muted: (text) => paint(text, COLORS.muted),
    dim: (text) => paint(text, COLORS.dim),
    ink: (text) => paint(text, COLORS.ink),
    tone: (text, name) => paint(text, COLORS[name] ?? COLORS.ink),
    bold: (text) => (color ? `\u001B[1m${text}\u001B[22m` : String(text)),
    invert: (text) => (color ? `\u001B[7m${text}\u001B[27m` : String(text)),
  };
}

export function stripAnsi(text) {
  return String(text).replaceAll(ESCAPE, "");
}

// Escape sequences occupy no columns, so width is measured on the visible text.
export function displayWidth(text) {
  return stripAnsi(text).length;
}

// Truncating styled text has to keep the escape sequences intact, otherwise a
// colour bleeds into the rest of the line.
export function truncate(text, width) {
  if (width <= 0) return "";
  const source = String(text);
  if (displayWidth(source) <= width) return source;
  const limit = width - 1;
  let visible = 0;
  let output = "";
  let index = 0;
  while (index < source.length && visible < limit) {
    if (source[index] === "\u001B") {
      const match = /^\u001B\[[0-9;]*[A-Za-z]/.exec(source.slice(index));
      if (match) {
        output += match[0];
        index += match[0].length;
        continue;
      }
    }
    output += source[index];
    index += 1;
    visible += 1;
  }
  return `${output}\u001B[39m…`;
}

export function pad(text, width) {
  const cut = truncate(text, width);
  return cut + " ".repeat(Math.max(0, width - displayWidth(cut)));
}

export function padStart(text, width) {
  const cut = truncate(text, width);
  return " ".repeat(Math.max(0, width - displayWidth(cut))) + cut;
}

export const screen = Object.freeze({
  enter: "\u001B[?1049h\u001B[?25l",
  leave: "\u001B[?25h\u001B[?1049l",
  clear: "\u001B[2J\u001B[H",
  home: "\u001B[H",
  eraseLine: "\u001B[K",
});

// A distance a person reads at a glance, not a timestamp they have to parse.
export function since(iso, now = Date.now()) {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return "—";
  const seconds = Math.round((now - time) / 1000);
  const ago = seconds >= 0;
  const magnitude = Math.abs(seconds);
  for (const [suffix, size] of [["d", 86_400], ["h", 3600], ["m", 60]]) {
    if (magnitude >= size) return `${Math.floor(magnitude / size)}${suffix}${ago ? "" : " ahead"}`;
  }
  return magnitude < 5 ? "now" : `${magnitude}s${ago ? "" : " ahead"}`;
}

// How long until a deadline, read forwards rather than as a negative age.
export function until(iso, now = Date.now()) {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return "—";
  const seconds = Math.round((time - now) / 1000);
  if (seconds <= 0) return "expired";
  for (const [suffix, size] of [["d", 86_400], ["h", 3600], ["m", 60]]) {
    if (seconds >= size) return `${Math.floor(seconds / size)}${suffix}`;
  }
  return `${seconds}s`;
}

// A run id carries its date up front, so the distinctive half is the tail.
// A job id is a UUID, where the head is what people quote.
export function shortId(value, { kind = "job" } = {}) {
  if (!value) return "—";
  const text = String(value);
  if (kind === "run") {
    const tail = text.split("-").at(-1);
    return tail && tail !== text ? tail : text.slice(0, 8);
  }
  return text.slice(0, 8);
}

export function duration(milliseconds) {
  if (!Number.isFinite(milliseconds)) return "—";
  if (milliseconds < 1000) return `${Math.round(milliseconds)}ms`;
  const seconds = milliseconds / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}
