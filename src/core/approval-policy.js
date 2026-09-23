export class ApprovalPolicy {
  constructor({ allow = ["read"], requireHuman = ["write", "shell", "network"] } = {}, { policy, dryRun = false } = {}) {
    this.allow = new Set(allow);
    this.requireHuman = new Set(requireHuman);
    this.policy = policy;
    this.dryRun = dryRun === true;
  }

  evaluate(request, context) {
    const policyDecision = this.policy?.evaluateOperation(request, context);
    // A dry run still evaluates policy, so the receipt records what would have
    // been decided, but nothing that changes state is carried out.
    if (this.dryRun && !this.allow.has(request?.kind)) {
      return {
        kind: "reject",
        reason: `Dry run: '${request?.kind ?? "unknown"}' operations are not executed.`,
        dryRun: true,
        ...(policyDecision?.policy ? { policy: policyDecision.policy } : {}),
        wouldBe: policyDecision?.kind ?? (this.requireHuman.has(request?.kind) ? "human-required" : "reject"),
      };
    }
    if (policyDecision?.kind === "reject") return policyDecision;
    if (request?.managedApprovalRequired) {
      return { kind: "human-required", ...(policyDecision?.policy ? { policy: policyDecision.policy } : {}) };
    }
    if (policyDecision) return policyDecision;
    if (this.allow.has(request?.kind)) return { kind: "approve-once" };
    if (this.requireHuman.has(request?.kind)) return { kind: "human-required" };
    return { kind: "reject", reason: `Operation '${request?.kind ?? "unknown"}' is not allowed.` };
  }
}
