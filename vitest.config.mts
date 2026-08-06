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
    /**
     * Coverage counts the whole of `src`, not just the files a test happened
     * to import. Without an explicit `include`, V8 reports only what was
     * loaded during the run — an untested file is absent from the report
     * rather than scored as zero, so the headline percentage describes the
     * tested corner of the codebase and says nothing about the rest.
     *
     * Thresholds are a ratchet set just under the current numbers: they stop
     * coverage sliding backwards without turning a percentage into the goal.
     * The target is still the list in docs/decisions/testing-strategy.md.
     * Raise these when you clear real ground; never lower them to go green.
     */
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/**/*.test.{ts,tsx}",
        // Test scaffolding, not shipped code.
        "src/**/__mocks__/**",
        // Type-only modules — no runtime statements to cover.
        "src/types/**",
        "src/**/*.d.ts",
        // Framework-called shells with no logic of their own. `loading` and
        // `not-found` are static markup; `error.tsx` is a one-line handoff to
        // the shared RouteError primitive, which is itself covered.
        "src/app/**/loading.tsx",
        "src/app/**/not-found.tsx",
        "src/app/**/error.tsx",
      ],
      reporter: ["text", "html"],
      thresholds: {
        statements: 19,
        branches: 15,
        functions: 16,
        lines: 19,
      },
    },
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
