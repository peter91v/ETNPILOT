import { dirname, join, resolve } from "node:path";
import YAML from "yaml";
import { loadConfig } from "../config/load.js";
import { loadPlugins } from "../plugins/load-plugin.js";
import { loadPinnedProjectContent } from "./provenance.js";

export async function loadProject(harness, root = process.cwd(), env = process.env, runtime = {}) {
  const projectRoot = resolve(root);
  const etnRoot = join(projectRoot, ".etnpilot");
  // A run works inside a worktree, where the user's local settings file is
  // not checked out. layerRoot points layer discovery back at the repository
  // so a run obeys the same settings as every other surface.
  const config = await loadConfig(join(etnRoot, "etnpilot.yaml"), env, { layerRoot: runtime.layerRoot });
  const { snapshot, evidence } = await loadPinnedProjectContent(projectRoot, config);

  for (const item of snapshot.items.filter(({ type }) => type === "instruction")) {
    harness.instructions.push(item.content);
  }
  for (const item of snapshot.items.filter(({ type }) => type === "prompt")) {
    harness.prompts.register(item.name, item.content);
  }
  for (const item of snapshot.items.filter(({ type }) => type === "skill")) {
    harness.skills.register(item.name, { name: item.name, content: item.content, directory: dirname(item.absolutePath) });
  }
  for (const item of snapshot.items.filter(({ type }) => type === "agent")) {
    const manifest = YAML.parse(item.content);
    const prompt = manifest.promptRef
      ? harness.prompts.get(manifest.promptRef)
      : manifest.prompt;
    // An agent that names no provider takes the project's. Repeating one
    // provider in every manifest is what 'defaultProvider' is there to spare,
    // and an agent registered without one could not be routed at all.
    const provider = manifest.provider
      ?? (manifest.providers?.length ? undefined : config.defaultProvider);
    harness.registerAgent({ ...manifest, ...(provider ? { provider } : {}), prompt });
  }
  const pluginEntries = runtime.bootstrapPluginsLoaded
    ? (config.plugins ?? []).filter((entry) => !isBootstrapPlugin(entry))
    : (config.plugins ?? []);
  if (pluginEntries.length > 0) {
    await loadPlugins(pluginEntries, harness, projectRoot, {
      isolation: config.pluginIsolation,
      signal: runtime.signal,
      secretResolver: runtime.secretResolver,
      fetchImpl: runtime.fetchImpl,
    });
  }
  return { root: projectRoot, config, content: evidence };
}

function isBootstrapPlugin(entry) {
  return entry && typeof entry === "object" && entry.bootstrap === true;
}
