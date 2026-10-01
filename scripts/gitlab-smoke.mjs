import { resolve } from "node:path";
import { GitLabClient } from "../src/gitlab/client.js";
import { runGitLabSmoke } from "../src/gitlab/smoke.js";

const env = process.env;
if (!env.ETNPILOT_SMOKE_GITLAB_URL || !env.ETNPILOT_SMOKE_GITLAB_PROJECT || !env.ETNPILOT_GITLAB_TOKEN) {
  console.error("GitLab smoke needs ETNPILOT_SMOKE_GITLAB_URL, ETNPILOT_SMOKE_GITLAB_PROJECT and ETNPILOT_GITLAB_TOKEN for a dedicated etnpilot-smoke project.");
  process.exitCode = 2;
} else {
  try {
    const report = await runGitLabSmoke({
      client: new GitLabClient({ baseUrl: env.ETNPILOT_SMOKE_GITLAB_URL, token: env.ETNPILOT_GITLAB_TOKEN }),
      project: env.ETNPILOT_SMOKE_GITLAB_PROJECT,
      receiptPath: resolve(`.etnpilot/state/gitlab-smoke-${Date.now()}.jsonl`),
      confirmWrites: process.argv.includes("--confirm-writes"),
    });
    console.log(JSON.stringify(report, null, 2));
    if (!report.pipelineVerified) process.exitCode = 3;
  } catch (error) {
    // Remote error bodies are deliberately not copied into smoke logs.
    console.error(`GitLab smoke failed (${error.status ?? error.code ?? "integration_error"}); inspect the dedicated project and receipt.`);
    process.exitCode = 1;
  }
}
