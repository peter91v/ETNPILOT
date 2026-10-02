// @ts-check
import { join, resolve } from "node:path";
import { loadConfig } from "../../config/load.js";
import { summarizeTelemetryFile } from "../../observability/telemetry.js";

// What was used, by model and by day, in the terms a provider's dashboard uses,
// so the two can be compared line by line.

export const usageCommands = [
  {
    match: ({ command }) => command === "usage",
    async run({ values }) {
      const root = resolve(values.root);
      const config = await loadConfig(join(root, ".etnpilot", "etnpilot.yaml"));
      const file = resolve(root, config.observability?.file ?? ".etnpilot/state/telemetry.jsonl");
      const summary = /** @type {any} */ (await summarizeTelemetryFile(file, { root, config }));
      if (values.json) {
        console.log(JSON.stringify(summary, null, 2));
        return 0;
      }
      const money = (value) => (value === undefined ? "not priced" : `${summary.currency ?? "USD"} ${value.toFixed(4)}`);
      console.log(`By model (${summary.invocations} calls, ${summary.requests} requests to the provider):`);
      for (const [model, row] of Object.entries(summary.models)) {
        console.log(`  ${model.padEnd(24)} ${String(row.requests).padStart(5)} req  ${row.inputTokens.toLocaleString("en").padStart(10)} in  ${row.outputTokens.toLocaleString("en").padStart(9)} out  ${row.cacheReadTokens.toLocaleString("en").padStart(9)} cached  ${money(row.estimatedCost)}`);
      }
      console.log("\nBy day (UTC, like the provider's dashboard):");
      for (const [day, row] of Object.entries(summary.days)) {
        console.log(`  ${day}  ${String(row.requests).padStart(5)} req  ${row.inputTokens.toLocaleString("en").padStart(10)} in  ${row.outputTokens.toLocaleString("en").padStart(9)} out  ${money(row.estimatedCost)}`);
      }
      console.log(`\nTotal: ${money(summary.estimatedCost)}${summary.retrospective ? " (some calls are priced now with the current rate table)" : ""}`);
      if (summary.pricing) console.log(`Rates: ${summary.pricing.source}${summary.pricing.asOf ? `, as of ${summary.pricing.asOf}` : ""}${summary.pricing.stale ? " (stale)" : ""}`);
      if (summary.unpricedModels) console.log(`No rate for: ${summary.unpricedModels.map((entry) => entry.model).join(", ")} (set observability.pricing.models, or wait for the price refresh)`);
      console.log("Compare with the dashboard of the provider; tokens should match exactly, cost only if the rates match.");
      // The dashboard counts every request the key made. This report counts what runs, chats and the page recorded.
      console.log("Not counted here: 'etnpilot smoke' and 'etnpilot forge' (they send requests but record no usage), calls made before observability was on, and other tools using the same key. The dashboard shows more for that reason.");
      return 0;
    },
  },
];
