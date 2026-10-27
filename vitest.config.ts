import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";

export default defineConfig(({ mode }) => ({
  test: {
    include: ["shared/**/*.test.ts", "server/**/*.test.ts", "client/**/*.test.ts"],
    environment: "node",
    // Make TEST_DATABASE_URL from .env visible to tests (and nothing else from it).
    env: loadEnv(mode, process.cwd(), "TEST_DATABASE_URL"),
    // Database tests share one test database, so test files must take turns.
    fileParallelism: false,
  },
}));
