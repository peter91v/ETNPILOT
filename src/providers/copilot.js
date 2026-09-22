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
        promptSent = true;
        const message = await session.sendAndWait({ prompt: String(context.input) });
        return { text: message?.data?.content ?? "", sessionId: session.sessionId };
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

function buildSystemMessage(context) {
  const instructions = [context.agent.prompt, ...context.instructions];
  for (const skill of context.skills) instructions.push(skill.content ?? String(skill));
  return { mode: "replace", content: instructions.filter(Boolean).join("\n\n") };
}
