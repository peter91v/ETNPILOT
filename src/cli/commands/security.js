// @ts-check
import { ApprovalPolicy } from "../../core/approval-policy.js";
import { Harness } from "../../core/harness.js";
import { PolicyEngine } from "../../policy/engine.js";
import { checkDependencyPolicy } from "../../supply/dependencies.js";
import { createSecretResolver } from "../../secrets/resolver.js";
import { createTerminalApprovalHandler } from "../../core/terminal-approval.js";
import { generateSbom } from "../../supply/sbom.js";
import { ignoreMissing, isBootstrapPlugin, writeOrPrint } from "../shared.js";
import { join, resolve } from "node:path";
import { loadConfig } from "../../config/load.js";
import { loadPlugins } from "../../plugins/load-plugin.js";
import { readProjectPackages } from "../../supply/ecosystems.js";
import { runAuthCommand } from ".././auth.js";
import { scanForSecrets } from "../../supply/secret-scan.js";

// The commands of one area. Each entry says which command line it answers
// ('match') and what it does ('run'); src/cli/commands.js tries them in order.

export const securityCommands = [
  {
    match: ({ command, subcommand }) => command === "login" || command === "logout" || command === "auth",
    async run({ command, subcommand, rest, values }) {
      return await runAuthCommand(command, subcommand, values, { rest });
    },
  },
  {
    match: ({ command, subcommand }) => command === "secret" && subcommand === "check",
    async run({ rest, values }) {
      if (!rest[0]) throw new Error("A configured secret name is required.");
      const root = resolve(values.root);
      const config = await loadConfig(join(root, ".etnpilot", "etnpilot.yaml"));
      const resolver = createSecretResolver({ root, config });
      const policy = new PolicyEngine(config.policy);
      const harness = new Harness({
        approvalPolicy: new ApprovalPolicy(config.approval, { policy }),
        approvalHandler: createTerminalApprovalHandler(),
        policy,
        secrets: resolver,
      });
      try {
        await loadPlugins((config.plugins ?? []).filter(isBootstrapPlugin), harness, root, {
          isolation: config.pluginIsolation,
          secretResolver: resolver,
          bootstrap: true,
        });
        const result = await resolver.check(rest[0]);
        console.log(JSON.stringify(result, null, 2));
        return result.available ? 0 : 1;
      } finally {
        await harness.close();
      }
    },
  },
  {
    match: ({ command, subcommand }) => command === "policy" && subcommand === "check",
    async run({ values }) {
      if (Boolean(values.kind) === Boolean(values.provider)) {
        throw new Error("Specify either --kind or --provider.");
      }
      if ([values.path, values.url, values.command].filter(Boolean).length > 1) throw new Error("Choose one of --path, --url or --command.");
      const root = resolve(values.root);
      const config = await loadConfig(join(root, ".etnpilot", "etnpilot.yaml"));
      const policy = new PolicyEngine(config.policy);
      const result = values.provider
        ? policy.evaluateProvider(values.provider, { agent: values.agent })
        : policy.evaluateOperation({
            kind: values.kind,
            ...(values.path ? { fileName: values.path } : {}),
            ...(values.url ? { url: values.url } : {}),
            ...(values.command ? { toolArguments: values.command.split(" ").filter(Boolean) } : {}),
          }, { agent: values.agent, workspace: root });
      const report = result ?? { configured: false, reason: "No policy section is configured." };
      console.log(JSON.stringify(report, null, 2));
      const denied = values.provider ? result?.allowed === false : result?.kind === "reject";
      return denied || !result ? 1 : 0;
    },
  },
  {
    match: ({ command, subcommand }) => command === "deps" && subcommand === "check",
    async run({ values }) {
      const root = resolve(values.root);
      const config = await loadConfig(join(root, ".etnpilot", "etnpilot.yaml")).catch(ignoreMissing);
      const inventory = await readProjectPackages(root, config?.supplyChain ?? {});
      const report = checkDependencyPolicy(inventory.packages, config?.supplyChain ?? {});
      console.log(JSON.stringify({ ecosystems: inventory.ecosystems, ...report }, null, 2));
      return report.ok ? 0 : 1;
    },
  },
  {
    match: ({ command, subcommand }) => command === "sbom",
    async run({ values }) {
      const root = resolve(values.root);
      const document = await generateSbom(root);
      await writeOrPrint(values.out ? resolve(root, values.out) : undefined, document);
    },
  },
  {
    match: ({ command, subcommand }) => command === "scan" && (subcommand === "secrets" || subcommand === undefined),
    async run({ values }) {
      const root = resolve(values.root);
      const config = await loadConfig(join(root, ".etnpilot", "etnpilot.yaml")).catch(ignoreMissing);
      const report = await scanForSecrets(root, { allow: config?.supplyChain?.secretScan?.allow ?? [] });
      console.log(JSON.stringify(report, null, 2));
      return report.ok ? 0 : 1;
    },
  },
];
