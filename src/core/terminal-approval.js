import { createInterface } from "node:readline/promises";

export function createTerminalApprovalHandler({ input = process.stdin, output = process.stdout } = {}) {
  let pending = Promise.resolve();
  return (request, context) => {
    const operation = pending.then(() => askForApproval(request, context, { input, output }));
    pending = operation.catch(() => {});
    return operation;
  };
}

async function askForApproval(request, context, { input, output }) {
  if (!input.isTTY || !output.isTTY) {
    return { kind: "reject", reason: "Interactive approval is unavailable." };
  }
  const details = describeRequest(request);
  const readline = createInterface({ input, output });
  try {
    const answer = await readline.question(
      `\nETNPilot approval required\nAgent: ${context.agent}\nOperation: ${request.kind ?? "unknown"}${details}\nApprove once? [y/N] `,
    );
    return /^(y|yes|j|ja)$/i.test(answer.trim())
      ? { kind: "approve-once" }
      : { kind: "reject", reason: "Rejected by the user." };
  } finally {
    readline.close();
  }
}

function describeRequest(request) {
  if (request.kind === "shell" && request.fullCommandText) return `\nCommand: ${request.fullCommandText}`;
  if (request.kind === "write" && request.fileName) return `\nFile: ${request.fileName}`;
  if ((request.kind === "custom-tool" || request.kind === "mcp") && request.toolName) return `\nTool: ${request.toolName}`;
  return "";
}
