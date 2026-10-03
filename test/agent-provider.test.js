import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAgent, updateAgent } from "../src/runtime/project-content.js";
import { createReviewServer } from "../src/ui/server.js";

const config = { providers: { alpha: { type: "openai-compatible", model: "alpha-model" }, beta: { type: "anthropic", model: "beta-model" } } };

async function project() {
  const root = await mkdtemp(join(tmpdir(), "etn-agent-provider-"));
  await mkdir(join(root, ".etnpilot", "agents"), { recursive: true });
  await writeFile(join(root, ".etnpilot", "etnpilot.yaml"), "version: 1\ndefaultProvider: alpha\nproviders:\n  alpha: { type: openai-compatible, baseUrl: 'http://127.0.0.1:9/v1', model: alpha-model }\n  beta: { type: anthropic, model: beta-model }\ncontent:\n  provenance:\n    mode: enforce\ncodegraph:\n  enabled: false\nobservability:\n  enabled: false\n");
  return root;
}

test("an agent made in the page can name its provider and model; empty means the project's own", async () => {
  const root = await project();
  await createAgent({ root, config, input: { name: "a1", prompt: "Do it.", provider: "beta", model: "beta-big", tools: ["read_file"] } });
  const manifest = await readFile(join(root, ".etnpilot", "agents", "a1.yaml"), "utf8");
  assert.match(manifest, /provider: beta/);
  assert.match(manifest, /model: beta-big/);

  await updateAgent({ root, config, name: "a1", input: { provider: "", model: "" } });
  const cleared = await readFile(join(root, ".etnpilot", "agents", "a1.yaml"), "utf8");
  assert.doesNotMatch(cleared, /provider:|model:/);
  assert.match(cleared, /name: a1/, "the rest is kept");

  await updateAgent({ root, config, name: "a1", input: { provider: "alpha" } });
  assert.match(await readFile(join(root, ".etnpilot", "agents", "a1.yaml"), "utf8"), /provider: alpha/);
  await updateAgent({ root, config, name: "a1", input: { description: "only the description" } });
  assert.match(await readFile(join(root, ".etnpilot", "agents", "a1.yaml"), "utf8"), /provider: alpha/, "an update that does not mention it leaves it");

  await assert.rejects(createAgent({ root, config, input: { name: "a2", prompt: "x", provider: "nope" } }), /not a provider of this project/);
  await assert.rejects(createAgent({ root, config, input: { name: "a3", prompt: "x", model: "bad model!" } }), /not a model id/);
  await assert.rejects(updateAgent({ root, config, name: "a1", input: { provider: "ghost" } }), /not a provider/);
});

test("a run started from the page can change provider, model and effort for its agent, and only to what is valid", async () => {
  const root = await project();
  const review = await createReviewServer({ root });
  try {
    const address = await review.listen({ port: 0 });
    const start = (body) => fetch(`http://127.0.0.1:${address.port}/api/runs/start`, {
      method: "POST", headers: { "x-etnpilot-token": review.token, "content-type": "application/json" }, body: JSON.stringify({ task: "t", worktree: false, ...body }),
    });
    for (const [body, pattern] of [
      [{ agent: "orchestrator", provider: "ghost" }, /not a provider of this project/],
      [{ agent: "orchestrator", model: "bad model!" }, /not a model id/],
      [{ agent: "orchestrator", effort: "max" }, /low, medium or high/],
    ]) {
      const answer = await start(body);
      assert.equal(answer.status, 400);
      assert.match((await answer.json()).error, pattern);
    }
  } finally {
    await review.close();
  }
});
