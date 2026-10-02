// @ts-check
import { resolve } from "node:path";
import { loadReceiptVerifiers } from "../../core/receipt-signing.js";
import { createRunApprovalHandler, resolveKeyWindows, resolveReceiptPublicKeys } from "../shared.js";
import { runProject } from "../../runtime/project-runner.js";
import { planResume } from "../../runtime/resume-plan.js";

// What resuming an earlier run would reuse and what it would run again
// (--dry-run: reads and checks, changes nothing), and resuming itself: a new
// run that carries the finished agent steps over and continues in the earlier
// run's worktree (docs/entwurf-lauf-fortsetzen.md).

export const resumeCommands = [
  {
    match: ({ command }) => command === "resume",
    async run({ subcommand: receipt, values }) {
      if (!receipt) throw new Error("Usage: etnpilot resume <run-id|receipt-file> [--dry-run] [--allow-drift] [--reset-partial] [--approvals terminal|inbox] [--publish] [--public-key path] [--json]");
      const verifiers = await loadReceiptVerifiers(await resolveReceiptPublicKeys(resolve(values.root), values["public-key"] ?? []), { windows: await resolveKeyWindows(resolve(values.root)) });
      const plan = await planResume({
        root: resolve(values.root),
        receipt,
        verifiers,
        requireSignatures: verifiers.size > 0 && !values["allow-unsigned"],
        allowDrift: values["allow-drift"],
        resetPartial: values["reset-partial"],
      });
      if (values.json) {
        console.log(JSON.stringify(plan, null, 2));
        return plan.resumable ? 0 : 1;
      }
      console.log(`${plan.runId ?? receipt}: ${plan.status ?? "?"}`);
      if (plan.failure) console.log(`  stopped${plan.failure.step ? ` in '${plan.failure.step}'` : ""}${plan.failure.error ? `: ${plan.failure.error}` : ""}`);
      for (const step of plan.steps) {
        const what = step.action === "reuse" ? `reuse   (${step.effect ?? "?"})` : `run again${step.reason ? ` — ${step.reason}` : ""}`;
        console.log(`  ${step.id.padEnd(18)} ${what}${step.needsConfirmation ? "  needs confirmation: it has an effect outside the workspace" : ""}`);
      }
      for (const note of plan.notes ?? []) console.log(note);
      if (plan.costSoFar !== undefined) console.log(`Cost so far: ${plan.costSoFar.toFixed(4)} (shown, not counted against a new run's budget)`);
      if (plan.reset) {
        console.log(`\nWill discard what the stopped step left in the worktree (${plan.reset.files.length} file${plan.reset.files.length === 1 ? "" : "s"}), going back to how the last finished step left it:`);
        for (const file of plan.reset.files.slice(0, 30)) console.log(`  ${file.status.padEnd(9)} ${file.path}`);
        if (plan.reset.files.length > 30) console.log(`  … ${plan.reset.files.length - 30} more`);
      }
      if (plan.drift) console.log("The configuration changed since the run started (allowed by --allow-drift).");
      if (!plan.resumable) {
        console.log("\nThis run cannot be resumed:");
        for (const refusal of plan.refusals) console.log(`  - ${refusal.message}`);
        if (plan.resetOffer) {
          console.log(`\nResuming with --reset-partial would discard (${plan.resetOffer.files.length}):`);
          for (const file of plan.resetOffer.files.slice(0, 30)) console.log(`  ${file.status.padEnd(9)} ${file.path}`);
        }
        return 1;
      }
      if (values["dry-run"]) {
        console.log("\nThis run could be resumed (without --dry-run, it is).");
        return 0;
      }
      console.log("\nResuming…\n");
      const resume = /** @type {any} */ (plan.resume);
      const result = await runProject({
        root: resolve(values.root),
        input: resume.request.input,
        agent: resume.request.agent,
        ...(resume.request.workflow ? { workflow: resume.request.workflow } : {}),
        ...(resume.request.agentOverride ? { agentOverride: resume.request.agentOverride } : {}),
        ...(resume.request.baseRef ? { baseRef: resume.request.baseRef } : {}),
        publish: values.publish,
        resume,
        approvalHandler: await createRunApprovalHandler(resolve(values.root), values.approvals),
      });
      console.log(JSON.stringify(result, null, 2));
      return result.summary?.status === "succeeded" ? 0 : 1;
    },
  },
];
