import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { git } from "../src/git/command.js";
import { runProject } from "../src/runtime/project-runner.js";
import { loadFixtures } from "../src/runtime/fixtures.js";

test("a recorded run replays offline and notices a stale fixture", async () => {
  const root = await createProject();
  let providerCalls = 0;
  const factories = {
    fake: (name) => ({
      name,
      async invoke(context) {
        providerCalls += 1;
        await writeFile(join(context.metadata.workspace, "result.txt"), "written");
        return { text: `answer for ${context.input}`, usage: { inputTokens: 5, outputTokens: 2 } };
      },
    }),
  };

  const recorded = await runProject({
    root,
    input: "do the work",
    recordFixtures: ".etnpilot/state/fixtures/run.json",
    providerFactories: factories,
  });
  assert.equal(recorded.summary.status, "succeeded");
  assert.equal(providerCalls, 1);
  assert.equal(recorded.fixtures.mode, "recorded");
  assert.equal(recorded.fixtures.exchanges, 1);

  const document = await loadFixtures(join(root, ".etnpilot", "state", "fixtures", "run.json"));
  assert.equal(document.redacted, true);
  assert.equal(document.exchanges[0].agent, "worker");
  assert.equal(document.exchanges[0].result.text, "answer for do the work");

  // Replaying needs no provider at all.
  const replayed = await runProject({
    root,
    input: "do the work",
    fixtures: ".etnpilot/state/fixtures/run.json",
    providerFactories: {},
  });
  assert.equal(replayed.summary.status, "succeeded");
  assert.equal(replayed.summary.steps.build.result.result.text, "answer for do the work");
  assert.equal(providerCalls, 1, "the provider was not called again");
  assert.deepEqual(replayed.fixtures, { mode: "replayed", exchanges: 1, unusedExchanges: 0 });

  // A different task means the recording no longer describes this run.
  const stale = await runProject({
    root,
    input: "something else",
    fixtures: ".etnpilot/state/fixtures/run.json",
    providerFactories: {},
  }).catch((error) => error);
  assert.match(stale.message, /does not match this run/);
});

test("recorded fixtures are redacted before they are written", async () => {
  const root = await createProject();
  await runProject({
    root,
    input: "do the work",
    recordFixtures: "fixtures.json",
    providerFactories: {
      fake: (name) => ({
        name,
        invoke: async () => ({
          text: "Set API_TOKEN=s3cr3t-value-not-for-sharing to continue.",
          raw: { prompt: "the full prompt" },
        }),
      }),
    },
  });

  const written = await readFile(join(root, "fixtures.json"), "utf8");
  assert.match(written, /API_TOKEN=\[redacted\]/);
  assert.doesNotMatch(written, /s3cr3t-value-not-for-sharing/);
  // The untouched provider payload is dropped rather than shipped.
  assert.doesNotMatch(written, /the full prompt/);
});

async function createProject() {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-fixtures-"));
  await mkdir(join(root, ".etnpilot", "agents"), { recursive: true });
  await writeFile(join(root, ".gitignore"), ".etnpilot/state/\n.etnpilot/worktrees/\n");
  await writeFile(join(root, ".etnpilot", "agents", "worker.yaml"), [
    "name: worker",
    "provider: fake",
    "prompt: Do the work.",
    "",
  ].join("\n"));
  await writeFile(join(root, ".etnpilot", "etnpilot.yaml"), [
    "version: 1",
    "defaultAgent: worker",
    "providers:",
    "  fake:",
    "    type: fake",
    "content:",
    "  provenance:",
    "    mode: off",
    "codegraph:",
    "  enabled: false",
    "observability:",
    "  enabled: false",
    "workflow:",
    "  steps:",
    "    - id: build",
    "      type: agent",
    "      agent: worker",
    "",
  ].join("\n"));
  await git(["init", "-b", "main"], { cwd: root });
  await git(["config", "user.email", "test@example.invalid"], { cwd: root });
  await git(["config", "user.name", "ETNPilot Test"], { cwd: root });
  await git(["add", "."], { cwd: root });
  await git(["commit", "-m", "initial"], { cwd: root });
  return root;
}
