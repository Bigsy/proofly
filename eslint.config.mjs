// Flat ESLint config for a framework-free MV3 extension: plain es2024
// modules everywhere, three runtime surfaces (extension pages, content
// scripts, the SW) plus the Vitest/Playwright test layer. Correctness rules
// come from eslint:recommended; the @stylistic layer doubles as the format
// check (the codebase predates any formatter — these rules pin the style it
// already follows instead of churning every file through Prettier).

import js from "@eslint/js";
import stylistic from "@stylistic/eslint-plugin";
import globals from "globals";

const style = {
  plugins: { "@stylistic": stylistic },
  rules: {
    "@stylistic/quotes": ["error", "double", { avoidEscape: true }],
    "@stylistic/semi": ["error", "always"],
    "@stylistic/no-trailing-spaces": "error",
    "@stylistic/eol-last": "error",
    "@stylistic/indent": ["error", 2, { SwitchCase: 1 }],
    "@stylistic/no-mixed-spaces-and-tabs": "error",
  },
};

export default [
  {
    ignores: ["node_modules/", "test-results/", "icons/", "vendor/"],
  },
  js.configs.recommended,
  style,
  {
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.browser,
        ...globals.webextensions,
        // The built-in AI globals (flag-gated Chrome APIs).
        Proofreader: "readonly",
        Rewriter: "readonly",
      },
    },
    rules: {
      // Empty catch IS the codebase's silent-degrade idiom — allow only that.
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-unused-vars": ["error", {
        args: "none",                      // deps-injected signatures keep doc-value
        caughtErrors: "none",              // catch (e) { /* silent degrade */ }
        varsIgnorePattern: "^_",
      }],
    },
  },
  {
    // Test layer: Node + browser mix (Vitest jsdom, Playwright, fixtures).
    files: ["test/**/*.js", "tools/**/*.js", "tools/**/*.mjs"],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },
];
