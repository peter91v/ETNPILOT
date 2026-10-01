import { BUILTIN_SECRET_PROVIDER_FACTORIES, createEnvironmentSecretProvider } from "./builtins.js";
import { defineSecretProvider } from "./provider.js";
import { openCredentialStore } from "../auth/credential-store.js";

export class SecretResolver {
  constructor({ values = {}, store } = {}) {
    if (!values || Array.isArray(values) || typeof values !== "object") {
      throw new TypeError("Secret values configuration must be an object.");
    }
    for (const name of Object.keys(values)) {
      if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) throw new TypeError(`Invalid secret name: '${name}'.`);
    }
    this.values = Object.freeze({ ...values });
    this.providers = new Map();
    // A login kept by 'etnpilot login'. Consulted only when the configured
    // source has nothing: a variable somebody set is a decision, a stored login
    // is a convenience, so the variable wins.
    this.store = store;
    // Why a stored login was not handed out, by secret name, so that the
    // message about the missing key can say so instead of blaming the variable.
    this.refusals = new Map();
  }

  register(provider) {
    const normalized = defineSecretProvider(provider);
    if (this.providers.has(normalized.name)) {
      throw new Error(`Secret provider '${normalized.name}' is already registered.`);
    }
    this.providers.set(normalized.name, normalized);
    return normalized;
  }

  unregister(name, expected) {
    const current = this.providers.get(name);
    if (!current || (expected !== undefined && current !== expected)) return false;
    return this.providers.delete(name);
  }

  names() {
    return Object.keys(this.values).sort();
  }

  // 'baseUrl' is where the value is about to be sent. A stored login is only
  // handed to a host it was issued for.
  async get(name, { fallback, required = false, baseUrl } = {}) {
    const reference = this.values[name] ?? fallback;
    if (!reference) {
      const stored = await this.stored(name, baseUrl);
      if (stored !== undefined) return stored;
      if (required) throw this.missing(name, `Required secret '${name}' is not configured.`, { code: "not_configured" });
      return undefined;
    }
    const value = await this.resolve(reference, { name, required: false });
    if (value !== undefined) return value;
    const stored = await this.stored(name, baseUrl);
    if (stored !== undefined) return stored;
    if (required) {
      throw this.missing(name, `Required secret '${name}' is unavailable.`, { code: "unavailable", provider: reference.provider });
    }
    return undefined;
  }

  // A stored login that was refused is the reason, when there is one.
  missing(name, message, details) {
    const refused = this.refusals.get(name);
    return refused
      ? new SecretResolutionError(`Required secret '${name}' was not used: ${refused}`, { code: "stored_login_refused" })
      : new SecretResolutionError(message, details);
  }

  async stored(name, baseUrl) {
    if (!this.store) return undefined;
    try {
      const answer = await this.store.resolve(name, { baseUrl });
      if (answer?.refused) {
        this.refusals.set(name, answer.refused);
        return undefined;
      }
      this.refusals.delete(name);
      return answer?.value;
    } catch {
      return undefined;
    }
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
    if (!reference) {
      const stored = await this.stored(name);
      return { name, configured: stored !== undefined, available: stored !== undefined, ...(stored !== undefined ? { provider: "stored-login" } : {}) };
    }
    try {
      const value = await this.resolve(reference, { name, required: false });
      if (value === undefined && (await this.stored(name)) !== undefined) {
        return { name, configured: true, available: true, provider: "stored-login" };
      }
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
  const resolver = new SecretResolver({ values: secretConfig.values ?? {}, store: openCredentialStore({ env }) });
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
