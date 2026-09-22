import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { definePlugin } from "./sdk.js";

export async function loadPlugin(specifier, harness, options = {}) {
  const plugin = await importPlugin(specifier);
  await harness.use(plugin, options);
  return plugin;
}

export async function loadPlugins(entries, harness, projectRoot = process.cwd()) {
  const pending = [];
  for (const entry of entries ?? []) {
    const descriptor = typeof entry === "string" ? { path: entry, options: {} } : entry;
    if (!descriptor?.path) throw new TypeError("A plugin entry requires a path.");
    const specifier = isPath(descriptor.path) ? resolve(projectRoot, descriptor.path) : descriptor.path;
    const plugin = await importPlugin(specifier);
    if (pending.some((item) => item.plugin.name === plugin.name) || harness.plugins.has(plugin.name)) {
      throw new Error(`plugin '${plugin.name}' is already registered.`);
    }
    pending.push({ plugin, options: descriptor.options ?? {} });
  }

  const ordered = orderPlugins(pending, harness);
  for (const item of ordered) await harness.use(item.plugin, item.options);
  return ordered.map((item) => item.plugin);
}

async function importPlugin(specifier) {
  const target = isPath(specifier) ? pathToFileURL(resolve(specifier)).href : specifier;
  const module = await import(target);
  return definePlugin(module.default ?? module.plugin ?? module);
}

function orderPlugins(pending, harness) {
  const byName = new Map(pending.map((item) => [item.plugin.name, item]));
  const visiting = new Set();
  const visited = new Set();
  const ordered = [];
  const visit = (name, trail = []) => {
    if (visited.has(name) || harness.plugins.has(name)) return;
    if (visiting.has(name)) throw new Error(`Plugin dependency cycle: ${[...trail, name].join(" -> ")}.`);
    const item = byName.get(name);
    if (!item) throw new Error(`Missing plugin dependency '${name}'.`);
    visiting.add(name);
    for (const dependency of item.plugin.dependencies) visit(dependency, [...trail, name]);
    visiting.delete(name);
    visited.add(name);
    ordered.push(item);
  };
  for (const item of pending) visit(item.plugin.name);
  return ordered;
}

function isPath(specifier) {
  return specifier.startsWith(".") || specifier.startsWith("/");
}
