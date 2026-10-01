import { CodeGraph } from "../../codegraph/codegraph.js";
import { resolve } from "node:path";

// The commands of one area. Each entry says which command line it answers
// ('match') and what it does ('run'); src/cli/commands.js tries them in order.

export const graphCommands = [
  {
    match: ({ command, subcommand }) => command === "graph" && subcommand === "build",
    async run({ rest }) {
      const root = resolve(rest[0] ?? ".");
      const graph = new CodeGraph(root);
      try {
        const result = await graph.indexDirectory(root);
        console.log(JSON.stringify(result, null, 2));
      } finally {
        graph.close();
      }
    },
  },
  {
    match: ({ command, subcommand }) => command === "graph" && subcommand === "dependencies",
    async run({ rest, values }) {
      if (!rest[0]) throw new Error("A file path is required.");
      const graph = new CodeGraph(resolve(values.root));
      try {
        await graph.open();
        console.log(JSON.stringify(graph.dependencies(rest[0]), null, 2));
      } finally {
        graph.close();
      }
    },
  },
  {
    match: ({ command, subcommand }) => command === "graph" && subcommand === "dependents",
    async run({ rest, values }) {
      if (!rest[0]) throw new Error("A file path is required.");
      const graph = new CodeGraph(resolve(values.root));
      try {
        await graph.open();
        console.log(JSON.stringify(graph.dependents(rest[0]), null, 2));
      } finally {
        graph.close();
      }
    },
  },
  {
    match: ({ command, subcommand }) => command === "graph" && subcommand === "symbols",
    async run({ rest, values }) {
      if (!rest[0]) throw new Error("A file path is required.");
      const graph = new CodeGraph(resolve(values.root));
      try {
        await graph.open();
        console.log(JSON.stringify(graph.symbols(rest[0]), null, 2));
      } finally {
        graph.close();
      }
    },
  },
  {
    match: ({ command, subcommand }) => command === "graph" && subcommand === "impact",
    async run({ rest, values }) {
      if (rest.length === 0) throw new Error("At least one changed file is required.");
      const maxDepth = values.depth === undefined ? 20 : Number.parseInt(values.depth, 10);
      const graph = new CodeGraph(resolve(values.root));
      try {
        await graph.open();
        console.log(JSON.stringify(graph.impact(rest, { maxDepth }), null, 2));
      } finally {
        graph.close();
      }
    },
  },
  {
    match: ({ command, subcommand }) => command === "graph" && subcommand === "stats",
    async run({ values }) {
      const graph = new CodeGraph(resolve(values.root));
      try {
        await graph.open();
        console.log(JSON.stringify(graph.stats(), null, 2));
      } finally {
        graph.close();
      }
    },
  },
];
