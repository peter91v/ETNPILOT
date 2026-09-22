import { BUILTIN_SECRET_PROVIDER_FACTORIES, createEnvironmentSecretProvider } from "./builtins.js";
import { defineSecretProvider } from "./provider.js";

export class SecretResolver {
  constructor({ values = {} } = {}) {
    if (!values || Array.isArray(values) || typeof values !== "object") {
      throw new TypeError("Secret values configuration must be an object.");
    }
    for (const name of Object.keys(values)) {
      if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) throw new TypeError(`Invalid secret name: '${name}'.`);
    }
    this.values = Object.freeze({ ...values });
    this.providers = new Map();
  }

  register(provider) {
    const normalized = defineSecretProvider(provider);
    if (this.providers.has(normalized.name)) {
      throw new Error(`Secret provider '${normalized.name}' is already registered.`);
    }
    this.providers.set(normalized.name, normalized);
    return normalized;
  }

  names() {
    return Object.keys(this.values).sort();
  }

  async get(name, { fallback, required = false } = {}) {
    const reference = this.values[name] ?? fallback;
    if (!reference) {
      if (required) throw new SecretResolutionError(`Required secret '${name}' is not configured.`, { code: "not_configured" });
      return undefined;
    }
    return this.resolve(reference, { name, required });
  }

  async resolve(reference, { name = "secret", required = true } = {}) {
    validateReference(reference, name);
    const provider = this.providers.get(reference.provider);
    if (!provider) {
      throw new SecretResolutionError(`Secret '${name}' uses an unknown provider.`, { code: "unknown_provider" });
    }
    let value;
    try {
      value = await provider.resolve(reference.key, { name });
    } catch {
      throw new SecretResolutionError(`Secret '${name}' could not be resolved.`, {
        code: "provider_failed",
        provider: provider.name,
      });
    }
    if (value === undefined || value === null || value === "") {
      if (required) {
        throw new SecretResolutionError(`Required secret '${name}' is unavailable.`, {
          code: "unavailable",
          provider: provider.name,
        });
      }
      return undefined;
    }
    if (typeof value !== "string") {
      throw new SecretResolutionError(`Secret '${name}' provider returned an invalid value.`, {
        code: "invalid_value",
        provider: provider.name,
      });
    }
    return value;
  }

  async check(name) {
    const reference = this.values[name];
    if (!reference) return { name, configured: false, available: false };
    try {
      const value = await this.resolve(reference, { name, required: false });
      return { name, configured: true, available: value !== undefined, provider: reference.provider };
    } catch (error) {
      return {
        name,
        configured: true,
        available: false,
        provider: reference.provider,
        reason: error.code ?? "resolution_failed",
      };
    }
  }
}

export function createSecretResolver({ root = process.cwd(), config = {}, env = process.env, factories = {} } = {}) {
  const secretConfig = config.secrets ?? {};
  const resolver = new SecretResolver({ values: secretConfig.values ?? {} });
  const configuredProviders = secretConfig.providers ?? {};
  const availableFactories = { ...BUILTIN_SECRET_PROVIDER_FACTORIES, ...factories };
  for (const [name, providerConfig] of Object.entries(configuredProviders)) {
    if (!providerConfig || typeof providerConfig !== "object" || !providerConfig.type) {
      throw new TypeError(`Secret provider '${name}' requires a type.`);
    }
    const factory = availableFactories[providerConfig.type];
    if (!factory) throw new Error(`Unknown secret provider type '${providerConfig.type}' for '${name}'.`);
    resolver.register(factory(name, providerConfig, { root, env }));
  }
  if (!resolver.providers.has("env")) resolver.register(createEnvironmentSecretProvider("env", {}, { env }));
  return resolver;
}

export class SecretResolutionError extends Error {
  constructor(message, { code, provider } = {}) {
    super(message);
    this.name = "SecretResolutionError";
    this.code = code;
    this.provider = provider;
  }
}

function validateReference(reference, name) {
  if (!reference || Array.isArray(reference) || typeof reference !== "object") {
    throw new SecretResolutionError(`Secret '${name}' reference must be an object.`, { code: "invalid_reference" });
  }
  if (typeof reference.provider !== "string" || typeof reference.key !== "string" || reference.key.length === 0) {
    throw new SecretResolutionError(`Secret '${name}' reference requires provider and key.`, {
      code: "invalid_reference",
    });
  }
}
