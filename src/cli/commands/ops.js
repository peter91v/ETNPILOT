import { GitLabClient } from "../../gitlab/client.js";
import { createSecretResolver } from "../../secrets/resolver.js";
import { join, resolve } from "node:path";
import { latestPipeline } from "../../gitlab/pipelines.js";
import { loadConfig } from "../../config/load.js";
import { summarizeTelemetryFile } from "../../observability/telemetry.js";

// The commands of one area. Each entry says which command line it answers
// ('match') and what it does ('run'); src/cli/commands.js tries them in order.

export const opsCommands = [
  {
    match: ({ command, subcommand }) => command === "pipeline" && subcommand === "status",
    async run({ rest, values }) {
      const root = resolve(values.root);
      const config = await loadConfig(join(root, ".etnpilot", "etnpilot.yaml"));
      if (!config.git?.project) throw new Error("'git.project' is required to query pipelines.");
      const resolver = createSecretResolver({ root, config });
      const token = await resolver.get("gitlab.apiToken", {
        fallback: { provider: "env", key: "ETNPILOT_GITLAB_TOKEN" },
        baseUrl: config.git.baseUrl,
        required: true,
      });
      const client = new GitLabClient({ baseUrl: config.git.baseUrl, token });
      const ref = rest[0] ?? config.git.targetBranch ?? "main";
      const pipeline = latestPipeline(await client.pipelines(config.git.project, ref));
      console.log(JSON.stringify(pipeline ?? { ref, status: "none" }, null, 2));
      return pipeline === undefined || pipeline.status === "failed" ? 1 : 0;
    },
  },
  {
    match: ({ command, subcommand }) => command === "telemetry" && subcommand === "summary",
    async run({ rest, values }) {
      const root = resolve(values.root);
      const config = await loadConfig(join(root, ".etnpilot", "etnpilot.yaml"));
      const path = resolve(root, config.observability?.file ?? ".etnpilot/state/telemetry.jsonl");
      console.log(JSON.stringify(await summarizeTelemetryFile(path, { workflowRunId: rest[0] }), null, 2));
    },
  },
];
