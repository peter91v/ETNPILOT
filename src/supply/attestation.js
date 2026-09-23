import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { verifyReceiptFile } from "../core/receipt-store.js";

const STATEMENT_TYPE = "https://in-toto.io/Statement/v1";
const PREDICATE_TYPE = "https://slsa.dev/provenance/v1";

// An in-toto statement derived from a run receipt: what was produced, by
// which builder, from which base. It restates the receipt in a format other
// tools already understand, and claims nothing the receipt does not record.
export async function buildRunAttestation(receiptPath, {
  root = process.cwd(),
  builderId = "https://github.com/peter91v/ETNPILOT",
  verifiers = new Map(),
} = {}) {
  const path = resolve(receiptPath);
  const verification = await verifyReceiptFile(path, { verifiers });
  const entries = (await readFile(path, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const terminal = entries.findLast((entry) => entry.terminal === true);
  if (!terminal) throw new Error(`Receipt '${path}' has no terminal entry; the run did not finish.`);
  if (!verification.valid) throw new Error(`Receipt '${path}' did not verify: ${verification.reason}.`);

  const workspace = resolve(terminal.workspace?.path ?? root);
  const changed = terminal.git?.changedPaths ?? [];
  const subject = [];
  for (const relativePath of changed) {
    const digest = await sha256File(join(workspace, relativePath));
    if (digest) subject.push({ name: relativePath, digest: { sha256: digest } });
  }

  return {
    _type: STATEMENT_TYPE,
    subject: subject.length > 0
      ? subject
      // A run that changed nothing still attests to itself.
      : [{ name: `etnpilot-run/${terminal.runId}`, digest: { sha256: terminal.hash ?? hashOf(terminal) } }],
    predicateType: PREDICATE_TYPE,
    predicate: {
      buildDefinition: {
        buildType: "https://github.com/peter91v/ETNPILOT/run/v1",
        externalParameters: {
          workspaceMode: terminal.workspace?.managed ? "worktree" : "in-place",
          mode: terminal.mode ?? "execute",
          ...(terminal.workspace?.branch ? { branch: terminal.workspace.branch } : {}),
          ...(terminal.workspace?.sandbox ? { sandbox: terminal.workspace.sandbox } : {}),
        },
        resolvedDependencies: terminal.git?.head
          ? [{ uri: "git+HEAD", digest: { sha1: terminal.git.head } }]
          : [],
      },
      runDetails: {
        builder: { id: builderId },
        metadata: {
          invocationId: terminal.runId,
          ...(terminal.proof ? { signatureKeyId: terminal.proof.keyId } : {}),
        },
        byproducts: [{
          name: "etnpilot-receipt",
          digest: { sha256: terminal.hash },
          // Reviewers verify the chain itself with `etnpilot receipt verify`.
          mediaType: "application/vnd.etnpilot.receipt+jsonl",
        }],
      },
    },
  };
}

async function sha256File(path) {
  try {
    return createHash("sha256").update(await readFile(path)).digest("hex");
  } catch {
    return undefined;
  }
}

function hashOf(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
