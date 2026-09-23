import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import YAML from "yaml";
import { SettingsError } from "./layers.js";
import {
  getIn,
  globalConfigFile,
  layerPaths,
  leaves,
  mergeLayers,
  modeFor,
  readLayers,
  setIn,
} from "./layers.js";

// Reading and changing settings, kept out of the CLI so the terminal, the TUI,
// the review page, and the app all change settings the same way and are
// refused for the same reasons.

const SCOPES = Object.freeze(["local", "global"]);

export class SettingsRefused extends Error {
  constructor(path, reason) {
    super(`Cannot change '${path}': ${reason}.`);
    this.name = "SettingsRefused";
    this.code = "settings_refused";
    this.path = path;
    this.reason = reason;
  }
}

export function projectConfigFile(root) {
  return join(resolve(root), ".etnpilot", "etnpilot.yaml");
}

export function scopeFile(scope, { root, env = process.env } = {}) {
  assertScope(scope);
  return scope === "global"
    ? globalConfigFile(env)
    : layerPaths(projectConfigFile(root), { env }).find((layer) => layer.source === "user-local").path;
}

export async function describeSettings({ root = process.cwd(), env = process.env } = {}) {
  const projectFile = projectConfigFile(root);
  const layers = await readLayers(projectFile, { env });
  const merged = mergeLayers(layers);
  const project = layers.find((layer) => layer.source === "project");
  const entries = leaves(merged.config)
    .filter(([path]) => !path.startsWith("settings."))
    .map(([path, value]) => ({
      path,
      value,
      // What the committed file says, so a surface can show what resetting
      // this setting would go back to.
      defaultValue: getIn(project.data, path),
      source: merged.sources.get(path) ?? "project",
      mode: modeFor(path, merged.modes),
    }));
  return {
    entries,
    layers: layers.map(({ source, path, sha256 }) => ({ source, path, sha256 })),
    overrides: merged.overrides,
    refusals: merged.refusals,
  };
}

export async function diffSettings({ root = process.cwd(), env = process.env } = {}) {
  const projectFile = projectConfigFile(root);
  const layers = await readLayers(projectFile, { env });
  const project = layers.find((layer) => layer.source === "project");
  const merged = mergeLayers(layers);
  if (merged.refusals.length > 0) throw new SettingsError(merged.refusals);
  return merged.overrides.map((path) => ({
    path,
    from: getIn(project.data, path),
    to: getIn(merged.config, path),
    source: merged.sources.get(path) ?? "project",
    mode: modeFor(path, merged.modes),
  }));
}

export async function setSetting(path, value, { root = process.cwd(), env = process.env, scope = "local" } = {}) {
  return writeSetting(path, { present: true, value }, { root, env, scope });
}

export async function unsetSetting(path, { root = process.cwd(), env = process.env, scope = "local" } = {}) {
  return writeSetting(path, { present: false }, { root, env, scope });
}

// A value is parsed as YAML, so 'true', '3', '[a, b]' and plain text all mean
// what they look like.
export function parseSettingValue(text) {
  if (typeof text !== "string") return text;
  return YAML.parse(text);
}

async function writeSetting(path, change, { root, env, scope }) {
  assertScope(scope);
  assertPath(path);
  const projectFile = projectConfigFile(root);
  const file = scopeFile(scope, { root, env });
  const source = scope === "global" ? "user-global" : "user-local";
  const text = await readFile(file, "utf8").catch(ignoreMissing);
  const document = text === undefined ? new YAML.Document({}) : YAML.parseDocument(text);
  const keys = path.split(".");
  if (change.present) document.setIn(keys, change.value);
  else document.deleteIn(keys);
  pruneEmpty(document, keys);
  const candidate = String(document);

  // The change is tried against the real layer stack before it is written, so
  // a refusal is reported instead of leaving a file the next run would reject.
  const layers = await readLayers(projectFile, { env });
  const proposed = layers.filter((layer) => layer.source !== source);
  const parsed = YAML.parse(candidate) ?? {};
  if (Object.keys(parsed).length > 0) proposed.push({ source, path: file, data: parsed, sha256: "" });
  proposed.sort((left, right) => layerOrder(left.source) - layerOrder(right.source));
  const merged = mergeLayers(proposed);
  const refusal = merged.refusals.find((candidateRefusal) => candidateRefusal.path === path)
    ?? merged.refusals[0];
  if (refusal) throw new SettingsRefused(refusal.path, refusal.reason);

  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, candidate, { encoding: "utf8", mode: 0o600 });
  return {
    path,
    file,
    scope,
    removed: !change.present,
    mode: modeFor(path, merged.modes),
    effective: getIn(merged.config, path),
  };
}

// An emptied branch would otherwise linger as '{}' and read as a deliberate
// setting rather than as nothing at all.
function pruneEmpty(document, keys) {
  for (let depth = keys.length - 1; depth > 0; depth -= 1) {
    const branch = keys.slice(0, depth);
    const value = document.getIn(branch);
    const items = value?.items;
    if (Array.isArray(items) && items.length === 0) document.deleteIn(branch);
    else break;
  }
}

function layerOrder(source) {
  return ["project", "user-global", "user-local"].indexOf(source);
}

function assertScope(scope) {
  if (!SCOPES.includes(scope)) throw new TypeError(`Unknown settings scope '${scope}'. Use ${SCOPES.join(" or ")}.`);
}

function assertPath(path) {
  if (typeof path !== "string" || !/^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/.test(path)) {
    throw new TypeError(`'${path}' is not a configuration path, such as 'queue.workers'.`);
  }
}

function ignoreMissing(error) {
  if (error.code === "ENOENT") return undefined;
  throw error;
}
