import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["./test/helpers/setup.js"],
    // Agent worktrees under .claude/ hold full repo copies — without this,
    // their test suites run too (duplicated, against stale code).
    exclude: ["**/node_modules/**", "**/.claude/**", "test/browser/**"],
  },
});
