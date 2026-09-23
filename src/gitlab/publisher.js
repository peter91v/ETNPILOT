import { git } from "../git/command.js";
import { GitLabClient } from "./client.js";

const DEFAULT_COMMITTER = Object.freeze({ name: "ETNPilot", email: "etnpilot@localhost" });

export class GitLabPublisher {
  constructor({ baseUrl, project, token, remote = "gitlab", committer, fetchImpl }) {
    if (!project) throw new TypeError("GitLab project is required.");
    if (!token) throw new Error("ETNPILOT_GITLAB_TOKEN is required for GitLab publishing.");
    this.project = project;
    this.remote = remote;
    this.committer = { ...DEFAULT_COMMITTER, ...(committer ?? {}) };
    this.client = new GitLabClient({ baseUrl, token, fetchImpl });
  }

  async publish({ cwd, branch, targetBranch = "main", title, description, receipt, receiptProof }) {
    const status = await git(["status", "--porcelain"], { cwd });
    if (!status.stdout) throw new Error("Nothing to publish: the worktree has no changes.");
    await git(["add", "--all"], { cwd });
    // Automated runs carry their own identity so publishing also works where
    // no user.name/user.email is configured, such as CI containers.
    await git([
      "-c", `user.name=${this.committer.name}`,
      "-c", `user.email=${this.committer.email}`,
      "commit", "-m", title,
    ], { cwd });
    await git(["push", "--set-upstream", this.remote, branch], { cwd });
    const mergeRequest = await this.client.createMergeRequest(this.project, {
      sourceBranch: branch,
      targetBranch,
      title,
      description,
      draft: true,
    });
    if (!receipt) return mergeRequest;
    const lines = [`ETNPilot verification receipt: \`${receipt}\``];
    if (receiptProof) {
      lines.push(`Signature: ${receiptProof.algorithm} with key \`${receiptProof.keyId}\``);
    }
    try {
      await this.client.addMergeRequestNote(this.project, mergeRequest.iid, lines.join("\n"));
    } catch (error) {
      // The branch and merge request already exist. Report the missing
      // evidence note instead of failing the run and leaving it half-done.
      return { ...mergeRequest, noteError: error.message, receipt };
    }
    return mergeRequest;
  }
}
