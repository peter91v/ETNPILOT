// @ts-check
import { resolve } from "node:path";
import { loadReceiptVerifiers } from "../../core/receipt-signing.js";
import { resolveReceiptPublicKeys } from "../shared.js";
import { planResume } from "../../runtime/resume-plan.js";

// What resuming an earlier run would reuse and what it would run again. Only
// the plan exists so far (docs/entwurf-lauf-fortsetzen.md, E2): it reads and
// checks and changes nothing.

export const resumeCommands = [
  {
    match: ({ command }) => command === "resume",
    async run({ subcommand: receipt, values }) {
      if (!receipt) throw new Error("Usage: etnpilot resume <run-id|receipt-file> --dry-run [--allow-drift] [--public-key path] [--json]");
      if (!values["dry-run"]) {
        throw new Error("Resuming is not built yet; only the plan is. Add --dry-run to see what would be reused (docs/entwurf-lauf-fortsetzen.md).");
      }
      const verifiers = await loadReceiptVerifiers(await resolveReceiptPublicKeys(resolve(values.root), values["public-key"] ?? []));
      const plan = await planResume({
        root: resolve(values.root),
        receipt,
        verifiers,
        requireSignatures: verifiers.size > 0 && !values["allow-unsigned"],
        allowDrift: values["allow-drift"],
      });
      if (values.json) {
        console.log(JSON.stringify(plan, null, 2));
        return plan.resumable ? 0 : 1;
      }
      console.log(`${plan.runId ?? receipt}: ${plan.status ?? "?"}`);
      for (const step of plan.steps) {
        const what = step.action === "reuse" ? `reuse   (${step.effect ?? "?"})` : `run again${step.reason ? ` — ${step.reason}` : ""}`;
        console.log(`  ${step.id.padEnd(18)} ${what}${step.needsConfirmation ? "  needs confirmation: it has an effect outside the workspace" : ""}`);
      }
      if (plan.costSoFar !== undefined) console.log(`Cost so far: ${plan.costSoFar.toFixed(4)} (shown, not counted against a new run's budget)`);
      if (plan.drift) console.log("The configuration changed since the run started (allowed by --allow-drift).");
      if (plan.resumable) console.log("\nThis run could be resumed.");
      else {
        console.log("\nThis run cannot be resumed:");
        for (const refusal of plan.refusals) console.log(`  - ${refusal.message}`);
      }
      return plan.resumable ? 0 : 1;
    },
  },
];
