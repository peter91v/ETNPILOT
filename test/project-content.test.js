import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initializeProject } from "../src/config/init.js";
import { loadConfig } from "../src/config/load.js";
import { createWorkflow, lockReviewedContent, readAgentDetails, readContentFile, readContentReview, readWorkflows } from "../src/runtime/project-content.js";
import { createReviewServer } from "../src/ui/server.js";

async function project() {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-content-"));
  await initializeProject(root, { forge: false, importExisting: false });
  const config = await loadConfig(join(root, ".etnpilot/etnpilot.yaml"), {});
  return { root, config };
}

test("a fresh project is all new; locking the digest that was shown makes it all locked", async () => {
  const { root, config } = await project();
  const before = await readContentReview({ root, config });
  assert.equal(before.lock.exists, false);
  assert.ok(before.items.length >= 2);
  assert.ok(before.items.every((item) => item.status === "new"));
  assert.equal(before.canLock, true);

  const after = await lockReviewedContent({ root, config, manifestDigest: before.manifestDigest });
  assert.ok(after.items.every((item) => item.status === "locked"));
  assert.equal(after.unreviewed, 0);
  assert.equal(after.canLock, false);
});

test("content that changed after it was shown is not locked", async () => {
  const { root, config } = await project();
  const shown = await readContentReview({ root, config });
  await writeFile(join(root, ".etnpilot/prompts/orchestrator.md"), "something nobody read\n");
  await assert.rejects(() => lockReviewedContent({ root, config, manifestDigest: shown.manifestDigest }), /changed since you opened it/);
  await assert.rejects(() => lockReviewedContent({ root, config, manifestDigest: "" }), /changed since/);
  assert.equal((await readContentReview({ root, config })).lock.exists, false, "nothing was locked");
});

test("after a lock: an edit shows as changed, a new file as new, a deleted one as removed", async () => {
  const { root, config } = await project();
  const first = await readContentReview({ root, config });
  await lockReviewedContent({ root, config, manifestDigest: first.manifestDigest });
  await writeFile(join(root, ".etnpilot/prompts/orchestrator.md"), "edited\n");
  await writeFile(join(root, ".etnpilot/instructions/new.md"), "new rule\n");
  const review = await readContentReview({ root, config });
  const status = Object.fromEntries(review.items.map((item) => [item.path, item.status]));
  assert.equal(status[".etnpilot/prompts/orchestrator.md"], "changed");
  assert.equal(status[".etnpilot/instructions/new.md"], "new");
  assert.equal(review.unreviewed, 2);
});

test("a file is read by its pinned path only", async () => {
  const { root, config } = await project();
  const found = await readContentFile({ root, config, path: ".etnpilot/prompts/orchestrator.md" });
  assert.match(found.content, /implement/);
  assert.equal(await readContentFile({ root, config, path: ".etnpilot/etnpilot.yaml" }), undefined);
  assert.equal(await readContentFile({ root, config, path: "../../etc/passwd" }), undefined);
  assert.equal(await readContentFile({ root, config, path: ".etnpilot/state/ui-token" }), undefined);
});

test("agents come with their prompt, tools, skills and who may call them", async () => {
  const { root, config } = await project();
  await writeFile(join(root, ".etnpilot/agents/worker.yaml"), "# Forged by AgentsForge from this repository. x\nname: worker\ndescription: Does it\npromptRef: worker\ntools: [read_file]\nsubagents: []\n");
  await writeFile(join(root, ".etnpilot/prompts/worker.md"), "You work.\n");
  await writeFile(join(root, ".etnpilot/agents/orchestrator.yaml"), "name: orchestrator\npromptRef: orchestrator\nsubagents: [worker]\ntools: [read_file, spawn_subagent]\n");
  const { agents } = await readAgentDetails({ root, config });
  const worker = agents.find((agent) => agent.name === "worker");
  assert.equal(worker.prompt.trim(), "You work.");
  assert.deepEqual(worker.tools, ["read_file"]);
  assert.deepEqual(worker.usedBy, ["orchestrator"]);
  assert.equal(worker.origin, "forged");
  assert.equal(worker.lock, "new");
  assert.equal(agents.find((agent) => agent.name === "orchestrator").tools.includes("spawn_subagent"), true);
});

test("a workflow made in the page is a file, validated against the agents, and unreviewed", async () => {
  const { root, config } = await project();
  const made = await createWorkflow({ root, config, input: { name: "Quick Look", steps: [{ id: "look", type: "agent", agent: "orchestrator" }] } });
  assert.equal(made.path, ".etnpilot/workflows/quick-look.yaml");
  assert.match(await readFile(join(root, made.path), "utf8"), /^# Created in the page/);
  const { workflows } = await readWorkflows({ root, config });
  assert.equal(workflows[0].name, "quick-look");
  assert.equal(workflows[0].lock, "new");
  assert.deepEqual(workflows[0].errors, []);

  await assert.rejects(() => createWorkflow({ root, config, input: { name: "quick-look", steps: [{ id: "a", type: "agent", agent: "orchestrator" }] } }), /already exists/);
  await assert.rejects(() => createWorkflow({ root, config, input: { name: "bad", steps: [{ id: "a", type: "agent", agent: "ghost" }] } }), /does not exist/);
});

test("the routes: review, read, lock, and a workflow created over HTTP", async () => {
  const { root } = await project();
  const review = await createReviewServer({ root });
  const address = await review.listen({ port: 0 });
  try {
    const call = (path, options = {}) => fetch(`http://127.0.0.1:${address.port}${path}`, { ...options, headers: { "x-etnpilot-token": review.token, "content-type": "application/json" } });
    const content = await (await call("/api/content")).json();
    assert.ok(content.items.length > 0);
    assert.equal((await call("/api/content/file?path=" + encodeURIComponent(content.items[0].path))).status, 200);
    assert.equal((await call("/api/content/file?path=" + encodeURIComponent("../secrets"))).status, 404);

    const stale = await call("/api/content/lock", { method: "POST", body: JSON.stringify({ manifestDigest: "nope" }) });
    assert.equal(stale.status, 409);
    const locked = await call("/api/content/lock", { method: "POST", body: JSON.stringify({ manifestDigest: content.manifestDigest }) });
    assert.equal(locked.status, 200);
    assert.equal((await locked.json()).unreviewed, 0);

    const created = await call("/api/workflows", { method: "POST", body: JSON.stringify({ name: "one", steps: [{ id: "a", type: "agent", agent: "orchestrator" }] }) });
    assert.equal(created.status, 201);
    const invalid = await call("/api/workflows", { method: "POST", body: JSON.stringify({ name: "two", steps: [] }) });
    assert.equal(invalid.status, 400);
    assert.ok((await invalid.json()).errors.length > 0);
    const list = await (await call("/api/workflows")).json();
    assert.deepEqual(list.workflows.map((workflow) => workflow.name), ["one"]);
    assert.equal(list.workflows[0].lock, "new");
  } finally {
    await review.close?.();
  }
});

test("the page has the Agents and Content views, the builder and the lock dialog", async () => {
  const { renderReviewPage } = await import("../src/ui/page.js");
  const html = renderReviewPage("t");
  for (const id of ["view-agents", "view-content", "workflow-modal", "file-modal", "lock-modal", "run-workflow"]) {
    assert.ok(html.includes(`id="${id}"`), id);
  }
  for (const name of ["renderAgents", "renderContent", "saveWorkflow", "confirmLock", "openContentFile", "loadProjectViews"]) {
    assert.ok(html.includes(`function ${name}`), name);
  }
  // The script still parses with them in it.
  const script = html.slice(html.indexOf("<script>") + 8, html.lastIndexOf("</script>"));
  assert.doesNotThrow(() => new Function(script));
});

test("an agent made in the page is written with the tools that were ticked, and no more", async () => {
  const { createAgent } = await import("../src/runtime/project-content.js");
  const { root, config } = await project();
  await mkdir(join(root, ".etnpilot/skills/release"), { recursive: true });
  await writeFile(join(root, ".etnpilot/skills/release/SKILL.md"), "---\nname: release\n---\nSteps\n");

  const made = await createAgent({ root, config, input: { name: "Doc Reader", description: "Reads docs", prompt: "You read the docs.", tools: ["read_file", "search_files"], skills: ["release"], subagents: ["orchestrator"], effort: "low" } });
  assert.equal(made.path, ".etnpilot/agents/doc-reader.yaml");
  const manifest = (await import("yaml")).default.parse(await readFile(join(root, made.path), "utf8"));
  assert.deepEqual(manifest.tools, ["read_file", "search_files", "load_skill", "spawn_subagent"]);
  assert.equal(manifest.effort, "low");
  assert.match(await readFile(join(root, made.promptPath), "utf8"), /read the docs/);

  // Ticking nothing is "only answers", written out; never "every tool".
  const none = await createAgent({ root, config, input: { name: "talker", prompt: "Answer.", tools: [] } });
  assert.deepEqual((await import("yaml")).default.parse(await readFile(join(root, none.path), "utf8")).tools, []);

  await assert.rejects(() => createAgent({ root, config, input: { name: "doc-reader", prompt: "x", tools: [] } }), /already exists/);
  const bad = await createAgent({ root, config, input: { name: "bad", prompt: "", tools: ["rm_rf"], skills: ["ghost"], subagents: ["nobody"], effort: "max" } }).catch((e) => e);
  assert.equal(bad.statusCode, 400);
  assert.ok(bad.details.errors.length >= 5, bad.details.errors.join(" | "));
});
