import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { git } from "../src/git/command.js";
import { runProject } from "../src/runtime/project-runner.js";

// What a run leaves behind when it goes wrong at each stage. 'executeProject' is
// a long function with many ways out; these pin down what each one must do, so
// that it can be taken apart without changing any of them.

async function project(extra = []) {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-paths-"));
  await mkdir(join(root, ".etnpilot", "agents"), { recursive: true });
  await writeFile(join(root, ".gitignore"), ".etnpilot/state/\n.etnpilot/worktrees/\n.codegraph/\n");
  await writeFile(join(root, ".etnpilot", "agents", "worker.yaml"), "name: worker\nprovider: fake\nprompt: Do it.\n");
  await writeFile(join(root, ".etnpilot", "etnpilot.yaml"), [
    "version: 1", "defaultAgent: worker", "providers:", "  fake:", "    type: fake",
    "content:", "  provenance:", "    mode: off", "observability:", "  enabled: false", ...extra, "",
  ].join("\n"));
  for (const args of [["init", "-b", "main"], ["config", "user.email", "t@example.invalid"], ["config", "user.name", "t"], ["add", "."], ["commit", "-m", "initial"]]) await git(args, { cwd: root });
  return root;
}

const fake = (invoke = () => ({ text: "done" })) => ({ fake: (name) => ({ name, invoke }) });

async function receipts(root) {
  const directory = join(root, ".etnpilot", "state", "runs");
  const files = (await readdir(directory).catch(() => [])).filter((name) => name.endsWith(".jsonl"));
  return Promise.all(files.map(async (file) => (await readFile(join(directory, file), "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))));
}

// A code index that works, until it is asked about the impact of a change.
function indexThatFailsOnImpact(counts) {
  const graph = {
    sync: async () => ({ success: true, filesChecked: 1, filesAdded: 0, filesModified: 0, filesRemoved: 0, durationMs: 1 }),
    indexAll: async () => ({ success: true, filesIndexed: 1, filesSkipped: 0, filesErrored: 0, durationMs: 1 }),
    getStats: () => ({ fileCount: 1, nodeCount: 1, edgeCount: 0, dbSizeBytes: 1, walSizeBytes: 0, lastIndexedAt: Date.now(), filesByLanguage: { javascript: 1 } }),
    getIndexState: () => "ready",
    getFileDependents: () => { throw new Error("the index fell over while answering"); },
    close: () => { counts.closed += 1; },
  };
  return async () => ({ CodeGraph: { isInitialized: () => true, open: async () => graph, init: async () => graph } });
}

test("a run that fails while it is being finished still ends in a sealed receipt, and closes what it opened", async () => {
  const root = await project(["codegraph:", "  enabled: true"]);
  const counts = { closed: 0 };
  const changing = ({ metadata }) => writeFile(join(metadata.workspace, "changed.js"), "export const x = 1;\n").then(() => ({ text: "done" }));
  await assert.rejects(
    runProject({ root, input: "change a file", codegraphImporter: indexThatFailsOnImpact(counts), providerFactories: fake(changing) }),
    /the index fell over while answering/,
  );
  assert.equal(counts.closed >= 1, true, "the index was left open");
  const [chain] = await receipts(root);
  const last = chain.at(-1);
  assert.equal(last.terminal, true, "the receipt was left without an end");
  assert.equal(last.status, "failed");
  assert.match(JSON.stringify(last.summary), /the index fell over while answering/);
  assert.equal(last.phase, "finish");
});

test("a run whose workflow fails is sealed as failed and the error carries the run", async () => {
  const root = await project();
  const error = await runProject({ root, input: "x", providerFactories: fake(() => { throw new Error("the model refused"); }) }).then(() => undefined, (failure) => failure);
  assert.match(error.message, /the model refused/);
  assert.ok(error.run.receiptHash);
  const [chain] = await receipts(root);
  assert.equal(chain.at(-1).terminal, true);
  assert.equal(chain.at(-1).status, "failed");
});

test("a run that cannot be set up leaves no worktree and no receipt behind", async () => {
  const root = await project(["workflow:", "  steps:", "    - id: a", "      type: agent", "      agent: nobody"]);
  const error = await runProject({ root, input: "x", providerFactories: fake() }).then(() => undefined, (failure) => failure);
  assert.match(error.message, /Unknown workflow agent/);
  assert.ok(error.workspaceCleanup, "the discarded workspace is reported");
  assert.deepEqual(await readdir(join(root, ".etnpilot", "worktrees")).catch(() => []), [], JSON.stringify(error.workspaceCleanup));
  assert.equal((await receipts(root)).length, 0);
});

test("a dry run cannot publish, and says so before doing any work", async () => {
  const root = await project();
  await assert.rejects(runProject({ root, input: "x", dryRun: true, publish: true, providerFactories: fake() }), /dry run cannot publish/);
  assert.equal((await receipts(root)).length, 0);
});

test("a run that succeeds seals once, keeps its worktree by default and reports it", async () => {
  const root = await project();
  const result = await runProject({ root, input: "x", providerFactories: fake() });
  assert.equal(result.status, "succeeded");
  const [chain] = await receipts(root);
  assert.equal(chain.filter((entry) => entry.terminal).length, 1);
  assert.equal(chain.at(-1).terminal, true);
  assert.ok(result.workspace.managed);
  assert.equal(result.cleanup.removed ?? false, false);
});

test("a lock made after the last commit is explained: the worktree has the old one, and the files are named", async () => {
  const root = await project();
  const config = join(root, ".etnpilot", "etnpilot.yaml");
  await writeFile(config, (await readFile(config, "utf8")).replace("mode: off", "mode: enforce"));
  const { writeContentLock } = await import("../src/content/provenance.js");
  await writeContentLock(root, { content: { provenance: { mode: "enforce" } } });
  // An agent edited after the lock, and committed with the old lock.
  await writeFile(join(root, ".etnpilot", "agents", "worker.yaml"), "name: worker\nprovider: fake\nprompt: Do it differently.\n");
  await git(["add", "-A"], { cwd: root });
  await git(["commit", "-m", "edited after the lock"], { cwd: root });
  // Reviewed and locked again afterwards, but not committed.
  await writeContentLock(root, { content: { provenance: { mode: "enforce" } } });

  const error = await runProject({ root, input: "x", providerFactories: fake() }).then(() => undefined, (failure) => failure);
  assert.equal(error.code, "content-lock-mismatch");
  assert.match(error.message, /changed: .*worker/);
  assert.match(error.message, /starts from the last commit/);
  assert.match(error.message, /content-lock\.json/);
  assert.match(error.message, /git add \.etnpilot && git commit/);
});
