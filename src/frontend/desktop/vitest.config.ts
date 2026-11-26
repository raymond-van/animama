import { defineConfig } from "vitest/config";

export default defineConfig({
  // Preload sources are CommonJS TypeScript (.cts); transform them like other
  // TypeScript so a test can import one.
  oxc: { include: /\.(m?ts|cts|[jt]sx)$/u },
  test: {
    include: ["tests/**/*.test.{ts,mjs}"],
    // Leave CPUs for parallel local work; CI keeps Vitest's default. Vitest's
    // VITEST_MAX_WORKERS environment variable overrides either value.
    maxWorkers: process.env.CI ? undefined : 3,
  },
});
