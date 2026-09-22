const INTEGER_LIMITS = Object.freeze({
  setupTimeoutMs: [100, 120_000],
  callTimeoutMs: [100, 3_600_000],
  shutdownTimeoutMs: [50, 30_000],
  memoryMb: [32, 4_096],
  maxOutputBytes: [1_024, 16 * 1_024 * 1_024],
  maxMessageBytes: [1_024, 16 * 1_024 * 1_024],
  maxPendingRequests: [1, 1_024],
  memoryPollIntervalMs: [25, 10_000],
});

export const PLUGIN_PROTOCOL_VERSION = 1;

export const DEFAULT_PLUGIN_LIMITS = Object.freeze({
  setupTimeoutMs: 10_000,
  callTimeoutMs: 30_000,
  shutdownTimeoutMs: 1_000,
  memoryMb: 128,
  maxOutputBytes: 64 * 1_024,
  maxMessageBytes: 1024 * 1_024,
  maxPendingRequests: 32,
  memoryPollIntervalMs: 100,
});

export class PluginProcessError extends Error {
  constructor(message, { code = "plugin_process_error", plugin, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "PluginProcessError";
    this.code = code;
    this.plugin = plugin;
  }
}

export function normalizePluginLimits(value = {}, defaults = DEFAULT_PLUGIN_LIMITS) {
  if (!isPlainObject(value)) throw new TypeError("Plugin isolation limits must be an object.");
  for (const name of Object.keys(value)) {
    if (!Object.hasOwn(INTEGER_LIMITS, name)) {
      throw new TypeError(`Unsupported plugin isolation limit '${name}'.`);
    }
  }
  const normalized = {};
  for (const [name, [minimum, maximum]] of Object.entries(INTEGER_LIMITS)) {
    const candidate = value[name] ?? defaults[name];
    if (!Number.isSafeInteger(candidate) || candidate < minimum || candidate > maximum) {
      throw new TypeError(`Plugin isolation limit '${name}' must be an integer from ${minimum} to ${maximum}.`);
    }
    normalized[name] = candidate;
  }
  return Object.freeze(normalized);
}

export function assertIpcMessage(message, maxBytes) {
  if (!isPlainObject(message) || message.v !== PLUGIN_PROTOCOL_VERSION) {
    throw new PluginProcessError("Plugin sent an invalid RPC envelope.", { code: "plugin_protocol_error" });
  }
  if (!['request', 'response'].includes(message.type)) {
    throw new PluginProcessError("Plugin sent an unknown RPC message type.", { code: "plugin_protocol_error" });
  }
  if (typeof message.id !== "string" || message.id.length === 0 || message.id.length > 128) {
    throw new PluginProcessError("Plugin sent an invalid RPC request ID.", { code: "plugin_protocol_error" });
  }
  if (message.type === "request" && (typeof message.method !== "string" || message.method.length > 128)) {
    throw new PluginProcessError("Plugin sent an invalid RPC method.", { code: "plugin_protocol_error" });
  }
  assertJsonSize(message, maxBytes, "Plugin RPC message");
  return message;
}

export function cloneIpcValue(value, maxBytes, label = "Plugin RPC value") {
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch (error) {
    throw new PluginProcessError(`${label} must be JSON-serializable.`, {
      code: "plugin_protocol_error",
      cause: error,
    });
  }
  if (encoded === undefined) {
    throw new PluginProcessError(`${label} must be JSON-serializable.`, { code: "plugin_protocol_error" });
  }
  const bytes = Buffer.byteLength(encoded);
  if (bytes > maxBytes) {
    throw new PluginProcessError(`${label} exceeds the ${maxBytes}-byte limit.`, {
      code: "plugin_output_limit",
    });
  }
  return JSON.parse(encoded);
}

export function serializeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    code: typeof error?.code === "string" ? error.code.slice(0, 128) : "plugin_error",
    message: message.slice(0, 4_096),
  };
}

export function errorFromPayload(payload, plugin) {
  return new PluginProcessError(
    typeof payload?.message === "string" ? payload.message : "Plugin RPC failed.",
    { code: typeof payload?.code === "string" ? payload.code : "plugin_error", plugin },
  );
}

export function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertJsonSize(value, maxBytes, label) {
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch (error) {
    throw new PluginProcessError(`${label} is not JSON-serializable.`, {
      code: "plugin_protocol_error",
      cause: error,
    });
  }
  if (encoded === undefined || Buffer.byteLength(encoded) > maxBytes) {
    throw new PluginProcessError(`${label} exceeds the ${maxBytes}-byte limit.`, {
      code: "plugin_output_limit",
    });
  }
}
