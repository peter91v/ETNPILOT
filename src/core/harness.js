import { randomUUID } from "node:crypto";
import { EventBus } from "./events.js";
import { Registry } from "./registry.js";
import { WORKSPACE_TOOL_DEFINITIONS } from "../providers/workspace-tools.js";
import { telemetryProviderAttributes } from "../observability/telemetry.js";

const DEFAULT_MAX_SUBAGENT_DEPTH = 4;
const MAX_PROPOSALS_PER_RUN = 5;

const EFFORT_LEVELS = Object.freeze(["low", "medium", "high"]);

const WORKSPACE_TOOL_NAMES = new Set(WORKSPACE_TOOL_DEFINITIONS.map((definition) => definition.name));

// What a yes covers when the person deciding named no scope of their own:
// the directory a write was in, or the program a command ran. Never wider than
// what was in front of them.
function defaultScope(request) {
  if (request?.kind === "write" && request.fileName) {
    const at = String(request.fileName).lastIndexOf("/");
    return at === -1 ? "*" : `${String(request.fileName).slice(0, at)}/**`;
  }
  if (request?.kind === "shell" && request.fullCommandText) {
    return String(request.fullCommandText).trim().split(/\s+/)[0];
  }
  return undefined;
}

function matchesScope(scope, request) {
  if (request?.kind === "write") {
    const file = String(request.fileName ?? "");
    if (scope === "*") return !file.includes("/");
    if (scope.endsWith("/**")) return file.startsWith(scope.slice(0, -2));
    return file === scope;
  }
  if (request?.kind === "shell") {
    return String(request.fullCommandText ?? "").trim().split(/\s+/)[0] === scope;
  }
  return false;
}

export class Harness {
  #grants;
  #tainted;

  constructor({
    approvalPolicy,
    approvalHandler,
    receiptStore,
    policy,
    telemetry,
    secrets,
    maxSubagentDepth = DEFAULT_MAX_SUBAGENT_DEPTH,
  } = {}) {
    if (!Number.isInteger(maxSubagentDepth) || maxSubagentDepth < 1) {
      throw new TypeError("maxSubagentDepth must be a positive integer.");
    }
    this.maxSubagentDepth = maxSubagentDepth;
    this.events = new EventBus();
    this.providers = new Registry("provider");
    this.plugins = new Registry("plugin");
    this.agents = new Registry("agent");
    this.skills = new Registry("skill");
    this.#grants = new Map();
    this.#tainted = new Map();
    this.prompts = new Registry("prompt");
    this.instructions = [];
    // Instructions that apply only where a run works: [{scope, path, content}].
    this.scopedInstructions = [];
    // Observing hooks from the project's configuration; see workspace-tools.
    this.hooks = {};
    // Instruction changes agents suggested: never applied, see content/proposals.
    this.proposals = [];
    this.approvalPolicy = approvalPolicy;
    this.approvalHandler = approvalHandler;
    this.receiptStore = receiptStore;
    this.policy = policy;
    this.telemetry = telemetry;
    this.secrets = secrets;
    this.providerRouter = undefined;
    this.pluginRuntimes = new Set();
  }

  async use() {
    throw new Error("In-process plugins are disabled. Load plugins by module path through loadPlugin() or project configuration.");
  }

  attachPluginRuntime(runtime) {
    this.pluginRuntimes.add(runtime);
    return runtime;
  }

  async close() {
    const runtimes = [...this.pluginRuntimes];
    this.pluginRuntimes.clear();
    await Promise.allSettled(runtimes.map((runtime) => runtime.close()));
  }

  setProviderRouter(router) {
    if (!router || typeof router.invoke !== "function") {
      throw new TypeError("A provider router must expose invoke(context).");
    }
    this.providerRouter = router;
    return router;
  }

  registerProvider(provider) {
    if (!provider?.name || typeof provider.invoke !== "function") {
      throw new TypeError("A provider must expose name and invoke(context).");
    }
    if (provider.capabilities !== undefined && (
      !Array.isArray(provider.capabilities)
      || provider.capabilities.some((capability) => typeof capability !== "string" || capability.length === 0)
    )) {
      throw new TypeError(`Provider '${provider.name}' capabilities must be an array of non-empty strings.`);
    }
    const registered = Object.freeze({ capabilities: [], ...provider });
    this.providers.register(provider.name, registered);
    return registered;
  }

  registerSecretProvider(provider) {
    if (!this.secrets) throw new Error("A secret resolver is required for plugin secret providers.");
    return this.secrets.register(provider);
  }

  approveOperation(request, context = {}) {
    return this.#approve(request, context);
  }

  // A decision about the run itself rather than about an operation on the
  // workspace: does this plan go ahead, is this question answered. The
  // operation policy does not govern it — 'policy.operations' is about reads,
  // writes, commands and hosts — so it goes straight to whoever answers, and
  // no 'approval.allow' entry can wave it through. A gate nobody answers is
  // not a gate.
  async requestDecision(request, context = {}) {
    if (!this.approvalHandler) {
      return { kind: "reject", reason: "Nobody is available to answer: no approval handler is configured." };
    }
    return this.approvalHandler(request, context);
  }

  registerAgent(agent) {
    if (!agent?.name || (!agent.provider && !agent.providers?.length) || !agent.prompt) {
      throw new TypeError(
        `An agent requires name, prompt, and a provider: ${agent?.name ? `'${agent.name}'` : "this manifest"}`
        + " names none, and the project sets no 'defaultProvider' to fall back on.",
      );
    }
    if (agent.effort !== undefined && !EFFORT_LEVELS.includes(agent.effort)) {
      throw new TypeError(`Agent '${agent.name}': 'effort' must be one of ${EFFORT_LEVELS.join(", ")}.`);
    }
    if (agent.tools !== undefined) {
      if (!Array.isArray(agent.tools) || agent.tools.some((name) => typeof name !== "string")) {
        throw new TypeError(`Agent '${agent.name}': 'tools' must be a list of tool names.`);
      }
      // A misspelt name would otherwise read as 'this agent may use nothing',
      // which looks like a model that refuses to work.
      // A dotted name is an MCP tool ('server.tool'); the servers are not
      // connected yet at registration, so it is checked when the run offers
      // its tools, and one that is not there is simply not offered.
      const unknown = agent.tools.filter((name) => !WORKSPACE_TOOL_NAMES.has(name) && !name.includes("."));
      if (unknown.length > 0) {
        throw new TypeError(
          `Agent '${agent.name}' lists tools that do not exist: ${unknown.join(", ")}.`
          + ` Known tools: ${[...WORKSPACE_TOOL_NAMES].join(", ")}.`,
        );
      }
    }
    this.agents.register(agent.name, Object.freeze({ skills: [], subagents: [], requires: [], ...agent }));
    return agent;
  }

  async run({ agent: agentName, input, parentRunId, metadata = {}, signal, ancestry = [] }) {
    signal?.throwIfAborted();
    const agent = this.agents.get(agentName);
    const runId = randomUUID();
    const startedAt = Date.now();
    const approvals = [];
    let receiptWritten = false;
    const runSpan = this.telemetry?.startSpan("invoke_agent", {
      traceId: metadata.traceId,
      parentSpanId: metadata.parentSpanId,
      attributes: {
        "gen_ai.operation.name": "invoke_agent",
        "gen_ai.agent.name": agentName,
        "etnpilot.workflow.run_id": metadata.workflowRunId,
        "etnpilot.agent.run_id": runId,
      },
    });
    let runSpanEnded = false;
    try {
      await this.events.emit("run.started", { runId, parentRunId, agent: agentName });
      const context = {
        runId,
        parentRunId,
        agent,
        input,
        metadata,
        telemetry: this.telemetry,
        trace: runSpan ? { traceId: runSpan.traceId, parentSpanId: runSpan.spanId } : undefined,
        signal,
        instructions: [...this.instructions],
        scopedInstructions: [...this.scopedInstructions],
        hooks: this.hooks,
        // Tells subscribers a tool call finished. Watching only: nothing a
        // subscriber returns changes the call.
        notifyToolCompleted: (info) => this.events.emit("tool.completed", { runId, agent: agentName, ...info }),
        skills: agent.skills.map((name) => this.skills.get(name)),
        spawn: (subagent, subInput) => {
          if (!agent.subagents.includes(subagent)) {
            throw new Error(`Agent '${agentName}' may not spawn '${subagent}'.`);
          }
          // Mutually referencing manifests would otherwise recurse until the
          // process runs out of memory, spending provider budget on the way.
          const chain = [...ancestry, agentName];
          if (chain.includes(subagent)) {
            throw new Error(`Subagent cycle detected: ${[...chain, subagent].join(" -> ")}.`);
          }
          if (chain.length >= this.maxSubagentDepth) {
            throw new Error(
              `Subagent depth limit of ${this.maxSubagentDepth} reached: ${[...chain, subagent].join(" -> ")}.`,
            );
          }
          return this.run({
            agent: subagent,
            input: subInput,
            parentRunId: runId,
            ancestry: chain,
            metadata: {
              ...metadata,
              ...(runSpan ? { traceId: runSpan.traceId, parentSpanId: runSpan.spanId } : {}),
            },
            signal,
          });
        },
        // A question for a person. It shares the approval path's plumbing and
        // none of its meaning: an answer decides nothing, and the operations
        // the model attempts afterwards are each approved on their own.
        ask: async ({ question, options }) => {
          const decision = await this.requestDecision({
            kind: "question",
            toolName: "ask_human",
            fullCommandText: question,
            ...(options ? { toolArguments: { options } } : {}),
          }, { runId, agent: agentName, workspace: metadata.workspace });
          if (decision.kind === "approve-once") {
            return { answered: true, text: decision.answer ?? decision.reason ?? "yes" };
          }
          return { answered: false, reason: decision.reason ?? "Not answered." };
        },
        propose: (proposal) => {
          if (this.proposals.length >= MAX_PROPOSALS_PER_RUN) {
            return { ok: false, error: `At most ${MAX_PROPOSALS_PER_RUN} proposals per run.` };
          }
          if (this.proposals.some((entry) => entry.name === proposal.name)) {
            return { ok: false, error: `'${proposal.name}' is already proposed in this run.` };
          }
          this.proposals.push({
            ...proposal,
            agent: agentName,
            // Recorded now: a proposal written after reading outside text is
            // one a reviewer should read differently.
            ...(this.taintReason(metadata.workflowRunId ?? runId) ? { tainted: this.taintReason(metadata.workflowRunId ?? runId) } : {}),
          });
          return { ok: true, proposed: proposal.name, applied: false, note: "Recorded for review. Nothing has changed." };
        },
        // Called by the one tool that brings in text nobody here wrote.
        taint: (reason) => {
          const dropped = this.markTainted(metadata.workflowRunId ?? runId, reason);
          if (dropped?.dropped > 0) {
            approvals.push({
              operationKind: "grant-revoked",
              decision: "revoked",
              at: new Date().toISOString(),
              evidence: { reason, grantsDropped: dropped.dropped },
            });
          }
        },
        approve: async (request) => {
          const decision = await this.#approve(request, {
            runId,
            agent: agentName,
            queueJobId: metadata.queueJobId,
            workspace: metadata.workspace,
          });
          approvals.push({
            operationKind: request?.kind ?? "unknown",
            decision: decision.kind,
            at: new Date().toISOString(),
            ...(decision.policy ? { policy: decision.policy } : {}),
            ...(decision.approvalId ? { approvalId: decision.approvalId } : {}),
            ...(decision.evidence ? { evidence: decision.evidence } : {}),
          });
          return decision;
        },
      };
      const routed = this.providerRouter
        ? await this.providerRouter.invoke(context)
        : await this.#invokeDirect(agent.provider, context);
      const receipt = {
        runId,
        parentRunId,
        agent: agentName,
        // Which workflow step this invocation belongs to, when it is one — a
        // subagent spawned from inside an agent carries none, and nests under
        // its parent instead. This is what lets a run's agents be read back
        // as the tree they actually ran in, rather than a flat list of lines.
        ...(metadata.workflowStep ? { workflowStep: metadata.workflowStep } : {}),
        provider: routed.provider,
        providerAttempts: routed.attempts,
        status: "succeeded",
        durationMs: Date.now() - startedAt,
        approvals,
        ...(routed.accounting ? { usage: routed.accounting } : {}),
        ...(runSpan ? { trace: { traceId: runSpan.traceId, spanId: runSpan.spanId } } : {}),
        result: routed.result,
      };
      runSpanEnded = true;
      await runSpan?.end({
        attributes: {
          "etnpilot.duration_ms": receipt.durationMs,
        },
      });
      await this.receiptStore?.append(receipt);
      receiptWritten = true;
      await this.events.emit("run.completed", receipt);
      return receipt;
    } catch (error) {
      const receipt = {
        runId,
        parentRunId,
        agent: agentName,
        ...(metadata.workflowStep ? { workflowStep: metadata.workflowStep } : {}),
        provider: error.provider ?? agent.provider,
        providerAttempts: error.providerAttempts ?? [],
        status: "failed",
        durationMs: Date.now() - startedAt,
        approvals,
        ...(runSpan ? { trace: { traceId: runSpan.traceId, spanId: runSpan.spanId } } : {}),
        error: error instanceof Error ? error.message : String(error),
      };
      if (!runSpanEnded) {
        runSpanEnded = true;
        await runSpan?.end({
          status: "error",
          attributes: {
            "error.type": error.code ?? error.name ?? "error",
            "etnpilot.duration_ms": receipt.durationMs,
          },
        });
      }
      // A run contributes exactly one receipt. Anything that fails after the
      // success receipt was sealed is reported, never rewritten.
      if (!receiptWritten) await this.receiptStore?.append(receipt);
      await this.events.emit("run.failed", receipt);
      throw error;
    }
  }

  async #approve(request, context) {
    if (!this.approvalPolicy) return { kind: "reject", reason: "No approval policy configured." };
    const decision = await this.approvalPolicy.evaluate(request, context);
    if (decision.kind !== "human-required") return decision;

    // A yes given earlier in this run, for operations like this one. It never
    // widens what the policy allows: this branch is only reached because the
    // policy already said a human may decide it.
    const covered = this.#coveringGrant(context.workflowRunId ?? context.runId, request);
    if (covered) {
      return {
        kind: "approve-once",
        coveredBy: covered.approvalId,
        scope: covered.scope,
        evidence: { ...covered.evidence, coveredBy: covered.approvalId },
        ...(decision.policy ? { policy: decision.policy } : {}),
      };
    }

    if (!this.approvalHandler) {
      return { kind: "reject", reason: "Human approval is required, but no approval handler is available." };
    }
    // The handler is told why it is being asked, so a reviewer sees the rule
    // that stopped the operation rather than only the operation.
    const handled = await this.approvalHandler(request, {
      ...context,
      ...(decision.policy ? { policy: decision.policy } : {}),
    });
    if (handled?.kind === "approve-for-run") {
      this.#grant(context.workflowRunId ?? context.runId, request, handled);
      return {
        kind: "approve-once",
        scope: handled.scope,
        grantedForRun: true,
        ...(handled.evidence ? { evidence: handled.evidence } : {}),
        ...(decision.policy ? { policy: decision.policy } : {}),
      };
    }
    return decision.policy ? { ...handled, policy: decision.policy } : handled;
  }

  // Everything a run-scoped yes covers, per run. Cleared when the run ends and
  // when the run reads something from outside — see 'markTainted'.
  #grant(runId, request, decision) {
    if (!runId || this.#tainted.has(runId)) return;
    const scope = decision.scope ?? defaultScope(request);
    if (!scope) return;
    const grants = this.#grants.get(runId) ?? [];
    grants.push({ kind: request?.kind, scope, approvalId: decision.approvalId, evidence: decision.evidence });
    this.#grants.set(runId, grants);
  }

  #coveringGrant(runId, request) {
    if (!runId || this.#tainted.has(runId)) return undefined;
    return (this.#grants.get(runId) ?? []).find((grant) => grant.kind === request?.kind && matchesScope(grant.scope, request));
  }

  // The rule the plan made a condition rather than advice: once a run has
  // pulled in text nobody here wrote, every run-scoped yes in it falls back to
  // asking again. A fetched page saying 'change src/auth.js' must not ride
  // through on a grant given for 'src/**' before the page was read.
  markTainted(runId, reason) {
    if (!runId) return;
    this.#tainted.set(runId, reason);
    const dropped = (this.#grants.get(runId) ?? []).length;
    this.#grants.delete(runId);
    return { dropped, reason };
  }

  taintReason(runId) {
    return this.#tainted.get(runId);
  }

  releaseRun(runId) {
    this.#grants.delete(runId);
    this.#tainted.delete(runId);
  }

  async #invokeDirect(providerName, context) {
    const policyDecision = this.policy?.evaluateProvider(providerName, { agent: context.agent.name });
    if (policyDecision?.allowed === false) {
      const error = new Error(policyDecision.reason ?? "Provider is denied by policy.");
      error.provider = providerName;
      error.providerAttempts = [{
        provider: providerName,
        status: "skipped",
        reason: "policy-denied",
        policy: policyDecision.policy,
      }];
      throw error;
    }
    const startedAt = Date.now();
    const providerSpan = this.telemetry?.startSpan("gen_ai.invoke_agent", {
      traceId: context.trace?.traceId,
      parentSpanId: context.trace?.parentSpanId,
      kind: 3,
      attributes: {
        "gen_ai.operation.name": "chat",
        "gen_ai.request.model": context.agent.model,
        "etnpilot.provider.name": providerName,
        "etnpilot.agent.name": context.agent.name,
        "etnpilot.workflow.run_id": context.metadata?.workflowRunId,
        "etnpilot.agent.run_id": context.runId,
      },
    });
    let result;
    try {
      result = await this.providers.get(providerName).invoke(context);
    } catch (error) {
      const attempt = { provider: providerName, status: "failed", durationMs: Date.now() - startedAt };
      await providerSpan?.end({
        status: "error",
        attributes: {
          "error.type": error.code ?? error.name ?? "provider_error",
          "etnpilot.duration_ms": attempt.durationMs,
        },
      });
      error.provider ??= providerName;
      error.providerAttempts ??= [attempt];
      throw error;
    }
    const accounting = this.telemetry?.recordProviderUsage({
      workflowRunId: context.metadata?.workflowRunId,
      agentRunId: context.runId,
      provider: providerName,
      model: result?.model ?? context.agent.model,
      usage: result?.usage,
    });
    const attempt = { provider: providerName, status: "succeeded", durationMs: Date.now() - startedAt };
    await providerSpan?.end({
      attributes: {
        "etnpilot.duration_ms": attempt.durationMs,
        ...telemetryProviderAttributes(accounting),
      },
    });
    if (accounting?.budgetExceeded) {
      const error = new Error("Workflow usage budget exceeded.");
      error.code = "budget_exceeded";
      error.budget = accounting.budgetExceeded;
      error.provider = providerName;
      error.providerAttempts = [attempt];
      throw error;
    }
    return {
      provider: providerName,
      result,
      accounting,
      attempts: [attempt],
    };
  }
}
