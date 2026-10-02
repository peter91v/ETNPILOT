import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createTerminalApprovalHandler } from "../src/core/terminal-approval.js";
import { git } from "../src/git/command.js";
import { runProject } from "../src/runtime/project-runner.js";

async function project(gateExtra = []) {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-gate-"));
  await mkdir(join(root, ".etnpilot", "agents"), { recursive: true });
  await writeFile(join(root, ".gitignore"), ".etnpilot/state/\n.etnpilot/worktrees/\n.codegraph/\n");
  await writeFile(join(root, ".etnpilot", "agents", "worker.yaml"), "name: worker\nprovider: fake\nprompt: Do it.\n");
  await writeFile(join(root, ".etnpilot", "etnpilot.yaml"), [
    "version: 1", "defaultAgent: worker", "providers:", "  fake:", "    type: fake",
    "content:", "  provenance:", "    mode: off", "codegraph:", "  enabled: false", "observability:", "  enabled: false",
    "workflow:", "  steps:", "    - id: plan", "      type: agent", "      agent: worker",
    "    - id: approve-plan", "      type: gate", "      needs: [plan]", ...gateExtra,
    "    - id: build", "      type: agent", "      agent: worker", "      needs: [approve-plan]", "",
  ].join("\n"));
  for (const args of [["init", "-b", "main"], ["config", "user.email", "t@example.invalid"], ["config", "user.name", "t"], ["add", "."], ["commit", "-m", "initial"]]) await git(args, { cwd: root });
  return root;
}

const PLAN = "## Plan\n1) hello.py\n\n## Offene Fragen\n- Wo soll hello.py liegen?\n- Welche Python-Version?\n";

function providers(inputs) {
  let calls = 0;
  return { fake: (name) => ({ name, invoke: async ({ input }) => { calls += 1; inputs.push(input); return { text: calls === 1 ? PLAN : "built" }; } }) };
}

test("a gate asks each open question on its own, then the plan, and the next step is told the answers", async () => {
  const root = await project();
  const requests = [];
  const inputs = [];
  const result = await runProject({
    root,
    input: "make hello.py",
    providerFactories: providers(inputs),
    approvalHandler: async (request) => {
      requests.push({ kind: request.kind, text: request.fullCommandText, position: request.toolArguments?.number, of: request.toolArguments?.of, diff: request.diff });
      if (request.kind === "question") return request.toolArguments.number === 1 ? { kind: "approve-once", answer: "im Repository-Root" } : { kind: "reject", reason: "Not answered." };
      return { kind: "approve-once" };
    },
  });
  assert.equal(result.summary.status, "succeeded");
  assert.deepEqual(requests.map((entry) => entry.kind), ["question", "question", "plan"]);
  assert.deepEqual(requests.slice(0, 2).map((entry) => [entry.position, entry.of]), [[1, 2], [2, 2]]);
  assert.match(requests[0].text, /Wo soll hello\.py liegen/);
  // The plan decision shows the answers beside the plan.
  assert.match(requests[2].diff, /Your answers to the open questions/);
  assert.match(requests[2].diff, /im Repository-Root/);
  assert.match(requests[2].diff, /\(not answered\)/);
  // And the step after the gate is told what was answered and what was not.
  const buildInput = inputs.at(-1);
  assert.match(buildInput, /Answers to the open questions/);
  assert.match(buildInput, /Answer: im Repository-Root/);
  assert.match(buildInput, /not answered; use your judgement/);
});

test("`questions: false` makes a gate the single decision it was", async () => {
  const root = await project(["      questions: false"]);
  const kinds = [];
  await runProject({
    root,
    input: "make hello.py",
    providerFactories: providers([]),
    approvalHandler: async (request) => { kinds.push(request.kind); return { kind: "approve-once" }; },
  });
  assert.deepEqual(kinds, ["plan"]);
});

function terminal(lines) {
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = true;
  output.isTTY = true;
  let shown = "";
  output.on("data", (chunk) => { shown += chunk; });
  const queue = [...lines];
  output.on("data", () => { if (queue.length > 0) setImmediate(() => input.write(`${queue.shift()}\n`)); });
  return { input, output, shown: () => shown };
}

test("in the terminal a question is answered with text, an empty line leaves it open, and an approval is still y/N", async () => {
  const io = terminal(["im Root", "", "y"]);
  const handler = createTerminalApprovalHandler({ input: io.input, output: io.output });
  const question = (number) => ({ kind: "question", fullCommandText: `Frage ${number}?`, toolArguments: { number, of: 2 } });
  assert.deepEqual(await handler(question(1), { agent: "approve-plan" }), { kind: "approve-once", answer: "im Root" });
  assert.deepEqual(await handler(question(2), { agent: "approve-plan" }), { kind: "reject", reason: "Not answered." });
  assert.deepEqual(await handler({ kind: "plan", fullCommandText: "Continue?" }, { agent: "approve-plan" }), { kind: "approve-once" });
  assert.match(io.shown(), /ETNPilot asks \(1 of 2\): Frage 1\?/);
  assert.match(io.shown(), /\(2 of 2\)/);
  assert.match(io.shown(), /Approve once\?/);
});
