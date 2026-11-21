import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 60000,
    // Tests match plain CLI output. `lerna run test` (Nx) sets FORCE_COLOR,
    // which would otherwise wrap that output in ANSI codes.
    env: { NO_COLOR: "1" },
  },
});
