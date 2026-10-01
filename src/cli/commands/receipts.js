import { agentRawResponses, openProjectState } from "../../runtime/project-state.js";
import { basename, resolve } from "node:path";
import { buildRunAttestation } from "../../supply/attestation.js";
import { generateReceiptKeyPair, loadReceiptVerifiers } from "../../core/receipt-signing.js";
import { resolveReceiptPublicKeys, writeOrPrint } from "../shared.js";
import { verifyReceiptFile } from "../../core/receipt-store.js";

// The commands of one area. Each entry says which command line it answers
// ('match') and what it does ('run'); src/cli/commands.js tries them in order.

export const receiptsCommands = [
  {
    match: ({ command, subcommand }) => command === "receipt" && subcommand === "keygen",
    async run({ values }) {
      const publicKeys = values["public-key"] ?? [];
      if (publicKeys.length > 1) throw new Error("Receipt key generation accepts one --public-key path.");
      const root = resolve(values.root);
      const result = await generateReceiptKeyPair({
        privateKeyPath: resolve(root, values["private-key"] ?? ".etnpilot/keys/receipt-signing-private.pem"),
        publicKeyPath: resolve(root, publicKeys[0] ?? ".etnpilot/receipt-signing-public.pem"),
      });
      console.log(JSON.stringify(result, null, 2));
    },
  },
  {
    match: ({ command, subcommand }) => command === "receipt" && subcommand === "show",
    async run({ rest, values }) {
      // The same answer the review page and the terminal interface give, from
      // the same reader: a run explained in one place and not the others is a
      // run explained differently depending on where you look.
      const root = resolve(values.root);
      const state = await openProjectState({ root });
      try {
        const runs = await state.collect().then((snapshot) => snapshot.runs ?? []);
        const file = rest[0] ? basename(rest[0]) : runs[0]?.receiptFile;
        if (!file) throw new Error("No receipt to show: this project has recorded no runs yet.");
        // A path printed by 'etnpilot run' is the natural thing to paste, so the
        // directory part is dropped rather than refused; what is read is always
        // this project's own runs directory.
        const receipt = await state.readReceipt(file).catch((error) => {
          if (error.code === "ENOENT") {
            throw new Error(`No receipt named '${file}' in .etnpilot/state/runs. 'etnpilot receipt show' with no file takes the newest.`);
          }
          throw error instanceof TypeError ? new Error(`${error.message} Receipts live in .etnpilot/state/runs.`) : error;
        });
        const run = runs.find((candidate) => candidate.receiptFile === file);
        const outcome = receipt.outcome;
        console.log(JSON.stringify({
          receipt: file,
          ...(run ? { runId: run.runId, mode: run.mode, sealed: run.terminal, signed: run.signed, durationMs: run.durationMs } : {}),
          status: outcome.status,
          entries: receipt.entries.length,
          // Why it ended, first: that is what someone opening a failed run is
          // asking. The step's whole result belongs in the file, not in an
          // answer read on a phone.
          why: outcome.reasons.map((reason) => (reason.step ? `${reason.step}: ` : "") + reason.text),
          steps: outcome.steps.map((step) => ({
            id: step.id,
            status: step.status,
            ...(step.attempts > 1 ? { attempts: step.attempts } : {}),
            ...(step.error ? { error: step.error } : {}),
          })),
          // Where the files are, and what it did to them.
          ...(outcome.workspace ? { workspace: outcome.workspace } : {}),
          ...(outcome.tools ? { tools: outcome.tools } : {}),
          ...(outcome.agents.length > 0 ? { agents: outcome.agents } : {}),
          ...(outcome.rehearsal ? { mergeRehearsal: outcome.rehearsal } : {}),
          ...(outcome.usage ? { usage: outcome.usage } : {}),
          ...(outcome.cleanup ? { cleanup: outcome.cleanup } : {}),
          // The provider's own response body, exactly as it arrived — not shown
          // by default, because it is one payload per call and belongs to
          // whoever asked for it by name with '--raw'.
          ...(values.raw ? { raw: agentRawResponses(receipt) } : {}),
        }, null, 2));
        return receipt.outcome.status === "succeeded" ? 0 : 1;
      } finally {
        state.close();
      }
    },
  },
  {
    match: ({ command, subcommand }) => command === "receipt" && subcommand === "verify",
    async run({ rest, values }) {
      if (!rest[0]) throw new Error("A receipt file is required.");
      if (values["require-signatures"] && values["allow-unsigned"]) {
        throw new Error("Choose either --require-signatures or --allow-unsigned, not both.");
      }
      if (values["require-terminal"] && values["allow-incomplete"]) {
        throw new Error("Choose either --require-terminal or --allow-incomplete, not both.");
      }
      const publicKeyPaths = await resolveReceiptPublicKeys(resolve(values.root), values["public-key"] ?? []);
      const verifiers = await loadReceiptVerifiers(publicKeyPaths);
      const requireSignatures = values["require-signatures"]
        || (publicKeyPaths.length > 0 && !values["allow-unsigned"]);
      const requireTerminal = values["require-terminal"]
        || (publicKeyPaths.length > 0 && !values["allow-incomplete"]);
      const result = await verifyReceiptFile(resolve(rest[0]), {
        verifiers,
        requireSignatures,
        requireTerminal,
      });
      console.log(JSON.stringify(result, null, 2));
      return result.valid ? 0 : 1;
    },
  },
  {
    match: ({ command, subcommand }) => command === "attest",
    async run({ subcommand, values }) {
      if (!subcommand) throw new Error("A receipt file is required.");
      const root = resolve(values.root);
      const publicKeyPaths = await resolveReceiptPublicKeys(root, values["public-key"] ?? []);
      const statement = await buildRunAttestation(resolve(subcommand), {
        root,
        verifiers: await loadReceiptVerifiers(publicKeyPaths),
      });
      await writeOrPrint(values.out ? resolve(root, values.out) : undefined, statement);
    },
  },
];
