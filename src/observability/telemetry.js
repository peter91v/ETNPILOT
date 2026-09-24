import { randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const TELEMETRY_VERSION = 1;
const SCOPE_NAME = "etnpilot";
const SCOPE_VERSION = "0.1.0";

export async function createTelemetry({
  root = process.cwd(),
  config = {},
  secretResolver,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
} = {}) {
  const options = normalizeConfig(config.observability);
  if (!options.enabled) return undefined;
  let headers = {};
  if (options.otlp?.headersSecret) {
    if (!secretResolver) throw new Error("OTLP headers use a secret reference but no resolver is available.");
    headers = parseHeaders(await secretResolver.get(options.otlp.headersSecret, { required: true }));
  }
  return new Telemetry({
    ...options,
    file: options.file ? resolve(root, options.file) : undefined,
    otlp: options.otlp ? { ...options.otlp, headers } : undefined,
    fetchImpl,
    now,
  });
}

export class Telemetry {
  constructor({
    file,
    serviceName = "etnpilot",
    environment,
    failureMode = "ignore",
    otlp,
    pricing = {},
    budgets = {},
    fetchImpl = globalThis.fetch,
    now = () => Date.now(),
  } = {}) {
    this.file = file;
    this.serviceName = serviceName;
    this.environment = environment;
    this.failureMode = failureMode;
    this.otlp = otlp;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.pricing = normalizePricing(pricing);
    this.budgets = normalizeBudgets(budgets);
    this.totals = new Map();
    this.pending = Promise.resolve();
    this.errors = [];
  }

  startSpan(name, { traceId, parentSpanId, kind = 1, attributes = {} } = {}) {
    if (typeof name !== "string" || name.length === 0) throw new TypeError("Span name is required.");
    if (traceId !== undefined && !/^[a-f0-9]{32}$/.test(traceId)) {
      throw new TypeError("traceId must be 32 lowercase hexadecimal characters.");
    }
    if (parentSpanId !== undefined && !/^[a-f0-9]{16}$/.test(parentSpanId)) {
      throw new TypeError("parentSpanId must be 16 lowercase hexadecimal characters.");
    }
    if (!Number.isInteger(kind) || kind < 0 || kind > 5) {
      throw new TypeError("Span kind must be an integer from 0 to 5.");
    }
    const startedAt = this.now();
    const span = {
      traceId: traceId ?? randomHex(16),
      spanId: randomHex(8),
      parentSpanId,
      name,
      kind,
      startedAt,
      attributes: cleanAttributes(attributes),
    };
    let ended = false;
    const telemetry = this;
    return Object.freeze({
      traceId: span.traceId,
      spanId: span.spanId,
      end: async ({ status = "ok", attributes: finalAttributes = {} } = {}) => {
        if (ended) throw new Error(`Span '${name}' has already ended.`);
        ended = true;
        const completed = {
          ...span,
          endedAt: telemetry.now(),
          status,
          attributes: { ...span.attributes, ...cleanAttributes(finalAttributes) },
        };
        await telemetry.emit(completed);
        return completed;
      },
    });
  }

  recordProviderUsage({ workflowRunId, agentRunId, provider, model, usage = {} }) {
    const normalized = normalizeUsage(usage);
    const key = workflowRunId ?? agentRunId;
    const rate = this.pricing.models[model]
      ?? this.pricing.models[undatedModel(model)]
      ?? this.pricing.models["*"];
    const estimatedCost = rate ? calculateCost(normalized, rate) : undefined;
    const previous = this.totals.get(key) ?? emptySummary(this.pricing.currency);
    const total = {
      ...previous,
      inputTokens: previous.inputTokens + normalized.inputTokens,
      outputTokens: previous.outputTokens + normalized.outputTokens,
      cacheReadTokens: previous.cacheReadTokens + normalized.cacheReadTokens,
      cacheWriteTokens: previous.cacheWriteTokens + normalized.cacheWriteTokens,
      providerUnits: previous.providerUnits + normalized.providerUnits,
      estimatedCost: addOptional(previous.estimatedCost, estimatedCost),
      invocations: previous.invocations + 1,
      pricedInvocations: previous.pricedInvocations + (estimatedCost === undefined ? 0 : 1),
      unpricedInvocations: previous.unpricedInvocations + (estimatedCost === undefined ? 1 : 0),
    };
    this.totals.set(key, total);
    const exceeded = budgetViolations(total, this.budgets);
    return Object.freeze({
      provider,
      model,
      ...normalized,
      ...(estimatedCost === undefined ? {} : { estimatedCost, currency: this.pricing.currency }),
      workflow: Object.freeze({ ...total }),
      ...(exceeded.length > 0 ? { budgetExceeded: Object.freeze(exceeded) } : {}),
    });
  }

  summary(workflowRunId) {
    return Object.freeze({ ...(this.totals.get(workflowRunId) ?? emptySummary(this.pricing.currency)) });
  }

  async emit(span) {
    const payload = toOtlpPayload(span, {
      serviceName: this.serviceName,
      environment: this.environment,
    });
    const operation = async () => {
      if (this.file) {
        await mkdir(dirname(this.file), { recursive: true });
        await appendFile(this.file, `${JSON.stringify(payload)}\n`, "utf8");
      }
      if (this.otlp?.enabled) await exportOtlp(payload, this.otlp, this.fetchImpl);
    };
    const queued = this.pending.then(operation, operation);
    this.pending = queued.catch((error) => {
      if (this.errors.length < 100) {
        this.errors.push({ at: new Date().toISOString(), code: error.code ?? "telemetry_export_failed" });
      }
    });
    if (this.failureMode === "fail") await queued;
    else await this.pending;
  }

  async flush() {
    await this.pending;
    return { errors: [...this.errors] };
  }
}

export async function summarizeTelemetryFile(path, { workflowRunId } = {}) {
  const content = await readFile(resolve(path), "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  const summary = emptySummary();
  // Which models went without a rate. 'not priced' with no model named leaves
  // someone setting a rate for a model the runs never used, and the card says
  // the same thing afterwards.
  const unpriced = new Map();
  const priced = new Set();
  let spans = 0;
  for (const line of content.split("\n").filter(Boolean)) {
    const payload = JSON.parse(line);
    for (const resource of payload.resourceSpans ?? []) {
      for (const scope of resource.scopeSpans ?? []) {
        for (const span of scope.spans ?? []) {
          const attributes = fromOtlpAttributes(span.attributes ?? []);
          if (workflowRunId && attributes["etnpilot.workflow.run_id"] !== workflowRunId) continue;
          spans += 1;
          if (attributes["etnpilot.usage.recorded"] !== true) continue;
          summary.inputTokens += attributes["gen_ai.usage.input_tokens"] ?? 0;
          summary.outputTokens += attributes["gen_ai.usage.output_tokens"] ?? 0;
          summary.cacheReadTokens += attributes["gen_ai.usage.cache_read.input_tokens"] ?? 0;
          summary.cacheWriteTokens += attributes["gen_ai.usage.cache_creation.input_tokens"] ?? 0;
          summary.providerUnits += attributes["etnpilot.provider.usage_units"] ?? 0;
          const model = attributes["gen_ai.request.model"] ?? "unknown";
          if (attributes["etnpilot.cost.estimated"] !== undefined) {
            summary.estimatedCost = (summary.estimatedCost ?? 0) + attributes["etnpilot.cost.estimated"];
            summary.pricedInvocations += 1;
            priced.add(model);
          } else {
            summary.unpricedInvocations += 1;
            unpriced.set(model, (unpriced.get(model) ?? 0) + 1);
          }
          summary.invocations += 1;
          summary.currency ??= attributes["etnpilot.cost.currency"];
        }
      }
    }
  }
  return {
    version: TELEMETRY_VERSION,
    spans,
    workflowRunId,
    ...summary,
    // A cost is recorded when the call happens, so a rate set afterwards
    // never reaches a call already on disk. Naming the models says which rate
    // is missing, and how many calls predate the one that exists.
    ...(unpriced.size > 0
      ? {
        unpricedModels: [...unpriced]
          .map(([model, calls]) => ({ model, calls, ...(priced.has(model) ? { pricedSince: true } : {}) }))
          .sort((left, right) => right.calls - left.calls),
      }
      : {}),
  };
}

function normalizeConfig(config = {}) {
  if (!config || Array.isArray(config) || typeof config !== "object") {
    throw new TypeError("observability must be an object.");
  }
  rejectUnknown(config, ["enabled", "file", "serviceName", "environment", "failureMode", "otlp", "pricing", "budgets"], "observability");
  const enabled = config.enabled === true;
  const failureMode = config.failureMode ?? "ignore";
  if (!["ignore", "fail"].includes(failureMode)) throw new TypeError("observability.failureMode must be ignore or fail.");
  if (config.file !== undefined && config.file !== false && typeof config.file !== "string") {
    throw new TypeError("observability.file must be a path or false.");
  }
  if (config.serviceName !== undefined && (typeof config.serviceName !== "string" || !config.serviceName)) {
    throw new TypeError("observability.serviceName must be a non-empty string.");
  }
  if (config.environment !== undefined && (typeof config.environment !== "string" || !config.environment)) {
    throw new TypeError("observability.environment must be a non-empty string.");
  }
  const otlp = normalizeOtlp(config.otlp);
  return {
    enabled,
    file: config.file === false ? undefined : (config.file ?? ".etnpilot/state/telemetry.jsonl"),
    serviceName: config.serviceName ?? "etnpilot",
    environment: config.environment,
    failureMode,
    otlp,
    pricing: config.pricing ?? {},
    budgets: config.budgets ?? {},
  };
}

function normalizeOtlp(config) {
  if (config === undefined) return undefined;
  if (!config || Array.isArray(config) || typeof config !== "object") throw new TypeError("observability.otlp must be an object.");
  rejectUnknown(config, ["enabled", "endpoint", "headersSecret", "timeoutMs"], "observability.otlp");
  if (config.enabled !== undefined && typeof config.enabled !== "boolean") {
    throw new TypeError("observability.otlp.enabled must be a boolean.");
  }
  const timeoutMs = positiveInteger(config.timeoutMs ?? 5000, "observability.otlp.timeoutMs");
  if (config.enabled !== true) return { enabled: false, timeoutMs };
  if (typeof config.endpoint !== "string") throw new TypeError("Enabled OTLP export requires an endpoint.");
  const endpoint = new URL(config.endpoint);
  if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
    throw new TypeError("OTLP endpoint must be an HTTP(S) URL without credentials.");
  }
  if (config.headersSecret !== undefined && typeof config.headersSecret !== "string") {
    throw new TypeError("observability.otlp.headersSecret must be a secret name.");
  }
  return { enabled: true, endpoint: endpoint.toString(), headersSecret: config.headersSecret, timeoutMs };
}

function normalizePricing(config) {
  if (!config || Array.isArray(config) || typeof config !== "object") throw new TypeError("observability.pricing must be an object.");
  rejectUnknown(config, ["currency", "models"], "observability.pricing");
  const currency = config.currency ?? "USD";
  if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) throw new TypeError("Pricing currency must be a three-letter uppercase code.");
  if (config.models !== undefined && (!config.models || Array.isArray(config.models) || typeof config.models !== "object")) {
    throw new TypeError("observability.pricing.models must be an object.");
  }
  const models = {};
  for (const [model, rates] of Object.entries(config.models ?? {})) {
    if (!model) throw new TypeError("Pricing model names must not be empty.");
    if (!rates || Array.isArray(rates) || typeof rates !== "object") throw new TypeError(`Pricing for '${model}' must be an object.`);
    rejectUnknown(rates, ["inputPerMillion", "outputPerMillion", "cacheReadPerMillion", "cacheWritePerMillion"], `pricing for '${model}'`);
    models[model] = Object.freeze({
      inputPerMillion: nonNegative(rates.inputPerMillion ?? 0, `${model}.inputPerMillion`),
      outputPerMillion: nonNegative(rates.outputPerMillion ?? 0, `${model}.outputPerMillion`),
      cacheReadPerMillion: nonNegative(rates.cacheReadPerMillion ?? rates.inputPerMillion ?? 0, `${model}.cacheReadPerMillion`),
      cacheWritePerMillion: nonNegative(rates.cacheWritePerMillion ?? rates.inputPerMillion ?? 0, `${model}.cacheWritePerMillion`),
    });
  }
  return Object.freeze({ currency, models: Object.freeze(models) });
}

function normalizeBudgets(config) {
  if (!config || Array.isArray(config) || typeof config !== "object") throw new TypeError("observability.budgets must be an object.");
  return Object.freeze(Object.fromEntries(Object.entries(config).map(([name, value]) => {
    if (!["maxInputTokensPerWorkflow", "maxOutputTokensPerWorkflow", "maxEstimatedCostPerWorkflow", "maxProviderUnitsPerWorkflow"].includes(name)) {
      throw new TypeError(`Unknown observability budget '${name}'.`);
    }
    return [name, nonNegative(value, name)];
  })));
}

function normalizeUsage(usage) {
  return Object.freeze({
    inputTokens: nonNegativeInteger(usage.inputTokens ?? 0, "inputTokens"),
    outputTokens: nonNegativeInteger(usage.outputTokens ?? 0, "outputTokens"),
    cacheReadTokens: nonNegativeInteger(usage.cacheReadTokens ?? 0, "cacheReadTokens"),
    cacheWriteTokens: nonNegativeInteger(usage.cacheWriteTokens ?? 0, "cacheWriteTokens"),
    providerUnits: nonNegative(usage.providerUnits ?? 0, "providerUnits"),
  });
}

function calculateCost(usage, rates) {
  const uncachedInput = Math.max(0, usage.inputTokens - usage.cacheReadTokens - usage.cacheWriteTokens);
  return round12((
    uncachedInput * rates.inputPerMillion
    + usage.cacheReadTokens * rates.cacheReadPerMillion
    + usage.cacheWriteTokens * rates.cacheWritePerMillion
    + usage.outputTokens * rates.outputPerMillion
  ) / 1_000_000);
}

function budgetViolations(total, budgets) {
  const checks = [
    ["input_tokens", total.inputTokens, budgets.maxInputTokensPerWorkflow],
    ["output_tokens", total.outputTokens, budgets.maxOutputTokensPerWorkflow],
    ["estimated_cost", total.estimatedCost, budgets.maxEstimatedCostPerWorkflow],
    ["provider_units", total.providerUnits, budgets.maxProviderUnitsPerWorkflow],
  ];
  return checks.filter(([, actual, limit]) => limit !== undefined && actual !== undefined && actual > limit)
    .map(([metric, actual, limit]) => Object.freeze({ metric, actual, limit }));
}

function toOtlpPayload(span, resource) {
  return {
    resourceSpans: [{
      resource: { attributes: toOtlpAttributes({
        "service.name": resource.serviceName,
        "service.version": SCOPE_VERSION,
        ...(resource.environment ? { "deployment.environment.name": resource.environment } : {}),
      }) },
      scopeSpans: [{
        scope: { name: SCOPE_NAME, version: SCOPE_VERSION },
        spans: [{
          traceId: span.traceId,
          spanId: span.spanId,
          ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
          name: span.name,
          kind: span.kind,
          startTimeUnixNano: toUnixNano(span.startedAt),
          endTimeUnixNano: toUnixNano(span.endedAt),
          attributes: toOtlpAttributes(span.attributes),
          status: { code: span.status === "error" ? 2 : 1 },
        }],
      }],
    }],
  };
}

async function exportOtlp(payload, config, fetchImpl) {
  if (typeof fetchImpl !== "function") throw telemetryError("No fetch implementation is available.");
  let response;
  try {
    response = await fetchImpl(config.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", ...config.headers },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(config.timeoutMs ?? 5000),
    });
  } catch {
    throw telemetryError("OTLP export request failed.");
  }
  if (!response.ok) {
    await response.text().catch(() => undefined);
    throw telemetryError(`OTLP export failed (${response.status}).`);
  }
  await response.text().catch(() => undefined);
}

function parseHeaders(value) {
  if (value.length > 16_384) throw new Error("OTLP header secret is too large.");
  let headers;
  try { headers = JSON.parse(value); } catch { throw new Error("OTLP header secret must contain a JSON object."); }
  if (!headers || Array.isArray(headers) || typeof headers !== "object") throw new Error("OTLP header secret must contain a JSON object.");
  for (const [name, headerValue] of Object.entries(headers)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || typeof headerValue !== "string" || /[\r\n]/.test(headerValue)) {
      throw new Error("OTLP header secret contains an invalid header.");
    }
  }
  return Object.freeze({ ...headers });
}

function cleanAttributes(attributes) {
  return Object.fromEntries(Object.entries(attributes).filter(([, value]) => (
    value !== undefined && value !== null
    && (["string", "boolean"].includes(typeof value) || (typeof value === "number" && Number.isFinite(value)))
  )));
}

function toOtlpAttributes(attributes) {
  return Object.entries(attributes).map(([key, value]) => ({ key, value: toOtlpValue(value) }));
}

function toOtlpValue(value) {
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number" && Number.isInteger(value)) return { intValue: String(value) };
  if (typeof value === "number") return { doubleValue: value };
  return { stringValue: String(value) };
}

function fromOtlpAttributes(attributes) {
  return Object.fromEntries(attributes.map(({ key, value }) => [key, fromOtlpValue(value)]));
}

function fromOtlpValue(value = {}) {
  if (value.intValue !== undefined) return Number(value.intValue);
  if (value.doubleValue !== undefined) return value.doubleValue;
  if (value.boolValue !== undefined) return value.boolValue;
  return value.stringValue;
}

function providerAttributes(accounting = {}) {
  return cleanAttributes({
    "gen_ai.operation.name": "chat",
    "etnpilot.usage.recorded": true,
    "gen_ai.request.model": accounting.model,
    "gen_ai.usage.input_tokens": accounting.inputTokens,
    "gen_ai.usage.output_tokens": accounting.outputTokens,
    "gen_ai.usage.cache_read.input_tokens": accounting.cacheReadTokens,
    "gen_ai.usage.cache_creation.input_tokens": accounting.cacheWriteTokens,
    "etnpilot.provider.usage_units": accounting.providerUnits,
    "etnpilot.cost.estimated": accounting.estimatedCost,
    "etnpilot.cost.currency": accounting.currency,
  });
}

export function telemetryProviderAttributes(accounting) {
  return providerAttributes(accounting);
}

// Providers answer with the dated snapshot they actually served —
// 'gpt-5-mini-2025-08-07' for a request that named 'gpt-5-mini'. A rate keyed
// by the name someone configured must reach it, or every rate goes stale the
// next time the provider rotates its snapshot. The suffix is an exact shape,
// not a prefix guess: 'gpt-5' never picks up the rate for 'gpt-5-mini'.
function undatedModel(model) {
  return typeof model === "string" ? model.replace(/-\d{4}-\d{2}-\d{2}$/, "") : model;
}

function emptySummary(currency) {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    providerUnits: 0,
    estimatedCost: undefined,
    currency,
    invocations: 0,
    pricedInvocations: 0,
    unpricedInvocations: 0,
  };
}

function addOptional(left, right) {
  if (left === undefined && right === undefined) return undefined;
  return round12((left ?? 0) + (right ?? 0));
}

function randomHex(bytes) {
  return randomBytes(bytes).toString("hex");
}

function toUnixNano(milliseconds) {
  return String(BigInt(Math.trunc(milliseconds)) * 1_000_000n);
}

function nonNegative(value, field) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new TypeError(`${field} must be a non-negative number.`);
  return value;
}

function nonNegativeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${field} must be a non-negative safe integer.`);
  return value;
}

function positiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${field} must be a positive safe integer.`);
  return value;
}

function rejectUnknown(object, allowed, field) {
  const unknown = Object.keys(object).find((key) => !allowed.includes(key));
  if (unknown) throw new TypeError(`Unknown ${field} setting '${unknown}'.`);
}

function round12(value) {
  return Math.round(value * 1e12) / 1e12;
}

function telemetryError(message) {
  const error = new Error(message);
  error.code = "telemetry_export_failed";
  return error;
}

export const OBSERVABILITY_VERSION = TELEMETRY_VERSION;
