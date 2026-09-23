import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { loadConfig } from "../config/load.js";
import { loadProject } from "../content/load-project.js";
import { verifyProjectContent } from "../content/provenance.js";
import { ApprovalPolicy } from "../core/approval-policy.js";
import { Harness } from "../core/harness.js";
import { JsonlReceiptStore } from "../core/receipt-store.js";
import { loadReceiptSigner } from "../core/receipt-signing.js";
import { runCheck } from "../checks/runner.js";
import { CodeGraph, createCodeGraphMcpServer, isCodeGraphSourcePath } from "../codegraph/codegraph.js";
import { git } from "../git/command.js";
import { WorktreeManager } from "../git/worktrees.js";
import { GitLabPublisher } from "../gitlab/publisher.js";
import { registerConfiguredProviders } from "../providers/register.js";
import { ProviderRouter } from "../providers/router.js";
import { PolicyEngine } from "../policy/engine.js";
import { loadPlugins } from "../plugins/load-plugin.js";
import { WorkflowEngine } from "../workflow/engine.js";
import { createSecretResolver } from "../secrets/resolver.js";
import { createTelemetry } from "../observability/telemetry.js";

export async function runProject({
  root = process.cwd(),
  input,
  agent,
  worktree,
  inPlace = false,
  baseRef,
  cleanupPolicy,
  publish = false,
  env = process.env,
  providerFactories,
  fetchImpl,
  approvalHandler,
  signal,
  metadata = {},
  secretResolver,
} = {}) {
  if (!input) throw new TypeError("A task prompt is required.");
  const repositoryRoot = resolve(root);
  const bootstrapConfig = await loadConfig(join(repositoryRoot, ".etnpilot", "etnpilot.yaml"), env);
  const secrets = secretResolver ?? createSecretResolver({ root: repositoryRoot, config: bootstrapConfig, env });
  const useWorktree = worktree ?? (inPlace ? false : bootstrapConfig.workspace?.mode !== "in-place");
  const effectiveCleanupPolicy = cleanupPolicy ?? bootstrapConfig.workspace?.cleanup ?? "never";
  assertCleanupPolicy(effectiveCleanupPolicy);
  const runId = createRunId();
  const branch = `etnpilot/run-${runId}`;
  const worktreeManager = new WorktreeManager(repositoryRoot);
  const receiptPath = join(repositoryRoot, ".etnpilot", "state", "runs", `${runId}.jsonl`);
  const policy = new PolicyEngine(bootstrapConfig.policy);
  const harness = new Harness({
    approvalPolicy: new ApprovalPolicy(bootstrapConfig.approval, { policy }),
    approvalHandler,
    policy,
    secrets,
  });
  let config;
  let gitLabToken;
  let receiptSigner;
  let receiptStore;
  let telemetry;
  let workspace;
  let codegraph;
  let codegraphBefore;
  let contentEvidence;
  let workflow;
  try {
    const bootstrapPlugins = (bootstrapConfig.plugins ?? []).filter(isBootstrapPlugin);
    await loadPlugins(bootstrapPlugins, harness, repositoryRoot, {
      isolation: bootstrapConfig.pluginIsolation,
      signal,
      secretResolver: secrets,
      fetchImpl,
      bootstrap: true,
    });
    gitLabToken = await secrets.get("gitlab.apiToken", {
      fallback: { provider: "env", key: "ETNPILOT_GITLAB_TOKEN" },
    });
    if (publish) assertPublishable(useWorktree, bootstrapConfig, gitLabToken);
    telemetry = await createTelemetry({
      root: repositoryRoot,
      config: bootstrapConfig,
      secretResolver: secrets,
      fetchImpl,
    });
    receiptSigner = await loadReceiptSigner({
      root: repositoryRoot,
      config: bootstrapConfig,
      env,
      secretResolver: secrets,
    });
    workspace = useWorktree
      ? await worktreeManager.create({
          name: `run-${runId}`,
          branch,
          startPoint: baseRef ?? bootstrapConfig.git?.baseRef ?? "HEAD",
        })
      : { name: "in-place", branch: await currentBranch(repositoryRoot), path: repositoryRoot, managed: false };
    if (useWorktree) workspace.managed = true;
    receiptStore = new JsonlReceiptStore(receiptPath, { signer: receiptSigner });
    harness.telemetry = telemetry;
    harness.receiptStore = receiptStore;
    ({ config, content: contentEvidence } = await loadProject(harness, workspace.path, env, {
      signal,
      secretResolver: secrets,
      fetchImpl,
      bootstrapPluginsLoaded: true,
    }).catch((error) => { throw describeProjectLoadError(error, useWorktree); }));
    codegraph = createCodegraph(workspace.path, config);
    if (codegraph) {
      codegraphBefore = await codegraph.graph.indexDirectory(workspace.path, { signal });
      harness.instructions.push([
        "CodeGraph is available through the local codegraph_explore MCP tool.",
        "Query it before planning broad edits and use its refreshed index when reviewing changes.",
      ].join("\n"));
    }
    await registerConfiguredProviders(harness, config.providers, {
      workingDirectory: workspace.path,
      env,
      secretResolver: secrets,
      factories: providerFactories,
      ...(codegraph ? {
        mcpServers: { codegraph: codegraph.mcp },
        readOnlyMcpTools: codegraph.mcp.tools,
      } : {}),
    });
    harness.setProviderRouter(new ProviderRouter(harness.providers, config.routing, { policy }));
    workflow = normalizeWorkflow(config.workflow, agent ?? config.defaultAgent ?? "orchestrator");
    assertWorkflowAgents(harness, workflow);
  } catch (error) {
    codegraph?.graph.close();
    await harness.close();
    // Setup never reached the workflow, so the run left no evidence worth
    // keeping. Remove the workspace instead of leaking a worktree per attempt.
    error.workspaceCleanup = await discardWorkspace(workspace, worktreeManager, branch);
    throw error;
  }
  const engine = new WorkflowEngine({
    concurrency: workflow.concurrency,
    failFast: workflow.failFast,
    timeoutMs: workflow.timeoutMs,
    maxSteps: workflow.maxSteps,
    events: harness.events,
  });
  const checkEnv = checkEnvironment(env, config.checks);
  const publisher = publish ? createPublisher(config, gitLabToken, fetchImpl) : undefined;
  const startedAt = Date.now();
  const workflowSpan = telemetry?.startSpan("etnpilot.workflow", {
    attributes: {
      "etnpilot.workflow.run_id": runId,
      "etnpilot.workspace.mode": useWorktree ? "worktree" : "in-place",
    },
  });
  const traceMetadata = workflowSpan
    ? { traceId: workflowSpan.traceId, parentSpanId: workflowSpan.spanId }
    : {};
  let summary;
  try {
    summary = await engine.run(workflow.steps, async (step, execution) => {
      if (step.type === "agent") {
        return harness.run({
          agent: step.agent,
          input: composeAgentInput(input, execution.dependencyResults),
          metadata: {
            ...metadata,
            ...traceMetadata,
            workflowRunId: runId,
            workflowStep: step.id,
            workspace: workspace.path,
          },
          signal: execution.signal,
        });
      }
      if (step.type === "check") {
        return runObservedCheck(step, {
          cwd: workspace.path,
          signal: execution.signal,
          env: checkEnv,
          telemetry,
          trace: traceMetadata,
          workflowRunId: runId,
        });
      }
      throw new Error(`Unsupported workflow step type: '${step.type}'.`);
    }, { signal, context: { runId, workspace } });
    contentEvidence = await verifyContentAfterRun(workspace.path, config, contentEvidence);
  } catch (error) {
    if (contentEvidence?.mode === "enforce" && contentEvidence.verifiedAfterRun !== true) {
      try {
        contentEvidence = await verifyContentAfterRun(workspace.path, config, contentEvidence);
      } catch (verificationError) {
        contentEvidence = {
          ...contentEvidence,
          verifiedAfterRun: false,
          verificationError: verificationError.code ?? "content-verification-failed",
        };
      }
    }
    summary = error.workflow ?? { status: "failed", error: error.message };
    const observability = await finishTelemetry({
      telemetry,
      span: workflowSpan,
      workflowRunId: runId,
      status: "error",
      durationMs: Date.now() - startedAt,
      file: bootstrapConfig.observability?.file,
    });
    const receiptHash = await receiptStore.append({
      type: "workflow",
      terminal: true,
      runId,
      status: "failed",
      durationMs: Date.now() - startedAt,
      workspace,
      content: contentEvidence,
      observability,
      summary,
    });
    codegraph?.graph.close();
    await harness.close();
    error.run = {
      runId,
      workspace,
      receiptPath,
      receiptHash,
      receiptProof: receiptSigner ? {
        algorithm: receiptSigner.algorithm,
        keyId: receiptSigner.keyId,
      } : undefined,
      observability,
      content: contentEvidence,
      summary,
    };
    throw error;
  }

  await harness.close();

  const gitEvidence = await collectGitEvidence(workspace.path);
  let codegraphEvidence;
  if (codegraph) {
    try {
      const update = await codegraph.graph.indexDirectory(workspace.path);
      const sourceChanges = gitEvidence.changedPaths.filter(isSourcePath);
      codegraphEvidence = {
        engine: "@colbymchenry/codegraph",
        indexPath: join(workspace.path, ".codegraph"),
        before: codegraphBefore,
        after: update,
        impact: sourceChanges.length > 0
          ? codegraph.graph.impact(sourceChanges, { maxDepth: config.codegraph?.maxImpactDepth ?? 20 })
          : { changed: [], files: [], tests: [], maxDepth: config.codegraph?.maxImpactDepth ?? 20 },
      };
    } finally {
      codegraph.graph.close();
    }
  }
  const observability = await finishTelemetry({
    telemetry,
    span: workflowSpan,
    workflowRunId: runId,
    status: summary.status === "succeeded" ? "ok" : "error",
    durationMs: Date.now() - startedAt,
    file: bootstrapConfig.observability?.file,
  });
  const receiptHash = await receiptStore.append({
    type: "workflow",
    terminal: true,
    runId,
    status: summary.status,
    durationMs: Date.now() - startedAt,
    workspace,
    content: contentEvidence,
    git: gitEvidence,
    codegraph: codegraphEvidence,
    observability,
    summary,
  });
  let mergeRequest;
  let publication;
  if (publisher && summary.status !== "succeeded") {
    // Unreviewed work from a failed workflow is never pushed, even when
    // fail-fast is disabled and the engine returned without throwing.
    publication = { published: false, reason: "workflow-not-succeeded" };
  } else if (publisher) {
    mergeRequest = await publisher.publish({
      cwd: workspace.path,
      branch,
      targetBranch: config.git?.targetBranch ?? "main",
      title: `ETNPilot: ${firstLine(input)}`,
      description: `Automated ETNPilot run \`${runId}\`. Review the attached evidence before merging.`,
      receipt: receiptHash,
      receiptProof: receiptSigner ? {
        algorithm: receiptSigner.algorithm,
        keyId: receiptSigner.keyId,
      } : undefined,
    });
    publication = { published: true, ...(mergeRequest?.noteError ? { noteError: mergeRequest.noteError } : {}) };
  }
  const cleanup = await cleanupWorkspace({
    policy: effectiveCleanupPolicy,
    published: Boolean(mergeRequest),
    workspace,
    manager: worktreeManager,
  });
  return {
    runId,
    status: summary.status,
    workspace,
    cleanup,
    receiptPath,
    receiptHash,
    receiptProof: receiptSigner ? {
      algorithm: receiptSigner.algorithm,
      keyId: receiptSigner.keyId,
    } : undefined,
    summary,
    content: contentEvidence,
    git: gitEvidence,
    codegraph: codegraphEvidence,
    observability,
    mergeRequest,
    ...(publication ? { publication } : {}),
  };
}

const DEFAULT_CHECK_ENV_ALLOW = Object.freeze(["PATH", "HOME", "LANG", "LC_ALL", "TZ", "TMPDIR"]);

// Checks execute code the agent just wrote. They inherit an allow-listed
// environment so repository and provider credentials cannot be read by them.
function checkEnvironment(env, config = {}) {
  const extra = config.envAllow ?? [];
  if (!Array.isArray(extra) || extra.some((name) => typeof name !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(name))) {
    throw new TypeError("checks.envAllow must contain uppercase environment variable names.");
  }
  const allow = new Set([...DEFAULT_CHECK_ENV_ALLOW, ...extra]);
  const inherited = Object.fromEntries(
    Object.entries(env).filter(([key, value]) => allow.has(key) && value !== undefined),
  );
  return { ...inherited, ...(config.env ?? {}), ETNPILOT_CHECK: "1" };
}

function assertWorkflowAgents(harness, workflow) {
  const missing = [...new Set(workflow.steps
    .filter((step) => step.type === "agent" || step.type === undefined)
    .map((step) => step.agent)
    .filter((name) => name && !harness.agents.has(name)))];
  if (missing.length === 0) return;
  const available = harness.agents.list();
  throw new Error([
    `Unknown workflow agent${missing.length > 1 ? "s" : ""}: ${missing.map((name) => `'${name}'`).join(", ")}.`,
    available.length > 0
      ? `Configured agents: ${available.join(", ")}.`
      : "No agents are defined. Add a manifest under '.etnpilot/agents/'.",
  ].join(" "));
}

function describeProjectLoadError(error, useWorktree) {
  if (error?.code !== "ENOENT" || !useWorktree) return error;
  const detailed = new Error(
    "The run worktree has no '.etnpilot/etnpilot.yaml'. A worktree is created from the committed"
    + " base ref, so commit '.etnpilot/' first or run with --no-worktree.",
  );
  detailed.code = "etnpilot_content_not_committed";
  detailed.cause = error;
  return detailed;
}

async function discardWorkspace(workspace, manager, branch) {
  if (!workspace?.managed) return { removed: false, reason: "in-place-run" };
  try {
    const removal = await manager.removeIfClean(workspace.name);
    if (!removal.removed) return removal;
    await manager.deleteBranch(branch).catch(() => {});
    return { ...removal, branch, branchRemoved: true };
  } catch (error) {
    return { removed: false, reason: "cleanup-failed", error: error.message };
  }
}

async function verifyContentAfterRun(root, config, initial) {
  if (!initial || initial.mode === "off" || initial.verifyAfterRun === false) return initial;
  const verified = await verifyProjectContent(root, config, initial);
  return { ...verified, verifiedAfterRun: true };
}

async function runObservedCheck(step, { cwd, signal, env, telemetry, trace, workflowRunId }) {
  const span = telemetry?.startSpan("etnpilot.check", {
    traceId: trace.traceId,
    parentSpanId: trace.parentSpanId,
    attributes: {
      "etnpilot.workflow.run_id": workflowRunId,
      "etnpilot.workflow.step": step.id,
      "etnpilot.check.name": step.name ?? step.id,
    },
  });
  const startedAt = Date.now();
  try {
    const result = await runCheck(step, { cwd, signal, env });
    await span?.end({ attributes: { "etnpilot.duration_ms": Date.now() - startedAt } });
    return result;
  } catch (error) {
    await span?.end({
      status: "error",
      attributes: {
        "error.type": error.code ?? error.name ?? "check_failed",
        "etnpilot.duration_ms": Date.now() - startedAt,
      },
    });
    throw error;
  }
}

async function finishTelemetry({ telemetry, span, workflowRunId, status, durationMs, file }) {
  if (!telemetry || !span) return undefined;
  await span.end({ status, attributes: { "etnpilot.duration_ms": durationMs } });
  const flushed = await telemetry.flush();
  return {
    version: 1,
    traceId: span.traceId,
    spanId: span.spanId,
    file: file ?? ".etnpilot/state/telemetry.jsonl",
    summary: telemetry.summary(workflowRunId),
    exportErrors: flushed.errors.length,
  };
}

function normalizeWorkflow(workflow = {}, defaultAgent) {
  const steps = workflow.steps?.length
    ? workflow.steps
    : [{ id: "agent", type: "agent", agent: defaultAgent }];
  return {
    concurrency: workflow.concurrency ?? 1,
    failFast: workflow.failFast ?? true,
    timeoutMs: workflow.timeoutMs ?? 30 * 60_000,
    maxSteps: workflow.maxSteps ?? 50,
    steps,
  };
}

function composeAgentInput(input, dependencies) {
  if (Object.keys(dependencies).length === 0) return String(input);
  const evidence = Object.entries(dependencies).map(([id, result]) => {
    const payload = result?.result ?? result;
    return `### ${id}\n${JSON.stringify(payload, null, 2)}`;
  }).join("\n\n");
  return `${input}\n\nDependency results:\n\n${evidence}`;
}

async function collectGitEvidence(cwd) {
  const [head, status, diff, changed, staged, untracked] = await Promise.all([
    git(["rev-parse", "HEAD"], { cwd }),
    git(["status", "--short"], { cwd }),
    git(["diff", "--stat"], { cwd }),
    git(["diff", "--name-only", "HEAD", "--"], { cwd }),
    git(["diff", "--cached", "--name-only", "--"], { cwd }),
    git(["ls-files", "--others", "--exclude-standard"], { cwd }),
  ]);
  const changedPaths = [...new Set(
    [changed.stdout, staged.stdout, untracked.stdout]
      .flatMap((value) => value.split("\n"))
      .filter(Boolean)
      .map((path) => path.replaceAll("\\", "/")),
  )].sort();
  return { head: head.stdout, status: status.stdout, diffStat: diff.stdout, changedPaths };
}

async function currentBranch(cwd) {
  return (await git(["branch", "--show-current"], { cwd })).stdout;
}

function createRunId() {
  return `${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
}

function firstLine(value) {
  return String(value).split("\n", 1)[0].slice(0, 72);
}

function assertPublishable(useWorktree, config, token) {
  if (!useWorktree) throw new Error("Publishing an in-place run is not allowed.");
  if (!config.git?.project) throw new Error("Publishing requires 'git.project' in .etnpilot/etnpilot.yaml.");
  if (!token) throw new Error("A GitLab API token is required for GitLab publishing.");
}

function createPublisher(config, token, fetchImpl) {
  return new GitLabPublisher({
    baseUrl: config.git?.baseUrl,
    project: config.git?.project,
    remote: config.git?.remote ?? "gitlab",
    committer: config.git?.committer,
    token,
    fetchImpl,
  });
}

function createCodegraph(workspaceRoot, config) {
  if (config.codegraph?.enabled === false || config.codegraph?.autoIndex === false) return null;
  return {
    graph: new CodeGraph(workspaceRoot),
    mcp: createCodeGraphMcpServer(workspaceRoot, config.codegraph),
  };
}

function isBootstrapPlugin(entry) {
  return entry && typeof entry === "object" && entry.bootstrap === true;
}

function isSourcePath(path) {
  return isCodeGraphSourcePath(path);
}

function assertCleanupPolicy(policy) {
  if (!["never", "on-success", "after-publish"].includes(policy)) {
    throw new Error(`Unsupported workspace cleanup policy: '${policy}'.`);
  }
}

async function cleanupWorkspace({ policy, published, workspace, manager }) {
  if (!workspace.managed) return { requested: false, removed: false, reason: "in-place-run" };
  const requested = policy === "on-success" || (policy === "after-publish" && published);
  if (!requested) return { requested: false, removed: false, reason: "retained-by-policy" };
  return { requested: true, ...await manager.removeIfClean(workspace.name) };
}
