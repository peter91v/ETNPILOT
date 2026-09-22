import assert from "node:assert/strict";
import { test } from "node:test";
import { runCheck } from "../src/checks/runner.js";

test("check runner executes argument arrays without a shell", async () => {
  const result = await runCheck({
    name: "sample",
    command: [process.execPath, "-e", "process.stdout.write(process.argv[1])", "hello; echo unsafe"],
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "hello; echo unsafe");
  assert.deepEqual(result.command.slice(-1), ["hello; echo unsafe"]);
});

test("check runner rejects non-zero exits with captured evidence", async () => {
  await assert.rejects(
    () => runCheck({ command: [process.execPath, "-e", "process.stderr.write('bad'); process.exit(2)"] }),
    (error) => error.result.exitCode === 2 && error.result.stderr === "bad",
  );
});
