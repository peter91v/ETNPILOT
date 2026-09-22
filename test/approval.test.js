import assert from "node:assert/strict";
import { test } from "node:test";
import { createTerminalApprovalHandler } from "../src/core/terminal-approval.js";

test("terminal approval rejects safely when no interactive terminal exists", async () => {
  const approve = createTerminalApprovalHandler({
    input: { isTTY: false },
    output: { isTTY: false },
  });
  assert.deepEqual(
    await approve({ kind: "shell", fullCommandText: "npm test" }, { agent: "builder" }),
    { kind: "reject", reason: "Interactive approval is unavailable." },
  );
});
