// @ts-check
import { forgeProject, summarizeForge } from "../../forge/forge.js";
import { join, resolve } from "node:path";
import { loadConfig } from "../../config/load.js";
import { wireOrchestrator } from "../../config/init.js";

// The commands of one area. Each entry says which command line it answers
// ('match') and what it does ('run'); src/cli/commands.js tries them in order.

export const agentsCommands = [
  {
    match: ({ command, subcommand }) => command === "smoke",
    async run({ values }) {
      // A few tiny real requests against the configured provider: the login, one
      // answer, one tool call, one streamed answer, and the forge digest.
      const { runSmoke, formatSmoke, SMOKE_STEPS } = await import("../../runtime/smoke.js");
      const root = resolve(values.root);
      const config = await loadConfig(join(root, ".etnpilot", "etnpilot.yaml"));
      const skip = String(values.skip ?? "").split(",").map((name) => name.trim()).filter(Boolean);
      const unknown = skip.filter((name) => !SMOKE_STEPS.includes(name));
      if (unknown.length > 0) throw new Error(`Unknown step${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}. Steps: ${SMOKE_STEPS.join(", ")}.`);
      console.log("etnpilot smoke: a few tiny real requests (a few cents at most). Nothing is written to the project.");
      const report = await runSmoke(root, {
        config, provider: values.provider, model: values.model, skip, gitlab: values.gitlab,
        onStep: (id) => { if (!values.json && process.stdout.isTTY) process.stdout.write(`  … ${id}\r`); },
      });
      if (values.json) console.log(JSON.stringify(report, null, 2));
      else for (const line of formatSmoke(report)) console.log(line);
      return report.steps.some((step) => step.status === "fail") ? 1 : 0;
    },
  },
  {
    match: ({ command, subcommand }) => command === "forge",
    async run({ values }) {
      // AgentsForge on a project that already exists: the same request init makes.
      const root = resolve(values.root);
      const config = await loadConfig(join(root, ".etnpilot", "etnpilot.yaml"));
      const preview = values.preview
        ? async (lines) => {
          console.log("AgentsForge proposes:");
          for (const line of lines) console.log(`  - ${line}`);
          if (!process.stdin.isTTY) {
            console.log("(No terminal to ask on, so nothing is written. Run it on a terminal to accept.)");
            return false;
          }
          const { createInterface } = await import("node:readline/promises");
          const asker = createInterface({ input: process.stdin, output: process.stdout });
          try {
            return /^y(es)?$/i.test((await asker.question("Write these? [y/N] ")).trim());
          } finally {
            asker.close();
          }
        }
        : undefined;
      const report = /** @type {any} */ (await forgeProject(root, { config, dryRun: Boolean(values["dry-run"]), preview, onProgress: (line) => console.log(line) }));
      if (values["dry-run"]) {
        console.log(`AgentsForge would send a digest of ${report.sent.files} files (${Math.round(report.sent.bytes / 1024)} KiB; ${report.sent.leftOut} credential files left out). Included in part:`);
        for (const path of report.sent.included) console.log(`  ${path}`);
        console.log("Nothing was sent.");
      } else {
        const wiring = { notes: [] };
        await wireOrchestrator(join(root, ".etnpilot"), wiring);
        report.notes.push(...wiring.notes);
        for (const line of summarizeForge(report)) console.log(line);
        if (report.agents.length + report.skills.length + report.instructions.length > 0) console.log("Review what was written, then run 'etnpilot content lock'.");
      }
    },
  },
  {
    match: ({ command, subcommand }) => command === "chat",
    async run({ values }) {
      const { runChat } = await import("../chat.js");
      if (values.resume && values.continue) throw new Error("Choose either --resume or --continue, not both.");
      return runChat({
        root: resolve(values.root),
        agent: values.agent,
        resume: values.continue ? "last" : values.resume,
      });
    },
  },
  {
    match: ({ command, subcommand }) => command === "eval",
    async run({ subcommand, rest, values }) {
      // Whether a run does the job, rather than whether the code runs. Against
      // the scripted provider this is free and deterministic and measures the
      // harness; against a real one it costs money and measures the agent.
      const { listEvalCases, runEvalCase, formatEvalTable, summarizeEvals } = await import("../../runtime/evals.js");
      const { mkdtemp } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const directory = resolve(values.root, values.cases ?? "test/evals");
      const all = await listEvalCases(directory);
      if (all.length === 0) throw new Error(`No eval cases in ${directory}.`);
      const names = [subcommand, ...rest].filter(Boolean);
      const unknown = names.filter((name) => !all.some((one) => one.id === name));
      if (unknown.length > 0) {
        throw new Error(`Unknown eval${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}.`
          + ` Known: ${all.map((one) => one.id).join(", ")}.`);
      }
      const wanted = names.length > 0 ? all.filter((one) => names.includes(one.id)) : all;
      const provider = values.provider ?? "scripted";
      if (provider !== "scripted") {
        console.log(`Running ${wanted.length} case(s) against '${provider}'. This spends real tokens.`);
      }
      const results = [];
      for (const one of wanted) {
        results.push(await runEvalCase(one, { root: await mkdtemp(join(tmpdir(), `etnpilot-eval-${one.id}-`)), provider }));
      }
      if (values.json) {
        console.log(JSON.stringify({ ...summarizeEvals(results), results }, null, 2));
      } else {
        console.log(formatEvalTable(results));
      }
      return results.every((result) => result.ok) ? 0 : 1;
    },
  },
];
