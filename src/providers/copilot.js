import { ProviderError } from "./router.js";

export function createCopilotProvider(options = {}) {
  const importer = options.importer ?? (() => import("@github/copilot-sdk"));

  return {
    name: options.name ?? "github-copilot",
    capabilities: ["chat", "tools", "permissions", "skills"],
    async invoke(context) {
      let CopilotClient;
      try {
        ({ CopilotClient } = await importer());
      } catch (error) {
        throw new ProviderError(
          "GitHub Copilot provider requires '@github/copilot-sdk'. Install it in the ETNPilot project.",
          { code: "sdk_unavailable", cause: error },
        );
      }
      let client;
      let session;
      let promptSent = false;
      const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, providerUnits: 0 };
      let usageModel;
      try {
        client = new CopilotClient({
          workingDirectory: options.workingDirectory ?? process.cwd(),
          gitHubToken: options.gitHubToken,
          useLoggedInUser: options.gitHubToken ? false : true,
          logLevel: options.logLevel ?? "warning",
        });
        await client.start();
        session = await client.createSession({
          model: context.agent.model ?? options.model ?? "auto",
          workingDirectory: options.workingDirectory ?? process.cwd(),
          systemMessage: buildSystemMessage(context),
          onPermissionRequest: async (request) => {
            const decision = await context.approve(request);
            if (decision.kind === "approve-once") return decision;
            if (decision.kind === "human-required") return { kind: "no-result" };
            return { kind: "reject", feedback: decision.reason ?? "Denied by ETNPilot policy." };
          },
        });
        if (typeof session.on === "function") {
          session.on("assistant.usage", (event) => {
            const data = event?.data ?? {};
            usage.inputTokens += number(data.inputTokens);
            usage.outputTokens += number(data.outputTokens);
            usage.cacheReadTokens += number(data.cacheReadTokens);
            usage.cacheWriteTokens += number(data.cacheWriteTokens);
            usage.providerUnits += number(data.cost);
            usageModel = data.model ?? usageModel;
          });
        }
        promptSent = true;
        const message = await session.sendAndWait({ prompt: String(context.input) });
        return {
          text: message?.data?.content ?? "",
          sessionId: session.sessionId,
          model: usageModel ?? context.agent.model ?? options.model,
          usage,
        };
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        throw new ProviderError(
          promptSent ? "GitHub Copilot failed after prompt delivery." : "GitHub Copilot session setup failed.",
          {
            code: promptSent ? "invocation_failed" : "session_unavailable",
            retryable: true,
            safeToRetry: !promptSent,
            cause: error,
          },
        );
      } finally {
        await session?.disconnect();
        await client?.stop();
      }
    },
  };
}

function number(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function buildSystemMessage(context) {
  const instructions = [context.agent.prompt, ...context.instructions];
  for (const skill of context.skills) instructions.push(skill.content ?? String(skill));
  return { mode: "replace", content: instructions.filter(Boolean).join("\n\n") };
}
