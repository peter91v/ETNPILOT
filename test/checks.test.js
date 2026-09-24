import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runCheck } from "../src/checks/runner.js";

// A failed check collects its own output and then has to show it. 'exit code
// 126' on its own is a number nobody can act on, and the reason was right
// there in stderr.

async function binDir(name, body) {
  const dir = await mkdtemp(join(tmpdir(), "etnpilot-bin-"));
  const path = join(dir, name);
  await writeFile(path, body, "utf8");
  await chmod(path, 0o755);
  return dir;
}

test("a failed check reports what it said, not only its exit code", async () => {
  const dir = await binDir("failing", '#!/bin/sh\necho "some progress"\necho "error: missing semicolon at line 4" >&2\nexit 1\n');
  await assert.rejects(
    () => runCheck({ command: ["failing"] }, { cwd: dir, env: { PATH: `${dir}:/usr/bin:/bin` } }),
    (error) => {
      assert.match(error.message, /Check failed with exit code 1: failing/);
      assert.match(error.message, /error: missing semicolon at line 4/);
      // The full output stays available for the receipt and the views.
      assert.equal(error.result.stdout, "some progress\n");
      return true;
    },
  );
});

test("where the command said nothing, its stdout is the next best thing", async () => {
  const dir = await binDir("quiet", '#!/bin/sh\necho "1 test failed"\nexit 2\n');
  await assert.rejects(
    () => runCheck({ command: ["quiet"] }, { cwd: dir, env: { PATH: `${dir}:/usr/bin:/bin` } }),
    (error) => {
      assert.match(error.message, /1 test failed/);
      return true;
    },
  );
});

test("126 and 127 point at the environment, and at the file that can widen it", async () => {
  // The Termux case: 'npm' exits 126 before running, because the loader is
  // missing something the allow list did not pass through.
  const dir = await binDir("unrunnable", "#!/bin/sh\nexit 126\n");
  await assert.rejects(
    () => runCheck({ command: ["unrunnable"] }, { cwd: dir, env: { PATH: `${dir}:/usr/bin:/bin` } }),
    (error) => {
      assert.match(error.message, /could not be executed/);
      assert.match(error.message, /'checks\.envAllow' in the committed \.etnpilot\/etnpilot\.yaml/);
      // What it was given, so the missing name is visible rather than guessed.
      assert.match(error.message, /It inherited only these variables: PATH/);
      // The setting is stricter-only, so sending someone to a local change
      // would send them to a refusal.
      assert.match(error.message, /a local file cannot widen it/);
      return true;
    },
  );

  // A missing command and a missing '#!' interpreter both arrive as ENOENT,
  // so the message owns both rather than asserting the wrong one.
  const broken = await binDir("no-interpreter", "#!/nonexistent/interpreter\ntrue\n");
  for (const [where, command] of [[broken, "no-interpreter"], [dir, "nothing-by-this-name"]]) {
    await assert.rejects(
      () => runCheck({ command: [command] }, { cwd: where, env: { PATH: where } }),
      (error) => {
        assert.match(error.message, /Check could not start/);
        assert.match(error.message, /not found on PATH, or the interpreter/);
        assert.match(error.message, /checks\.envAllow/);
        return true;
      },
    );
  }
});

test("a long failure is trimmed rather than pasted whole", async () => {
  const dir = await binDir("noisy", '#!/bin/sh\ni=0\nwhile [ $i -lt 200 ]; do echo "line $i" >&2; i=$((i+1)); done\nexit 1\n');
  await assert.rejects(
    () => runCheck({ command: ["noisy"] }, { cwd: dir, env: { PATH: `${dir}:/usr/bin:/bin` } }),
    (error) => {
      assert.match(error.message, /line 199/);
      assert.equal(/line 100/.test(error.message), false, "only the tail is in the message");
      assert.equal(error.message.length < 3000, true);
      // Nothing is lost: the whole output is still on the error.
      assert.match(error.result.stderr, /line 0/);
      return true;
    },
  );
});

test("the environment a check inherits carries what Termux needs to exec at all", async () => {
  // 'env: node: Permission denied' is what a check reports on Android when
  // LD_PRELOAD is not passed: libtermux-exec is what lets the system execute a
  // script's interpreter there, so without it nothing with a '#!' line runs.
  const { checkEnvironmentForTest } = await import("../src/runtime/project-runner.js");
  const inherited = checkEnvironmentForTest({
    PATH: "/usr/bin",
    HOME: "/home/user",
    LD_PRELOAD: "/data/data/com.termux/files/usr/lib/libtermux-exec.so",
    PREFIX: "/data/data/com.termux/files/usr",
    LD_LIBRARY_PATH: "/data/data/com.termux/files/usr/lib",
    ANDROID_DATA: "/data",
    ANDROID_ROOT: "/system",
    OPENAI_API_KEY: "sk-secret",
    ETNPILOT_GITLAB_TOKEN: "glpat-secret",
  }, {});

  for (const name of ["PATH", "HOME", "LD_PRELOAD", "PREFIX", "LD_LIBRARY_PATH", "ANDROID_DATA", "ANDROID_ROOT"]) {
    assert.equal(name in inherited, true, `${name} reaches the check`);
  }
  // The reason this list exists: a check runs agent-authored code, and the
  // credentials this run holds are not its to read.
  assert.equal("OPENAI_API_KEY" in inherited, false);
  assert.equal("ETNPILOT_GITLAB_TOKEN" in inherited, false);
  assert.equal(inherited.ETNPILOT_CHECK, "1");
});

test("'dependencies are missing' is said only where nothing above the worktree has them", async () => {
  // A worktree inside the project resolves to the checkout's own node_modules,
  // exactly as Node does, so claiming they are missing there would be an
  // invention. The walk up is done rather than assumed.
  const { dependenciesMissingForTest } = await import("../src/runtime/project-runner.js");
  const root = await mkdtemp(join(tmpdir(), "etnpilot-deps-"));
  const { mkdir, writeFile: write } = await import("node:fs/promises");
  await write(join(root, "package.json"), "{}", "utf8");
  await mkdir(join(root, "node_modules"), { recursive: true });

  // Where ETNPilot puts them: inside the project.
  const inside = join(root, ".etnpilot", "worktrees", "run-1");
  await mkdir(inside, { recursive: true });
  await write(join(inside, "package.json"), "{}", "utf8");
  assert.equal(await dependenciesMissingForTest(inside, root), false, "the checkout's own are found by walking up");

  // Somewhere else entirely, with nothing above it.
  const elsewhere = await mkdtemp(join(tmpdir(), "etnpilot-elsewhere-"));
  const detached = join(elsewhere, "run-2");
  await mkdir(detached, { recursive: true });
  await write(join(detached, "package.json"), "{}", "utf8");
  assert.equal(await dependenciesMissingForTest(detached, root), true);

  // A project with no manifest is not a project missing dependencies.
  const bare = join(elsewhere, "run-3");
  await mkdir(bare, { recursive: true });
  assert.equal(await dependenciesMissingForTest(bare, root), false);
  // And a run in the checkout itself never is.
  assert.equal(await dependenciesMissingForTest(root, root), false);
});
