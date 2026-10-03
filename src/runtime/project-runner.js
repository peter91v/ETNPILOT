// @ts-check
import { restoreWorkspace } from "../git/workspace-restore.js";
import { swallow } from "./swallow.js";
import { acquireWorkspaceLease } from "./workspace-lease.js";
import { commandEnvironment } from "./command-environment.js";
import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { loadConfig } from "../config/load.js";
import { settingsEvidence } from "../config/layers.js";
import { loadProject } from "../content/load-project.js";
import { verifyProjectContent } from "../content/provenance.js";
import { ApprovalPolicy } from "../core/approval-policy.js";
import { Harness } from "../core/harness.js";
import { JsonlReceiptStore } from "../core/receipt-store.js";
import { loadReceiptSigner } from "../core/receipt-signing.js";
import { runCheck } from "../checks/runner.js";
import {
  CodeGraph,
  createCodeGraphMcpServer,
  isCodeGraphSourcePath,
  isCodeGraphUnavailable,
} from "../codegraph/codegraph.js";
import { git } from "../git/command.js";
import { rehearseMerge } from "../git/merge-rehearsal.js";
import { createHash } from "node:crypto";
import { canonicalJson } from "../core/receipt-store.js";
import { WorktreeManager } from "../git/worktrees.js";
import { workspaceDigest } from "../git/workspace-digest.js";
import { extractOpenQuestions } from "./open-questions.js";
import { acquireWorktreeLock } from "./worktree-lock.js";
import { GitLabClient } from "../gitlab/client.js";
import { inspectMergeTrain } from "../gitlab/merge-train.js";
import { GitLabPublisher } from "../gitlab/publisher.js";
import { registerConfiguredProviders } from "../providers/register.js";
import { ProviderRouter } from "../providers/router.js";
import { PolicyEngine } from "../policy/engine.js";
import { loadPlugins } from "../plugins/load-plugin.js";
import { WorkflowEngine } from "../workflow/engine.js";
import { evaluateQuorum, parseVerdict, QUORUM_INSTRUCTION, quorumError } from "../workflow/quorum.js";
import { runLadder } from "../workflow/ladder.js";
import { createSecretResolver } from "../secrets/resolver.js";
import { createTelemetry } from "../observability/telemetry.js";
import { refreshPricing } from "../observability/pricing-sync.js";
import { buildDevcontainerImage, createSandbox, readDevcontainerImage } from "./sandbox.js";
import { createFixtureRecorder, fixtureProviderFactories, loadFixtures } from "./fixtures.js";
import { connectMcpTools } from "../providers/mcp-client.js";
import { describeProposals, summarizeProposal, writeProposals } from "../content/proposals.js";

const PROPOSALS_ROOT = ".etnpilot/proposals";

// Every branch a run publishes from starts here, which is also how a surface
// tells ETNPilot's own merge requests apart from everyone else's.
export const RUN_BRANCH_PREFIX = "etnpilot/";

async function executeProject(options = {}) {
  // A worktree that is being continued has one run in it at a time.
  const lock = options.resume
    ? await acquireWorktreeLock(resolve(options.root ?? process.cwd()), options.resume.workspace.path, { label: `resuming ${options.resume.from.runId}` })
    : undefined;
  try {
    const run = await setUpRun(options);
    const outcome = await runWorkflow(run);
    return await finishRun(run, outcome);
  } finally {
    await lock?.release();
  }
}

// Everything a run needs before its first step: configuration, a workspace, the
// project loaded into the harness, tools and providers. If any of it fails, what was
// opened is closed and the workspace is discarded; nothing was run, so there is no
// receipt to seal.
async function setUpRun({
  root = process.cwd(),
  input,
  agent,
  workflow: workflowName,
  worktree,
  inPlace = false,
  baseRef,
  dryRun = false,
  recordFixtures,
  fixtures,
  cleanupPolicy,
  publish = false,
  env = process.env,
  providerFactories,
  fetchImpl,
  codegraphImporter,
  approvalHandler,
  signal,
  metadata = {},
  // Set by a conversation: { id, turn, history }. The run is one turn of it.
  session,
  // A conversation's choice of model, provider, effort or tools for the agent it
  // talks to: { model, provider, effort, tools }. Applied to that one agent for this run.
  agentOverride,
  secretResolver,
  onEvent,
  // Set by 'etnpilot resume': { from: { runId, receiptHash }, workspace: { path, branch }, reuse: { [stepId]: { result, entryHash, effect } } }.
  // The run carries the finished steps of an earlier run into a new one and continues in the
  // earlier run's worktree, which this run does not own and never discards.
  resume,
} = /** @type {any} */ ({})) {
  if (!input) throw new TypeError("A task prompt is required.");
  const repositoryRoot = resolve(root);
  const bootstrapConfig = await loadConfig(join(repositoryRoot, ".etnpilot", "etnpilot.yaml"), env);
  const secrets = secretResolver ?? createSecretResolver({ root: repositoryRoot, config: bootstrapConfig, env });
  const useWorktree = resume ? true : worktree ?? (inPlace ? false : bootstrapConfig.workspace?.mode !== "in-place");
  const effectiveCleanupPolicy = cleanupPolicy ?? bootstrapConfig.workspace?.cleanup ?? "never";
  assertCleanupPolicy(effectiveCleanupPolicy);
  const runId = createRunId();
  const branch = resume ? resume.workspace.branch : `${RUN_BRANCH_PREFIX}run-${runId}`;
  const worktreeManager = new WorktreeManager(repositoryRoot);
  const receiptPath = join(repositoryRoot, ".etnpilot", "state", "runs", `${runId}.jsonl`);
  const policy = new PolicyEngine(bootstrapConfig.policy);
  if (dryRun && publish) throw new Error("A dry run cannot publish.");
  const harness = new Harness({
    approvalPolicy: new ApprovalPolicy(bootstrapConfig.approval, { policy, dryRun }),
    approvalHandler,
    policy,
    secrets,
  });
  // A surface that started this run can watch it: which step is working and
  // which agent is inside it. An observer never changes the run — the event
  // bus contains a listener that throws.
  if (onEvent) harness.events.on("*", onEvent);
  let config;
  let namedWorkflows = new Map();
  let gitLabToken;
  let receiptSigner;
  let receiptStore;
  let telemetry;
  let workspace;
  let codegraph;
  let mcp;
  const mcpErrors = [];
  let codegraphBefore;
  let codegraphUnavailable;
  let contentEvidence;
  let workflow;
  let sandbox;
  let recorder;
  let fixturePlayer;
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
      baseUrl: bootstrapConfig.git?.baseUrl,
    });
    if (publish) assertPublishable(useWorktree, bootstrapConfig, gitLabToken);
    // Prices for models the built-in table does not know, so a run is costed
    // without anyone typing a rate. Never fails the run.
    await refreshPricing({ root: repositoryRoot, config: bootstrapConfig, fetchImpl }).catch(swallow("price refresh", undefined));
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
    workspace = await openWorkspace({ resume, useWorktree, worktreeManager, runId, branch, baseRef, bootstrapConfig, repositoryRoot });
    receiptStore = new JsonlReceiptStore(receiptPath, { signer: receiptSigner });
    harness.telemetry = telemetry;
    harness.receiptStore = receiptStore;
    ({ config, content: contentEvidence, workflows: namedWorkflows } = await loadProject(harness, workspace.path, env, {
      signal,
      secretResolver: secrets,
      fetchImpl,
      bootstrapPluginsLoaded: true,
      layerRoot: repositoryRoot,
    }).catch(async (error) => { throw await describeProjectLoadError(error, useWorktree, repositoryRoot); }));
    harness.hooks = config.hooks ?? {};
    codegraph = createCodegraph(workspace.path, config, { importer: codegraphImporter });
    if (codegraph) {
      // Throws for any failure that should stop the run; the catch below closes `codegraph`.
      const indexed = await indexCodegraph(codegraph, { workspace, harness, signal });
      codegraphBefore = indexed.before;
      if (indexed.unavailable) {
        codegraphUnavailable = indexed.unavailable;
        codegraph = undefined;
      }
    }
    // The project's own MCP servers, for every provider rather than one. A
    // server that will not start costs its tools, not the run.
    // CodeGraph is one of them for the chat providers: the same descriptor the
    // Copilot adapter is handed, spoken through the same client as any other
    // server. Without this the prompt below promised a tool that 'anthropic'
    // and 'openai' were never given.
    mcp = await connectProjectMcp({ codegraph, config, harness, errors: mcpErrors });
    sandbox = createSandbox(await resolveSandboxConfig(config.sandbox ?? {}, workspace.path), {
      workspace: workspace.path,
    });
    // Fail before the first step rather than halfway through a run.
    if (sandbox && !dryRun) await sandbox.assertAvailable();
    let effectiveFactories = providerFactories;
    if (fixtures) {
      const replay = await playbackProviders({ fixtures, repositoryRoot, config });
      fixturePlayer = replay.player;
      effectiveFactories = replay.factories;
    }
    await registerConfiguredProviders(harness, config.providers, {
      workingDirectory: workspace.path,
      env,
      secretResolver: secrets,
      factories: effectiveFactories,
      sandbox,
      // Whatever the project's MCP servers offer, handed to every provider as
      // ordinary tools rather than to one provider as a special case.
      extraTools: mcp?.tools ?? [],
      ...(codegraph ? {
        mcpServers: { codegraph: codegraph.mcp },
        readOnlyMcpTools: codegraph.mcp.tools,
      } : {}),
    });
    if (recordFixtures) recorder = recordProviders(harness, { recordFixtures, repositoryRoot, config });
    harness.setProviderRouter(new ProviderRouter(harness.providers, config.routing, {
      policy,
      defaultProvider: config.defaultProvider,
    }));
    workflow = normalizeWorkflow(config.workflow, {
      requested: agent,
      fallback: config.defaultAgent ?? "orchestrator",
      named: workflowName ? selectNamedWorkflow(namedWorkflows, workflowName) : undefined,
    });
    if (agentOverride && agent) applyAgentOverride(harness, agent, agentOverride);
    assertWorkflowAgents(harness, workflow);
    await harness.events.emit("workflow.planned", {
      runId,
      steps: workflow.steps.map((step) => step.id),
      // What each step will use, so a surface can name the agents of a workflow
      // before any of them has started.
      plan: plannedSteps(workflow),
      ...(workflowName && !agent ? { workflow: workflowName } : {}),
    });
  } catch (error) {
    codegraph?.graph.close();
    await mcp?.close();
    await harness.close();
    // Setup never reached the workflow, so the run left no evidence worth
    // keeping. Remove the workspace instead of leaking a worktree per attempt.
    error.workspaceCleanup = await discardWorkspace(workspace, worktreeManager, branch);
    throw await explainMissingName(error, repositoryRoot, useWorktree);
  }
  return {
    root, input, agent, workflowName, dryRun, publish, env, fetchImpl, signal, metadata, session, approvalHandler,
    repositoryRoot, bootstrapConfig, secrets, useWorktree, effectiveCleanupPolicy, runId, branch, worktreeManager, resume, agentOverride, baseRef,
    receiptPath, policy, harness, config, gitLabToken, receiptSigner, receiptStore, telemetry, workspace,
    codegraph, mcp, codegraphBefore, codegraphUnavailable, contentEvidence, workflow, sandbox, recorder, fixturePlayer,
    toolsReleased: false,
  };
}

// The workflow itself. A failure here is sealed as a failed receipt with the run's
// evidence, everything opened is closed, and the error carries the run.
async function runWorkflow(run) {
  const {
    root, input, dryRun, publish, fetchImpl, metadata, session, env, signal,
    bootstrapConfig, useWorktree, runId, harness, config, gitLabToken, receiptSigner, receiptStore, telemetry,
    workspace, sandbox, workflow, receiptPath, resume, agent, workflowName, agentOverride, baseRef,
  } = run;
  let { contentEvidence } = run;
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
    // The first entry of every run: under which configuration, and from which
    // workspace state, the steps below started. Both are digests, never the
    // configuration itself.
    await receiptStore.append({
      type: "run-start",
      runId,
      mode: dryRun ? "dry-run" : "execute",
      configDigest: `sha256:${createHash("sha256").update(canonicalJson(config)).digest("hex")}`,
      // The steps and their order, and where the work happens: what a reader
      // needs to say which steps a run finished and whether its workspace is
      // still there.
      plan: workflow.steps.map((step) => ({ id: step.id, type: step.type ?? "agent", needs: step.needs ?? [] })),
      workspace: { path: workspace.path, branch: workspace.branch, managed: workspace.managed === true },
      // What was asked, so a later reader can ask for the same thing again.
      request: { input, ...(agent ? { agent } : {}), ...(workflowName ? { workflow: workflowName } : {}), ...(agentOverride ? { agentOverride } : {}), ...(baseRef ? { baseRef } : {}) },
      ...(resume ? { resumedFrom: { runId: resume.from.runId, receiptHash: resume.from.receiptHash, reusedSteps: Object.entries(resume.reuse).map(([step, carried]) => ({ step, entryHash: carried.entryHash })) } } : {}),
      ...(dryRun ? {} : { workspaceDigest: await workspaceDigest(workspace.path) }),
    });
    const runStep = async (step, execution) => {
      if (step.type === "agent") {
        const receipt = await harness.run({
          agent: step.agent,
          input: composeAgentInput(input, execution.dependencyResults),
          metadata: {
            ...metadata,
            ...traceMetadata,
            workflowRunId: runId,
            workflowStep: step.id,
            workspace: workspace.path,
            ...(session ? { sessionId: session.id, turn: session.turn, kind: session.kind, history: session.history, attachments: session.attachments } : {}),
          },
          signal: execution.signal,
        });
        assertStepExpectation(step, receipt);
        return receipt;
      }
      if (step.type === "ladder") {
        if (dryRun) return { step: step.id, skipped: true, reason: "dry-run" };
        return runLadderStep(step, harness, {
          input, execution, metadata, traceMetadata, runId, workspace, receiptStore,
          verifyCommand: (verifier) => verifyLadderCommand(step, verifier, { workspace, root, execution, checkEnv, sandbox, telemetry, traceMetadata, runId }),
          checkBaseline: async (verifiers) => {
            for (const verifier of verifiers) {
              const outcome = await verifyLadderCommand(step, verifier, { workspace, root, execution, checkEnv, sandbox, telemetry, traceMetadata, runId });
              if (!outcome.ok) return { ...outcome, name: verifier.name ?? verifier.command.join(" ") };
            }
            return { ok: true };
          },
        });
      }
      if (step.type === "quorum") {
        return runQuorumStep(step, harness, {
          input,
          execution,
          metadata,
          traceMetadata,
          runId,
          workspace,
        });
      }
      // A person reads what the previous step produced and says whether the
      // rest of the run should happen. This is the cheapest place to stop a
      // run that is about to spend money and open a merge request on a plan
      // nobody agreed with — and it is mechanical, so it appears in the
      // receipt like every other decision.
      if (step.type === "gate") {
        if (dryRun) return { step: step.id, skipped: true, reason: "dry-run" };
        return runGateStep(step, harness, { execution, runId, workspace });
      }
      if (step.type === "check") {
        // Checks execute commands, so a dry run records them instead.
        if (dryRun) return { name: step.name ?? step.id, command: step.command, skipped: true, reason: "dry-run" };
        return runObservedCheck(step, {
          cwd: workspace.path,
          root,
          signal: execution.signal,
          env: checkEnv,
          sandbox,
          telemetry,
          trace: traceMetadata,
          workflowRunId: runId,
        });
      }
      // Which step, and what it may be: 'type: undefined' on its own leaves
      // someone reading a workflow file with no idea which line is wrong.
      throw new Error(
        `Workflow step '${step.id}' has an unsupported type: '${step.type}'.`
        + " Every step needs one of 'agent', 'quorum', 'ladder', 'check' or 'gate'.",
      );
    };
    summary = await engine.run(workflow.steps, async (step, execution) => {
      // A step an earlier run finished is not run again: its result is carried
      // over, and the receipt says whose it is.
      const carried = resume?.reuse?.[step.id];
      const result = carried ? carried.result : await runStep(step, execution);
      // What the workspace looked like when this step finished, so a later
      // reader can tell whether the step's result still describes it.
      if (!dryRun) await recordStepEvidence(receiptStore, { runId, step, result, workspace, ...(carried ? { reused: { runId: resume.from.runId, entryHash: carried.entryHash }, effect: carried.effect } : {}) });
      return result;
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
      mode: dryRun ? "dry-run" : "execute",
      status: "failed",
      durationMs: Date.now() - startedAt,
      workspace,
      content: contentEvidence,
      observability,
      summary,
    });
    await releaseTools(run);
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
  return { summary, contentEvidence, publisher, startedAt, workflowSpan };
}

// Everything after the workflow: evidence, the sealed receipt, publishing, cleanup.
// If it fails before the receipt is sealed, the receipt is sealed as failed (a run
// must not be left looking unfinished), and either way what was opened is closed.
async function finishRun(run, { summary, contentEvidence, publisher, startedAt, workflowSpan }) {
  const {
    input, agent, workflowName, dryRun, fetchImpl, session, bootstrapConfig, effectiveCleanupPolicy, runId, branch,
    worktreeManager, receiptPath, harness, config, gitLabToken, receiptSigner, receiptStore, telemetry, workspace,
    codegraph, codegraphBefore, codegraphUnavailable, sandbox, recorder, fixturePlayer,
  } = run;
  let sealed = false;
  try {

    await harness.close();

    const fixtureEvidence = await finishFixtures(recorder, fixturePlayer);
    const gitEvidence = await collectGitEvidence(workspace.path);
    // Rehearsed even when nothing will be published: knowing the branch has
    // drifted from its target is evidence a reviewer wants either way.
    const rehearsal = workspace.managed && config.git?.rehearseMerge !== false
      ? await rehearseMerge({
          cwd: workspace.path,
          remote: config.git?.remote,
          targetBranch: config.git?.targetBranch ?? "main",
          fetch: config.git?.rehearseFetch !== false,
        })
      : undefined;
    const mergeTrain = rehearsal?.clean === true
      ? await inspectTrain({ config, token: gitLabToken, workspace, branch, fetchImpl })
      : undefined;

    const codegraphEvidence = await describeCodegraph({ codegraph, codegraphBefore, codegraphUnavailable, workspace, gitEvidence, config });
    // The servers were only ever closed when a run failed. A run that succeeded
    // left every one of them running — invisible while a project configured
    // none, and a hung process on every run now that codegraph is one.
    await releaseTools(run);
    const observability = await finishTelemetry({
      telemetry,
      span: workflowSpan,
      workflowRunId: runId,
      status: summary.status === "succeeded" ? "ok" : "error",
      durationMs: Date.now() - startedAt,
      file: bootstrapConfig.observability?.file,
    });
    // What agents suggested for the project's instructions. Written into the
    // worktree here, by the harness, after the evidence about the run's own
    // changes was taken — so it is neither counted as the agent's edit nor
    // able to alter what the run itself was told.
    const proposals = dryRun ? [] : harness.proposals;
    if (proposals.length > 0) await writeProposals(workspace.path, proposals, runId);
    const receiptHash = await receiptStore.append({
      type: "workflow",
      terminal: true,
      runId,
      mode: dryRun ? "dry-run" : "execute",
      ...(workflowName && !agent ? { workflow: workflowName } : {}),
      status: summary.status,
      durationMs: Date.now() - startedAt,
      workspace: { ...workspace, ...(sandbox ? { sandbox: sandbox.describe() } : {}) },
      settings: settingsEvidence(bootstrapConfig),
      content: contentEvidence,
      git: {
        ...gitEvidence,
        ...(rehearsal ? { mergeRehearsal: rehearsal } : {}),
        ...(mergeTrain ? { mergeTrain } : {}),
      },
      ...(session ? { session: { id: session.id, turn: session.turn, ...(session.kind ? { kind: session.kind } : {}), ...(session.attachments?.length ? { attachments: session.attachments } : {}) } } : {}),
      ...(fixtureEvidence ? { fixtures: fixtureEvidence } : {}),
      ...(proposals.length > 0 ? { proposals: proposals.map(summarizeProposal) } : {}),
      codegraph: codegraphEvidence,
      observability,
      summary,
    });
    sealed = true;
    const { mergeRequest, publication } = await publishRun({
      publisher, summary, rehearsal, config, workspace, branch, input, runId, proposals, receiptHash, receiptSigner,
    });
    const cleanup = await cleanupWorkspace({
      policy: effectiveCleanupPolicy,
      published: Boolean(mergeRequest),
      workspace,
      manager: worktreeManager,
    });
    return {
      runId,
      status: summary.status,
      ...(dryRun ? { mode: "dry-run" } : {}),
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
      ...(rehearsal ? { mergeRehearsal: rehearsal } : {}),
      ...(mergeTrain ? { mergeTrain } : {}),
      ...(fixtureEvidence ? { fixtures: fixtureEvidence } : {}),
      codegraph: codegraphEvidence,
      observability,
      mergeRequest,
      ...(publication ? { publication } : {}),
    };
  } catch (error) {
    await releaseTools(run).catch(swallow("closing tools after a failed finish", undefined));
    if (!sealed) {
      error.run = { runId, workspace, receiptPath };
      try {
        error.run.receiptHash = await receiptStore.append({
          type: "workflow",
          terminal: true,
          runId,
          mode: dryRun ? "dry-run" : "execute",
          status: "failed",
          phase: "finish",
          durationMs: Date.now() - startedAt,
          workspace,
          content: contentEvidence,
          summary: { status: "failed", error: error.message },
        });
      } catch (sealError) {
        // The failure that matters is the first one; this is only noted on it.
        error.sealFailure = sealError.message;
      }
    }
    throw error;
  }
}

// One receipt entry per finished step: the step, what kind of effect it can
// have, and the digest of the workspace it left behind. The effect is derived
// from what the step is and what it was approved to do; it is a label for
// readers, never a permission.
async function recordStepEvidence(receiptStore, /** @type {any} */ { runId, step, result, workspace, reused, effect: carriedEffect }) {
  const approvals = Array.isArray(result?.approvals) ? result.approvals : [];
  const reachedOut = approvals.some((approval) => approval?.operationKind === "network");
  const effect = carriedEffect ?? (reachedOut ? "external" : step.type === "gate" ? "read" : "workspace");
  await receiptStore.append({
    type: "step",
    runId,
    step: step.id,
    stepType: step.type,
    status: "succeeded",
    effect,
    ...(reused ? { reused } : {}),
    workspaceDigest: await workspaceDigest(workspace.path),
  });
}

// The worktree of an earlier run, taken over by a run that continues it. It has
// to be one git still knows, on the branch the earlier run recorded.
// Where the run works: the earlier run's worktree when resuming (with what its
// stopped step left discarded, if the person asked), a new worktree, or the
// checkout itself.
async function openWorkspace({ resume, useWorktree, worktreeManager, runId, branch, baseRef, bootstrapConfig, repositoryRoot }) {
  const workspace = resume
    ? await adoptWorkspace(worktreeManager, resume.workspace)
    : useWorktree
      ? await worktreeManager.create({
        name: `run-${runId}`,
        branch,
        startPoint: baseRef ?? bootstrapConfig.git?.baseRef ?? "HEAD",
      })
      : { name: "in-place", branch: await currentBranch(repositoryRoot), path: repositoryRoot, managed: false };
  if (useWorktree) workspace.managed = true;
  // The person asked for what the stopped step left behind to be discarded
  // (the plan listed it): the worktree goes back to how the last finished
  // step left it, before anything runs in it.
  if (resume?.reset) await restoreWorkspace(workspace.path, resume.reset.digest);
  return workspace;
}

// What each step will use, so a surface can name the agents of a workflow
// before any of them has started.
function plannedSteps(workflow) {
  return workflow.steps.map((step) => ({
    id: step.id,
    type: step.type ?? "agent",
    agents: step.type === "quorum" ? (step.agents ?? []) : step.type === "ladder" ? [step.agent, ...(step.router ? [step.router.agent] : []), ...(step.verify ?? []).concat(step.verifyLight ?? []).flatMap((verifier) => verifier.reviewer ? [verifier.reviewer] : [])] : (step.type ?? "agent") === "agent" && step.agent ? [step.agent] : [],
    ...(step.type === "check" ? { command: (step.command ?? []).join(" ") } : {}),
    ...(step.needs?.length ? { needs: step.needs } : {}),
  }));
}

async function adoptWorkspace(manager, { path, branch }) {
  const wanted = resolve(path);
  const known = (await manager.list()).find((entry) => typeof entry.worktree === "string" && resolve(entry.worktree) === wanted);
  if (!known) throw new Error(`The earlier run's worktree is no longer registered with git: ${wanted}.`);
  if (known.branch && known.branch !== `refs/heads/${branch}`) {
    throw new Error(`The earlier run's worktree is on '${String(known.branch).replace("refs/heads/", "")}', not on '${branch}'.`);
  }
  return { name: basename(wanted), branch, path: wanted, managed: true, adopted: true };
}

// Closes the code index and the MCP servers, once, however the run ends.
async function releaseTools(run) {
  if (run.toolsReleased) return;
  run.toolsReleased = true;
  try {
    run.codegraph?.graph.close();
  } finally {
    await run.mcp?.close();
  }
}

// PATH and the locale are what any command needs. The rest are what one needs
// on Termux, where a check without them fails before it runs: LD_PRELOAD holds
// libtermux-exec, which is what lets Android execute a script's interpreter at
// all — without it 'npm' dies as "env: 'node': Permission denied" — and PREFIX,
// LD_LIBRARY_PATH and the ANDROID_* pair are read by the loader and by every
// wrapper script. None of them carry credentials, which is what this list
// keeps out; they come from the same shell that started the run, exactly as
// PATH does.
export const checkEnvironmentForTest = commandEnvironment;
const checkEnvironment = commandEnvironment;

async function resolveSandboxConfig(sandboxConfig, workspacePath) {
  if (sandboxConfig.enabled !== true || sandboxConfig.useDevcontainerImage !== true) return sandboxConfig;
  const devcontainer = await readDevcontainerImage(workspacePath, sandboxConfig.devcontainerPath
    ? { path: sandboxConfig.devcontainerPath }
    : {});
  if (!devcontainer.image && devcontainer.build) {
    if (sandboxConfig.buildDevcontainerImage !== true) {
      throw new Error(
        `The devcontainer builds its image rather than naming one (${devcontainer.reason}).`
        + " Set sandbox.buildDevcontainerImage to build it, prebuild it and set sandbox.image,"
        + " or unset sandbox.useDevcontainerImage.",
      );
    }
    const built = await buildDevcontainerImage(workspacePath, {
      build: devcontainer.build,
      runtime: sandboxConfig.runtime ?? "docker",
    });
    return { ...sandboxConfig, image: built.image, imageSource: devcontainer.source, imageBuilt: built.built };
  }
  if (!devcontainer.image) {
    throw new Error(
      `sandbox.useDevcontainerImage is set, but no image was found (${devcontainer.reason}).`
      + " Add an 'image' to the devcontainer, or unset the option to use sandbox.image.",
    );
  }
  return { ...sandboxConfig, image: devcontainer.image, imageSource: devcontainer.source };
}

function assertWorkflowAgents(harness, workflow) {
  const referenced = workflow.steps.flatMap((step) => {
    if (step.type === "quorum") return step.agents ?? [];
    if (step.type === "ladder") return [step.agent, step.router?.agent, ...(step.verify ?? []).concat(step.verifyLight ?? []).map((verifier) => verifier.reviewer)];
    return step.type === "agent" || step.type === undefined ? [step.agent] : [];
  });
  const missing = [...new Set(referenced.filter((name) => name && !harness.agents.has(name)))];
  if (missing.length === 0) return;
  const available = harness.agents.list();
  throw new Error([
    `Unknown workflow agent${missing.length > 1 ? "s" : ""}: ${missing.map((name) => `'${name}'`).join(", ")}.`,
    available.length > 0
      ? `Configured agents: ${available.join(", ")}.`
      : "No agents are defined. Add a manifest under '.etnpilot/agents/'.",
  ].join(" "));
}

async function describeProjectLoadError(error, useWorktree, repositoryRoot) {
  if (error?.code === "content-lock-mismatch" && useWorktree) return await explainUncommittedContent(error, repositoryRoot);
  if (error?.code !== "ENOENT" || !useWorktree) return error;
  const detailed = new Error(
    "The run worktree has no '.etnpilot/etnpilot.yaml'. A worktree is created from the committed"
    + " base ref, so commit '.etnpilot/' first or run with --no-worktree.",
  );
  detailed.code = "etnpilot_content_not_committed";
  detailed.cause = error;
  return detailed;
}

// A run works in a worktree made from the last commit. A workflow or agent that
// was made since (on the page, say) is a file in the checkout and nothing in the
// worktree, so the run says it does not exist, which is true there and not what a
// person who just made it expects to read. Said here, with the file and the fix.
async function explainMissingName(error, repositoryRoot, useWorktree) {
  const unknownWorkflow = error?.code === "unknown_workflow";
  const unknownAgent = /^Unknown workflow agent/.test(String(error?.message ?? ""));
  if (!useWorktree || (!unknownWorkflow && !unknownAgent)) return error;
  const status = await git(["status", "--porcelain", "--untracked-files=all", "--", ".etnpilot"], { cwd: repositoryRoot }).then((result) => result.stdout, () => "");
  const files = status.split("\n").filter(Boolean).map((line) => line.slice(3).trim().replace(/^"|"$/g, ""));
  const prefix = unknownWorkflow ? ".etnpilot/workflows/" : ".etnpilot/agents/";
  const mine = files.filter((file) => file.startsWith(prefix));
  if (mine.length === 0) return error;
  const explained = new Error(
    `${error.message} In your checkout there ${mine.length === 1 ? "is a file" : "are files"} that the run's worktree does not have, because ${mine.length === 1 ? "it is" : "they are"} not committed: ${mine.join(", ")}.`
    + " A run works on committed content, which is what was reviewed. Commit "
    + `${mine.length === 1 ? "it" : "them"} (git add .etnpilot && git commit -m "Add ETNPilot workflow") and run again, or choose 'Work directly in this directory'.`,
  );
  explained.code = error.code;
  explained.cause = error;
  explained.workspaceCleanup = error.workspaceCleanup;
  return explained;
}

// A worktree starts from the last commit. Content that was changed, or locked,
// after it is in the checkout and not in the worktree, so the lock the worktree
// holds is the old one and the check fails for a reason the message did not
// give. Said here, with the files.
async function explainUncommittedContent(error, repositoryRoot) {
  const status = await git(["status", "--porcelain", "--untracked-files=all", "--", ".etnpilot"], { cwd: repositoryRoot }).then((result) => result.stdout, () => "");
  const files = status.split("\n").filter(Boolean).map((line) => line.slice(3).trim());
  if (files.length === 0) return error;
  const explained = new Error(
    `${error.message} The run's worktree starts from the last commit, and in your checkout these differ from it: ${files.slice(0, 6).join(", ")}${files.length > 6 ? ` and ${files.length - 6} more` : ""}.`
    + " If you reviewed and locked them, commit them (git add .etnpilot && git commit) and run again.",
  );
  explained.code = error.code;
  explained.details = error.details;
  explained.cause = error;
  return explained;
}

async function discardWorkspace(workspace, manager, branch) {
  if (!workspace?.managed) return { removed: false, reason: "in-place-run" };
  // A worktree this run took over belongs to the run it came from.
  if (workspace.adopted) return { removed: false, reason: "adopted-workspace" };
  try {
    const removal = await manager.removeIfClean(workspace.name);
    if (!removal.removed) return removal;
    await manager.deleteBranch(branch).catch(() => {});
    return { ...removal, branch, branchRemoved: true };
  } catch (error) {
    return { removed: false, reason: "cleanup-failed", error: error.message };
  }
}

// Only worth asking once the branch itself merges: a branch that already
// conflicts with its target has a nearer problem than the queue behind it.
async function inspectTrain({ config, token, workspace, branch, fetchImpl }) {
  const train = config.git?.mergeTrain ?? {};
  if (train.enabled !== true || !config.git?.project || !token) return undefined;
  try {
    return await inspectMergeTrain({
      client: new GitLabClient({ baseUrl: config.git.baseUrl, token, fetchImpl }),
      project: config.git.project,
      cwd: workspace.path,
      remote: config.git.remote,
      targetBranch: config.git.targetBranch ?? "main",
      ownBranch: branch,
      limit: train.maxMergeRequests ?? 10,
    });
  } catch (error) {
    return { inspected: false, reason: "merge-train-failed", error: error.message };
  }
}

async function finishFixtures(recorder, player) {
  if (recorder) {
    const written = await recorder.flush();
    return { mode: "recorded", ...written };
  }
  if (player) {
    return { mode: "replayed", exchanges: player.consumed.length, unusedExchanges: player.remaining() };
  }
  return undefined;
}

async function verifyContentAfterRun(root, config, initial) {
  if (!initial || initial.mode === "off" || initial.verifyAfterRun === false) return initial;
  const verified = await verifyProjectContent(root, config, initial);
  return { ...verified, verifiedAfterRun: true };
}

// Independent reviewers, usually on different providers, must agree before a
// change is considered reviewed. Their verdicts and the arithmetic are part of
// the receipt, so the decision can be re-checked later.
// The approval path, used for a decision about the run rather than about an
// operation: same inbox, same surfaces, same receipt. 'approval.allow' cannot
// wave it through, because a gate nobody answers is not a gate.
async function runGateStep(step, harness, { execution, runId, workspace }) {
  const previous = Object.entries(execution.dependencyResults ?? {});
  const textOf = (result) => {
    const payload = result?.result ?? result ?? {};
    return payload.result?.text ?? payload.text;
  };
  const context = { runId, agent: step.id, workspace: workspace.path };
  // What the steps before left open, asked one question at a time before the
  // run goes on: a plan that ends in four questions is four decisions, and
  // answering them as one "yes" is not answering them. A question can be left
  // unanswered; then the next step is told so. `questions: false` turns it off.
  const asked = step.questions === false
    ? []
    : previous.flatMap(([id, result]) => extractOpenQuestions(textOf(result)).map((question) => ({ from: id, question })));
  const answers = [];
  for (const [index, entry] of asked.entries()) {
    const reply = await harness.requestDecision({
      kind: "question",
      toolName: step.id,
      toolArguments: { step: step.id, from: entry.from, number: index + 1, of: asked.length },
      fullCommandText: entry.question,
    }, context);
    const text = reply.kind === "approve-once" ? String(reply.answer ?? reply.reason ?? "").trim() : "";
    answers.push({ from: entry.from, question: entry.question, answer: text === "" ? null : text });
  }
  const forReview = [
    ...previous.map(([id, result]) => `### ${id}\n${textOf(result) ?? "(it produced no text)"}`),
    ...(answers.length > 0
      ? [`### Your answers to the open questions\n${answers.map((entry, index) => `${index + 1}. ${entry.question}\n   -> ${entry.answer ?? "(not answered)"}`).join("\n")}`]
      : []),
  ].join("\n\n");
  const decision = await harness.requestDecision({
    kind: step.kind ?? "plan",
    toolName: step.id,
    // The whole thing, because this is the one decision whose entire point is
    // that somebody read it.
    toolArguments: { step: step.id, waitingOn: previous.map(([id]) => id) },
    diff: forReview,
    fullCommandText: step.prompt ?? `Continue the run past '${step.id}'?`,
  }, context);
  if (decision.kind !== "approve-once") {
    const error = new Error(
      `Stopped at '${step.id}': ${decision.reason ?? "the plan was not approved"}.`,
    );
    error.code = "gate_rejected";
    throw error;
  }
  return { step: step.id, approved: true, evidence: decision.evidence, reviewed: previous.map(([id]) => id), ...(answers.length > 0 ? { answers } : {}) };
}

async function runQuorumStep(step, harness, { input, execution, metadata, traceMetadata, runId, workspace }) {
  const agents = step.agents ?? [];
  if (agents.length === 0) throw new Error(`Quorum step '${step.id}' requires at least one agent.`);
  const run = (agentName) => harness.run({
    agent: agentName,
    input: `${composeAgentInput(input, execution.dependencyResults)}\n\n${QUORUM_INSTRUCTION}`,
    metadata: {
      ...metadata,
      ...traceMetadata,
      workflowRunId: runId,
      workflowStep: step.id,
      workspace: workspace.path,
    },
    signal: execution.signal,
  });

  const receipts = step.sequential === true
    ? await runSequentially(agents, run)
    : await Promise.all(agents.map(run));
  const votes = receipts.map((receipt, index) => ({
    agent: agents[index],
    provider: receipt.provider,
    verdict: parseVerdict(receipt.result?.text),
    runId: receipt.runId,
  }));
  const outcome = evaluateQuorum(votes, {
    required: step.required,
    distinctProviders: step.distinctProviders !== false,
  });
  if (!outcome.satisfied) throw quorumError(outcome);
  return outcome;
}

// The ladder: one tier at a time, cheapest first, each result verified. A tier
// is the step's agent with another model, provider and effort, registered
// under its own name for the run so the receipt says which one answered.
async function verifyLadderCommand(step, verifier, { workspace, root, execution, checkEnv, sandbox, telemetry, traceMetadata, runId }) {
  try {
    await runObservedCheck({ ...step, id: `${step.id}-verify`, name: verifier.name ?? verifier.command.join(" "), command: verifier.command }, {
      cwd: workspace.path, root, signal: execution.signal, env: checkEnv, sandbox, telemetry, trace: traceMetadata, workflowRunId: runId,
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, detail: String(error.message ?? error), code: error.exitCode };
  }
}

async function runLadderStep(step, harness, { input, execution, metadata, traceMetadata, runId, workspace, receiptStore, verifyCommand, checkBaseline }) {
  const base = harness.agents.get(step.agent);
  const composed = composeAgentInput(input, execution.dependencyResults);
  const call = (agent, text) => harness.run({
    agent,
    input: text,
    metadata: { ...metadata, ...traceMetadata, workflowRunId: runId, workflowStep: step.id, workspace: workspace.path },
    signal: execution.signal,
  });
  const result = await runLadder(step, {
    input: composed,
    signal: execution.signal,
    record: (entry) => receiptStore.append({ runId, ...entry }),
    runAgent: async (tier, text) => {
      const name = `${step.agent}.${step.id}-t${tier.index + 1}`;
      const variant = Object.freeze(tierAgent(base, name, tier));
      if (harness.agents.has(name)) harness.agents.replace(name, variant);
      else harness.agents.register(name, variant);
      return call(name, text);
    },
    runReviewer: (name, text) => call(name, text),
    runTriage: step.router ? (text) => call(step.router.agent, text) : undefined,
    verifyCommand,
    checkBaseline,
  });
  return result;
}

function tierAgent(base, name, tier) {
  const next = { ...base, name };
  if (tier.model) next.model = tier.model;
  if (tier.effort) next.effort = tier.effort;
  if (tier.provider) {
    next.provider = tier.provider;
    delete next.providers;
  }
  return next;
}

async function runSequentially(agents, run) {
  const receipts = [];
  for (const agent of agents) receipts.push(await run(agent));
  return receipts;
}

// A linked worktree is a fresh checkout: it has the repository's files and no
// 'node_modules' of its own. That is only a problem when nothing above it has
// one either — a worktree inside the project, which is where ETNPilot puts
// them, resolves to the checkout's own, exactly as Node does. Saying
// 'dependencies are missing' about a worktree that finds them would be the
// same invention this file keeps removing, so the walk up is done rather than
// assumed.
export const dependenciesMissingForTest = (cwd, root) => dependenciesMissing(cwd, root);

async function dependenciesMissing(cwd, root) {
  if (resolve(cwd) === resolve(root)) return false;
  if (!await access(join(cwd, "package.json")).then(() => true, () => false)) return false;
  let directory = resolve(cwd);
  for (;;) {
    if (await access(join(directory, "node_modules")).then(() => true, () => false)) return false;
    const parent = dirname(directory);
    if (parent === directory) return true;
    directory = parent;
  }
}

async function runObservedCheck(step, { cwd, signal, env, telemetry, trace, workflowRunId, sandbox, root }) {
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
    const command = sandbox ? sandbox.wrap(step.command, { env, cwd }) : step.command;
    const result = await runCheck({ ...step, command }, { cwd, signal, env });
    await span?.end({ attributes: { "etnpilot.duration_ms": Date.now() - startedAt } });
    return sandbox ? { ...result, sandbox: sandbox.describe(), declaredCommand: step.command } : result;
  } catch (error) {
    await span?.end({
      status: "error",
      attributes: {
        "error.type": error.code ?? error.name ?? "check_failed",
        "etnpilot.duration_ms": Date.now() - startedAt,
      },
    });
    if (root && await dependenciesMissing(cwd, root)) {
      error.message += `\nThis ran in ${cwd}, a linked worktree with a 'package.json' and no`
        + " 'node_modules' in it or above it, so the project's dependencies are not installed"
        + " where the check ran. Install them there, or run in the checkout itself with"
        + " 'etnpilot config set workspace.mode in-place' — that stays local.";
    }
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

function applyAgentOverride(harness, name, override) {
  const current = harness.agents.get(name);
  const next = { ...current };
  if (override.model) next.model = override.model;
  // A list, possibly empty: an agent that may use nothing, mechanically.
  if (Array.isArray(override.tools)) next.tools = override.tools;
  if (override.effort) {
    if (!["low", "medium", "high"].includes(override.effort)) throw new TypeError("effort must be low, medium or high.");
    next.effort = override.effort;
  }
  if (override.provider) {
    // One provider, chosen. The router still asks the policy before anything is
    // sent, so this cannot reach a provider the project does not allow.
    next.provider = override.provider;
    delete next.providers;
  }
  harness.agents.replace(name, Object.freeze(next));
}

// A workflow chosen by name is one of the project's pinned workflow files; a
// name that is not among them is refused with the names that are.
function selectNamedWorkflow(workflows, name) {
  const found = workflows.get(name);
  if (!found) {
    const available = [...workflows.keys()];
    const error = new Error(`There is no workflow called '${name}'.${available.length > 0 ? ` The project has: ${available.join(", ")}.` : " The project has none in '.etnpilot/workflows/'."}`);
    error.code = "unknown_workflow";
    throw error;
  }
  return found;
}

function normalizeWorkflow(workflow = {}, { requested, fallback, named } = /** @type {any} */ ({})) {
  // Asking for an agent by name means running that agent. Letting the
  // configured steps win would make '--agent', the issue trigger's agent, and
  // the run prompt quietly decorative wherever a project defines a workflow.
  const steps = requested
    ? [{ id: "agent", type: "agent", agent: requested }]
    : named?.steps?.length
      ? named.steps
    : workflow.steps?.length
      ? workflow.steps
      : [{ id: "agent", type: "agent", agent: fallback }];
  return {
    concurrency: workflow.concurrency ?? 1,
    failFast: workflow.failFast ?? true,
    timeoutMs: workflow.timeoutMs ?? 30 * 60_000,
    maxSteps: workflow.maxSteps ?? 50,
    steps,
  };
}

// What a step must have done, not only that its agent answered. A model that
// describes a change, or asks whether it may make one, returns a perfectly
// successful message and touches nothing — and a workflow that calls that
// 'succeeded' is reporting work that did not happen. A step that exists to
// change the repository says so, and is held to it.
const STEP_EXPECTATIONS = new Set(["tool-use"]);

// Exported under its own name so a test can put a step and a receipt to it
// without starting a run.
export const assertStepExpectationForTest = (step, receipt) => assertStepExpectation(step, receipt);

function assertStepExpectation(step, receipt) {
  if (step.expect === undefined) return;
  if (!STEP_EXPECTATIONS.has(step.expect)) {
    throw new TypeError(
      `Workflow step '${step.id}' expects '${step.expect}', which is not something a step can expect.`
      + ` The only one is 'tool-use'.`,
    );
  }
  const calls = receipt?.result?.toolCalls ?? receipt?.result?.steps ?? [];
  if (calls.some((call) => call.ok !== false)) return;
  const refused = calls.filter((call) => call.ok === false);
  const said = String(receipt?.result?.text ?? "").trim().replace(/\s+/g, " ").slice(0, 300);
  throw new Error(
    `Workflow step '${step.id}' ran agent '${step.agent}' and changed nothing:`
    + (refused.length > 0
      ? ` every tool call was refused (${refused.map((call) => call.tool ?? "a tool").join(", ")}).`
      : " it called no tool at all.")
    + " This step declares 'expect: tool-use', so describing the work is not doing it."
    + (said ? ` The agent answered: ${said}` : ""),
  );
}

// What the next step is told about the one before it. This used to be
// 'JSON.stringify(result, null, 2)' of the whole thing — every field, indented
// — so four steps with long answers filled the context window before the
// fourth agent had read its own task.
//
// What a following step actually needs is what the previous one concluded and
// what it touched, not the shape of the object that carried it.
const DEPENDENCY_TEXT_LIMIT = 4000;

export const composeAgentInputForTest = (input, dependencies) => composeAgentInput(input, dependencies);

function composeAgentInput(input, dependencies) {
  if (Object.keys(dependencies).length === 0) return String(input);
  const evidence = Object.entries(dependencies).map(([id, result]) => {
    const payload = result?.result ?? result ?? {};
    const parts = [];
    const text = typeof payload === "string" ? payload : payload.text;
    if (text) {
      parts.push(text.length > DEPENDENCY_TEXT_LIMIT
        ? `${text.slice(0, DEPENDENCY_TEXT_LIMIT)}\n[…${text.length - DEPENDENCY_TEXT_LIMIT} more characters]`
        : text);
    }
    const files = payload.workspace?.changedPaths ?? payload.changedPaths;
    if (Array.isArray(files) && files.length > 0) {
      parts.push(`Files it changed: ${files.slice(0, 50).join(", ")}${files.length > 50 ? `, and ${files.length - 50} more` : ""}`);
    }
    const tools = payload.toolCalls;
    if (Array.isArray(tools) && tools.length > 0) {
      const refused = tools.filter((call) => call.ok === false);
      parts.push(`Tools: ${tools.length} call${tools.length === 1 ? "" : "s"}`
        + (refused.length > 0 ? `, ${refused.length} refused (${[...new Set(refused.map((call) => call.tool))].join(", ")})` : ""));
    }
    if (Array.isArray(payload.answers) && payload.answers.length > 0) {
      parts.push(`Answers to the open questions:\n${payload.answers.map((entry) => `- ${entry.question}\n  Answer: ${entry.answer ?? "(not answered; use your judgement and say what you assumed)"}`).join("\n")}`);
    }
    if (payload.status && payload.status !== "succeeded") parts.push(`Status: ${payload.status}`);
    if (payload.error) parts.push(`Error: ${payload.error}`);
    return `### ${id}\n${parts.join("\n\n") || "(it produced no text)"}`;
  }).join("\n\n");
  return `${input}\n\nWhat the earlier steps did:\n\n${evidence}`;
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

function codegraphAsServer(descriptor) {
  return {
    command: descriptor.command,
    args: descriptor.args,
    cwd: descriptor.cwd,
    env: descriptor.env,
    timeoutMs: descriptor.timeout,
    tools: descriptor.tools,
    readOnlyTools: descriptor.tools,
  };
}

function createCodegraph(workspaceRoot, config, { importer } = /** @type {any} */ ({})) {
  if (config.codegraph?.enabled === false || config.codegraph?.autoIndex === false) return null;
  return {
    graph: new CodeGraph(workspaceRoot, importer ? { importer } : undefined),
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

export async function runProject(options = {}) {
  const root = resolve(options.root ?? process.cwd());
  const config = await loadConfig(join(root, ".etnpilot", "etnpilot.yaml"), options.env ?? process.env);
  const inPlace = options.worktree === false || (options.worktree === undefined && (options.inPlace || config.workspace?.mode === "in-place"));
  const lease = inPlace && !options.workspaceLease ? await acquireWorkspaceLease(root, { sessionId: options.session?.id }) : undefined;
  try { return await executeProject(options); }
  finally { lease?.release(); }
}

// What the code index saw before and after the run, and what the change reaches.
// The index is closed here whatever happens.
async function describeCodegraph({ codegraph, codegraphBefore, codegraphUnavailable, workspace, gitEvidence, config }) {
  if (codegraphUnavailable) {
    return { engine: "@colbymchenry/codegraph", available: false, reason: codegraphUnavailable };
  }
  if (!codegraph) return undefined;
  try {
    const update = await codegraph.graph.indexDirectory(workspace.path);
    const sourceChanges = gitEvidence.changedPaths.filter(isSourcePath);
    const maxDepth = config.codegraph?.maxImpactDepth ?? 20;
    return {
      engine: "@colbymchenry/codegraph",
      indexPath: join(workspace.path, ".codegraph"),
      before: codegraphBefore,
      after: update,
      impact: sourceChanges.length > 0
        ? codegraph.graph.impact(sourceChanges, { maxDepth })
        : { changed: [], files: [], tests: [], maxDepth },
    };
  } finally {
    codegraph.graph.close();
  }
}

// Publishing is never implicit, and never of unreviewed work: a failed workflow, or a
// branch that conflicts with its target, is reported instead of pushed.
async function publishRun({ publisher, summary, rehearsal, config, workspace, branch, input, runId, proposals, receiptHash, receiptSigner }) {
  if (publisher && summary.status !== "succeeded") {
    // Even when fail-fast is disabled and the engine returned without throwing.
    return { publication: { published: false, reason: "workflow-not-succeeded" } };
  }
  if (publisher && rehearsal?.clean === false && config.git?.publishOnConflict !== true) {
    return { publication: { published: false, reason: "merge-conflict", conflicts: rehearsal.conflicts } };
  }
  if (!publisher) return {};
  const mergeRequest = await publisher.publish({
    cwd: workspace.path,
    branch,
    targetBranch: config.git?.targetBranch ?? "main",
    title: `ETNPilot: ${firstLine(input)}`,
    description: `Automated ETNPilot run \`${runId}\`. Review the attached evidence before merging.`
      + describeProposals(proposals, { tainted: proposals.find((entry) => entry.tainted)?.tainted }),
    proposalsPath: proposals.length > 0 ? PROPOSALS_ROOT : undefined,
    receipt: receiptHash,
    receiptProof: receiptSigner ? { algorithm: receiptSigner.algorithm, keyId: receiptSigner.keyId } : undefined,
  });
  return { mergeRequest, publication: { published: true, ...(mergeRequest?.noteError ? { noteError: mergeRequest.noteError } : {}) } };
}

// Indexes the workspace before the run. A machine with no compiled index loses
// the index, not the run: the sandbox fails a run because it is a safeguard, an
// index is not. The receipt then says the index was absent, so no later reader
// assumes it was consulted. Any other indexing failure still stops the run.
async function indexCodegraph(codegraph, { workspace, harness, signal }) {
  try {
    const before = await codegraph.graph.indexDirectory(workspace.path, { signal });
    harness.instructions.push([
      "CodeGraph is available through the codegraph_explore MCP tool"
        + " (offered as codegraph.codegraph_explore by providers that prefix a server name).",
      "Query it before planning broad edits and use its refreshed index when reviewing changes.",
    ].join("\n"));
    return { before };
  } catch (error) {
    if (!isCodeGraphUnavailable(error)) throw error;
    codegraph.graph.close();
    return { unavailable: error.message };
  }
}

// The project's own MCP servers, for every provider rather than one. A server
// that will not start costs its tools, not the run. CodeGraph is one of them for
// the chat providers: the same descriptor the Copilot adapter is handed, spoken
// through the same client as any other server.
async function connectProjectMcp({ codegraph, config, harness, errors }) {
  const servers = {
    ...(codegraph ? { codegraph: codegraphAsServer(codegraph.mcp) } : {}),
    ...config.mcpServers,
  };
  if (Object.keys(servers).length === 0) return undefined;
  return connectMcpTools(servers, {
    onError: ({ server, error }) => {
      errors.push({ server, error });
      harness.instructions.push(`The MCP server '${server}' is unavailable: ${error}`);
    },
  });
}

// Offline execution: recorded answers stand in for every provider.
async function playbackProviders({ fixtures, repositoryRoot, config }) {
  return fixtureProviderFactories(await loadFixtures(resolve(repositoryRoot, fixtures)), {
    types: Object.values(config.providers ?? {}).map((entry) => entry.type),
    strict: config.fixtures?.strict !== false,
  });
}

function recordProviders(harness, { recordFixtures, repositoryRoot, config }) {
  const recorder = createFixtureRecorder({
    path: resolve(repositoryRoot, recordFixtures),
    redact: config.fixtures?.redact !== false,
  });
  for (const name of harness.providers.list()) {
    harness.providers.replace(name, recorder.wrap(harness.providers.get(name)));
  }
  return recorder;
}
