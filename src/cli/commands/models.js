import { join, resolve } from "node:path";
import { loadConfig } from "../../config/load.js";
import { openProjectState } from "../../runtime/project-state.js";

// What a configured provider offers this account, with the price the built-in
// table knows. Answers "which id is 'GPT-5.6 Luna'?" without guessing.

export const modelsCommands = [
  {
    match: ({ command }) => command === "models",
    async run({ values }) {
      const root = resolve(values.root);
      const config = await loadConfig(join(root, ".etnpilot", "etnpilot.yaml"));
      const name = values.provider ?? config.defaultProvider;
      if (!name) throw new Error("Name a provider with --provider (this project has no defaultProvider).");
      const state = await openProjectState({ root });
      try {
        const result = await state.listProviderModels(name);
        if (values.json) {
          console.log(JSON.stringify(result, null, 2));
          return result.available ? 0 : 1;
        }
        if (!result.available) {
          console.log(`'${name}': ${result.reason}`);
          return 1;
        }
        console.log(`${result.models.length} model(s) '${name}' offers this account (price per million tokens: in / out):`);
        for (const model of result.models) {
          const price = model.knownPrice ? `${model.knownPrice.inputPerMillion} / ${model.knownPrice.outputPerMillion}` : "no price known";
          console.log(`  ${String(model.id).padEnd(34)} ${price}`);
        }
        const unpriced = result.models.filter((model) => !model.knownPrice).length;
        if (unpriced > 0) console.log(`\n${unpriced} without a price in the table; they are priced from the public catalogue when it knows them (observability.pricing.autoUpdate).`);
        return 0;
      } finally {
        state.close();
      }
    },
  },
];
