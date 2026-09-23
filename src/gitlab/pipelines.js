import { setTimeout as delay } from "node:timers/promises";

const TERMINAL_STATES = new Set(["success", "failed", "canceled", "skipped", "manual"]);

export function latestPipeline(pipelines) {
  if (!Array.isArray(pipelines) || pipelines.length === 0) return undefined;
  // GitLab returns newest first, but an explicit ordering keeps that an
  // assumption we do not depend on.
  return [...pipelines].sort((left, right) => (right.id ?? 0) - (left.id ?? 0))[0];
}

// ETNPilot reports its own status into GitLab. This reads the project's
// verdict back, so a run that published can say whether CI actually agreed.
export async function waitForPipeline({
  client,
  project,
  ref,
  timeoutMs = 15 * 60_000,
  pollIntervalMs = 15_000,
  signal,
  now = Date.now,
} = {}) {
  if (!client || !project || !ref) throw new TypeError("A pipeline wait requires a client, project, and ref.");
  const startedAt = now();
  let seen;
  for (;;) {
    signal?.throwIfAborted();
    const pipeline = latestPipeline(await client.pipelines(project, ref));
    if (pipeline) {
      seen = summarize(pipeline);
      if (TERMINAL_STATES.has(pipeline.status)) return { ...seen, settled: true };
    }
    if (now() - startedAt >= timeoutMs) {
      return seen
        ? { ...seen, settled: false, reason: "timeout" }
        : { settled: false, reason: seen === undefined ? "no-pipeline" : "timeout" };
    }
    await delay(pollIntervalMs, undefined, { signal });
  }
}

function summarize(pipeline) {
  return {
    id: pipeline.id,
    status: pipeline.status,
    ref: pipeline.ref,
    sha: pipeline.sha,
    webUrl: pipeline.web_url,
    updatedAt: pipeline.updated_at,
  };
}
