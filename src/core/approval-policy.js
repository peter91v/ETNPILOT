export class ApprovalPolicy {
  constructor({ allow = ["read"], requireHuman = ["write", "shell", "network"] } = {}, { policy } = {}) {
    this.allow = new Set(allow);
    this.requireHuman = new Set(requireHuman);
    this.policy = policy;
  }

  evaluate(request, context) {
    const policyDecision = this.policy?.evaluateOperation(request, context);
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
