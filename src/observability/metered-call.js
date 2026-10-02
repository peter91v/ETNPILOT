// @ts-check
import { invocationMeter } from "../providers/usage-meter.js";
import { telemetryProviderAttributes } from "./telemetry.js";

// A request to a provider that does not go through a run (the quick check in
// `etnpilot smoke`) still costs what any other does. This makes one such call
// the way a run makes it: the usage is metered and written to the usage record
// as a span, so `etnpilot usage` can be set against the provider's dashboard
// without a hole where the checks were. With no telemetry (observability off)
// it just calls the provider.
export async function meteredInvoke({ telemetry, provider, providerName, context, attributes = {} }) {
  if (!telemetry) return provider.invoke(context);
  const span = telemetry.startSpan("gen_ai.invoke_agent", {
    kind: 3,
    attributes: {
      "gen_ai.operation.name": "chat",
      "gen_ai.request.model": context.agent?.model,
      "etnpilot.provider.name": providerName,
      "etnpilot.agent.name": context.agent?.name,
      "etnpilot.agent.run_id": context.runId,
      ...attributes,
    },
  });
  const meter = invocationMeter({ ...context, telemetry }, providerName);
  const startedAt = Date.now();
  let result;
  let accounting;
  try {
    result = await provider.invoke(meter.context);
    accounting = meter.finish(result);
  } catch (error) {
    meter.finish(undefined, error);
    await span.end({
      status: "error",
      attributes: {
        ...telemetryProviderAttributes(error.accounting),
        "error.type": error.code ?? error.name ?? "provider_error",
        "etnpilot.duration_ms": Date.now() - startedAt,
      },
    });
    throw error;
  }
  await span.end({ attributes: { "etnpilot.duration_ms": Date.now() - startedAt, ...telemetryProviderAttributes(accounting) } });
  return result;
}
