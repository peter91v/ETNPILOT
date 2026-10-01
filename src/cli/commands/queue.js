// @ts-check
import { resolve } from "node:path";
import { withApprovalInbox, withWorkflowQueue } from "../shared.js";

// The commands of one area. Each entry says which command line it answers
// ('match') and what it does ('run'); src/cli/commands.js tries them in order.

export const queueCommands = [
  {
    match: ({ command, subcommand }) => command === "approval" && subcommand === "list",
    async run({ values }) {
      const limit = values.limit === undefined ? 100 : Number.parseInt(values.limit, 10);
      await withApprovalInbox(resolve(values.root), async (inbox) => {
        console.log(JSON.stringify(inbox.list({ status: values.status ?? "pending", limit }), null, 2));
      });
    },
  },
  {
    match: ({ command, subcommand }) => command === "approval" && subcommand === "show",
    async run({ rest, values }) {
      if (!rest[0]) throw new Error("An approval ID is required.");
      await withApprovalInbox(resolve(values.root), async (inbox) => {
        const approval = inbox.get(rest[0]);
        if (!approval) throw new Error(`Unknown approval '${rest[0]}'.`);
        console.log(JSON.stringify(approval, null, 2));
      });
    },
  },
  {
    match: ({ command, subcommand }) => command === "approval" && (subcommand === "approve" || subcommand === "reject"),
    async run({ subcommand, rest, values }) {
      if (!rest[0]) throw new Error("An approval ID is required.");
      await withApprovalInbox(resolve(values.root), async (inbox) => {
        const decision = subcommand === "approve"
          ? (values["for-run"] ? "approved-for-run" : "approved")
          : "rejected";
        const result = inbox.decide(rest[0], decision, {
          actor: values.actor ?? process.env.USER ?? "cli",
          reason: values.reason,
          scope: values.scope,
        });
        console.log(JSON.stringify(result, null, 2));
      });
    },
  },
  {
    match: ({ command, subcommand }) => command === "queue" && subcommand === "list",
    async run({ values }) {
      const limit = values.limit === undefined ? 100 : Number.parseInt(values.limit, 10);
      await withWorkflowQueue(resolve(values.root), async (queue) => {
        console.log(JSON.stringify(queue.list({ status: values.status ?? "all", limit }), null, 2));
      });
    },
  },
  {
    match: ({ command, subcommand }) => command === "queue" && subcommand === "show",
    async run({ rest, values }) {
      if (!rest[0]) throw new Error("A workflow job ID is required.");
      await withWorkflowQueue(resolve(values.root), async (queue) => {
        const job = queue.get(rest[0]);
        if (!job) throw new Error(`Unknown workflow job '${rest[0]}'.`);
        console.log(JSON.stringify(job, null, 2));
      });
    },
  },
  {
    match: ({ command, subcommand }) => command === "queue" && subcommand === "resume",
    async run({ rest, values }) {
      if (!rest[0]) throw new Error("A workflow job ID is required.");
      await withWorkflowQueue(resolve(values.root), async (queue) => {
        console.log(JSON.stringify(queue.resume(rest[0], { force: values.force }), null, 2));
      });
    },
  },
  {
    match: ({ command, subcommand }) => command === "queue" && subcommand === "cancel",
    async run({ rest, values }) {
      if (!rest[0]) throw new Error("A workflow job ID is required.");
      await withWorkflowQueue(resolve(values.root), async (queue) => {
        console.log(JSON.stringify(queue.requestCancel(rest[0], {
          actor: values.actor ?? process.env.USER ?? "cli",
          reason: values.reason,
        }), null, 2));
      });
    },
  },
];
