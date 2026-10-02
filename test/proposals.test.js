import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Harness } from "../src/core/harness.js";
import { git } from "../src/git/command.js";
import { GitLabPublisher } from "../src/gitlab/publisher.js";
import { describeProposals, validateProposal, writeProposals } from "../src/content/proposals.js";
import { createWorkspaceTools } from "../src/providers/workspace-tools.js";

// P4.4: what an agent learned is offered, never applied.

const good = { name: "testing.md", content: "Run npm test before pushing.", rationale: "Pushed twice with a red suite." };

test("a proposal must say what it is, where it goes and why", () => {
  assert.equal(validateProposal(good), undefined);
  assert.match(validateProposal({ ...good, name: "../escape.md" }), /name/);
  assert.match(validateProposal({ ...good, name: "/etc/x.md" }), /name/);
  assert.match(validateProposal({ ...good, name: "notes.txt" }), /name/);
  assert.match(validateProposal({ ...good, content: " " }), /content/);
  assert.match(validateProposal({ ...good, rationale: "" }), /rationale/);
});

test("the tool records a proposal and changes nothing", async () => {
  const harness = new Harness();
  harness.registerProvider({
    name: "p",
    async invoke(context) {
      const root = await mkdtemp(join(tmpdir(), "etn-prop-"));
      const tools = createWorkspaceTools({ workingDirectory: root });
      const first = await tools.invoke("propose_instruction", good, context);
      const twice = await tools.invoke("propose_instruction", good, context);
      const bad = await tools.invoke("propose_instruction", { ...good, name: "../x.md" }, context);
      return { text: JSON.stringify({ first, twice, bad }), root };
    },
  });
  harness.registerAgent({ name: "a", provider: "p", prompt: "x" });
  const receipt = await harness.run({ agent: "a", input: "go" });
  const { first, twice, bad } = JSON.parse(receipt.result.text);
  assert.equal(first.ok, true);
  assert.equal(first.applied, false);
  assert.equal(twice.ok, false);
  assert.equal(bad.ok, false);
  assert.equal(harness.proposals.length, 1);
  assert.equal(harness.proposals[0].agent, "a");
  // The run's own instructions are exactly what they were.
  assert.deepEqual(harness.instructions, []);
});

test("a proposal made after reading outside text says so", async () => {
  const harness = new Harness();
  harness.registerProvider({
    name: "p",
    async invoke(context) {
      context.taint("fetch_url example.test");
      const tools = createWorkspaceTools({ workingDirectory: tmpdir() });
      await tools.invoke("propose_instruction", good, context);
      return { text: "x" };
    },
  });
  harness.registerAgent({ name: "a", provider: "p", prompt: "x" });
  await harness.run({ agent: "a", input: "go" });
  assert.match(harness.proposals[0].tainted, /fetch_url/);
  assert.match(describeProposals(harness.proposals, { tainted: harness.proposals[0].tainted }), /stranger/);
});

test("the harness writes it under .etnpilot/proposals, marked as not applied", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "etn-prop-ws-"));
  const [path] = await writeProposals(workspace, [{ ...good, agent: "builder" }], "run-1");
  assert.equal(path, ".etnpilot/proposals/instructions/testing.md");
  const text = await readFile(join(workspace, path), "utf8");
  assert.match(text, /Not applied/);
  assert.match(text, /Pushed twice/);
  assert.match(text, /Run npm test before pushing\./);
});

test("published, it is a commit of its own, apart from the work", async () => {
  const remote = await mkdtemp(join(tmpdir(), "etn-remote-"));
  await git(["init", "--bare", "-b", "main"], { cwd: remote });
  const work = await mkdtemp(join(tmpdir(), "etn-work-"));
  await git(["init", "-b", "main"], { cwd: work });
  await git(["remote", "add", "gitlab", remote], { cwd: work });
  await writeFile(join(work, "a.txt"), "one");
  await git(["add", "."], { cwd: work });
  await git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "base"], { cwd: work });
  await git(["checkout", "-b", "etnpilot/x"], { cwd: work });

  await writeFile(join(work, "a.txt"), "two");
  await mkdir(join(work, "src"), { recursive: true });
  await writeFile(join(work, "src", "b.js"), "b");
  await writeProposals(work, [{ ...good, agent: "builder" }], "run-1");

  const calls = [];
  const publisher = new GitLabPublisher({
    baseUrl: "https://gitlab.example.invalid",
    project: "g/p",
    token: "t",
    fetchImpl: async (url, init) => {
      calls.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ iid: 1 }), { status: 201, headers: { "content-type": "application/json" } });
    },
  });
  await publisher.publish({
    cwd: work, branch: "etnpilot/x", title: "ETNPilot: do it", description: "d",
    proposalsPath: ".etnpilot/proposals",
  });
  const log = (await git(["log", "--format=%s", "main..HEAD"], { cwd: work })).stdout.split("\n");
  assert.equal(log.length, 2);
  assert.match(log[0], /proposed instruction changes/);
  assert.equal(log[1], "ETNPilot: do it");
  const proposalFiles = (await git(["show", "--name-only", "--format=", "HEAD"], { cwd: work })).stdout.split("\n");
  assert.deepEqual(proposalFiles, [".etnpilot/proposals/instructions/testing.md"]);
  const workFiles = (await git(["show", "--name-only", "--format=", "HEAD~1"], { cwd: work })).stdout.split("\n").sort();
  assert.deepEqual(workFiles, ["a.txt", "src/b.js"]);
});

test("the content lock does not see a proposal, so verification is unchanged until someone adopts one", async () => {
  const { captureProjectContent } = await import("../src/content/provenance.js");
  const root = await mkdtemp(join(tmpdir(), "etn-lock-"));
  await mkdir(join(root, ".etnpilot", "instructions"), { recursive: true });
  await writeFile(join(root, ".etnpilot", "instructions", "base.md"), "Keep diffs small.");
  const before = (await captureProjectContent(root)).manifest.digest;
  await writeProposals(root, [{ ...good, agent: "builder" }], "run-1");
  assert.equal((await captureProjectContent(root)).manifest.digest, before);
});

test("the token goes to git for the GitLab's own address only, and a remote that is another project is refused before anything is pushed", async () => {
  const { pushEnvironment, remoteMismatch } = await import("../src/gitlab/publisher.js");
  const env = pushEnvironment("https://git.example.test/", "glpat-secret", { PATH: "/bin" });
  assert.equal(env.GIT_CONFIG_KEY_0, "http.https://git.example.test/.extraHeader", "scoped to that address");
  assert.equal(Buffer.from(env.GIT_CONFIG_VALUE_0.split(" ").at(-1), "base64").toString(), "oauth2:glpat-secret");
  assert.equal(env.GIT_TERMINAL_PROMPT, "0", "nothing is asked on a terminal");
  assert.equal(JSON.stringify(env).includes("glpat-secret"), false, "the token itself is not in the environment in the clear");

  assert.match(remoteMismatch("https://git.example.test/g/other.git", "https://git.example.test", "g/p"), /points to 'g\/other' but git\.project is 'g\/p'/);
  assert.match(remoteMismatch("git@git.example.test:g/other.git", "https://git.example.test", "g/p"), /g\/other/);
  assert.equal(remoteMismatch("https://git.example.test/g/p.git", "https://git.example.test", "g/p"), undefined);
  assert.equal(remoteMismatch("https://oauth2:x@git.example.test/G/P", "https://git.example.test", "g/p"), undefined, "case and credentials in the address do not matter");
  assert.equal(remoteMismatch("/tmp/some/bare", "https://git.example.test", "g/p"), undefined, "a local path is not this check's business");
  assert.equal(remoteMismatch("https://elsewhere.test/g/other.git", "https://git.example.test", "g/p"), undefined, "nor is another host");

  const work = await mkdtemp(join(tmpdir(), "etn-mismatch-"));
  await git(["init", "-b", "main"], { cwd: work });
  await writeFile(join(work, "a.txt"), "one");
  await git(["add", "."], { cwd: work });
  await git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "base"], { cwd: work });
  await git(["remote", "add", "gitlab", "https://git.example.test/g/other.git"], { cwd: work });
  await writeFile(join(work, "a.txt"), "two");
  const publisher = new GitLabPublisher({ baseUrl: "https://git.example.test", project: "g/p", token: "t", fetchImpl: async () => { throw new Error("no request may be made"); } });
  await assert.rejects(publisher.publish({ cwd: work, branch: "main", title: "x", description: "d" }), /git remote points to 'g\/other'/);
  await git(["remote", "remove", "gitlab"], { cwd: work });
  await assert.rejects(publisher.publish({ cwd: work, branch: "main", title: "x", description: "d" }), /no git remote called 'gitlab'.*Add one: git remote add gitlab/);
  await git(["remote", "add", "upstream", "https://git.example.test/g/p.git"], { cwd: work });
  await assert.rejects(publisher.publish({ cwd: work, branch: "main", title: "x", description: "d" }), /The remotes here are: upstream\. Name the right one: etnpilot config set git\.remote upstream/);
});
