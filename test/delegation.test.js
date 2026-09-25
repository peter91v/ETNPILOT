import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import YAML from "yaml";
import { createWorkspaceTools } from "../src/providers/workspace-tools.js";
import { createAnthropicProvider } from "../src/providers/anthropic.js";
import { Harness } from "../src/core/harness.js";
import { ApprovalPolicy } from "../src/core/approval-policy.js";
import { initializeProject } from "../src/config/init.js";
import { writeContentLock } from "../src/content/provenance.js";
import { loadConfig } from "../src/config/load.js";
import { runProject } from "../src/runtime/project-runner.js";
import { git } from "../src/git/command.js";

// P3: delegation that happens, a plan a person approves before anything is
// built, and a question the agent can actually ask.

test("an orchestrator delegates, and the harness's own limits still decide", async () => {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-spawn-"));
  const tools = createWorkspaceTools({ workingDirectory: root });
  const spawned = [];
  const context = {
    agent: { name: "orchestrator", subagents: ["builder"] },
    spawn: async (agent, task) => {
      spawned.push({ agent, task });
      if (agent !== "builder") throw new Error(`Agent 'orchestrator' may not spawn '${agent}'.`);
      return { result: { status: "succeeded", result: { text: "wrote it", toolCalls: [{ tool: "write_file", ok: true }] } } };
    },
  };

  const result = await tools.invoke("spawn_subagent", { agent: "builder", task: "write the file" }, context);
  assert.equal(result.ok, true);
  assert.equal(result.text, "wrote it");
  assert.deepEqual(spawned, [{ agent: "builder", task: "write the file" }]);

  // The cycle and depth checks live in the harness and are not repeated here;
  // what the tool must do is let the model read why it was refused.
  const refused = await tools.invoke("spawn_subagent", { agent: "reviewer", task: "look" }, context);
  assert.equal(refused.ok, false);
  assert.match(refused.error, /may not spawn 'reviewer'/);

  const empty = await tools.invoke("spawn_subagent", { agent: "builder", task: "  " }, context);
  assert.match(empty.error, /cannot see this conversation/);
});

test("the tool is offered only to an agent that has somebody to delegate to", async () => {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-spawn-offer-"));
  const bodies = [];
  const provider = createAnthropicProvider({
    apiKey: "k", tools: true, workingDirectory: root,
    fetchImpl: async (_url, options) => {
      bodies.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }] }), { status: 200 });
    },
  });
  const base = { input: "go", instructions: [], skills: [], approve: async () => ({ kind: "approve-once" }) };
  await provider.invoke({ ...base, agent: { name: "builder", prompt: "p" } });
  assert.equal(bodies[0].tools.some((tool) => tool.name === "spawn_subagent"), false);
  await provider.invoke({ ...base, agent: { name: "orchestrator", prompt: "p", subagents: ["builder"] } });
  assert.equal(bodies[1].tools.some((tool) => tool.name === "spawn_subagent"), true);
});

test("a gate stops the run until a person says the plan is right", async () => {
  // The planner writes nothing and the builder writes 'out.txt', so the file
  // is evidence of which side of the gate the run reached.
  const steps = [
    { id: "plan", type: "agent", agent: "planner" },
    { id: "approve-plan", type: "gate", needs: ["plan"] },
    { id: "build", type: "agent", agent: "orchestrator", needs: ["approve-plan"] },
  ];

  // Rejected: nothing after the gate runs, and the reason is the one given.
  const rejected = await scriptedProject(steps);
  const asked = [];
  const stopped = await runProject({
    root: rejected, input: "do it", worktree: false,
    approvalHandler: async (request) => {
      asked.push(request.kind);
      return request.kind === "plan" ? { kind: "reject", reason: "the plan is wrong" } : { kind: "approve-once" };
    },
  }).catch((error) => error);
  assert.match(stopped.message, /Stopped at 'approve-plan': the plan is wrong/);
  assert.equal(asked.includes("plan"), true, "the gate asked");
  // The build never happened: the file the scripted provider writes is absent.
  await assert.rejects(readFile(join(rejected, "out.txt"), "utf8"), /ENOENT/);

  // Approved: the rest of the run proceeds.
  const approved = await scriptedProject(steps);
  const finished = await runProject({
    root: approved, input: "do it", worktree: false,
    approvalHandler: async () => ({ kind: "approve-once" }),
  });
  assert.equal(finished.summary.status, "succeeded");
  assert.deepEqual(Object.keys(finished.summary.steps), ["plan", "approve-plan", "build"]);
  assert.equal(finished.summary.steps["approve-plan"].result.approved, true);
});

test("a gate cannot be waved through by settings, because then it is not a gate", async () => {
  // 'approval.allow' short-circuits an operation of that kind. A gate does not
  // go through the operation policy at all: it is a decision about the run.
  const harness = new Harness({ approvalPolicy: new ApprovalPolicy({ allow: ["plan", "question"] }) });
  const refused = await harness.requestDecision({ kind: "plan" });
  assert.equal(refused.kind, "reject");
  assert.match(refused.reason, /Nobody is available to answer/);

  const answered = new Harness({
    approvalPolicy: new ApprovalPolicy({ allow: ["plan"] }),
    approvalHandler: async () => ({ kind: "approve-once" }),
  });
  assert.equal((await answered.requestDecision({ kind: "plan" })).kind, "approve-once");
});

test("the agent can ask, and the answer is text rather than a permission", async () => {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-ask-"));
  const tools = createWorkspaceTools({ workingDirectory: root });
  const asked = [];
  const answered = await tools.invoke("ask_human", { question: "Which parser?", options: ["fast", "strict"] }, {
    agent: { name: "builder" },
    ask: async (request) => {
      asked.push(request);
      return { answered: true, text: "strict" };
    },
  });
  assert.equal(answered.ok, true);
  assert.equal(answered.answer, "strict");
  assert.deepEqual(asked[0].options, ["fast", "strict"]);

  // A question nobody answers ends the attempt with that as the reason, not
  // with a timeout nobody can interpret.
  const unanswered = await tools.invoke("ask_human", { question: "Anyone?" }, {
    agent: { name: "builder" },
    ask: async () => ({ answered: false, reason: "The question expired after 24 hours." }),
  });
  assert.equal(unanswered.ok, false);
  assert.match(unanswered.error, /expired after 24 hours/);

  // And it grants nothing: a write attempted afterwards is still decided.
  const writes = [];
  await tools.invoke("write_file", { path: "x.txt", content: "y" }, {
    agent: { name: "builder" },
    approve: async (request) => {
      writes.push(request.kind);
      return { kind: "reject", reason: "no" };
    },
  });
  assert.deepEqual(writes, ["write"], "the write asked on its own");
  await assert.rejects(readFile(join(root, "x.txt"), "utf8"), /ENOENT/);
});

test("what a person types when they approve is what the agent reads back", async () => {
  // There is no second field for an answer: the reason a person gives when
  // deciding is the answer, for a question, and a note for anything else.
  const { ApprovalInbox, createInboxApprovalHandler } = await import("../src/core/approval-inbox.js");
  const root = await mkdtemp(join(tmpdir(), "etnpilot-ask-inbox-"));
  const inbox = new ApprovalInbox(join(root, "approvals.sqlite"));
  const handler = createInboxApprovalHandler({ inbox, timeoutMs: 5000, pollIntervalMs: 10 });
  const pending = handler({ kind: "question", fullCommandText: "Which parser?" }, { runId: "r", agent: "builder" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const [record] = inbox.list({ status: "pending" });
  inbox.decide(record.id, "approved", { actor: "maintainer", reason: "use the strict one" });
  const decision = await pending;
  assert.equal(decision.kind, "approve-once");
  assert.equal(decision.answer, "use the strict one");
  assert.equal(decision.evidence.reason, "use the strict one");
  inbox.close();
});

async function scriptedProject(steps) {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-gate-"));
  await initializeProject(root);
  const file = join(root, ".etnpilot", "etnpilot.yaml");
  const document = YAML.parseDocument(await readFile(file, "utf8"));
  document.setIn(["providers", "scripted"], {
    type: "scripted",
    steps: [{ tool: "write_file", arguments: { path: "out.txt", content: "built\n" } }],
  });
  document.setIn(["providers", "planning"], { type: "scripted", steps: [], text: "Here is the plan." });
  document.setIn(["defaultProvider"], "scripted");
  const rules = document.getIn(["policy", "providers", "rules"]).toJSON();
  document.setIn(["policy", "providers", "rules"], rules.map((rule) => (rule.id === "configured-providers"
    ? { ...rule, providers: [...rule.providers, "scripted", "planning"] }
    : rule)));
  await writeFile(join(root, ".etnpilot", "agents", "planner.yaml"),
    "name: planner\npromptRef: orchestrator\nprovider: planning\nrequires: [chat]\n", "utf8");
  document.setIn(["workflow", "steps"], steps);
  await writeFile(file, String(document), "utf8");
  await git(["init", "--initial-branch=main", "."], { cwd: root });
  await git(["config", "user.email", "t@t"], { cwd: root });
  await git(["config", "user.name", "t"], { cwd: root });
  await git(["add", "-A"], { cwd: root });
  await git(["commit", "-m", "fixture"], { cwd: root });
  await writeContentLock(root, await loadConfig(file));
  return root;
}
