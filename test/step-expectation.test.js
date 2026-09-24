import assert from "node:assert/strict";
import { test } from "node:test";
import { assertStepExpectationForTest } from "../src/runtime/project-runner.js";

// A model that describes a change, or asks whether it may make one, returns a
// perfectly successful message and touches nothing. A workflow that calls that
// 'succeeded' reports work that did not happen — which is the one thing this
// project exists not to do.

const receipt = (result) => ({ agent: "builder", status: "succeeded", result });

test("a step that declares it must use tools is held to it", () => {
  const step = { id: "build", type: "agent", agent: "builder", expect: "tool-use" };

  // What was reported: the agent answered, asked for permission, and the run
  // ended 'succeeded' with no file written.
  assert.throws(
    () => assertStepExpectationForTest(step, receipt({
      text: "Ich werde test.txt anlegen. Bitte bestätige, dann führe ich es aus.",
      toolCalls: [],
    })),
    (error) => {
      assert.match(error.message, /step 'build' ran agent 'builder' and changed nothing: it called no tool at all/);
      assert.match(error.message, /describing the work is not doing it/);
      // What it said instead, so the receipt carries the evidence.
      assert.match(error.message, /Bitte bestätige/);
      return true;
    },
  );

  // A provider without tools reports no toolCalls array at all; that is still
  // nothing changed.
  assert.throws(() => assertStepExpectationForTest(step, receipt({ text: "Done." })), /called no tool at all/);

  // Every call refused is a different sentence: the agent did its part.
  assert.throws(
    () => assertStepExpectationForTest(step, receipt({
      text: "",
      toolCalls: [{ tool: "write_file", ok: false, error: "Denied." }],
    })),
    /every tool call was refused \(write_file\)/,
  );

  // One successful call is enough: the step did something.
  assertStepExpectationForTest(step, receipt({ toolCalls: [{ tool: "write_file", ok: true }] }));
  // The scripted provider records the same thing under another name.
  assertStepExpectationForTest(step, receipt({ steps: [{ tool: "write_file", ok: true }] }));
});

test("a step that expects nothing is left alone, and an unknown expectation is refused", () => {
  // Most steps are answers, not changes, and must not be failed for it.
  assertStepExpectationForTest({ id: "plan", type: "agent", agent: "orchestrator" }, receipt({ text: "A plan." }));

  assert.throws(
    () => assertStepExpectationForTest(
      { id: "build", type: "agent", agent: "builder", expect: "a-miracle" },
      receipt({ toolCalls: [{ tool: "write_file", ok: true }] }),
    ),
    /expects 'a-miracle', which is not something a step can expect\. The only one is 'tool-use'/,
  );
});
