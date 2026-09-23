import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { git } from "../src/git/command.js";
import { rehearseMerge } from "../src/git/merge-rehearsal.js";
import { initializeProject, PROJECT_TEMPLATES, renderProjectConfig } from "../src/config/init.js";
import { loadConfig } from "../src/config/load.js";
import YAML from "yaml";

test("a merge rehearsal reports conflicts before a merge request exists", async () => {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-rehearsal-"));
  await git(["init", "-b", "main"], { cwd: root });
  await git(["config", "user.email", "test@example.invalid"], { cwd: root });
  await git(["config", "user.name", "ETNPilot Test"], { cwd: root });
  await writeFile(join(root, "shared.txt"), "base\n");
  await writeFile(join(root, "untouched.txt"), "stable\n");
  await git(["add", "."], { cwd: root });
  await git(["commit", "-m", "base"], { cwd: root });

  // A run branch that only touches its own file merges cleanly.
  await git(["checkout", "-b", "etnpilot/run-1"], { cwd: root });
  await writeFile(join(root, "added.txt"), "new\n");
  await git(["add", "."], { cwd: root });
  await git(["commit", "-m", "run"], { cwd: root });

  const clean = await rehearseMerge({ cwd: root, targetBranch: "main", fetch: false });
  assert.equal(clean.rehearsed, true);
  assert.equal(clean.clean, true);
  assert.deepEqual(clean.conflicts, []);

  // Now let both sides edit the same line.
  await git(["checkout", "main"], { cwd: root });
  await writeFile(join(root, "shared.txt"), "main change\n");
  await git(["commit", "-am", "main change"], { cwd: root });
  await git(["checkout", "etnpilot/run-1"], { cwd: root });
  await writeFile(join(root, "shared.txt"), "run change\n");
  await git(["commit", "-am", "run change"], { cwd: root });

  const conflicted = await rehearseMerge({ cwd: root, targetBranch: "main", fetch: false });
  assert.equal(conflicted.rehearsed, true);
  assert.equal(conflicted.clean, false);
  assert.deepEqual(conflicted.conflicts, ["shared.txt"]);

  // An unreachable remote is reported, never mistaken for a clean merge.
  const unfetchable = await rehearseMerge({ cwd: root, remote: "missing", targetBranch: "main" });
  assert.equal(unfetchable.rehearsed, false);
  assert.equal(unfetchable.reason, "fetch-failed");
});

test("project templates override the documented default and keep its comments", async () => {
  assert.deepEqual(Object.keys(PROJECT_TEMPLATES), ["default", "minimal", "regulated"]);
  assert.equal(renderProjectConfig("default"), renderProjectConfig());
  assert.throws(() => renderProjectConfig("unknown"), /Unknown project template 'unknown'/);

  const regulated = YAML.parse(renderProjectConfig("regulated"));
  assert.equal(regulated.receipts.signing.enabled, true);
  assert.equal(regulated.sandbox.enabled, true);
  assert.equal(regulated.git.issueTrigger.approvals.source, "gitlab");
  assert.deepEqual(regulated.supplyChain.licenses.allow, ["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC"]);
  // Untouched defaults stay as they are.
  assert.equal(regulated.policy.operations.default, "deny");
  assert.match(renderProjectConfig("regulated"), /# Required once enabled: only these GitLab users may start a run\./);

  const minimal = YAML.parse(renderProjectConfig("minimal"));
  assert.equal(minimal.codegraph.enabled, false);
  assert.equal(minimal.content.provenance.mode, "off");

  const root = await mkdtemp(join(tmpdir(), "etnpilot-template-"));
  const initialized = await initializeProject(root, { template: "minimal" });
  assert.equal(initialized.template, "minimal");
  assert.equal((await loadConfig(join(root, ".etnpilot", "etnpilot.yaml"))).observability.enabled, false);
});

test("merge-train inspection names the queued merge requests a branch collides with", async () => {
  const { inspectMergeTrain } = await import("../src/gitlab/merge-train.js");
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  // An "upstream" repository holding two queued merge requests.
  const upstream = await mkdtemp(join(tmpdir(), "etnpilot-train-upstream-"));
  await git(["init", "-b", "main"], { cwd: upstream });
  await git(["config", "user.email", "test@example.invalid"], { cwd: upstream });
  await git(["config", "user.name", "ETNPilot Test"], { cwd: upstream });
  await writeFile(join(upstream, "shared.txt"), "base\n");
  await writeFile(join(upstream, "other.txt"), "base\n");
  await git(["add", "."], { cwd: upstream });
  await git(["commit", "-m", "base"], { cwd: upstream });

  for (const [iid, file, content] of [[7, "shared.txt", "from mr 7\n"], [9, "other.txt", "from mr 9\n"]]) {
    await git(["checkout", "-q", "-b", `feature-${iid}`, "main"], { cwd: upstream });
    await writeFile(join(upstream, file), content);
    await git(["commit", "-qam", `mr ${iid}`], { cwd: upstream });
    // GitLab exposes merge-request heads under this ref namespace.
    await git(["update-ref", `refs/merge-requests/${iid}/head`, "HEAD"], { cwd: upstream });
  }
  await git(["checkout", "-q", "main"], { cwd: upstream });

  const local = await mkdtemp(join(tmpdir(), "etnpilot-train-local-"));
  await git(["clone", "-q", upstream, local], { cwd: upstream });
  await git(["config", "user.email", "test@example.invalid"], { cwd: local });
  await git(["config", "user.name", "ETNPilot Test"], { cwd: local });
  await git(["checkout", "-q", "-b", "etnpilot/run-1"], { cwd: local });
  await writeFile(join(local, "shared.txt"), "from the run\n");
  await git(["commit", "-qam", "run change"], { cwd: local });

  const client = {
    mergeRequests: async () => [
      { iid: 7, title: "Touches shared.txt\u0007", source_branch: "feature-7", web_url: "https://gitlab.invalid/mr/7" },
      { iid: 9, title: "Touches other.txt", source_branch: "feature-9", web_url: "https://gitlab.invalid/mr/9" },
      { iid: 11, title: "This run", source_branch: "etnpilot/run-1", web_url: "https://gitlab.invalid/mr/11" },
    ],
  };

  const report = await inspectMergeTrain({
    client,
    project: "group/project",
    cwd: local,
    remote: "origin",
    targetBranch: "main",
    ownBranch: "etnpilot/run-1",
  });

  assert.equal(report.inspected, true);
  // The run's own merge request is not compared against itself.
  assert.equal(report.queued, 2);
  assert.equal(report.clear, false);
  assert.equal(report.conflicts.length, 1);
  assert.deepEqual(
    { iid: report.conflicts[0].iid, files: report.conflicts[0].files, branch: report.conflicts[0].sourceBranch },
    { iid: 7, files: ["shared.txt"], branch: "feature-7" },
  );
  // Titles come from other people, so control characters are escaped.
  assert.equal(report.conflicts[0].title, "Touches shared.txt\\u{0007}");

  const unavailable = await inspectMergeTrain({
    client: { mergeRequests: async () => { throw new Error("401 Unauthorized"); } },
    project: "group/project",
    cwd: local,
    targetBranch: "main",
  });
  assert.equal(unavailable.inspected, false);
  assert.equal(unavailable.reason, "merge-requests-unavailable");
});
