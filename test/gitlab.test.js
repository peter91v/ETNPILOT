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
