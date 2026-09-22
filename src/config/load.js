import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import YAML from "yaml";

export async function loadConfig(path = ".etnpilot/etnpilot.yaml", env = process.env) {
  const config = YAML.parse(await readFile(resolve(path), "utf8"));
  if (config?.version !== 1) throw new Error(`Unsupported ETNPilot config version: ${config?.version}.`);
  return interpolate(config, env);
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
