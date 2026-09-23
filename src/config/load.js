import { resolve } from "node:path";
import { mergeLayers, readLayers, SETTINGS, SettingsError } from "./layers.js";

// The committed default, then whatever this user has set on this machine.
// Local layers are never committed, so a checkout behaves the same for
// everyone until someone changes something for themselves.
export async function loadConfig(path = ".etnpilot/etnpilot.yaml", env = process.env, {
  layerRoot,
  userLayers = env.ETNPILOT_IGNORE_USER_CONFIG !== "1",
} = {}) {
  const projectFile = resolve(path);
  const layers = await readLayers(projectFile, { env, layerRoot, userLayers });
  const merged = mergeLayers(layers);
  // A refused setting is reported, never quietly dropped: a user who thinks
  // they tightened something must not be told nothing at all.
  if (merged.refusals.length > 0) throw new SettingsError(merged.refusals);
  const config = interpolate(merged.config, env);
  if (config?.version !== 1) throw new Error(`Unsupported ETNPilot config version: ${config?.version}.`);
  Object.defineProperty(config, SETTINGS, {
    value: Object.freeze({
      projectFile,
      layers: layers.map(({ source, path: file, sha256 }) => Object.freeze({ source, path: file, sha256 })),
      overrides: Object.freeze(merged.overrides),
      modes: Object.freeze(merged.modes),
    }),
    enumerable: false,
  });
  return config;
}

function interpolate(value, env) {
  if (Array.isArray(value)) return value.map((item) => interpolate(item, env));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, interpolate(item, env)]));
  }
  if (typeof value !== "string") return value;
  return value.replace(/\$\{([A-Z][A-Z0-9_]*)(?::-([^}]*))?\}/g, (_, name, fallback) => {
    const result = env[name] ?? fallback;
    if (result === undefined) throw new Error(`Missing environment variable: ${name}.`);
    return result;
  });
}
