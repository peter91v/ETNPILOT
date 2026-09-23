import assert from "node:assert/strict";
import { test } from "node:test";
import { ApprovalPolicy } from "../src/core/approval-policy.js";
import { PolicyEngine } from "../src/policy/engine.js";

test("operation policy applies the safest matching rule", () => {
  const policy = new PolicyEngine({
    operations: {
      default: "deny",
      rules: [
        { id: "read-project", effect: "allow", kinds: ["read"], paths: ["**"] },
        { id: "protect-env", effect: "deny", kinds: ["read", "write"], paths: [".env", "**/.env"] },
        { id: "write-project", effect: "human", kinds: ["write"], paths: ["**"] },
      ],
    },
  });
  const context = { agent: "builder", workspace: "/workspace/project" };

  assert.deepEqual(policy.evaluateOperation({ kind: "read", fileName: "src/index.js" }, context), {
    kind: "approve-once",
    policy: { section: "operations", effect: "allow", rule: "read-project" },
  });
  assert.equal(policy.evaluateOperation({ kind: "read", fileName: ".env" }, context).kind, "reject");
  assert.equal(policy.evaluateOperation({ kind: "write", fileName: "src/index.js" }, context).kind, "human-required");
  assert.equal(policy.evaluateOperation({ kind: "read", fileName: "../outside.txt" }, context).kind, "reject");
});

test("network and provider policies match normalized targets", () => {
  const policy = new PolicyEngine({
    operations: {
      rules: [{ id: "review-gitlab", effect: "human", kinds: ["network"], hosts: ["*.example.com"] }],
    },
    providers: {
      default: "deny",
      rules: [
        { id: "allow-team", effect: "allow", providers: ["team-*"] },
        { id: "deny-review-backup", effect: "deny", providers: ["team-backup"], agents: ["reviewer"] },
      ],
    },
  });

  assert.equal(policy.evaluateOperation({ kind: "network", url: "https://git.example.com/api?token=hidden" }).kind, "human-required");
  assert.equal(policy.evaluateOperation({ kind: "network", url: "https://evil.invalid" }).kind, "reject");
  assert.equal(policy.evaluateProvider("team-primary", { agent: "reviewer" }).allowed, true);
  const denied = policy.evaluateProvider("team-backup", { agent: "reviewer" });
  assert.equal(denied.allowed, false);
  assert.equal(denied.policy.rule, "deny-review-backup");
});

test("approval policy cannot override a policy denial", async () => {
  const policy = new PolicyEngine({
    operations: {
      rules: [{ id: "deny-keys", effect: "deny", kinds: ["read"], paths: ["**/*.pem"] }],
    },
  });
  const approval = new ApprovalPolicy({ allow: ["read"] }, { policy });
  const decision = await approval.evaluate(
    { kind: "read", fileName: "keys/private.pem", managedApprovalRequired: true },
    { workspace: "/workspace/project" },
  );
  assert.equal(decision.kind, "reject");
  assert.equal(decision.policy.rule, "deny-keys");
});

test("policy configuration rejects ambiguous or unsupported rules", () => {
  assert.throws(() => new PolicyEngine({ operation: {} }), /unknown section 'operation'/);
  assert.throws(
    () => new PolicyEngine({ operations: { rules: [{ id: "empty", effect: "allow" }] } }),
    /requires at least one matcher/,
  );
  assert.throws(
    () => new PolicyEngine({ providers: { rules: [{ id: "human", effect: "human", providers: ["model"] }] } }),
    /unsupported effect/,
  );
  assert.throws(
    () => new PolicyEngine({ operations: { rules: [{ id: "bad", effect: "allow", commands: ["npm test"] }] } }),
    /unknown field 'commands'/,
  );
});

test("policy paths can be matched without case sensitivity", () => {
  const config = {
    operations: {
      default: "allow",
      rules: [{ id: "protect-keys", effect: "deny", kinds: ["read"], paths: ["**/*.pem"] }],
    },
  };
  const sensitive = new PolicyEngine(config, { caseInsensitivePaths: false });
  const insensitive = new PolicyEngine(config, { caseInsensitivePaths: true });
  const request = { kind: "read", fileName: "keys/Signing.PEM" };

  assert.equal(sensitive.evaluateOperation(request).kind, "approve-once");
  assert.equal(insensitive.evaluateOperation(request).kind, "reject");
  assert.equal(insensitive.evaluateOperation({ kind: "read", fileName: "keys/signing.pem" }).kind, "reject");
});

test("policy follows symbolic links before matching paths", async (t) => {
  const { mkdtemp, mkdir, writeFile, symlink } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const workspace = await mkdtemp(join(tmpdir(), "etnpilot-policy-links-"));
  const outside = await mkdtemp(join(tmpdir(), "etnpilot-policy-outside-"));
  await mkdir(join(workspace, "src"), { recursive: true });
  await writeFile(join(workspace, "secret.pem"), "key\n");
  await writeFile(join(outside, "elsewhere.txt"), "data\n");
  await symlink(join(workspace, "secret.pem"), join(workspace, "src", "innocent.txt"));
  await symlink(outside, join(workspace, "src", "escape"));

  const policy = new PolicyEngine({
    operations: {
      default: "deny",
      rules: [
        { id: "protect-keys", effect: "deny", kinds: ["read", "write"], paths: ["**/*.pem"] },
        { id: "read-src", effect: "allow", kinds: ["read"], paths: ["src/**"] },
      ],
    },
  });
  const decide = (fileName) => policy.evaluateOperation({ kind: "read", fileName }, { workspace });

  // A link under src/ that resolves to the protected key is denied.
  assert.equal(decide("src/innocent.txt").kind, "reject");
  assert.equal(decide("src/innocent.txt").policy.rule, "protect-keys");
  // A link that leaves the workspace matches no path rule, so the default applies.
  assert.equal(decide("src/escape/elsewhere.txt").kind, "reject");
  // A file that does not exist yet is still judged through its real parents.
  assert.equal(decide("src/new-file.txt").kind, "approve-once");

  const lexical = new PolicyEngine({
    operations: {
      default: "deny",
      rules: [
        { id: "protect-keys", effect: "deny", kinds: ["read", "write"], paths: ["**/*.pem"] },
        { id: "read-src", effect: "allow", kinds: ["read"], paths: ["src/**"] },
      ],
    },
  }, { resolveSymlinks: false });
  assert.equal(lexical.evaluateOperation({ kind: "read", fileName: "src/innocent.txt" }, { workspace }).kind, "approve-once");
  t.diagnostic("symlink resolution turns a bypass into a denial");
});
