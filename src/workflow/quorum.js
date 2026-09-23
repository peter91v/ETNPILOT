// Tolerates the markdown a model tends to wrap the line in ("**VERDICT:**").
const VERDICT_LINE = /^[\s>*_-]*VERDICT[\s*_]*[:=][\s*_]*(approve|reject)\b/im;

export const QUORUM_INSTRUCTION =
  "End your answer with a line reading 'VERDICT: approve' or 'VERDICT: reject'."
  + " Anything else counts as an abstention.";

// A reviewer that cannot state a verdict has not reviewed. Silence is an
// abstention, never an approval.
export function parseVerdict(text) {
  const match = VERDICT_LINE.exec(String(text ?? ""));
  return match ? match[1].toLowerCase() : "abstain";
}

// Two reviewers on the same provider are one opinion with two voices, so by
// default only one approval per provider counts toward the quorum.
export function evaluateQuorum(votes, { required, distinctProviders = true } = {}) {
  const threshold = required ?? Math.floor(votes.length / 2) + 1;
  if (!Number.isInteger(threshold) || threshold < 1) {
    throw new TypeError("A quorum requires a positive integer of approvals.");
  }
  const seenProviders = new Set();
  const counted = [];
  const discounted = [];
  for (const vote of votes) {
    if (vote.verdict !== "approve") continue;
    if (distinctProviders && vote.provider !== undefined && seenProviders.has(vote.provider)) {
      discounted.push({ ...vote, reason: "duplicate-provider" });
      continue;
    }
    if (vote.provider !== undefined) seenProviders.add(vote.provider);
    counted.push(vote);
  }
  const rejections = votes.filter((vote) => vote.verdict === "reject");
  return {
    required: threshold,
    approvals: counted.length,
    rejections: rejections.length,
    abstentions: votes.filter((vote) => vote.verdict === "abstain").length,
    providers: [...seenProviders].sort(),
    satisfied: counted.length >= threshold && rejections.length === 0,
    votes,
    ...(discounted.length > 0 ? { discounted } : {}),
  };
}

export function quorumError(outcome) {
  const reason = outcome.rejections > 0
    ? `${outcome.rejections} reviewer(s) rejected the change`
    : `only ${outcome.approvals} of ${outcome.required} required approvals`;
  const error = new Error(`Reviewer quorum not reached: ${reason}.`);
  error.code = "quorum_not_reached";
  error.quorum = outcome;
  return error;
}
