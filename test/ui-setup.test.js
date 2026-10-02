import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { createProject } from "../src/runtime/first-run.js";
import { createSetupRoutes } from "../src/ui/setup-routes.js";
import { createReviewServer } from "../src/ui/server.js";

const run = promisify(execFile);

async function workdir() {
  const home = await mkdtemp(join(tmpdir(), "etn-uis-home-"));
  const root = await mkdtemp(join(tmpdir(), "etn-uis-repo-"));
  await run("git", ["-C", root, "init", "-q"]);
  const env = { ...process.env, ETNPILOT_HOME: home, GIT_CONFIG_GLOBAL: join(home, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1" };
  await createProject({ root, template: "minimal", forge: false });
  return { root, env };
}

const gitlabOk = async () => ({ ok: true, status: 200, json: async () => ({ username: "peter" }) });

test("the page reads what is ready and sets the provider and GitLab in one place", async () => {
  const { root, env } = await workdir();
  const handle = createSetupRoutes({ root, env, fetchImpl: gitlabOk });

  const first = await handle("GET", "/api/setup");
  assert.equal(first.status, 200);
  assert.equal(first.body.gitlab.connected, false);
  assert.equal(first.body.gitlab.baseUrl, undefined, "the placeholder address is not an answer");
  assert.ok(first.body.providers.options.some((option) => option.id === "anthropic"));

  assert.equal((await handle("POST", "/api/setup/provider", { id: "nope" })).status, 400);
  assert.equal((await handle("POST", "/api/setup/provider", { id: "anthropic" })).status, 200);
  assert.equal((await handle("GET", "/api/setup")).body.providers.current, "anthropic");

  const bad = await handle("POST", "/api/setup/gitlab", { host: "https://git.acme.test", project: "justone", token: "t" });
  assert.equal(bad.status, 400);
  const good = await handle("POST", "/api/setup/gitlab", { host: "https://git.acme.test", project: "varga/etnpilot-smoke", user: "peter", token: "glpat-ui-token-1" });
  assert.equal(good.status, 200);
  assert.doesNotMatch(JSON.stringify(good.body), /glpat-ui-token/, "the token is never sent back");
  const after = (await handle("GET", "/api/setup")).body.gitlab;
  assert.deepEqual([after.baseUrl, after.project, after.connected, after.helper], ["https://git.acme.test", "varga/etnpilot-smoke", true, true]);
  assert.equal(await handle("GET", "/api/elsewhere"), undefined);
});

test("the server only answers /api/setup with the token", async () => {
  const { root, env } = await workdir();
  const review = await createReviewServer({ root, env });
  try {
    const address = await review.listen({ port: 0 });
    const base = `http://127.0.0.1:${address.port}`;
    assert.equal((await fetch(`${base}/api/setup`)).status, 401);
    const answer = await fetch(`${base}/api/setup`, { headers: { "x-etnpilot-token": review.token } });
    assert.equal(answer.status, 200);
    assert.ok(Array.isArray((await answer.json()).providers.options));
  } finally {
    await review.close();
  }
});

test("saving a GitLab token on the Accounts page installs the helper in the project's repository", async () => {
  const { root, env } = await workdir();
  const { setSetting } = await import("../src/config/settings.js");
  await setSetting("git.baseUrl", "https://git.acme.test", { root, env, scope: "local" });
  const review = await createReviewServer({ root, env, fetchImpl: gitlabOk });
  try {
    const address = await review.listen({ port: 0 });
    const answer = await fetch(`http://127.0.0.1:${address.port}/api/auth/key`, {
      method: "POST",
      headers: { "x-etnpilot-token": review.token, "content-type": "application/json" },
      body: JSON.stringify({ service: "gitlab", value: "glpat-accounts-token-1" }),
    });
    assert.equal(answer.status, 200);
    assert.equal((await answer.json()).gitHelper, "git.acme.test");
    const { stdout } = await run("git", ["-C", root, "config", "--local", "--get-all", "credential.https://git.acme.test.helper"]);
    assert.match(stdout, / credential/);
  } finally {
    await review.close();
  }
});

test("the page drafts with a model, shows it, and writes only the draft it kept", async () => {
  const { root, env } = await workdir();
  const answer = { agents: [{ name: "doc-writer", description: "writes docs", tools: ["read_file", "write_file"], skills: [], prompt: "Write the docs." }], skills: [], instructions: [] };
  const review = await createReviewServer({ root, env, authorModel: async () => ({ text: JSON.stringify(answer), usage: {} }) });
  try {
    const address = await review.listen({ port: 0 });
    const call = (path, body) => fetch(`http://127.0.0.1:${address.port}${path}`, {
      method: "POST", headers: { "x-etnpilot-token": review.token, "content-type": "application/json" }, body: JSON.stringify(body),
    });
    assert.equal((await fetch(`http://127.0.0.1:${address.port}/api/author/draft`, { method: "POST" })).status, 401);
    const bad = await call("/api/author/draft", { mode: "new", kind: "agent", request: "" });
    assert.equal(bad.status, 400);
    const drafted = await (await call("/api/author/draft", { mode: "new", kind: "agent", request: "an agent for docs" })).json();
    assert.equal(drafted.text, "Write the docs.");
    await assert.rejects(readFile(join(root, ".etnpilot", "agents", "doc-writer.yaml"), "utf8"), /ENOENT/, "nothing is written by drafting");
    assert.deepEqual((await (await call("/api/author/items", { kind: "prompt" })).json()).names, ["orchestrator"]);
    assert.equal((await call("/api/author/items", { kind: "agent" })).status, 400);
    assert.equal((await call("/api/author/apply", { id: "made-up" })).status, 404);
    const applied = await (await call("/api/author/apply", { id: drafted.id })).json();
    assert.deepEqual(applied.written, [".etnpilot/agents/doc-writer.yaml"]);
    assert.match(await readFile(join(root, ".etnpilot", "prompts", "doc-writer.md"), "utf8"), /Write the docs/);
    assert.equal((await call("/api/author/apply", { id: drafted.id })).status, 404, "a draft is accepted once");
  } finally {
    await review.close();
  }
});

test("the agents route names the default provider and what each provider answers with", async () => {
  const { root, env } = await workdir();
  const review = await createReviewServer({ root, env });
  try {
    const address = await review.listen({ port: 0 });
    const answer = await (await fetch(`http://127.0.0.1:${address.port}/api/agents`, { headers: { "x-etnpilot-token": review.token } })).json();
    assert.equal(typeof answer.defaultProvider, "string");
    assert.ok(answer.providers.includes(answer.defaultProvider));
    assert.equal(typeof answer.providerInfo.anthropic.model, "string");
    assert.equal(answer.providerInfo.anthropic.type, "anthropic");
  } finally {
    await review.close();
  }
});
