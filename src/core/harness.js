import { randomUUID } from "node:crypto";
import { EventBus } from "./events.js";
import { Registry } from "./registry.js";
import { createPluginContext, definePlugin } from "../plugins/sdk.js";

export class Harness {
  constructor({ approvalPolicy, approvalHandler, receiptStore } = {}) {
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
    this.providerRouter = undefined;
  }

  async use(plugin, options = {}) {
    const manifest = definePlugin(plugin);
    for (const dependency of manifest.dependencies) {
      if (!this.plugins.has(dependency)) {
        throw new Error(`Plugin '${manifest.name}' requires plugin '${dependency}' to be loaded first.`);
      }
    }
    if (this.plugins.has(manifest.name)) {
      throw new Error(`plugin '${manifest.name}' is already registered.`);
    }
    await manifest.setup(createPluginContext(this, manifest), options);
    this.plugins.register(manifest.name, manifest);
    await this.events.emit("plugin.loaded", { plugin: manifest.name, version: manifest.version });
    return this;
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

  registerAgent(agent) {
    if (!agent?.name || (!agent.provider && !agent.providers?.length) || !agent.prompt) {
      throw new TypeError("An agent requires name, at least one provider, and prompt.");
    }
    this.agents.register(agent.name, Object.freeze({ skills: [], subagents: [], requires: [], ...agent }));
    return agent;
  }

  async run({ agent: agentName, input, parentRunId, metadata = {} }) {
    const agent = this.agents.get(agentName);
    const runId = randomUUID();
    const startedAt = Date.now();
    await this.events.emit("run.started", { runId, parentRunId, agent: agentName });

    try {
      const context = {
        runId,
        parentRunId,
        agent,
        input,
        metadata,
        instructions: [...this.instructions],
        skills: agent.skills.map((name) => this.skills.get(name)),
        spawn: (subagent, subInput) => {
          if (!agent.subagents.includes(subagent)) {
            throw new Error(`Agent '${agentName}' may not spawn '${subagent}'.`);
          }
          return this.run({
            agent: subagent,
            input: subInput,
            parentRunId: runId,
            metadata,
          });
        },
        approve: (request) => this.#approve(request, { runId, agent: agentName }),
      };
      const routed = this.providerRouter
        ? await this.providerRouter.invoke(context)
        : {
            provider: agent.provider,
            result: await this.providers.get(agent.provider).invoke(context),
            attempts: [{ provider: agent.provider, status: "succeeded" }],
          };
      const receipt = {
        runId,
        parentRunId,
        agent: agentName,
        provider: routed.provider,
        providerAttempts: routed.attempts,
        status: "succeeded",
        durationMs: Date.now() - startedAt,
        result: routed.result,
      };
      await this.receiptStore?.append(receipt);
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
        error: error instanceof Error ? error.message : String(error),
      };
      await this.receiptStore?.append(receipt);
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
    return this.approvalHandler(request, context);
  }
}
