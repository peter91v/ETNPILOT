const API_VERSION = 1;

export const PLUGIN_CAPABILITIES = Object.freeze([
  "provider.register",
  "agent.register",
  "skill.register",
  "prompt.register",
  "instruction.add",
  "event.subscribe",
]);

const KNOWN_CAPABILITIES = new Set(PLUGIN_CAPABILITIES);

export function definePlugin(definition) {
  if (!definition || typeof definition !== "object") {
    throw new TypeError("A plugin definition must be an object.");
  }
  if (definition.apiVersion !== API_VERSION) {
    throw new TypeError(`Unsupported plugin apiVersion '${definition.apiVersion}'. Expected ${API_VERSION}.`);
  }
  if (typeof definition.name !== "string" || !/^[a-z0-9][a-z0-9._-]*$/i.test(definition.name)) {
    throw new TypeError(`Invalid plugin name: '${definition.name}'.`);
  }
  if (typeof definition.version !== "string" || definition.version.length === 0) {
    throw new TypeError(`Plugin '${definition.name}' requires a version.`);
  }
  if (typeof definition.setup !== "function") {
    throw new TypeError(`Plugin '${definition.name}' requires setup(context, options).`);
  }
  const capabilities = uniqueStrings(definition.capabilities ?? [], "capabilities", definition.name);
  const dependencies = uniqueStrings(definition.dependencies ?? [], "dependencies", definition.name);
  for (const capability of capabilities) {
    if (!KNOWN_CAPABILITIES.has(capability)) {
      throw new TypeError(`Plugin '${definition.name}' declares unknown capability '${capability}'.`);
    }
  }
  return Object.freeze({
    ...definition,
    apiVersion: API_VERSION,
    capabilities: Object.freeze(capabilities),
    dependencies: Object.freeze(dependencies),
  });
}

export function createPluginContext(harness, plugin) {
  const allowed = new Set(plugin.capabilities);
  const requireCapability = (capability) => {
    if (!allowed.has(capability)) {
      throw new Error(`Plugin '${plugin.name}' did not declare capability '${capability}'.`);
    }
  };
  return Object.freeze({
    plugin: Object.freeze({ name: plugin.name, version: plugin.version, apiVersion: plugin.apiVersion }),
    registerProvider(provider) {
      requireCapability("provider.register");
      return harness.registerProvider(provider);
    },
    registerAgent(agent) {
      requireCapability("agent.register");
      return harness.registerAgent(agent);
    },
    registerSkill(name, skill) {
      requireCapability("skill.register");
      return harness.skills.register(name, skill);
    },
    registerPrompt(name, prompt) {
      requireCapability("prompt.register");
      return harness.prompts.register(name, prompt);
    },
    addInstruction(instruction) {
      requireCapability("instruction.add");
      if (typeof instruction !== "string" || instruction.length === 0) {
        throw new TypeError("A plugin instruction must be a non-empty string.");
      }
      harness.instructions.push(instruction);
      return instruction;
    },
    subscribe(type, listener) {
      requireCapability("event.subscribe");
      return harness.events.on(type, listener);
    },
  });
}

function uniqueStrings(values, field, pluginName) {
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string" || value.length === 0)) {
    throw new TypeError(`Plugin '${pluginName}' ${field} must be an array of non-empty strings.`);
  }
  return [...new Set(values)];
}
