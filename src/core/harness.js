import { randomUUID } from "node:crypto";
import { EventBus } from "./events.js";
import { Registry } from "./registry.js";

export class Harness {
  constructor({ approvalPolicy, receiptStore } = {}) {
    this.events = new EventBus();
    this.providers = new Registry("provider");
    this.plugins = new Registry("plugin");
    this.agents = new Registry("agent");
    this.skills = new Registry("skill");
    this.prompts = new Registry("prompt");
    this.instructions = [];
    this.approvalPolicy = approvalPolicy;
    this.receiptStore = receiptStore;
  }

  async use(plugin, options = {}) {
    if (!plugin?.name || typeof plugin.setup !== "function") {
      throw new TypeError("A plugin must expose name and setup(harness, options).");
    }
    this.plugins.register(plugin.name, plugin);
    await plugin.setup(this, options);
    await this.events.emit("plugin.loaded", { plugin: plugin.name });
    return this;
  }

  registerProvider(provider) {
    if (!provider?.name || typeof provider.invoke !== "function") {
      throw new TypeError("A provider must expose name and invoke(context).");
    }
    this.providers.register(provider.name, provider);
    return provider;
  }

  registerAgent(agent) {
    if (!agent?.name || !agent.provider || !agent.prompt) {
      throw new TypeError("An agent requires name, provider, and prompt.");
    }
    this.agents.register(agent.name, Object.freeze({ skills: [], subagents: [], ...agent }));
    return agent;
  }

  async run({ agent: agentName, input, parentRunId, metadata = {} }) {
    const agent = this.agents.get(agentName);
    const provider = this.providers.get(agent.provider);
    const runId = randomUUID();
    const startedAt = Date.now();
    await this.events.emit("run.started", { runId, parentRunId, agent: agentName });

    try {
      const result = await provider.invoke({
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
      });
      const receipt = {
        runId,
        parentRunId,
        agent: agentName,
        provider: agent.provider,
        status: "succeeded",
        durationMs: Date.now() - startedAt,
        result,
      };
      await this.receiptStore?.append(receipt);
      await this.events.emit("run.completed", receipt);
      return receipt;
    } catch (error) {
      const receipt = {
        runId,
        parentRunId,
        agent: agentName,
        provider: agent.provider,
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
    return this.approvalPolicy.evaluate(request, context);
  }
}
