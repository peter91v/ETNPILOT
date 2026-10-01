import js from "@eslint/js";
import globals from "globals";

// A small rule set on purpose: what catches real mistakes (undefined names,
// unused variables, empty blocks, accidental assignments), not style.
export default [
  { ignores: ["node_modules/**", "upstream/**", "coverage/**", ".etnpilot/**", ".codegraph/**"] },
  js.configs.recommended,
  {
    files: ["**/*.js", "**/*.mjs"],
    languageOptions: { ecmaVersion: 2024, sourceType: "module", globals: { ...globals.node } },
    rules: {
      "no-unused-vars": ["error", { args: "none", caughtErrors: "none", ignoreRestSiblings: true, varsIgnorePattern: "^_" }],
      // Best-effort cleanups are written as .catch(() => {}); an empty catch
      // needs a reason in a comment, which allowEmptyCatch does not demand, so
      // empty blocks other than catch are the ones refused.
      "no-empty": ["error", { allowEmptyCatch: true }],
      // Several modules strip or reject control characters on purpose.
      "no-control-regex": "off",
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-var": "error",
      "prefer-const": ["error", { destructuring: "all" }],
      // A ratchet, not a goal: the most complex function today is just under
      // this. A function above it fails; lower it as the big ones are split.
      complexity: ["error", 60],
    },
  },
  {
    // The one known outlier, held where it is so it cannot grow: the TUI's
    // run detail. Splitting it is the open work.
    files: ["src/tui/render.js"],
    rules: { complexity: ["error", 71] },
  },
  {
    // The page's script runs in a browser as one file made of these, in order,
    // so what one defines the others use: undefined-name and unused checks
    // across files are not meaningful, the syntax and the rest are.
    files: ["src/ui/client/**/*.js"],
    languageOptions: { sourceType: "script", globals: { ...globals.browser, TOKEN: "readonly", renderChatMarkdown: "readonly" } },
    rules: { "no-undef": "off", "no-unused-vars": "off", "no-redeclare": "off", "prefer-const": "off" },
  },
  {
    // Code inside page.evaluate() runs in the browser, in the page's own scope.
    files: ["test-ui/**/*.js"],
    languageOptions: { globals: { ...globals.node, ...globals.browser, show: "readonly" } },
  },
  {
    files: ["test/**/*.js", "test/**/*.mjs", "test-ui/**/*.js"],
    rules: { "no-unused-vars": "off" },
  },
];
