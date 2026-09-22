import rawProcess from "node:process";
import { register } from "node:module";
import { randomUUID } from "node:crypto";
import { definePlugin, createPluginContext } from "./sdk.js";
import {
  assertIpcMessage,
  cloneIpcValue,
  errorFromPayload,
  PLUGIN_PROTOCOL_VERSION,
  serializeError,
} from "./protocol.js";

const sendRaw = rawProcess.send?.bind(rawProcess);
const disconnectRaw = rawProcess.disconnect?.bind(rawProcess);
const exitRaw = rawProcess.exit.bind(rawProcess);
const setTimeoutRaw = globalThis.setTimeout.bind(globalThis);
const clearTimeoutRaw = globalThis.clearTimeout.bind(globalThis);
const pending = new Map();
const providers = new Map();
const listeners = new Map();
let inspected = false;
let setupComplete = false;
let maxMessageBytes = 1024 * 1024;
let callbackTimeoutMs = 30_000;
let pluginName;

if (!sendRaw) exitRaw(1);
lockDownGlobals();

rawProcess.on("message", (message) => {
  void handleMessage(message).catch((error) => {
    safeSend({
      v: PLUGIN_PROTOCOL_VERSION,
      type: "response",
      id: typeof message?.id === "string" ? message.id : "invalid",
      ok: false,
      error: serializeError(error),
    });
  });
});
rawProcess.on("disconnect", () => exitRaw(0));

async function handleMessage(message) {
  assertIpcMessage(message, maxMessageBytes);
  if (message.type === "response") {
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeoutRaw(request.timer);
    if (message.ok) request.resolve(message.result);
    else request.reject(errorFromPayload(message.error, pluginName));
    return;
  }

  try {
    const result = await dispatch(message.method, message.params ?? {});
    safeSend({ v: PLUGIN_PROTOCOL_VERSION, type: "response", id: message.id, ok: true, result });
  } catch (error) {
    safeSend({
      v: PLUGIN_PROTOCOL_VERSION,
      type: "response",
      id: message.id,
      ok: false,
      error: serializeError(error),
    });
  }
}

async function dispatch(method, params) {
  if (method === "shutdown") {
    for (const request of pending.values()) request.reject(protocolError("Plugin worker is shutting down."));
    pending.clear();
    setTimeoutRaw(() => {
      disconnectRaw?.();
      exitRaw(0);
    }, 0);
    return { stopped: true };
  }
  if (method === "inspect") return inspect(params);
  if (!inspected) throw protocolError("Plugin worker has not been inspected.");
  if (method === "setup") return setupPlugin(params);
  if (!setupComplete) throw protocolError("Plugin worker setup has not completed.");
  if (method === "provider.invoke") return invokeProvider(params);
  if (method === "event.emit") return emitEvent(params);
  throw protocolError(`Unknown plugin RPC method '${method}'.`);
}

let plugin;

async function inspect(params) {
  if (inspected) throw protocolError("Plugin worker is already inspected.");
  if (typeof params.entryUrl !== "string" || typeof params.sdkUrl !== "string") {
    throw protocolError("Plugin worker requires entry and SDK URLs.");
  }
  maxMessageBytes = params.maxMessageBytes;
  callbackTimeoutMs = params.callbackTimeoutMs;
  register(new URL("./import-policy.js", import.meta.url), {
    parentURL: import.meta.url,
    data: { sdkUrl: params.sdkUrl },
  });
  const imported = await import(params.entryUrl);
  plugin = definePlugin(imported.default ?? imported.plugin ?? imported);
  pluginName = plugin.name;
  inspected = true;
  return cloneIpcValue({
    apiVersion: plugin.apiVersion,
    name: plugin.name,
    version: plugin.version,
    capabilities: plugin.capabilities,
    dependencies: plugin.dependencies,
  }, maxMessageBytes, "Plugin manifest");
}

async function setupPlugin(params) {
  if (setupComplete) throw protocolError("Plugin worker setup is already complete.");
  const actions = [];
  const bridge = createBridge(actions);
  await plugin.setup(createPluginContext(bridge, plugin), deepFreeze(params.options ?? {}));
  setupComplete = true;
  return cloneIpcValue(actions, maxMessageBytes, "Plugin setup result");
}

function createBridge(actions) {
  return {
    registerProvider(provider) {
      if (!provider?.name || typeof provider.invoke !== "function") {
        throw new TypeError("A plugin provider must expose name and invoke(context).");
      }
      const capabilities = stringArray(provider.capabilities ?? [], `Provider '${provider.name}' capabilities`);
      if (providers.has(provider.name)) throw new Error(`provider '${provider.name}' is already registered by this plugin.`);
      providers.set(provider.name, provider);
      actions.push({ type: "provider.register", value: { name: provider.name, capabilities } });
      return provider;
    },
    registerAgent(agent) {
      const value = cloneIpcValue(agent, maxMessageBytes, "Plugin agent");
      actions.push({ type: "agent.register", value });
      return agent;
    },
    registerSkill(name, skill) {
      actions.push({ type: "skill.register", name, value: cloneIpcValue(skill, maxMessageBytes, "Plugin skill") });
      return skill;
    },
    registerPrompt(name, prompt) {
      actions.push({ type: "prompt.register", name, value: cloneIpcValue(prompt, maxMessageBytes, "Plugin prompt") });
      return prompt;
    },
    addInstruction(instruction) {
      actions.push({ type: "instruction.add", value: instruction });
      return instruction;
    },
    subscribe(type, listener) {
      if (typeof type !== "string" || type.length === 0 || typeof listener !== "function") {
        throw new TypeError("A plugin event subscription requires a type and listener.");
      }
      const listenerId = randomUUID();
      listeners.set(listenerId, listener);
      actions.push({ type: "event.subscribe", eventType: type, listenerId });
      return () => listeners.delete(listenerId);
    },
  };
}

async function invokeProvider(params) {
  const provider = providers.get(params.provider);
  if (!provider) throw protocolError(`Unknown plugin provider '${params.provider}'.`);
  const invocationId = params.invocationId;
  const context = deepFreeze({
    ...params.context,
    approve: (request) => callHost("runtime.approve", { invocationId, request }),
    spawn: (agent, input) => callHost("runtime.spawn", { invocationId, agent, input }),
  }, new Set(["approve", "spawn"]));
  const result = await provider.invoke(context);
  return cloneIpcValue(result, maxMessageBytes, "Plugin provider result");
}

async function emitEvent(params) {
  const listener = listeners.get(params.listenerId);
  if (!listener) throw protocolError("Unknown plugin event subscription.");
  const result = await listener(deepFreeze(params.event));
  return cloneIpcValue(result ?? null, maxMessageBytes, "Plugin event result");
}

function callHost(method, params) {
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeoutRaw(() => {
      pending.delete(id);
      const error = new Error(`Plugin host callback '${method}' timed out.`);
      error.code = "plugin_timeout";
      reject(error);
    }, callbackTimeoutMs);
    timer.unref?.();
    pending.set(id, { resolve, reject, timer });
    safeSend({ v: PLUGIN_PROTOCOL_VERSION, type: "request", id, method, params });
  });
}

function safeSend(message) {
  try {
    cloneIpcValue(message, maxMessageBytes, "Plugin RPC message");
    sendRaw(message, (error) => {
      if (error) exitRaw(1);
    });
  } catch (error) {
    const fallback = {
      v: PLUGIN_PROTOCOL_VERSION,
      type: "response",
      id: typeof message?.id === "string" ? message.id : "oversize",
      ok: false,
      error: serializeError(error),
    };
    sendRaw(fallback, () => {});
  }
}

function lockDownGlobals() {
  const deniedNetwork = () => Promise.reject(permissionError("Plugin network access is not permitted."));
  Object.defineProperty(globalThis, "fetch", { value: deniedNetwork, configurable: false, writable: false });
  for (const name of ["WebSocket", "EventSource"]) {
    if (name in globalThis) Object.defineProperty(globalThis, name, { value: undefined, configurable: false, writable: false });
  }
  const safeProcess = Object.freeze({
    arch: rawProcess.arch,
    platform: rawProcess.platform,
    version: rawProcess.version,
    versions: Object.freeze({ node: rawProcess.versions.node }),
    env: Object.freeze({}),
    argv: Object.freeze([]),
    cwd: () => rawProcess.cwd(),
    uptime: rawProcess.uptime.bind(rawProcess),
  });
  Object.defineProperty(globalThis, "process", { value: safeProcess, configurable: false, writable: false });
}

function deepFreeze(value, skip = new Set()) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const [key, child] of Object.entries(value)) {
    if (!skip.has(key)) deepFreeze(child, skip);
  }
  return Object.freeze(value);
}

function stringArray(value, label) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new TypeError(`${label} must be an array of non-empty strings.`);
  }
  return [...new Set(value)];
}

function protocolError(message) {
  const error = new Error(message);
  error.code = "plugin_protocol_error";
  return error;
}

function permissionError(message) {
  const error = new Error(message);
  error.code = "plugin_permission_denied";
  return error;
}
