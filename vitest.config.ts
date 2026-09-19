import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      // react's package.json resolves "@ravnexchange/sdk" to core's BUILT dist/ via the npm
      // workspace; this points tests straight at the TS source instead, so `vitest run` never
      // needs `npm run build` first.
      "@ravnexchange/sdk": fileURLToPath(new URL("./core/src/index.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});
