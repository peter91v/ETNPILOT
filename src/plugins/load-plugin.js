import { resolve } from "node:path";
import { normalizePluginLimits } from "./protocol.js";
import { validatePluginManifest } from "./sdk.js";
import { PluginWorkerHost } from "./worker-host.js";

const BOOTSTRAP_CAPABILITIES = new Set(["secret.register", "secret.read", "network.fetch"]);

export async function loadPlugin(specifier, harness, options = {}, runtime = {}) {
  const loaded = await loadPlugins([{ path: specifier, options }], harness, runtime.projectRoot ?? process.cwd(), runtime);
  return loaded[0];
}

export async function loadPlugins(entries, harness, projectRoot = process.cwd(), runtime = {}) {
  const pending = [];
  const root = resolve(projectRoot);
  const defaults = normalizePluginLimits(runtime.isolation ?? {});
  try {
    for (const entry of entries ?? []) {
      const descriptor = typeof entry === "string" ? { path: entry, options: {} } : entry;
      if (!descriptor?.path) throw new TypeError("A plugin entry requires a path.");
      const limits = normalizePluginLimits(descriptor.limits ?? {}, defaults);
      const started = await PluginWorkerHost.start({
        specifier: descriptor.path,
        projectRoot: root,
        limits,
        moduleRoot: descriptor.moduleRoot,
        signal: runtime.signal,
        resources: {
          secretInputs: descriptor.secretInputs ?? [],
          networkAllow: descriptor.networkAllow ?? [],
          resolveSecret: runtime.secretResolver
            ? (name) => runtime.secretResolver.get(name, { required: true })
            : undefined,
          fetchImpl: runtime.fetchImpl,
          authorizeNetwork: (request, plugin) => harness.approveOperation(request, {
            agent: `plugin:${plugin ?? "unknown"}`,
            workspace: root,
          }),
        },
      });
      const manifest = validatePluginManifest(started.manifest);
      if (runtime.bootstrap === true && manifest.capabilities.some((capability) => !BOOTSTRAP_CAPABILITIES.has(capability))) {
        const error = new Error(`Bootstrap plugin '${manifest.name}' declares a non-bootstrap capability.`);
        await started.host.close(error);
        throw error;
      }
      if (pending.some((item) => item.manifest.name === manifest.name) || harness.plugins.has(manifest.name)) {
        const error = new Error(`plugin '${manifest.name}' is already registered.`);
        await started.host.close(error);
        throw error;
      }
      pending.push({
        manifest,
        options: descriptor.options ?? {},
        host: started.host,
      });
    }

    const ordered = orderPlugins(pending, harness);
    const undo = [];
    try {
      for (const item of ordered) {
        item.actions = await item.host.setup(item.options, { signal: runtime.signal });
        validateActions(item.actions, item.manifest);
        item.cleanup = [];
        applyPlugin(item, harness, undo);
      }
      for (const item of ordered) {
        harness.plugins.register(item.manifest.name, item.manifest);
        recordUndo(item, undo, () => harness.plugins.unregister(item.manifest.name, item.manifest));
        harness.attachPluginRuntime(item.host);
        item.host.addCleanup(() => {
          for (const revert of item.cleanup.reverse()) revert();
        });
      }
      for (const item of ordered) {
        await harness.events.emit("plugin.loaded", {
          plugin: item.manifest.name,
          version: item.manifest.version,
          isolated: true,
        });
      }
      for (const item of ordered) item.host.release();
      return ordered.map((item) => item.manifest);
    } catch (error) {
      for (const revert of undo.reverse()) revert();
      throw error;
    }
  } catch (error) {
    await Promise.allSettled(pending.map((item) => item.host.close(error)));
    throw error;
  }
}

function applyPlugin(item, harness, undo) {
  for (const action of item.actions) {
    if (action.type === "provider.register") {
      const provider = item.host.createProvider(action);
      const registered = harness.registerProvider(provider);
      recordUndo(item, undo, () => harness.providers.unregister(provider.name, registered));
    } else if (action.type === "secret.register") {
      const provider = item.host.createSecretProvider(action);
      const registered = harness.registerSecretProvider(provider);
      recordUndo(item, undo, () => harness.secrets.unregister(provider.name, registered));
    } else if (action.type === "agent.register") {
      const registered = harness.registerAgent(action.value);
      recordUndo(item, undo, () => harness.agents.unregister(action.value.name, registered));
    } else if (action.type === "skill.register") {
      const registered = harness.skills.register(action.name, action.value);
      recordUndo(item, undo, () => harness.skills.unregister(action.name, registered));
    } else if (action.type === "prompt.register") {
      const registered = harness.prompts.register(action.name, action.value);
      recordUndo(item, undo, () => harness.prompts.unregister(action.name, registered));
    } else if (action.type === "instruction.add") {
      harness.instructions.push(action.value);
      recordUndo(item, undo, () => {
        const index = harness.instructions.lastIndexOf(action.value);
        if (index !== -1) harness.instructions.splice(index, 1);
      });
    } else if (action.type === "event.subscribe") {
      const unsubscribe = item.host.subscribe(harness.events, action);
      recordUndo(item, undo, unsubscribe);
    }
  }
}

function recordUndo(item, undo, callback) {
  let active = true;
  const revert = () => {
    if (!active) return;
    active = false;
    callback();
  };
  item.cleanup.push(revert);
  undo.push(revert);
}

function validateActions(actions, manifest) {
  if (!Array.isArray(actions)) throw new TypeError(`Plugin '${manifest.name}' returned invalid setup actions.`);
  const allowed = new Set(manifest.capabilities);
  const names = new Set();
  for (const action of actions) {
    if (!action || typeof action !== "object" || !allowed.has(action.type)) {
      throw new Error(`Plugin '${manifest.name}' requested undeclared capability '${action?.type ?? "unknown"}'.`);
    }
    if (action.type === "provider.register") {
      assertRegistrationName(action.value?.name, action.type, names);
      if (!Array.isArray(action.value?.capabilities)) throw new TypeError("Plugin provider capabilities must be an array.");
    } else if (action.type === "secret.register") {
      assertRegistrationName(action.value?.name, action.type, names);
    } else if (action.type === "agent.register") {
      assertRegistrationName(action.value?.name, action.type, names);
    } else if (["skill.register", "prompt.register"].includes(action.type)) {
      assertRegistrationName(action.name, action.type, names);
    } else if (action.type === "instruction.add") {
      if (typeof action.value !== "string" || action.value.length === 0) {
        throw new TypeError("Plugin instructions must be non-empty strings.");
      }
    } else if (action.type === "event.subscribe") {
      if (typeof action.eventType !== "string" || !action.eventType || typeof action.listenerId !== "string") {
        throw new TypeError("Plugin event subscription is invalid.");
      }
    }
  }
}

function assertRegistrationName(name, type, names) {
  if (typeof name !== "string" || !/^[a-z0-9][a-z0-9._-]*$/i.test(name)) {
    throw new TypeError(`Invalid ${type} name: '${name}'.`);
  }
  const key = `${type}:${name}`;
  if (names.has(key)) throw new Error(`${type} '${name}' is registered more than once by the plugin.`);
  names.add(key);
}

function orderPlugins(pending, harness) {
  const byName = new Map(pending.map((item) => [item.manifest.name, item]));
  const visiting = new Set();
  const visited = new Set();
  const ordered = [];
  const visit = (name, trail = []) => {
    if (visited.has(name) || harness.plugins.has(name)) return;
    if (visiting.has(name)) throw new Error(`Plugin dependency cycle: ${[...trail, name].join(" -> ")}.`);
    const item = byName.get(name);
    if (!item) throw new Error(`Missing plugin dependency '${name}'.`);
    visiting.add(name);
    for (const dependency of item.manifest.dependencies) visit(dependency, [...trail, name]);
    visiting.delete(name);
    visited.add(name);
    ordered.push(item);
  };
  for (const item of pending) visit(item.manifest.name);
  return ordered;
}
