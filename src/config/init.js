import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const DEFAULT_CONFIG = `version: 1
defaultProvider: github-copilot
providers:
  github-copilot:
    type: github-copilot
    model: auto
git:
  host: gitlab
  baseUrl: https://gitlab.metropol-it.at
  remote: gitlab
  targetBranch: main
codegraph:
  database: .etnpilot/state/codegraph.sqlite
  autoIndex: true
  maxImpactDepth: 20
approval:
  allow: [read]
  requireHuman: [write, shell, network]
workspace:
  mode: worktree
  cleanup: never
workflow:
  concurrency: 1
  failFast: true
  timeoutMs: 1800000
  maxSteps: 50
`;

export async function initializeProject(root) {
  const configDir = join(root, ".etnpilot");
  await Promise.all([
    mkdir(join(configDir, "agents"), { recursive: true }),
    mkdir(join(configDir, "instructions"), { recursive: true }),
    mkdir(join(configDir, "plugins"), { recursive: true }),
    mkdir(join(configDir, "prompts"), { recursive: true }),
    mkdir(join(configDir, "skills"), { recursive: true }),
    mkdir(join(configDir, "state"), { recursive: true }),
    mkdir(join(configDir, "worktrees"), { recursive: true }),
  ]);
  await writeFile(join(configDir, "etnpilot.yaml"), DEFAULT_CONFIG, { encoding: "utf8", flag: "wx" })
    .catch((error) => {
      if (error.code !== "EEXIST") throw error;
    });
  return { root, configDir };
}
