import { git } from "../git/command.js";
import { GitLabClient } from "./client.js";

export class GitLabPublisher {
  constructor({ baseUrl, project, token, remote = "gitlab", fetchImpl }) {
    if (!project) throw new TypeError("GitLab project is required.");
    if (!token) throw new Error("ETNPILOT_GITLAB_TOKEN is required for GitLab publishing.");
    this.project = project;
    this.remote = remote;
    this.client = new GitLabClient({ baseUrl, token, fetchImpl });
  }

  async publish({ cwd, branch, targetBranch = "main", title, description, receipt, receiptProof }) {
    const status = await git(["status", "--porcelain"], { cwd });
    if (!status.stdout) throw new Error("Nothing to publish: the worktree has no changes.");
    await git(["add", "--all"], { cwd });
    await git(["commit", "-m", title], { cwd });
    await git(["push", "--set-upstream", this.remote, branch], { cwd });
    const mergeRequest = await this.client.createMergeRequest(this.project, {
      sourceBranch: branch,
      targetBranch,
      title,
      description,
      draft: true,
    });
    if (receipt) {
      const lines = [`ETNPilot verification receipt: \`${receipt}\``];
      if (receiptProof) {
        lines.push(`Signature: ${receiptProof.algorithm} with key \`${receiptProof.keyId}\``);
      }
      await this.client.addMergeRequestNote(
        this.project,
        mergeRequest.iid,
        lines.join("\n"),
      );
    }
    return mergeRequest;
  }
}
