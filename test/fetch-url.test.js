import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createWorkspaceTools, WORKSPACE_TOOL_DEFINITIONS } from "../src/providers/workspace-tools.js";
import { ApprovalPolicy } from "../src/core/approval-policy.js";
import { PolicyEngine } from "../src/policy/engine.js";

// P1.4: the agent can read documentation. The project has had a network rule
// with a host list since the beginning and nothing that ever asked for it.
//
// It lands after P1.6 on purpose: this is the tool that brings text nobody in
// the project wrote into the model's context.

const workspace = async (fetchImpl) => createWorkspaceTools({
  workingDirectory: await mkdtemp(join(tmpdir(), "etnpilot-fetch-")),
  fetchImpl,
});

const approver = (recorder) => ({
  agent: { name: "builder" },
  approve: async (request) => {
    recorder?.push(request);
    return { kind: "approve-once" };
  },
});

test("a page is fetched as text, and the run records where it came from", async () => {
  const tools = await workspace(async () => new Response("# API\nuse the thing", {
    status: 200, headers: { "content-type": "text/markdown" },
  }));
  const requests = [];
  const result = await tools.invoke("fetch_url", { url: "https://docs.example/api" }, approver(requests));
  assert.equal(result.ok, true);
  assert.match(result.content, /use the thing/);
  assert.equal(result.url, "https://docs.example/api");

  // The decision the policy sees is a network one, with the URL — which is
  // what 'approved-network-targets' has always been written against.
  assert.equal(requests[0].kind, "network");
  assert.equal(requests[0].url, "https://docs.example/api");
  assert.equal(requests[0].toolName, "fetch_url");
});

test("the project's own host list decides, before anything leaves the machine", async () => {
  // The rule that has been in the shipped configuration all along.
  const policy = new PolicyEngine({
    operations: {
      default: "deny",
      rules: [{ id: "approved-network-targets", effect: "human", kinds: ["network"], hosts: ["docs.example"] }],
    },
  });
  const approval = new ApprovalPolicy({ allow: [], requireHuman: ["network"] }, { policy });

  let reached = false;
  const tools = await workspace(async () => {
    reached = true;
    return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
  });
  const decide = async (request) => {
    const decision = await approval.evaluate(request, { agent: "builder" });
    // A denied host never becomes a question for a person, and never a request:
    // the policy refuses it before the tool is allowed to reach the network.
    return decision.kind === "reject" ? decision : { kind: "approve-once" };
  };

  const refused = await tools.invoke("fetch_url", { url: "https://evil.example/x" }, { agent: { name: "builder" }, approve: decide });
  assert.equal(refused.ok, false);
  assert.equal(reached, false, "nothing left the machine");

  const allowed = await tools.invoke("fetch_url", { url: "https://docs.example/x" }, { agent: { name: "builder" }, approve: decide });
  assert.equal(allowed.ok, true);
  assert.equal(reached, true);
});

test("a redirect to another host is a second decision, not a free pass", async () => {
  const tools = await workspace(async (url) => (url === "https://docs.example/a"
    ? new Response("", { status: 302, headers: { location: "https://elsewhere.example/b" } })
    : new Response("arrived", { status: 200, headers: { "content-type": "text/plain" } })));
  const requests = [];
  const result = await tools.invoke("fetch_url", { url: "https://docs.example/a" }, approver(requests));

  assert.deepEqual(requests.map((request) => new URL(request.url).host), ["docs.example", "elsewhere.example"]);
  // The second request says where it came from, so the person deciding can
  // see that an approved host handed them off.
  assert.equal(requests[1].toolArguments.redirectedFrom, "https://docs.example/a");
  assert.deepEqual(result.redirects, ["https://docs.example/a"]);

  // Refusing the second one stops it, even though the first was approved.
  const stopped = await tools.invoke("fetch_url", { url: "https://docs.example/a" }, {
    agent: { name: "builder" },
    approve: async (request) => (new URL(request.url).host === "docs.example"
      ? { kind: "approve-once" }
      : { kind: "reject", reason: "not that host" }),
  });
  assert.equal(stopped.ok, false);
});

test("only text, only http, and bounded", async () => {
  const image = await workspace(async () => new Response("bytes", { status: 200, headers: { "content-type": "image/png" } }));
  assert.match((await image.invoke("fetch_url", { url: "https://docs.example/i.png" }, approver())).error, /only text can be read/);

  const tools = await workspace(async () => new Response("x", { status: 200, headers: { "content-type": "text/plain" } }));
  assert.match((await tools.invoke("fetch_url", { url: "ftp://docs.example/f" }, approver())).error, /Only http and https/);
  assert.match((await tools.invoke("fetch_url", { url: "not a url" }, approver())).error, /is not a URL/);

  const huge = createWorkspaceTools({
    workingDirectory: await mkdtemp(join(tmpdir(), "etnpilot-fetch-big-")),
    limits: { maxFetchBytes: 10 },
    fetchImpl: async () => new Response("x".repeat(1000), { status: 200, headers: { "content-type": "text/plain" } }),
  });
  const cut = await huge.invoke("fetch_url", { url: "https://docs.example/big" }, approver());
  assert.equal(cut.truncated, true);
  assert.equal(cut.content.length, 10);

  const looping = createWorkspaceTools({
    workingDirectory: await mkdtemp(join(tmpdir(), "etnpilot-fetch-loop-")),
    fetchImpl: async () => new Response("", { status: 302, headers: { location: "https://docs.example/again" } }),
  });
  assert.match((await looping.invoke("fetch_url", { url: "https://docs.example/a" }, approver())).error, /Too many redirects/);
});

test("it is offered only to an agent whose manifest names it", async () => {
  const tools = createWorkspaceTools({
    workingDirectory: await mkdtemp(join(tmpdir(), "etnpilot-fetch-priv-")),
    allowed: ["read_file"],
    fetchImpl: async () => new Response("x", { status: 200, headers: { "content-type": "text/plain" } }),
  });
  assert.equal(tools.definitions.some((definition) => definition.name === "fetch_url"), false);
  const refused = await tools.invoke("fetch_url", { url: "https://docs.example/x" }, approver());
  assert.equal(refused.refused, "not-allowed");

  const definition = WORKSPACE_TOOL_DEFINITIONS.find((entry) => entry.name === "fetch_url");
  assert.match(definition.description, /policy allows/);
  assert.match(definition.description, /never instructions/);
});
