import { ProviderError } from "./router.js";
import { createWorkspaceTools } from "./workspace-tools.js";

// A provider that asks no model anything. It performs exactly the workspace
// tool calls the configuration lists, through the same mediated tools and the
// same approval path every other provider uses.
//
// It exists because the harness was otherwise untestable by the people using
// it: every test in this repository injects a provider, but that seam lived in
// the test code alone. Someone with no Copilot build and no API endpoint could
// not run ETNPilot at all — not even to see whether policy, approvals,
// receipts, checks and the merge rehearsal work on their machine.
//
// It is not an agent and must never be mistaken for one. Its receipts record
// the model as 'scripted', and it decides nothing: the steps are whatever the
// configuration already said they would be.

const TOOLS = Object.freeze(["read_file", "list_files", "write_file", "run_command"]);

export function createScriptedProvider({
  name = "scripted",
  steps = [],
  text = "Scripted run finished.",
  workingDirectory,
  toolLimits,
  sandbox,
  toolsImpl,
} = {}) {
  if (!Array.isArray(steps)) throw new TypeError(`Provider '${name}' steps must be an array.`);
  if (!workingDirectory && !toolsImpl) throw new TypeError(`Provider '${name}' requires a workingDirectory.`);
  const script = steps.map((step, index) => {
    if (!step || typeof step !== "object" || Array.isArray(step)) {
      throw new TypeError(`Provider '${name}' step ${index} must be a mapping.`);
    }
    if (!TOOLS.includes(step.tool)) {
      throw new TypeError(
        `Provider '${name}' step ${index} has tool '${step.tool}'. Available: ${TOOLS.join(", ")}.`,
      );
    }
    return Object.freeze({ tool: step.tool, arguments: step.arguments ?? {} });
  });

  return {
    name,
    capabilities: ["chat", "tools"],
    async invoke(context) {
      context.signal?.throwIfAborted();
      const tools = toolsImpl ?? createWorkspaceTools({
        workingDirectory,
        limits: toolLimits,
        signal: context.signal,
        sandbox,
      });
      const performed = [];
      for (const step of script) {
        context.signal?.throwIfAborted();
        const result = await tools.invoke(step.tool, step.arguments, context);
        performed.push({ tool: step.tool, ok: result?.ok !== false, ...(result?.error ? { error: result.error } : {}) });
        // A script declares what it will do. A step that was refused or failed
        // means it did not, so the run fails and says which step. Reporting
        // success here would put 'succeeded' above a receipt full of denials.
        if (result?.ok === false) {
          const error = new ProviderError(
            `Scripted step ${performed.length} (${step.tool}) did not run: ${result.error}`,
            { code: "scripted_step_failed" },
          );
          error.steps = performed;
          throw error;
        }
      }
      return { text, model: "scripted", steps: performed };
    },
  };
}
