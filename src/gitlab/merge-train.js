import { git } from "../git/command.js";
import { escapeControlCharacters } from "../core/text-safety.js";

// A branch that merges cleanly today can still be broken by whatever lands
// before it. This looks at the other open merge requests queued for the same
// target and reports the ones this run's branch would collide with, so the
// collision is known while the change is still cheap to adjust.
export async function inspectMergeTrain({
  client,
  project,
  cwd,
  remote,
  targetBranch = "main",
  head = "HEAD",
  ownBranch,
  limit = 10,
} = {}) {
  if (!client || !project || !cwd) {
    throw new TypeError("A merge-train inspection requires a client, project, and working directory.");
  }
  let mergeRequests;
  try {
    mergeRequests = await client.mergeRequests(project, { state: "opened", targetBranch });
  } catch (error) {
    return { inspected: false, reason: "merge-requests-unavailable", error: error.message, targetBranch };
  }

  const queued = mergeRequests
    .filter((mergeRequest) => mergeRequest.source_branch !== ownBranch)
    .slice(0, limit);
  const conflicts = [];
  const skipped = [];
  for (const mergeRequest of queued) {
    const reference = `refs/merge-requests/${mergeRequest.iid}/head`;
    try {
      await git(["fetch", "--quiet", remote ?? "origin", reference], { cwd });
    } catch (error) {
      skipped.push({ iid: mergeRequest.iid, reason: "fetch-failed", error: error.message });
      continue;
    }
    let result;
    try {
      result = await git(["merge-tree", "--write-tree", "--name-only", head, "FETCH_HEAD"], {
        cwd,
        allowExitCodes: [1],
      });
    } catch (error) {
      skipped.push({ iid: mergeRequest.iid, reason: "merge-tree-failed", error: error.message });
      continue;
    }
    if (result.exitCode === 0) continue;
    const files = [];
    for (const line of result.stdout.split("\n").slice(1)) {
      if (line.trim() === "") break;
      files.push(line.trim());
    }
    conflicts.push({
      iid: mergeRequest.iid,
      // Titles are written by other people: treated as data, never as markup.
      title: escapeControlCharacters(String(mergeRequest.title ?? "")).slice(0, 200),
      sourceBranch: mergeRequest.source_branch,
      webUrl: mergeRequest.web_url,
      files,
    });
  }

  return {
    inspected: true,
    targetBranch,
    queued: queued.length,
    ...(mergeRequests.length > queued.length ? { truncated: mergeRequests.length } : {}),
    conflicts,
    ...(skipped.length > 0 ? { skipped } : {}),
    clear: conflicts.length === 0,
  };
}
