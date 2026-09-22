export class ApprovalPolicy {
  constructor({ allow = ["read"], requireHuman = ["write", "shell", "network"] } = {}) {
    this.allow = new Set(allow);
    this.requireHuman = new Set(requireHuman);
  }

  evaluate(request) {
    if (request?.managedApprovalRequired) return { kind: "human-required" };
    if (this.allow.has(request?.kind)) return { kind: "approve-once" };
    if (this.requireHuman.has(request?.kind)) return { kind: "human-required" };
    return { kind: "reject", reason: `Operation '${request?.kind ?? "unknown"}' is not allowed.` };
  }
}
