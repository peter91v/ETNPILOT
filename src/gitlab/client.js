export class GitLabClient {
  constructor({ baseUrl, token, fetchImpl = globalThis.fetch, statusRetryDelayMs = 100 }) {
    if (!baseUrl) throw new TypeError("GitLab baseUrl is required.");
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.token = token;
    this.fetch = fetchImpl;
    this.statusRetryDelayMs = statusRetryDelayMs;
  }

  project(project) {
    return this.request("GET", `/projects/${encodeURIComponent(project)}`);
  }

  branches(project) {
    return this.request("GET", `/projects/${encodeURIComponent(project)}/repository/branches`);
  }

  createBranch(project, branch, ref = "main") {
    return this.request("POST", `/projects/${encodeURIComponent(project)}/repository/branches`, { branch, ref });
  }

  createMergeRequest(project, { sourceBranch, targetBranch = "main", title, description, draft = true }) {
    return this.request("POST", `/projects/${encodeURIComponent(project)}/merge_requests`, {
      source_branch: sourceBranch,
      target_branch: targetBranch,
      title: draft && !title.startsWith("Draft:") ? `Draft: ${title}` : title,
      description,
    });
  }

  mergeRequest(project, iid) {
    return this.request("GET", `/projects/${encodeURIComponent(project)}/merge_requests/${iid}`);
  }

  addMergeRequestNote(project, iid, body) {
    return this.request("POST", `/projects/${encodeURIComponent(project)}/merge_requests/${iid}/notes`, { body });
  }

  addIssueNote(project, iid, body) {
    return this.request("POST", `/projects/${encodeURIComponent(project)}/issues/${iid}/notes`, { body });
  }

  async setCommitStatus(project, sha, { state, name = "etnpilot", description, ref, targetUrl, pipelineId } = {}) {
    if (!sha) throw new TypeError("A commit SHA is required.");
    if (!["pending", "running", "success", "failed", "canceled", "skipped"].includes(state)) {
      throw new TypeError(`Unsupported GitLab commit status: '${state}'.`);
    }
    const body = {
      state,
      name,
      ...(description ? { description: description.slice(0, 255) } : {}),
      ...(ref ? { ref } : {}),
      ...(targetUrl ? { target_url: targetUrl } : {}),
      ...(pipelineId ? { pipeline_id: pipelineId } : {}),
    };
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.request("POST", `/projects/${encodeURIComponent(project)}/statuses/${encodeURIComponent(sha)}`, body);
      } catch (error) {
        if (!(error instanceof GitLabApiError) || error.status !== 409 || attempt === 3) throw error;
        await new Promise((resolve) => setTimeout(resolve, this.statusRetryDelayMs * attempt));
      }
    }
  }

  pipelines(project, ref) {
    return this.request("GET", `/projects/${encodeURIComponent(project)}/pipelines`, ref ? { ref } : undefined);
  }

  async request(method, path, body) {
    const url = new URL(`${this.baseUrl}/api/v4${path}`);
    const options = { method, headers: { accept: "application/json" } };
    if (this.token) options.headers["private-token"] = this.token;
    if (method === "GET" && body) {
      for (const [key, value] of Object.entries(body)) url.searchParams.set(key, value);
    } else if (body) {
      options.headers["content-type"] = "application/json";
      options.body = JSON.stringify(body);
    }
    const response = await this.fetch(url, options);
    if (!response.ok) {
      await response.text();
      throw new GitLabApiError(`GitLab API failed (${response.status}).`, {
        status: response.status,
      });
    }
    return response.status === 204 ? undefined : response.json();
  }
}

export class GitLabApiError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = "GitLabApiError";
    this.status = status;
    this.body = body;
  }
}
