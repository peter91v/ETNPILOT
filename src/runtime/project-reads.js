import { GitLabClient } from "../gitlab/client.js";
import { RUN_BRANCH_PREFIX } from "./project-runner.js";
import { WorktreeManager } from "../git/worktrees.js";
import YAML from "yaml";
import { createSecretResolver } from "../secrets/resolver.js";
import { escapeControlCharacters } from "../core/text-safety.js";
import { git } from "../git/command.js";
import { join, resolve } from "node:path";
import { normalizeContentProvenance, verifyProjectContent } from "../content/provenance.js";
import { pricingCatalogRevision } from "../observability/known-pricing.js";
import { readRegularFile } from "./bounded-io.js";
import { readdir, stat } from "node:fs/promises";
import { refreshPricing } from "../observability/pricing-sync.js";
import { summarizeTelemetryFile } from "../observability/telemetry.js";
import { swallow } from "./swallow.js";

// What a surface reads about a project on request rather than on every poll:
// agents, usage, worktrees, merge requests, readiness.

export function worktreeManager(root, config) {
  return new WorktreeManager(root, config?.git?.worktreeRoot ?? ".etnpilot/worktrees");
}

// The agents a run can be given, read from the manifests the run itself would
// load. A name typed by hand is a run that fails a minute later.
export async function readAgents({ root, config }) {
  const directory = join(resolve(root), ".etnpilot", "agents");
  const files = await readdir(directory).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const agents = [];
  for (const file of files.filter((name) => name.endsWith(".yaml") || name.endsWith(".yml")).sort()) {
    const content = await readRegularFile(join(directory, file), 16 * 1024 * 1024).then((bytes) => bytes.toString("utf8")).catch(() => "");
    let manifest;
    try {
      manifest = YAML.parse(content) ?? {};
    } catch (error) {
      // A manifest that does not parse is named rather than hidden: a run
      // would fail on it too.
      agents.push({ name: file.replace(/\.ya?ml$/, ""), file, error: error.message });
      continue;
    }
    // What it would actually run with: its own provider, or the project's.
    const provider = manifest.provider ?? (manifest.providers?.length ? undefined : config?.defaultProvider);
    agents.push({
      name: typeof manifest.name === "string" && manifest.name ? manifest.name : file.replace(/\.ya?ml$/, ""),
      file,
      ...(provider ? { provider, ...(manifest.provider ? {} : { inheritedProvider: true }) } : {}),
      ...(Array.isArray(manifest.requires) ? { requires: manifest.requires } : {}),
      // What it may do, so a surface can say an agent only reads before anyone asks it to write.
      ...(Array.isArray(manifest.tools) ? { tools: manifest.tools } : {}),
      ...(typeof manifest.description === "string" ? { description: manifest.description } : {}),
    });
  }
  return {
    agents,
    // The providers a conversation may name for one turn.
    providers: Object.keys(config?.providers ?? {}),
    // What an empty choice means, so the surface does not have to guess.
    defaultAgent: config?.defaultAgent,
    steps: (config?.workflow?.steps ?? []).map((step) => step.id ?? step.agent).filter(Boolean),
  };
}

// Tokens and cost for this project, as recorded by the runs themselves. A
// surface that never shows this leaves a budget nobody can see.
let usageCache;
export async function readUsage({ root, config }) {
  await refreshPricing({ root, config }).catch(swallow("price refresh", undefined));
  const file = resolve(root, config?.observability?.file ?? ".etnpilot/state/telemetry.jsonl");
  const stats = await stat(file).catch(() => undefined);
  if (!stats) {
    return {
      available: false,
      reason: config?.observability?.enabled === true
        ? "No telemetry has been written yet; usage appears once a run records it."
        : "observability.enabled is false, so nothing records what a run costs.",
    };
  }
  const key = JSON.stringify([file, stats.mtimeMs, stats.size, config?.observability?.pricing, config?.observability?.budgets, pricingCatalogRevision()]);
  if (usageCache?.key === key) return usageCache.value;
  const summary = await summarizeTelemetryFile(file, { root, config });
  const value = { available: true, file, ...summary, budgets: config?.observability?.budgets ?? {} };
  usageCache = { key, value };
  return value;
}

export async function readWorktrees({ root, config }) {
  const manager = worktreeManager(root, config);
  try {
    const entries = await manager.describe();
    return {
      available: true,
      root: manager.worktreeRoot,
      entries,
      managed: entries.filter((entry) => entry.managed).length,
      unsaved: entries.filter((entry) => entry.readable && entry.blocking > 0).length,
    };
  } catch (error) {
    // Not a git checkout, or git is missing: a surface says that rather than
    // showing an empty list that looks like 'no worktrees'.
    return { available: false, error: error.message, entries: [] };
  }
}

// The merge requests ETNPilot opened, and the others queued for the same
// target, because what lands before ours is what breaks ours. Read straight
// from GitLab: a merge request's state lives there and nowhere else, and the
// receipt is sealed before publishing, so it cannot carry this.
export async function readMergeRequests({ root, config, env }, { state = "opened", fetchImpl, limit = 50 } = {}) {
  const project = config?.git?.project;
  if (!project) {
    return {
      configured: false,
      reason: "Set 'git.project' in .etnpilot/etnpilot.yaml to see merge requests here.",
      entries: [],
    };
  }
  let token;
  let secrets;
  try {
    secrets = createSecretResolver({ root, config, env });
    token = await secrets.get("gitlab.apiToken", {
      fallback: { provider: "env", key: "ETNPILOT_GITLAB_TOKEN" },
      baseUrl: config.git?.baseUrl,
    });
  } catch (error) {
    return { configured: true, available: false, project, error: error.message, entries: [] };
  }
  if (!token) {
    return {
      configured: true,
      available: false,
      project,
      error: secrets.refusals.get("gitlab.apiToken") ?? "No GitLab API token is configured; set ETNPILOT_GITLAB_TOKEN, 'secrets.gitlab.apiToken' or run 'etnpilot login gitlab'.",
      entries: [],
    };
  }
  const client = new GitLabClient({ baseUrl: config.git.baseUrl, token, fetchImpl });
  let mergeRequests;
  try {
    mergeRequests = await client.mergeRequests(project, { state, perPage: limit });
  } catch (error) {
    // Offline, or a token that cannot read this project. Either way the screen
    // reports it instead of pretending the project has no merge requests.
    return { configured: true, available: false, project, error: error.message, entries: [] };
  }
  const entries = mergeRequests.slice(0, limit).map((mergeRequest) => presentMergeRequest(mergeRequest));
  return {
    configured: true,
    available: true,
    project,
    state,
    targetBranch: config.git?.targetBranch ?? "main",
    entries,
    ours: entries.filter((entry) => entry.own).length,
    ...(mergeRequests.length > entries.length ? { truncated: mergeRequests.length } : {}),
  };
}

// Titles, branch names and author names are written by other people. They are
// data here, escaped and bounded, exactly as the merge-train inspection treats
// them.
function presentMergeRequest(mergeRequest) {
  const text = (value, max = 200) => escapeControlCharacters(String(value ?? "")).slice(0, max);
  const sourceBranch = text(mergeRequest.source_branch, 200);
  return {
    iid: Number(mergeRequest.iid),
    title: text(mergeRequest.title),
    state: text(mergeRequest.state, 20),
    draft: mergeRequest.draft === true || mergeRequest.work_in_progress === true,
    sourceBranch,
    targetBranch: text(mergeRequest.target_branch, 200),
    author: text(mergeRequest.author?.username ?? mergeRequest.author?.name ?? "", 60),
    webUrl: text(mergeRequest.web_url, 500),
    updatedAt: text(mergeRequest.updated_at, 40),
    mergeStatus: text(mergeRequest.detailed_merge_status ?? mergeRequest.merge_status ?? "", 40),
    hasConflicts: mergeRequest.has_conflicts === true,
    // Ours is decided by the branch a run publishes from, not by a name in the
    // title, which anyone could copy.
    own: sourceBranch.startsWith(RUN_BRANCH_PREFIX),
  };
}

export async function checkRunReadiness({ root, config }) {
  // Project content is pinned by a lock a person made after reading it. A run
  // refuses content that has no lock or no longer matches it — so that is
  // asked first, and answered with the command, not with the refusal.
  let lock;
  if (normalizeContentProvenance(config ?? {}).mode === "enforce") {
    await verifyProjectContent(root, config).catch((error) => {
      lock = { message: error.message.replace(/\s+Run 'etnpilot content lock'[^.]*\.?/i, "").trim() || error.message };
    });
  }
  const lockCommand = "etnpilot content lock";
  const commit = "git add .etnpilot && git commit -m \"Add ETNPilot configuration\"";

  const inPlace = config?.workspace?.mode === "in-place";
  const inside = inPlace ? true : await git(["rev-parse", "--is-inside-work-tree"], { cwd: root }).then((result) => result.stdout === "true", () => false);
  const baseRef = config?.git?.baseRef ?? "HEAD";
  const committed = inPlace || !inside ? true : await git(["cat-file", "-e", `${baseRef}:.etnpilot/etnpilot.yaml`], { cwd: root }).then(() => true, () => false);

  if (!inPlace && !inside) {
    return {
      ready: false,
      code: "not-a-checkout",
      message: "This directory is not a git checkout, and a run works in a git worktree.",
      // Working in place does not need a checkout, but it does need the lock.
      fixes: lock ? [] : ["in-place"],
      commands: ["git init", ...(lock ? [lockCommand] : []), commit],
    };
  }
  if (!committed) {
    return {
      ready: false,
      code: "project-not-committed",
      baseRef,
      message: `A run works in its own worktree, made from ${baseRef}, and ${baseRef} has no '.etnpilot/etnpilot.yaml' yet.${lock ? ` Also: ${lock.message}` : ""}`,
      fixes: lock ? [] : ["in-place"],
      commands: [...(lock ? [lockCommand] : []), commit],
    };
  }
  if (lock) {
    return {
      ready: false,
      code: "content-not-locked",
      message: lock.message,
      fixes: [],
      commands: [lockCommand, ...(inPlace ? [] : [commit.replace("Add ETNPilot configuration", "Lock ETNPilot content")])],
    };
  }
  return { ready: true, workspace: inPlace ? "in-place" : "worktree", baseRef };
}

