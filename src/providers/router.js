export class ProviderError extends Error {
  constructor(message, { code = "provider_error", retryable = false, safeToRetry = false, cause } = {}) {
    super(message, { cause });
    this.name = "ProviderError";
    this.code = code;
    this.retryable = retryable;
    this.safeToRetry = safeToRetry;
  }
}

export class ProviderRouter {
  constructor(registry, config = {}, { policy } = {}) {
    this.registry = registry;
    this.policy = policy;
    this.defaults = normalizeProviderList(config.defaults ?? []);
    this.rules = normalizeRules(config.rules ?? []);
    this.fallback = {
      enabled: config.fallback?.enabled ?? true,
      maxAttempts: positiveInteger(config.fallback?.maxAttempts ?? 2, "routing.fallback.maxAttempts"),
    };
  }

  async invoke(context) {
    const route = this.#route(context.agent);
    const attempts = [];
    let invocationCount = 0;

    for (const name of route.providers) {
      const policyDecision = this.policy?.evaluateProvider(name, { agent: context.agent.name });
      if (policyDecision?.allowed === false) {
        attempts.push({
          provider: name,
          status: "skipped",
          reason: "policy-denied",
          policy: policyDecision.policy,
        });
        continue;
      }
      if (!this.registry.has(name)) {
        attempts.push({ provider: name, status: "skipped", reason: "not-registered" });
        continue;
      }
      const provider = this.registry.get(name);
      if (!hasCapabilities(provider, route.requires)) {
        attempts.push({ provider: name, status: "skipped", reason: "capability-mismatch" });
        continue;
      }
      if (provider.available === false || (typeof provider.available === "function" && !await provider.available())) {
        attempts.push({ provider: name, status: "skipped", reason: "unavailable" });
        continue;
      }
      if (invocationCount >= this.fallback.maxAttempts) break;
      invocationCount += 1;
      try {
        const result = await provider.invoke(context);
        attempts.push({ provider: name, status: "succeeded" });
        return { provider: name, result, attempts };
      } catch (error) {
        const safeFallback = error instanceof ProviderError && error.retryable && error.safeToRetry;
        attempts.push({
          provider: name,
          status: "failed",
          code: error instanceof ProviderError ? error.code : "provider_error",
          retryable: error instanceof ProviderError ? error.retryable : false,
          safeToRetry: error instanceof ProviderError ? error.safeToRetry : false,
        });
        if (!this.fallback.enabled || !safeFallback || invocationCount >= this.fallback.maxAttempts) {
          throw annotateError(error, name, attempts);
        }
      }
    }

    const error = new ProviderError(
      `No provider can satisfy agent '${context.agent.name}' with capabilities: ${route.requires.join(", ") || "none"}.`,
      { code: "no_eligible_provider" },
    );
    throw annotateError(error, undefined, attempts);
  }

  #route(agent) {
    const exactRules = this.rules.filter((rule) => rule.agent === agent.name);
    const wildcardRules = this.rules.filter((rule) => rule.agent === "*");
    const rules = [...exactRules, ...wildcardRules];
    return {
      providers: unique([
        ...rules.flatMap((rule) => rule.providers),
        ...normalizeProviderList(agent.providers ?? []),
        ...normalizeProviderList(agent.provider ? [agent.provider] : []),
        ...this.defaults,
      ]),
      requires: unique([
        ...normalizeStringList(agent.requires ?? [], `Agent '${agent.name}' requires`),
        ...rules.flatMap((rule) => rule.require),
      ]),
    };
  }
}

function normalizeRules(rules) {
  if (!Array.isArray(rules)) throw new TypeError("routing.rules must be an array.");
  return rules.map((rule, index) => {
    if (!rule || typeof rule !== "object" || typeof rule.agent !== "string") {
      throw new TypeError(`routing.rules[${index}] requires an agent.`);
    }
    return Object.freeze({
      agent: rule.agent,
      providers: normalizeProviderList(rule.providers ?? []),
      require: normalizeStringList(rule.require ?? [], `routing.rules[${index}].require`),
    });
  });
}

function normalizeProviderList(value) {
  const values = typeof value === "string" ? [value] : value;
  return normalizeStringList(values, "Provider list");
}

function normalizeStringList(values, field) {
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string" || value.length === 0)) {
    throw new TypeError(`${field} must be an array of non-empty strings.`);
  }
  return unique(values);
}

function positiveInteger(value, field) {
  if (!Number.isInteger(value) || value < 1) throw new TypeError(`${field} must be a positive integer.`);
  return value;
}

function hasCapabilities(provider, required) {
  const capabilities = new Set(provider.capabilities ?? []);
  return required.every((capability) => capabilities.has(capability));
}

function unique(values) {
  return [...new Set(values)];
}

function annotateError(error, provider, attempts) {
  const value = error instanceof Error ? error : new ProviderError(String(error));
  value.provider = provider;
  value.providerAttempts = [...attempts];
  return value;
}
