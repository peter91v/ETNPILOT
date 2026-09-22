export function createCopilotProvider(options = {}) {
  const importer = options.importer ?? (() => import("@github/copilot-sdk"));

  return {
    name: options.name ?? "github-copilot",
    async invoke(context) {
      const { CopilotClient } = await importer();
      const client = new CopilotClient({
        workingDirectory: options.workingDirectory ?? process.cwd(),
        gitHubToken: options.gitHubToken,
        useLoggedInUser: options.gitHubToken ? false : true,
        logLevel: options.logLevel ?? "warning",
      });
      await client.start();
      let session;
      try {
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
        const message = await session.sendAndWait({ prompt: String(context.input) });
        return { text: message?.data?.content ?? "", sessionId: session.sessionId };
      } finally {
        await session?.disconnect();
        await client.stop();
      }
    },
  };
}

function buildSystemMessage(context) {
  const instructions = [context.agent.prompt, ...context.instructions];
  for (const skill of context.skills) instructions.push(skill.content ?? String(skill));
  return { mode: "replace", content: instructions.filter(Boolean).join("\n\n") };
}
