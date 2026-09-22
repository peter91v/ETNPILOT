# Observability and cost controls

ETNPilot emits correlated workflow, agent, provider, subagent, and check spans as OTLP/JSON. The
same payload can be appended to a local JSONL file and sent to an OpenTelemetry Collector over
OTLP/HTTP. The protocol's standard trace endpoint is `/v1/traces` and JSON trace/span IDs use
hexadecimal encoding.

References:

- [OTLP specification](https://opentelemetry.io/docs/specs/otlp/)
- [OTLP exporter configuration](https://opentelemetry.io/docs/specs/otel/protocol/exporter/)
- [OpenTelemetry GenAI semantic conventions](https://github.com/open-telemetry/semantic-conventions-genai)

## Configuration

```yaml
observability:
  enabled: true
  file: .etnpilot/state/telemetry.jsonl
  serviceName: etnpilot
  environment: production
  failureMode: ignore
  otlp:
    enabled: true
    endpoint: https://collector.example.com/v1/traces
    headersSecret: observability.otlpHeaders
    timeoutMs: 5000
  pricing:
    currency: USD
    models:
      team-model:
        inputPerMillion: 2
        outputPerMillion: 8
        cacheReadPerMillion: 0.5
        cacheWritePerMillion: 2
  budgets:
    maxInputTokensPerWorkflow: 500000
    maxOutputTokensPerWorkflow: 100000
    maxEstimatedCostPerWorkflow: 5
    maxProviderUnitsPerWorkflow: 20
```

`file: false` disables the local file. When OTLP export is also disabled, spans are still accounted
in memory for the workflow receipt and budget checks. The generated configuration keeps the local
file enabled and remote export disabled.

`failureMode: ignore` records a normalized exporter-error count and keeps the workflow running.
`failureMode: fail` treats an unavailable file or collector as a workflow failure. Error bodies and
configured headers are never included in the normalized error evidence.
Remote requests are aborted after `timeoutMs` so an unavailable collector cannot hang a workflow.

## Collector authentication

Headers are resolved as a named secret containing one JSON object:

```yaml
secrets:
  values:
    observability.otlpHeaders:
      provider: env
      key: ETNPILOT_OTLP_HEADERS
```

```bash
export ETNPILOT_OTLP_HEADERS='{"authorization":"Bearer collector-token"}'
```

Header names and values are validated, newline injection is rejected, and URL credentials are not
allowed in `endpoint`. Prefer a local collector or a private TLS endpoint. Exporter traffic is an
operator-configured runtime integration, not an agent-requested network tool.

## GenAI usage

Provider spans use these standard attributes when reported by the provider:

- `gen_ai.usage.input_tokens`;
- `gen_ai.usage.output_tokens`;
- `gen_ai.usage.cache_read.input_tokens`;
- `gen_ai.usage.cache_creation.input_tokens`.

The OpenAI-compatible adapter normalizes common completion-response fields. The Copilot adapter
subscribes to `assistant.usage` events and aggregates all events from the session. Copilot's reported
`cost` is stored as `etnpilot.provider.usage_units`; it is deliberately not assigned a currency.

Telemetry never includes prompts, generated text, system instructions, tool arguments, secrets, or
raw provider responses. Run receipts retain the existing provider result according to their own
evidence policy; telemetry's privacy boundary does not change receipt content.

## Cost estimates

Rates are configured per one million tokens. Exact model names take precedence over an optional
`"*"` fallback. Cache-read and cache-write rates default to the input rate when omitted. Since
provider prices and enterprise agreements change independently of ETNPilot, no monetary rates are
built in.

An estimate appears only when a matching model rate exists. Unmatched invocations are counted as
`unpricedInvocations`, so a partial pricing table cannot silently look complete. The workflow
receipt reports token totals, estimated cost, currency, provider units, and priced/unpriced counts.

## Budget semantics

Budgets are cumulative per workflow, including subagents and fallback attempts that successfully
returned usage. Supported limits are:

| Setting | Unit |
|---|---|
| `maxInputTokensPerWorkflow` | tokens |
| `maxOutputTokensPerWorkflow` | tokens |
| `maxEstimatedCostPerWorkflow` | configured currency |
| `maxProviderUnitsPerWorkflow` | dimensionless provider units |

A provider call may be required to learn its final usage. Therefore, the call that crosses a limit
has already happened; ETNPilot records it, raises `budget_exceeded`, and prevents subsequent
workflow work. Monetary budgets only cover priced invocations. Use token or provider-unit limits as
an additional guard when a workflow can select unpriced models.

## Local inspection

```bash
etnpilot telemetry summary --root /path/to/project
etnpilot telemetry summary <workflow-run-id> --root /path/to/project
```

The local file contains one valid `ExportTraceServiceRequest` JSON object per line. It stays under
the ignored `.etnpilot/state/` directory and can be replayed or transformed by normal log shipping
tools. The summary command reads only token, unit, and estimate attributes; it does not contact a
collector.
