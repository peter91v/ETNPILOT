import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

// What an agent learned, offered to the people who own the instructions.
//
// Claude Code writes what it learns into its own memory and reads it back next
// time. Here that would be an agent editing the text that governs agents, past
// the content lock and past the human who is meant to have read it — exactly
// the hole the lock exists to close. So a proposal is never applied. It is a
// file under '.etnpilot/proposals/instructions/', on the run's branch, in a
// commit of its own that says what it is. A person reads it, moves it into
// 'instructions/' if they agree, and locks the content; until then nothing has
// changed and 'content verify' says so.

export const PROPOSALS_DIR = ".etnpilot/proposals/instructions";
export const MAX_PROPOSALS_PER_RUN = 5;
export const MAX_PROPOSAL_BYTES = 32 * 1024;

const NAME = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*){0,5}\.md$/;

export function validateProposal({ name, content, rationale }) {
  if (typeof name !== "string" || !NAME.test(name) || name.includes("..")) {
    return "'name' must be a relative path of lowercase letters, digits, '.', '_' and '-' ending in .md, for example 'testing.md' or 'src/ui/rules.md'.";
  }
  if (typeof content !== "string" || content.trim() === "") return "'content' must be the instruction text.";
  if (Buffer.byteLength(content) > MAX_PROPOSAL_BYTES) return `'content' exceeds ${MAX_PROPOSAL_BYTES} bytes.`;
  if (typeof rationale !== "string" || rationale.trim() === "") {
    return "'rationale' must say what you saw that makes this worth writing down; a reviewer reads it first.";
  }
  return undefined;
}

export function summarizeProposal(proposal) {
  return {
    name: proposal.name,
    agent: proposal.agent,
    bytes: Buffer.byteLength(proposal.content),
    digest: createHash("sha256").update(proposal.content).digest("hex"),
    ...(proposal.tainted ? { tainted: proposal.tainted } : {}),
  };
}

// Written into the run's worktree by the harness, never by the agent: the
// project's own policy denies an agent writes under '.etnpilot/', and that
// denial is what makes 'never applied' a fact rather than a promise.
export async function writeProposals(workspacePath, proposals, runId) {
  const written = [];
  for (const proposal of proposals) {
    const path = join(workspacePath, PROPOSALS_DIR, proposal.name);
    await mkdir(dirname(path), { recursive: true });
    const header = [
      `<!-- Proposed by agent '${proposal.agent}' in run ${runId}. Not applied.`,
      `Why: ${oneLine(proposal.rationale)}`,
      ...(proposal.tainted ? [`Written after this run read outside text (${oneLine(proposal.tainted)}); read it with that in mind.`] : []),
      "To adopt: move it to .etnpilot/instructions/, then run 'etnpilot content lock'. -->",
      "",
    ].join("\n");
    await writeFile(path, `${header}${proposal.content.endsWith("\n") ? proposal.content : `${proposal.content}\n`}`, "utf8");
    written.push(`${PROPOSALS_DIR}/${proposal.name}`);
  }
  return written;
}

// The paragraph a merge request carries so nobody merges one by accident.
export function describeProposals(proposals, { tainted } = {}) {
  if (proposals.length === 0) return "";
  const lines = [
    "",
    "**Proposed instruction changes — not applied.**",
    "This run suggests the following. They sit under `.etnpilot/proposals/` in their own commit; the instructions this run used are unchanged and `content verify` is unaffected until someone moves a file into `.etnpilot/instructions/` and locks it.",
    ...proposals.map((proposal) => `- \`${proposal.name}\` (by \`${proposal.agent}\`): ${oneLine(proposal.rationale)}`),
  ];
  if (tainted) lines.push("", `This run read outside text (${oneLine(tainted)}) before or while proposing. Read every proposal as if a stranger wrote it.`);
  return lines.join("\n");
}

function oneLine(text) {
  return String(text).replace(/\s+/g, " ").trim().slice(0, 300);
}
