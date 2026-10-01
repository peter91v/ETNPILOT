import assert from "node:assert/strict";
import test from "node:test";


test("LD_PRELOAD and LD_LIBRARY_PATH reach a command only on Termux", async () => {
  const { commandEnvironment } = await import("../src/runtime/command-environment.js");
  const other = commandEnvironment({ PATH: "/bin", LD_PRELOAD: "/evil.so", LD_LIBRARY_PATH: "/evil" });
  assert.equal(other.LD_PRELOAD, undefined);
  assert.equal(other.LD_LIBRARY_PATH, undefined);
  const termux = commandEnvironment({ PREFIX: "/data/data/com.termux/files/usr", LD_PRELOAD: "/usr/lib/libtermux-exec.so" });
  assert.equal(termux.LD_PRELOAD, "/usr/lib/libtermux-exec.so");
});
