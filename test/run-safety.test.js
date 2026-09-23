import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { git } from "../src/git/command.js";
import { runProject } from "../src/runtime/project-runner.js";

const FAILING_CHECK = `[${JSON.stringify(process.execPath)}, -e, ${JSON.stringify("process.exit(3)")}]`;

test("a failed workflow is never published", async () => {
  const root = await createProject({
    steps: [
      "    - id: build",
      "      type: agent",
      "      agent: worker",
      "    - id: verify",
      "      type: check",
      `      command: ${FAILING_CHECK}`,
      "      needs: [build]",
    ],
    extra: ["workflow:", "  failFast: false", "  steps:"],
  });
  const apiCalls = [];

  const failure = await runProject({
    root,
    input: "do the work",
    publish: true,
    env: { ...process.env, ETNPILOT_GITLAB_TOKEN: "api-token" },
    providerFactories: { fake: fakeProviderFactory },
    fetchImpl: async (url) => {
      apiCalls.push(String(url));
      return new Response("{}", { status: 200 });
    },
  }).catch((error) => error);

  // fail-fast is off, so the engine returns a failed summary instead of throwing.
  assert.equal(failure instanceof Error, false);
  assert.equal(failure.summary.status, "failed");
  assert.equal(failure.status, "failed");
  assert.equal(failure.mergeRequest, undefined);
  assert.deepEqual(failure.publication, { published: false, reason: "workflow-not-succeeded" });
  assert.deepEqual(apiCalls, []);
});

test("checks do not inherit repository or provider credentials", async () => {
  const root = await createProject({
    steps: [
      "    - id: leak",
      "      type: check",
      `      command: [${JSON.stringify(process.execPath)}, -e, ${JSON.stringify(
        "require('fs').writeFileSync('env.json', JSON.stringify(process.env))",
      )}]`,
    ],
  });

  const result = await runProject({
    root,
    input: "inspect the environment",
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      ETNPILOT_GITLAB_TOKEN: "super-secret-token",
      AWS_SECRET_ACCESS_KEY: "another-secret",
    },
    providerFactories: { fake: fakeProviderFactory },
  });

  assert.equal(result.summary.status, "succeeded");
  const seen = JSON.parse(await readFile(join(result.workspace.path, "env.json"), "utf8"));
  assert.equal(seen.ETNPILOT_GITLAB_TOKEN, undefined);
  assert.equal(seen.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(seen.ETNPILOT_CHECK, "1");
  assert.equal(typeof seen.PATH, "string");
});

test("an uncommitted project configuration fails with guidance and leaves no worktree", async () => {
  const root = await createProject({ commit: false });

  const error = await runProject({
    root,
    input: "do the work",
    providerFactories: { fake: fakeProviderFactory },
  }).catch((failure) => failure);

  assert.match(error.message, /worktree has no '\.etnpilot\/etnpilot\.yaml'/);
  assert.equal(error.workspaceCleanup.removed, true);
  assert.equal(await worktreeCount(root), 1);
  assert.deepEqual(await runBranches(root), []);
});

test("an unknown workflow agent is reported before the run and cleans up", async () => {
  // No workflow section: the run falls back to the configured default agent.
  const root = await createProject({ agentName: "builder", defaultAgent: "orchestrator", steps: [], extra: [] });

  const error = await runProject({
    root,
    input: "do the work",
    providerFactories: { fake: fakeProviderFactory },
  }).catch((failure) => failure);

  assert.match(error.message, /Unknown workflow agent: 'orchestrator'\./);
  assert.match(error.message, /Configured agents: builder\./);
  assert.equal(error.workspaceCleanup.removed, true);
  assert.equal(await worktreeCount(root), 1);
  assert.deepEqual(await runBranches(root), []);
});

function fakeProviderFactory(name, _config, context) {
  return {
    name,
    async invoke(request) {
      await writeFile(join(context.workingDirectory, "result.txt"), String(request.input));
      return { text: "done", usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
}

async function createProject({
  steps = ["    - id: build", "      type: agent", "      agent: worker"],
  extra = ["workflow:", "  steps:"],
  agentName = "worker",
  defaultAgent = "worker",
  commit = true,
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-run-safety-"));
  await mkdir(join(root, ".etnpilot", "agents"), { recursive: true });
  await writeFile(join(root, ".gitignore"), ".etnpilot/state/\n.etnpilot/worktrees/\n");
  await writeFile(join(root, ".etnpilot", "agents", `${agentName}.yaml`), [
    `name: ${agentName}`,
    "provider: fake",
    "prompt: Do the work.",
    "",
  ].join("\n"));
  await writeFile(join(root, ".etnpilot", "etnpilot.yaml"), [
    "version: 1",
    `defaultAgent: ${defaultAgent}`,
    "providers:",
    "  fake:",
    "    type: fake",
    "git:",
    "  baseUrl: https://gitlab.example.invalid",
    "  project: group/project",
    "content:",
    "  provenance:",
    "    mode: off",
    "codegraph:",
    "  enabled: false",
    "observability:",
    "  enabled: false",
    ...extra,
    ...steps,
    "",
  ].join("\n"));
  await git(["init", "-b", "main"], { cwd: root });
  await git(["config", "user.email", "test@example.invalid"], { cwd: root });
  await git(["config", "user.name", "ETNPilot Test"], { cwd: root });
  await writeFile(join(root, "README.md"), "# fixture\n");
  await git(["add", commit ? "." : "README.md"], { cwd: root });
  await git(["commit", "-m", "initial"], { cwd: root });
  return root;
}

async function worktreeCount(root) {
  const { stdout } = await git(["worktree", "list", "--porcelain"], { cwd: root });
  return stdout.split("\n\n").filter(Boolean).length;
}

async function runBranches(root) {
  const { stdout } = await git(["branch", "--list", "etnpilot/*", "--format=%(refname:short)"], { cwd: root });
  return stdout.split("\n").filter(Boolean);
}
