import assert from "node:assert/strict";
import { test } from "node:test";
import { GitLabClient } from "../src/gitlab/client.js";

test("GitLab client supports self-hosted project paths", async () => {
  const calls = [];
  const client = new GitLabClient({
    baseUrl: "https://gitlab.metropol-it.at/",
    token: "secret",
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return new Response(JSON.stringify({ iid: 7 }), { status: 201, headers: { "content-type": "application/json" } });
    },
  });
  const result = await client.createMergeRequest("varga.pter91/etnpilot", {
    sourceBranch: "feature/bootstrap",
    title: "Bootstrap",
  });
  assert.equal(result.iid, 7);
  assert.match(calls[0].url, /projects\/varga.pter91%2Fetnpilot\/merge_requests$/);
  assert.equal(calls[0].options.headers["private-token"], "secret");
  assert.match(calls[0].options.body, /Draft: Bootstrap/);
});

test("GitLab client sets external commit statuses", async () => {
  const calls = [];
  const client = new GitLabClient({
    baseUrl: "https://gitlab.example.invalid",
    token: "secret",
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return new Response(JSON.stringify({ status: "running" }), { status: 201 });
    },
  });
  await client.setCommitStatus("group/project", "abc123", {
    state: "running",
    name: "etnpilot/issue-7",
    ref: "main",
    targetUrl: "https://gitlab.example.invalid/group/project/-/issues/7",
  });
  assert.match(calls[0].url, /projects\/group%2Fproject\/statuses\/abc123$/);
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    state: "running",
    name: "etnpilot/issue-7",
    ref: "main",
    target_url: "https://gitlab.example.invalid/group/project/-/issues/7",
  });
});

test("GitLab client retries commit-status update conflicts", async () => {
  let calls = 0;
  const client = new GitLabClient({
    baseUrl: "https://gitlab.example.invalid",
    token: "secret",
    statusRetryDelayMs: 0,
    fetchImpl: async () => {
      calls += 1;
      return calls === 1
        ? new Response("update in progress", { status: 409 })
        : new Response(JSON.stringify({ status: "success" }), { status: 201 });
    },
  });
  const result = await client.setCommitStatus("group/project", "abc123", { state: "success" });
  assert.equal(result.status, "success");
  assert.equal(calls, 2);
});

test("GitLab client follows list pages and reports failures with context", async () => {
  const requested = [];
  const client = new GitLabClient({
    baseUrl: "https://gitlab.example.invalid",
    token: "secret",
    fetchImpl: async (url) => {
      requested.push(String(url));
      const page = Number(new URL(url).searchParams.get("page"));
      const body = page === 1
        ? Array.from({ length: 100 }, (_, index) => ({ name: `branch-${index}` }))
        : [{ name: "branch-100" }];
      return new Response(JSON.stringify(body), { status: 200 });
    },
  });

  const branches = await client.branches("group/project");
  assert.equal(branches.length, 101);
  assert.equal(requested.length, 2);
  assert.match(requested[0], /per_page=100&page=1$/);

  const failing = new GitLabClient({
    baseUrl: "https://gitlab.example.invalid",
    token: "secret",
    fetchImpl: async () => new Response(JSON.stringify({ message: "404 Project Not Found" }), { status: 404 }),
  });
  await assert.rejects(
    () => failing.project("group/missing"),
    /GitLab API failed \(404\): 404 Project Not Found/,
  );
});

test("GitLab client reports request timeouts", async () => {
  const client = new GitLabClient({
    baseUrl: "https://gitlab.example.invalid",
    token: "secret",
    timeoutMs: 5,
    fetchImpl: (url, options) => new Promise((_, reject) => {
      // Keeps the loop alive until the request signal fires.
      const keepAlive = setTimeout(() => reject(new Error("signal never fired")), 1000);
      options.signal.addEventListener("abort", () => {
        clearTimeout(keepAlive);
        reject(options.signal.reason);
      }, { once: true });
    }),
  });
  await assert.rejects(() => client.project("group/project"), /timed out after 5 ms/);
});
