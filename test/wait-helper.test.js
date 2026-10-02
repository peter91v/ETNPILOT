import assert from "node:assert/strict";
import { test } from "node:test";
import { waitFor } from "./helpers/wait.js";

test("a wait that succeeds returns, and one that times out says how long it waited and what it saw", async () => {
  let calls = 0;
  await waitFor(() => ++calls >= 3, "three polls", { intervalMs: 1 });
  await assert.rejects(
    waitFor(() => false, "something that never happens", { attempts: 3, intervalMs: 1, diagnose: () => "screen: empty\nmessage: (none)" }),
    (error) => /Timed out after \d+ ms waiting for something that never happens/.test(error.message)
      && /what it was doing/.test(error.message) && /screen: empty/.test(error.message),
  );
  await assert.rejects(
    waitFor(() => false, "x", { attempts: 1, intervalMs: 1, diagnose: () => { throw new Error("boom"); } }),
    /diagnosis failed: boom/,
  );
});
