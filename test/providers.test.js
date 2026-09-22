import assert from "node:assert/strict";
import { test } from "node:test";
import { createCopilotProvider } from "../src/providers/copilot.js";

test("Copilot provider uses the SDK session and preserves safe approvals", async () => {
  const calls = [];
  class CopilotClient {
    constructor(options) { calls.push(["client", options]); }
    async start() { calls.push(["start"]); }
    async createSession(options) {
      calls.push(["session", options]);
      return {
        sessionId: "session-1",
        sendAndWait: async ({ prompt }) => ({ data: { content: `answer:${prompt}` } }),
        disconnect: async () => calls.push(["disconnect"]),
      };
    }
    async stop() { calls.push(["stop"]); }
  }
  const provider = createCopilotProvider({ importer: async () => ({ CopilotClient }) });
  const result = await provider.invoke({
    agent: { prompt: "System", model: "auto" },
    input: "hello",
    instructions: ["Instruction"],
    skills: [{ content: "Skill" }],
    approve: async () => ({ kind: "reject", reason: "blocked" }),
  });
  assert.deepEqual(result, { text: "answer:hello", sessionId: "session-1" });
  assert.deepEqual(calls.slice(-2), [["disconnect"], ["stop"]]);
});
