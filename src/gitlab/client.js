export class GitLabClient {
  constructor({ baseUrl, token, fetchImpl = globalThis.fetch }) {
    if (!baseUrl) throw new TypeError("GitLab baseUrl is required.");
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.token = token;
    this.fetch = fetchImpl;
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
    if (!response.ok) throw new Error(`GitLab API failed (${response.status}): ${await response.text()}`);
    return response.status === 204 ? undefined : response.json();
  }
}
