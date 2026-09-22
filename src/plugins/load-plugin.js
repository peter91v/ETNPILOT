import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

export async function loadPlugin(specifier, harness, options = {}) {
  const target = specifier.startsWith(".") || specifier.startsWith("/")
    ? pathToFileURL(resolve(specifier)).href
    : specifier;
  const module = await import(target);
  const plugin = module.default ?? module.plugin ?? module;
  await harness.use(plugin, options);
  return plugin;
}
