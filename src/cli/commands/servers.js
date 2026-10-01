import { createFirstRunApp } from "../../tui/first-run.js";
import { createGitLabWebhookServer } from "../../gitlab/webhook-server.js";
import { createReviewServer } from "../../ui/server.js";
import { createTuiApp } from "../../tui/app.js";
import { describeProject } from "../../runtime/first-run.js";
import { openInBrowser } from "../../ui/open-browser.js";
import { openProjectState } from "../../runtime/project-state.js";
import { resolve } from "node:path";
import { shouldOpenBrowser } from "../shared.js";

// The commands of one area. Each entry says which command line it answers
// ('match') and what it does ('run'); src/cli/commands.js tries them in order.

export const serversCommands = [
  {
    match: ({ command, subcommand }) => command === "webhook" && subcommand === "serve",
    async run({ values, waitForShutdown }) {
      const port = values.port === undefined ? undefined : Number.parseInt(values.port, 10);
      if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65_535)) {
        throw new Error("--port must be an integer between 0 and 65535.");
      }
      const webhookServer = await createGitLabWebhookServer({ root: resolve(values.root) });
      const address = await webhookServer.listen({ host: values.host, port });
      const displayHost = typeof address === "object" ? address.address : values.host;
      const displayPort = typeof address === "object" ? address.port : port;
      console.log(`ETNPilot GitLab webhook receiver listening on http://${displayHost}:${displayPort}`);
      await waitForShutdown();
      await webhookServer.close();
    },
  },
  {
    match: ({ command, subcommand }) => command === "tui",
    async run({ values }) {
      const root = resolve(values.root);
      const { quietSqliteWarning } = await import("../quiet-warnings.js");
      quietSqliteWarning();
      if (!process.stdin.isTTY) {
        throw new Error("The TUI needs an interactive terminal. Use 'etnpilot ui' or the plain commands instead.");
      }
      // A directory with no project in it used to end here with the ENOENT of a
      // file nobody had heard of. It now offers to create one, and then opens on
      // what it created — which is what was being asked for.
      const project = await describeProject({ root });
      if (!project.exists) {
        const setup = createFirstRunApp({ root });
        try {
          await setup.start();
        } finally {
          setup.stop();
        }
        if (!setup.created) {
          console.log("Nothing was created. 'etnpilot init' does the same thing without the screen.");
          return 0;
        }
        console.log(`Created ${setup.created.configFile} (${setup.created.template}).`);
        for (const line of setup.created.importLines ?? []) console.log(line);
        if (setup.created.importLines?.length) console.log("Review what came along, then run 'etnpilot content lock'.");
      }
      const state = await openProjectState({ root });
      const app = createTuiApp({ state, actor: values.actor });
      try {
        await app.start();
      } finally {
        app.stop();
        state.close();
      }
    },
  },
  {
    match: ({ command, subcommand }) => command === "ui",
    async run({ command, rest, values, waitForShutdown }) {
      const port = values.port === undefined ? undefined : Number.parseInt(values.port, 10);
      if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65_535)) {
        throw new Error("--port must be an integer between 0 and 65535.");
      }
      const review = await createReviewServer({
        root: resolve(values.root),
        rotateToken: values["rotate-token"],
      });
      const address = await review.listen({ host: values.host, port });
      console.log(`ETNPilot review UI: ${address.url}`);
      if (address.warning) console.log(address.warning);
      // The token is no longer minted per start — an installed app holds a link,
      // and a link that expires at the next restart is an icon that 401s. So it
      // says what it is: a stored credential, and how to throw it away.
      console.log("The link carries this project's token, kept in .etnpilot/state/ and never committed.");
      console.log("Anyone who has it can approve operations, change local settings, and start runs.");
      console.log("Replace it with 'etnpilot ui --rotate-token', which locks out every link and app.");
      if (address.exposed) {
        // Binding away from loopback drops the guarantee the rest of this
        // surface is built on, so it is said plainly rather than left to the
        // documentation.
        console.log("");
        console.log("This port is open to your network, not just this machine. Everyone who can reach");
        console.log("it and has the token has that same power, and the connection is plain HTTP, so the");
        console.log("token can be read by anyone on that network. An SSH tunnel keeps it on loopback:");
        console.log(`  ssh -N -L ${address.port}:127.0.0.1:${address.port} <user>@<this-machine>`);
      }
      // The point of this command is to look at the page, so it opens where
      // there is a person to look: an interactive terminal, unless they said
      // otherwise. Nothing here can fail the server that is already listening.
      if (shouldOpenBrowser(values, process.env, process.stdout)) {
        const opened = await openInBrowser(address.url).catch((error) => ({ opened: false, reason: error.message }));
        console.log(opened.opened
          ? `Opened it with '${opened.command}'. Use --no-open to keep it in the terminal.`
          : `Could not open a browser (${opened.reason}) — copy the link above.`);
      }
      await waitForShutdown();
      await review.close();
    },
  },
];
