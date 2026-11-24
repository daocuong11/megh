import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // esbuild cannot emit decorator metadata, which controllers and DTOs rely
  // on. SWC reads it from tsconfig.json.
  plugins: [swc.vite()],
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
