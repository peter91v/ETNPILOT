export class GitLabClient {
  constructor({ baseUrl, token, fetchImpl = globalThis.fetch, statusRetryDelayMs = 100, timeoutMs = 30_000 }) {
    if (!baseUrl) throw new TypeError("GitLab baseUrl is required.");
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new TypeError("GitLab timeoutMs must be positive.");
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.token = token;
    this.fetch = fetchImpl;
    this.statusRetryDelayMs = statusRetryDelayMs;
    this.timeoutMs = timeoutMs;
  }

  project(project) {
    return this.request("GET", `/projects/${encodeURIComponent(project)}`);
  }

  branches(project) {
    return this.requestAll("GET", `/projects/${encodeURIComponent(project)}/repository/branches`);
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

  issueNotes(project, iid, { sort = "desc", orderBy = "created_at", perPage = 100 } = {}) {
    return this.requestAll(
      "GET",
      `/projects/${encodeURIComponent(project)}/issues/${iid}/notes`,
      { sort, order_by: orderBy },
      { perPage },
    );
  }

  mergeRequestApprovals(project, iid) {
    return this.request("GET", `/projects/${encodeURIComponent(project)}/merge_requests/${iid}/approvals`);
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
    return this.requestAll("GET", `/projects/${encodeURIComponent(project)}/pipelines`, ref ? { ref } : undefined);
  }

  // GitLab caps list responses, so collection endpoints follow their pages
  // instead of silently returning only the first one.
  async requestAll(method, path, query, { perPage = 100, maxPages = 20 } = {}) {
    const collected = [];
    for (let page = 1; page <= maxPages; page += 1) {
      const batch = await this.request(method, path, { ...(query ?? {}), per_page: perPage, page });
      if (!Array.isArray(batch)) return batch;
      collected.push(...batch);
      if (batch.length < perPage) break;
    }
    return collected;
  }

  async request(method, path, body) {
    const url = new URL(`${this.baseUrl}/api/v4${path}`);
    const options = {
      method,
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(this.timeoutMs),
    };
    if (this.token) options.headers["private-token"] = this.token;
    if (method === "GET" && body) {
      for (const [key, value] of Object.entries(body)) url.searchParams.set(key, value);
    } else if (body) {
      options.headers["content-type"] = "application/json";
      options.body = JSON.stringify(body);
    }
    let response;
    try {
      response = await this.fetch(url, options);
    } catch (error) {
      throw new GitLabApiError(
        error?.name === "TimeoutError"
          ? `GitLab API request timed out after ${this.timeoutMs} ms.`
          : `GitLab API request failed: ${error?.message ?? error}.`,
        { cause: error },
      );
    }
    if (!response.ok) {
      const detail = await describeError(response);
      throw new GitLabApiError(`GitLab API failed (${response.status})${detail ? `: ${detail}` : "."}`, {
        status: response.status,
        body: detail,
      });
    }
    return response.status === 204 ? undefined : response.json();
  }
}

// GitLab error bodies name the failing resource, which is what an operator
// needs. They are bounded and stripped of control characters before display.
async function describeError(response) {
  try {
    const text = await response.text();
    if (!text) return undefined;
    let message = text;
    try {
      const parsed = JSON.parse(text);
      message = parsed?.message ?? parsed?.error ?? text;
    } catch {
      // A non-JSON body is reported as-is.
    }
    return String(typeof message === "string" ? message : JSON.stringify(message))
      .replaceAll(/[\p{Cc}\p{Cf}]/gu, " ")
      .trim()
      .slice(0, 200);
  } catch {
    return undefined;
  }
}

export class GitLabApiError extends Error {
  constructor(message, { status, body, cause } = {}) {
    super(message, { cause });
    this.name = "GitLabApiError";
    this.status = status;
    this.body = body;
  }
}
