import { defineConfig } from "vitest/config";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Two projects, because the two kinds of test want different environments and
 * paying jsdom's startup cost for pure-logic tests makes the suite slow enough
 * that people stop running it.
 *
 *   unit       — *.test.ts   in node. Engines, route handlers, helpers.
 *   component  — *.test.tsx  in jsdom with Testing Library. Interactive UI.
 *
 * See docs/decisions/testing-strategy.md for what belongs in each.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    globals: true,
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          environment: "node",
          include: ["src/**/*.test.ts"],
        },
      },
      {
        extends: true,
        // No @vitejs/plugin-react: Vitest's built-in oxc transform already
        // handles the automatic JSX runtime, the plugin only adds Fast Refresh
        // (useless in a test run), and its current release pulls a @babel/core
        // 8 pre-release that conflicts with the rest of the tree.
        test: {
          name: "component",
          environment: "jsdom",
          include: ["src/**/*.test.tsx"],
          setupFiles: ["./vitest.setup.ts"],
        },
      },
    ],
  },
});
