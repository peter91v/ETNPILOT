// @ts-check
import { WorktreeManager } from "../../git/worktrees.js";
import { createRunApprovalHandler, ignoreMissing, resolveReceiptPublicKeys } from "../shared.js";
import { diagnose } from "../../runtime/diagnose.js";
import { initializeProject } from "../../config/init.js";
import { join, resolve } from "node:path";
import { knownCheck, listChecks, runProjectCheck } from "../../runtime/project-checks.js";
import { loadConfig } from "../../config/load.js";
import { loadReceiptVerifiers } from "../../core/receipt-signing.js";
import { readMergeRequests, readWorktrees } from "../../runtime/project-state.js";
import { recoverWorkspaceLease } from "../../runtime/workspace-lease.js";
import { replayRun } from "../../runtime/replay.js";
import { runProject } from "../../runtime/project-runner.js";
import { summarizeForge } from "../../forge/forge.js";
import { summarizeImport } from "../../config/migrate.js";
import { trustProject } from "../../trust/trust.js";

// The commands of one area. Each entry says which command line it answers
// ('match') and what it does ('run'); src/cli/commands.js tries them in order.

export const projectCommands = [
  {
    match: ({ command, subcommand }) => command === "init",
    async run({ subcommand, values }) {
      const result = await initializeProject(resolve(subcommand ?? "."), {
        template: values.template,
        importExisting: !values["no-import"],
        forge: values["no-forge"] ? false : "auto",
        onProgress: (line) => console.log(line),
      });
      // A project its owner just made on this machine is one they trust.
      await trustProject(result.root).catch(() => undefined);
      console.log(`Initialized ETNPilot in ${result.root} (template: ${result.template}).`);
      for (const line of result.imported ? summarizeImport(result.imported) : []) console.log(line);
      for (const line of result.forged ? summarizeForge(result.forged) : []) console.log(line);
      console.log("Next: review '.etnpilot/', run 'etnpilot content lock' to approve what you reviewed, commit it, then run 'etnpilot run \"<task>\"'.");
    },
  },
  {
    match: ({ command, subcommand }) => command === "run",
    async run({ command, subcommand, rest, values }) {
      if (values.worktree && (values["no-worktree"] || values["in-place"])) {
        throw new Error("Choose either --worktree or --no-worktree, not both.");
      }
      if (values["record-fixtures"] && values.fixtures) {
        throw new Error("Choose either --record-fixtures or --fixtures, not both.");
      }
      const task = [subcommand, ...rest].filter(Boolean).join(" ");
      const worktree = values.worktree ? true : (values["no-worktree"] || values["in-place"]) ? false : undefined;
      // In a pipeline this command printed nothing for minutes and then one
      // JSON object. The events are already produced — the surfaces use them to
      // show progress — and only the CLI threw them away.
      const streaming = values.events === "jsonl";
      if (values.events !== undefined && !streaming) {
        throw new Error(`Unknown --events format '${values.events}'. The only one is 'jsonl'.`);
      }
      // A reader of this stream must get a last line either way; a run that
      // throws would otherwise end mid-stream with the reason only on stderr.
      const emit = (line) => { if (streaming) console.log(JSON.stringify(line)); };
      const result = await runProject({
        root: resolve(values.root),
        input: task,
        agent: values.agent,
        ...(values.workflow ? { workflow: values.workflow } : {}),
        ...(streaming
          ? { onEvent: (event) => console.log(JSON.stringify(event)) }
          : {}),
        worktree,
        cleanupPolicy: values["cleanup-worktree"] ? "on-success" : undefined,
        publish: values.publish,
        dryRun: values["dry-run"],
        recordFixtures: values["record-fixtures"],
        fixtures: values.fixtures,
        approvalHandler: await createRunApprovalHandler(resolve(values.root), values.approvals),
      }).catch((error) => {
        emit({ type: "run.error", at: new Date().toISOString(), error: error.message });
        throw error;
      });
      // The last line is the result, whichever mode: a reader that takes the
      // final line gets the same answer either way.
      console.log(streaming ? JSON.stringify({ event: "run.result", ...result }) : JSON.stringify(result, null, 2));
      return result.summary?.status === "succeeded" ? 0 : 1;
    },
  },
  {
    match: ({ command, subcommand }) => command === "lease" && subcommand === "recover",
    async run({ values }) {
      console.log(JSON.stringify(await recoverWorkspaceLease(resolve(values.root), values["lease-owner"]), null, 2));
      return 0;
    },
  },
  {
    match: ({ command, subcommand }) => command === "replay",
    async run({ subcommand, values }) {
      if (!subcommand) throw new Error("A receipt file is required.");
      const root = resolve(values.root);
      const publicKeyPaths = await resolveReceiptPublicKeys(root, values["public-key"] ?? []);
      const report = await replayRun(resolve(subcommand), {
        root,
        verifiers: await loadReceiptVerifiers(publicKeyPaths),
        requireSignatures: values["require-signatures"] || publicKeyPaths.length > 0,
        inspectOnly: values["inspect-only"],
      });
      console.log(JSON.stringify(report, null, 2));
      return report.receiptValid && report.drifted.length === 0 ? 0 : 1;
    },
  },
  {
    match: ({ command, subcommand }) => command === "worktree" && subcommand === "list",
    async run({ values }) {
      // The same description the TUI shows: which branch each worktree holds,
      // which ones a run made, and what removing one would throw away.
      const root = resolve(values.root);
      const config = await loadConfig(join(root, ".etnpilot", "etnpilot.yaml")).catch(ignoreMissing);
      console.log(JSON.stringify(await readWorktrees({ root, config: config ?? {} }), null, 2));
    },
  },
  {
    match: ({ command, subcommand }) => command === "worktree" && subcommand === "cleanup",
    async run({ rest, values }) {
      if (!rest[0]) throw new Error("A worktree name is required.");
      const manager = new WorktreeManager(resolve(values.root));
      console.log(JSON.stringify(await manager.removeIfClean(rest[0]), null, 2));
    },
  },
  {
    match: ({ command, subcommand }) => command === "merge" && (subcommand === "list" || subcommand === undefined),
    async run({ values }) {
      const root = resolve(values.root);
      const config = await loadConfig(join(root, ".etnpilot", "etnpilot.yaml"));
      const merges = await readMergeRequests({ root, config, env: process.env }, { state: values.status ?? "opened" });
      console.log(JSON.stringify(merges, null, 2));
      // Nothing to say is success; being unable to ask is not.
      return merges.configured === false || merges.available === false ? 1 : 0;
    },
  },
  {
    match: ({ command, subcommand }) => command === "check",
    async run({ subcommand, rest, values }) {
      // The same registry the TUI and the page list, so 'what can this project
      // check about itself' has one answer, wherever it is asked.
      const root = resolve(values.root);
      const names = [subcommand, ...rest].filter(Boolean);
      const unknown = names.filter((name) => !knownCheck(name));
      if (unknown.length > 0) {
        throw new Error(`Unknown check${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}.`
          + ` Known: ${listChecks().map((one) => one.id).join(", ")}.`);
      }
      const wanted = names.length > 0 ? names : listChecks().map((one) => one.id);
      const results = [];
      for (const id of wanted) results.push(await runProjectCheck(id, { root }));
      console.log(JSON.stringify(names.length === 1 ? results[0] : { checks: results }, null, 2));
      // A check with no verdict of its own — no telemetry recorded yet — is not
      // a failure, so it does not decide the exit code.
      return results.some((result) => result.ok === false) ? 1 : 0;
    },
  },
  {
    match: ({ command, subcommand }) => command === "doctor",
    async run({ values }) {
      const report = await diagnose(resolve(values.root));
      console.log(JSON.stringify(report, null, 2));
      return report.ready ? 0 : 1;
    },
  },
];
