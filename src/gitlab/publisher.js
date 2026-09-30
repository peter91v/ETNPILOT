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

  async publish({ cwd, branch, targetBranch = "main", title, description, receipt, receiptProof, proposalsPath }) {
    const status = await git(["status", "--porcelain"], { cwd });
    if (!status.stdout) throw new Error("Nothing to publish: the worktree has no changes.");
    // Automated runs carry their own identity so publishing also works where
    // no user.name/user.email is configured, such as CI containers.
    const commit = (message) => git([
      "-c", `user.name=${this.committer.name}`,
      "-c", `user.email=${this.committer.email}`,
      "commit", "-m", message,
    ], { cwd });
    // Suggested instruction changes travel in a commit of their own, apart
    // from the work, so a reviewer sees which is which and can drop one.
    await git(["add", "--all", "--", ".", ...(proposalsPath ? [`:(exclude)${proposalsPath}`] : [])], { cwd });
    const staged = await git(["diff", "--cached", "--quiet"], { cwd, allowExitCodes: [1] });
    if (staged.exitCode !== 0) await commit(title);
    if (proposalsPath) {
      await git(["add", "--all", "--", proposalsPath], { cwd });
      const proposed = await git(["diff", "--cached", "--quiet"], { cwd, allowExitCodes: [1] });
      if (proposed.exitCode !== 0) {
        await commit("ETNPilot: proposed instruction changes (not applied — read before adopting)");
      }
    }
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
