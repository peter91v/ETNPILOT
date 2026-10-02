import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
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
