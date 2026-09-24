import { randomUUID } from "node:crypto";
import { EventBus } from "./events.js";
import { Registry } from "./registry.js";
import { telemetryProviderAttributes } from "../observability/telemetry.js";

const DEFAULT_MAX_SUBAGENT_DEPTH = 4;

export class Harness {
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
    this.prompts = new Registry("prompt");
    this.instructions = [];
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

  registerAgent(agent) {
    if (!agent?.name || (!agent.provider && !agent.providers?.length) || !agent.prompt) {
      throw new TypeError(
        `An agent requires name, prompt, and a provider: ${agent?.name ? `'${agent.name}'` : "this manifest"}`
        + " names none, and the project sets no 'defaultProvider' to fall back on.",
      );
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
    if (!this.approvalHandler) {
      return { kind: "reject", reason: "Human approval is required, but no approval handler is available." };
    }
    // The handler is told why it is being asked, so a reviewer sees the rule
    // that stopped the operation rather than only the operation.
    const handled = await this.approvalHandler(request, {
      ...context,
      ...(decision.policy ? { policy: decision.policy } : {}),
    });
    return decision.policy ? { ...handled, policy: decision.policy } : handled;
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
