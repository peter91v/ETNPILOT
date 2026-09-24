import { telemetryProviderAttributes } from "../observability/telemetry.js";

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
  constructor(registry, config = {}, { policy, defaultProvider } = {}) {
    this.registry = registry;
    this.policy = policy;
    // 'defaultProvider' is the project's plain answer to 'which provider?'.
    // It comes after routing.defaults, so a project that lists providers to
    // try keeps that order, and one that only names a default is not left
    // with no route at all.
    this.defaults = unique([
      ...normalizeProviderList(config.defaults ?? []),
      ...normalizeProviderList(defaultProvider ? [defaultProvider] : []),
    ]);
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
      const startedAt = Date.now();
      const providerSpan = context.telemetry?.startSpan("gen_ai.invoke_agent", {
        traceId: context.trace?.traceId,
        parentSpanId: context.trace?.parentSpanId,
        kind: 3,
        attributes: {
          "gen_ai.operation.name": "chat",
          "gen_ai.request.model": context.agent.model,
          "etnpilot.provider.name": name,
          "etnpilot.agent.name": context.agent.name,
          "etnpilot.workflow.run_id": context.metadata?.workflowRunId,
          "etnpilot.agent.run_id": context.runId,
        },
      });
      let result;
      try {
        result = await provider.invoke(context);
      } catch (error) {
        const durationMs = Date.now() - startedAt;
        await providerSpan?.end({
          status: "error",
          attributes: {
            "error.type": error instanceof ProviderError ? error.code : "provider_error",
            "etnpilot.duration_ms": durationMs,
          },
        });
        const safeFallback = error instanceof ProviderError && error.retryable && error.safeToRetry;
        attempts.push({
          provider: name,
          status: "failed",
          durationMs,
          // The reason it failed, kept with the attempt: a provider that was
          // tried and refused the connection is not 'no provider can satisfy'.
          message: String(error?.message ?? error).slice(0, 300),
          code: error instanceof ProviderError ? error.code : "provider_error",
          retryable: error instanceof ProviderError ? error.retryable : false,
          safeToRetry: error instanceof ProviderError ? error.safeToRetry : false,
        });
        if (!this.fallback.enabled || !safeFallback || invocationCount >= this.fallback.maxAttempts) {
          throw annotateError(error, name, attempts);
        }
        continue;
      }
      const durationMs = Date.now() - startedAt;
      const accounting = context.telemetry?.recordProviderUsage({
        workflowRunId: context.metadata?.workflowRunId,
        agentRunId: context.runId,
        provider: name,
        model: result?.model ?? context.agent.model,
        usage: result?.usage,
      });
      await providerSpan?.end({
        attributes: {
          "etnpilot.duration_ms": durationMs,
          ...telemetryProviderAttributes(accounting),
        },
      });
      attempts.push({
        provider: name,
        status: "succeeded",
        durationMs,
        ...(accounting ? { usage: compactAccounting(accounting) } : {}),
      });
      if (accounting?.budgetExceeded) {
        const error = new ProviderError("Workflow usage budget exceeded.", { code: "budget_exceeded" });
        error.budget = accounting.budgetExceeded;
        throw annotateError(error, name, attempts);
      }
      return { provider: name, result, attempts, accounting };
    }

    // The reason each candidate was passed over is already recorded; saying
    // "no provider can satisfy these capabilities" while the real cause was a
    // policy denial sends people to look at the wrong file.
    const error = new ProviderError(
      `No provider can satisfy agent '${context.agent.name}' with capabilities: ${route.requires.join(", ") || "none"}.`
      + explainSkips(attempts)
      + explainFailures(attempts)
      + this.#explainRoute(route),
      { code: "no_eligible_provider" },
    );
    throw annotateError(error, undefined, attempts);
  }

  // What was tried and what there is: an error that names neither sends
  // people looking through files for a provider that was never in the route.
  #explainRoute(route) {
    const configured = typeof this.registry?.list === "function" ? this.registry.list() : [];
    const tried = route.providers.length > 0 ? route.providers.map((name) => `'${name}'`).join(", ") : "nothing";
    const available = configured.length > 0
      ? `Configured and ready: ${configured.map((name) => `'${name}'`).join(", ")}.`
      : "No provider is configured under 'providers'.";
    return ` Tried in order: ${tried}. ${available}`
      + " The route comes from the agent's own 'provider', then 'routing.rules',"
      + " then 'routing.defaults', then 'defaultProvider'.";
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

function compactAccounting(accounting) {
  return {
    inputTokens: accounting.inputTokens,
    outputTokens: accounting.outputTokens,
    cacheReadTokens: accounting.cacheReadTokens,
    cacheWriteTokens: accounting.cacheWriteTokens,
    providerUnits: accounting.providerUnits,
    ...(accounting.estimatedCost === undefined ? {} : {
      estimatedCost: accounting.estimatedCost,
      currency: accounting.currency,
    }),
  };
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

const SKIP_REASONS = Object.freeze({
  "policy-denied": "denied by policy.providers",
  "not-registered": "not configured under 'providers'",
  "capability-mismatch": "does not declare a required capability",
  unavailable: "reported itself unavailable",
});

// A provider that was tried and failed is the more useful half of the story,
// and the one a message about capabilities hides.
function explainFailures(attempts) {
  const failed = attempts.filter((attempt) => attempt.status === "failed");
  if (failed.length === 0) return "";
  const reasons = failed
    .map((attempt) => `'${attempt.provider}' (${attempt.code}) ${(attempt.message ?? "no message").replace(/\.$/, "")}`)
    .join("; ");
  return ` Tried and failed: ${reasons}.`;
}

function explainSkips(attempts) {
  const skipped = attempts.filter((attempt) => attempt.status === "skipped");
  if (skipped.length === 0) return "";
  const reasons = skipped
    .map((attempt) => `'${attempt.provider}' ${SKIP_REASONS[attempt.reason] ?? attempt.reason}`)
    .join("; ");
  return ` Every candidate was passed over: ${reasons}.`;
}
