// @ts-check
import { git } from "../git/command.js";
import { GitLabClient } from "./client.js";

const DEFAULT_COMMITTER = Object.freeze({ name: "ETNPilot", email: "etnpilot@localhost" });

// The environment git is given to push to the GitLab: the token as a header for
// that one address, so it is sent to that host and no other, and nothing is
// asked on a terminal. It travels in the environment, not in the arguments,
// where every process of the user can read it. 'oauth2' is the user name GitLab
// takes for a token.
export function pushEnvironment(baseUrl, token, base = process.env) {
  const env = { ...base, GIT_TERMINAL_PROMPT: "0" };
  let origin;
  try { origin = new URL(baseUrl).origin; } catch { return env; }
  if (!origin.startsWith("https://") && !origin.startsWith("http://")) return env;
  const header = `Authorization: Basic ${Buffer.from(`oauth2:${token}`).toString("base64")}`;
  return { ...env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `http.${origin}/.extraHeader`, GIT_CONFIG_VALUE_0: header };
}

// Whether the remote is another project than the one the merge request is made
// in: a branch pushed to one and a merge request opened in the other is a branch
// in the wrong place and a merge request that cannot be made. Returns a sentence
// when they differ, nothing when they match or when the remote is not an address
// on this GitLab (a local path, another host), which is not this check's business.
export function remoteMismatch(remoteUrl, baseUrl, project) {
  if (!remoteUrl || !baseUrl || !project || /^\d+$/.test(String(project))) return undefined;
  let host;
  try { host = new URL(baseUrl).host; } catch { return undefined; }
  const web = /^https?:\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/i.exec(remoteUrl);
  const scp = /^(?:[^@]+@)?([^:/]+):(?!\/\/)(.+)$/.exec(remoteUrl);
  const match = web ?? scp;
  if (!match || match[1].toLowerCase() !== host.toLowerCase()) return undefined;
  const path = match[2].replace(/\.git$/i, "").replace(/\/+$/, "");
  if (path.toLowerCase() === String(project).toLowerCase()) return undefined;
  return `The git remote points to '${path}' but git.project is '${project}'. Point the remote at the project (git remote set-url <remote> ${web ? `${baseUrl.replace(/\/$/, "")}/${project}.git` : `<address of ${project}>`}) or git.project at the remote.`;
}

export class GitLabPublisher {
  constructor({ baseUrl, project, token, remote = "gitlab", committer, fetchImpl }) {
    if (!project) throw new TypeError("GitLab project is required.");
    if (!token) throw new Error("ETNPILOT_GITLAB_TOKEN is required for GitLab publishing.");
    this.baseUrl = baseUrl;
    this.token = token;
    this.project = project;
    this.remote = remote;
    this.committer = { ...DEFAULT_COMMITTER, ...(committer ?? {}) };
    this.client = new GitLabClient({ baseUrl, token, fetchImpl });
  }

  async publish({ cwd, branch, targetBranch = "main", title, description, receipt, receiptProof, proposalsPath }) {
    // Before anything is committed: a push to the wrong project, or to a remote
    // that is not there, is found out while nothing has happened yet.
    const remoteUrl = await git(["remote", "get-url", this.remote], { cwd }).then((result) => result.stdout, () => undefined);
    if (remoteUrl === undefined) {
      const names = (await git(["remote"], { cwd }).then((result) => result.stdout, () => "")).split("\n").filter(Boolean);
      throw new Error(`There is no git remote called '${this.remote}' in this worktree (git.remote is '${this.remote}'). `
        + (names.length > 0
          ? `The remotes here are: ${names.join(", ")}. Name the right one: etnpilot config set git.remote ${names[0]}`
          : `Add one: git remote add ${this.remote} <address of ${this.project}>.`));
    }
    const mismatch = remoteMismatch(remoteUrl, this.baseUrl, this.project);
    if (mismatch) throw new Error(mismatch);
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
    await git(["push", "--set-upstream", this.remote, branch], { cwd, env: pushEnvironment(this.baseUrl, this.token) });
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
