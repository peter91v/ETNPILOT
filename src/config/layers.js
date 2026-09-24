import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import YAML from "yaml";

// Settings arrive in layers. The project default is committed and reviewed;
// everything a user changes stays on their machine and is never checked in.
// A later layer wins, but only where the committed default says it may: a
// user can make the harness stricter, never quieter.

export const SETTINGS = Symbol.for("etnpilot.settings");

export const MODES = Object.freeze(["open", "stricter-only", "locked"]);

// Used when the committed default declares no modes of its own, which is the
// case for every project created before layering existed. Erring towards the
// safeguards means an older project does not silently become overridable.
export const DEFAULT_MODES = Object.freeze({
  "settings.**": "locked",
  "secrets.**": "locked",
  "content.provenance.**": "locked",
  "receipts.signing.**": "locked",
  "supplyChain.**": "locked",
  "policy.**": "stricter-only",
  "approval.allow": "stricter-only",
  "approval.requireHuman": "stricter-only",
  "checks.envAllow": "stricter-only",
  "sandbox.enabled": "stricter-only",
});

const EFFECT_PRIORITY = Object.freeze({ allow: 1, human: 2, deny: 3 });

export class SettingsError extends Error {
  constructor(refusals) {
    super(`Local settings were refused:\n${refusals.map((refusal) => `  ${refusal.path}: ${refusal.reason}`).join("\n")}`);
    this.name = "SettingsError";
    this.code = "settings_refused";
    this.refusals = refusals;
  }
}

export function userConfigHome(env = process.env) {
  if (env.ETNPILOT_CONFIG_HOME) return resolve(env.ETNPILOT_CONFIG_HOME);
  if (env.XDG_CONFIG_HOME) return join(resolve(env.XDG_CONFIG_HOME), "etnpilot");
  return join(homedir(), ".config", "etnpilot");
}

export function globalConfigFile(env = process.env) {
  return join(userConfigHome(env), "config.yaml");
}

export function localConfigFile(projectFile) {
  return join(dirname(resolve(projectFile)), "etnpilot.local.yaml");
}

export function layerPaths(projectFile, { env = process.env, layerRoot } = {}) {
  const local = layerRoot
    ? join(resolve(layerRoot), ".etnpilot", "etnpilot.local.yaml")
    : localConfigFile(projectFile);
  return [
    { source: "project", path: resolve(projectFile), required: true },
    { source: "user-global", path: globalConfigFile(env), required: false },
    { source: "user-local", path: local, required: false },
  ];
}

export async function readLayers(projectFile, { env = process.env, layerRoot, userLayers = true } = {}) {
  const wanted = layerPaths(projectFile, { env, layerRoot })
    .filter((layer) => userLayers || layer.source === "project");
  const layers = [];
  for (const layer of wanted) {
    const text = await readFile(layer.path, "utf8").catch((error) => {
      if (layer.required || error.code !== "ENOENT") throw error;
      return undefined;
    });
    if (text === undefined) continue;
    const data = YAML.parse(text) ?? {};
    if (!isPlainObject(data)) throw new TypeError(`${layer.path} must contain a YAML mapping.`);
    layers.push({
      source: layer.source,
      path: layer.path,
      data,
      // The hash covers the file as written, so a receipt names which settings
      // were in effect without carrying their values, which may be local paths.
      sha256: createHash("sha256").update(text).digest("hex"),
    });
  }
  return layers;
}

// Modes are read from the committed default only. A local file that could
// relax its own limits would not be a limit at all.
export function readModes(projectData = {}) {
  const declared = projectData?.settings?.modes;
  if (declared === undefined) return { ...DEFAULT_MODES };
  if (!isPlainObject(declared)) throw new TypeError("settings.modes must be a mapping of config path to mode.");
  for (const [pattern, mode] of Object.entries(declared)) {
    if (!MODES.includes(mode)) {
      throw new TypeError(`settings.modes['${pattern}'] must be one of ${MODES.join(", ")}; got '${mode}'.`);
    }
  }
  return { ...declared };
}

export function modeFor(path, modes) {
  let best;
  let bestScore = -1;
  for (const [pattern, mode] of Object.entries(modes)) {
    if (!matchPath(pattern, path)) continue;
    const score = specificity(pattern);
    if (score >= bestScore) {
      bestScore = score;
      best = mode;
    }
  }
  return best ?? "open";
}

export function mergeLayers(layers) {
  const project = layers.find((layer) => layer.source === "project");
  if (!project) throw new TypeError("A project layer is required.");
  const modes = readModes(project.data);
  let config = clone(project.data);
  const overrides = [];
  const sources = new Map();
  const refusals = [];
  for (const layer of layers.filter((candidate) => candidate !== project)) {
    for (const [path, value] of leaves(layer.data)) {
      const mode = modeFor(path, modes);
      const current = getIn(config, path);
      if (mode === "locked") {
        refusals.push({
          path,
          source: layer.source,
          file: layer.path,
          reason: "the project default locks this setting, so it can only change in the committed file",
        });
        continue;
      }
      if (mode === "stricter-only") {
        const narrowed = narrow(path, current, value, config);
        if (!narrowed.ok) {
          refusals.push({ path, source: layer.source, file: layer.path, reason: narrowed.reason });
          continue;
        }
        if (equal(current, narrowed.value)) continue;
        setIn(config, path, narrowed.value);
        overrides.push(path);
        sources.set(path, layer.source);
        continue;
      }
      if (equal(current, value)) continue;
      setIn(config, path, clone(value));
      overrides.push(path);
      sources.set(path, layer.source);
    }
  }
  return {
    config,
    modes,
    overrides: [...new Set(overrides)].sort(),
    sources,
    refusals,
  };
}

// A setting may only be narrowed where the rule for narrowing it is mechanical.
// Anything else is refused rather than guessed at, because "probably stricter"
// is not a safeguard.
function narrow(path, current, value, config) {
  if (path === "policy.operations.default" || path === "policy.providers.default") {
    return stricterEffect(current, value);
  }
  if (path === "policy.operations.rules" || path === "policy.providers.rules") {
    return appendRules(path, current, value, config);
  }
  if (path === "approval.allow" || path === "checks.envAllow") return subsetOnly(current, value);
  if (path === "approval.requireHuman") return supersetOnly(current, value);
  if (path === "sandbox.enabled") return onlyEnable(current, value);
  return {
    ok: false,
    reason: "there is no mechanical rule for narrowing this setting, so it can only change in the committed default",
  };
}

function stricterEffect(current, value) {
  const from = EFFECT_PRIORITY[current] ?? EFFECT_PRIORITY.deny;
  const to = EFFECT_PRIORITY[value];
  if (to === undefined) return { ok: false, reason: `'${value}' is not one of allow, human, deny` };
  if (to < from) return { ok: false, reason: `'${value}' is weaker than the project's '${current}'` };
  return { ok: true, value };
}

// Rules are appended, never replaced, so a local file cannot delete a rule it
// dislikes. An appended rule must also be at least as strict as the section
// default, because the engine takes the strongest match and falls back to the
// default when nothing matches — a weaker rule would widen what is allowed.
function appendRules(path, current, value, config) {
  if (!Array.isArray(value)) return { ok: false, reason: "policy rules must be a list" };
  const section = path.startsWith("policy.operations") ? "operations" : "providers";
  const sectionDefault = config.policy?.[section]?.default ?? "deny";
  const floor = EFFECT_PRIORITY[sectionDefault] ?? EFFECT_PRIORITY.deny;
  const existing = Array.isArray(current) ? current : [];
  const known = new Set(existing.map((rule) => rule?.id));
  const appended = [];
  for (const rule of value) {
    if (!isPlainObject(rule)) return { ok: false, reason: "every policy rule must be a mapping" };
    if (known.has(rule.id)) {
      return { ok: false, reason: `rule '${rule.id}' already exists in the project default; local rules are added, not replaced` };
    }
    const priority = EFFECT_PRIORITY[rule.effect];
    if (priority === undefined) return { ok: false, reason: `rule '${rule.id}' has no valid effect` };
    if (priority < floor) {
      return {
        ok: false,
        reason: `rule '${rule.id}' is '${rule.effect}', which is weaker than the section default '${sectionDefault}'`,
      };
    }
    known.add(rule.id);
    appended.push(clone(rule));
  }
  return { ok: true, value: [...existing, ...appended] };
}

function subsetOnly(current, value) {
  if (!Array.isArray(value)) return { ok: false, reason: "this setting must be a list" };
  const allowed = new Set(Array.isArray(current) ? current : []);
  const added = value.filter((entry) => !allowed.has(entry));
  if (added.length > 0) return { ok: false, reason: `entries may only be removed; '${added.join("', '")}' would be added` };
  return { ok: true, value: [...value] };
}

function supersetOnly(current, value) {
  if (!Array.isArray(value)) return { ok: false, reason: "this setting must be a list" };
  const required = Array.isArray(current) ? current : [];
  const removed = required.filter((entry) => !value.includes(entry));
  if (removed.length > 0) return { ok: false, reason: `entries may only be added; '${removed.join("', '")}' would be removed` };
  return { ok: true, value: [...value] };
}

function onlyEnable(current, value) {
  if (typeof value !== "boolean") return { ok: false, reason: "this setting must be true or false" };
  if (current === true && value === false) return { ok: false, reason: "it is enabled in the project default and may only stay on" };
  return { ok: true, value };
}

// Paths that must not be flattened further: their keys are external strings
// this project does not choose — a model id ('gpt-5.4', 'gpt-4.1') — and
// every path in this project is dot-separated. Splitting on '.' inside such
// a key turns one entry into two nested ones ('gpt-5' -> '4'), silently, for
// both reading and writing. Stopping here keeps the whole map as one leaf,
// which is also the only shape 'setSetting' can write back without the same
// corruption — see docs/trying-it-out.md's pricing section.
const OPAQUE_KEY_PATHS = new Set(["observability.pricing.models"]);

export function leaves(value, prefix = "") {
  const entries = [];
  for (const [key, item] of Object.entries(value ?? {})) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (OPAQUE_KEY_PATHS.has(path)) entries.push([path, item]);
    else if (isPlainObject(item) && Object.keys(item).length > 0) entries.push(...leaves(item, path));
    else entries.push([path, item]);
  }
  return entries;
}

export function getIn(target, path) {
  return path.split(".").reduce((value, key) => (isPlainObject(value) ? value[key] : undefined), target);
}

export function setIn(target, path, value) {
  const keys = path.split(".");
  const last = keys.pop();
  let cursor = target;
  for (const key of keys) {
    if (!isPlainObject(cursor[key])) cursor[key] = {};
    cursor = cursor[key];
  }
  cursor[last] = value;
  return target;
}

export function matchPath(pattern, path) {
  const patternSegments = pattern.split(".");
  const pathSegments = path.split(".");
  for (const [index, segment] of patternSegments.entries()) {
    if (segment === "**") return true;
    if (index >= pathSegments.length) return false;
    if (segment !== "*" && segment !== pathSegments[index]) return false;
  }
  return patternSegments.length === pathSegments.length;
}

function specificity(pattern) {
  const segments = pattern.split(".");
  return segments.filter((segment) => segment !== "**").length * 2 + (segments.includes("**") ? 0 : 1);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function equal(left, right) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

// What the receipt records: which layers were in effect and which settings they
// changed. Never the values, which can carry local paths and machine names.
export function settingsEvidence(config) {
  const settings = config?.[SETTINGS];
  if (!settings) return undefined;
  return {
    layers: settings.layers.map(({ source, sha256 }) => ({ source, sha256 })),
    overrides: [...settings.overrides],
  };
}
