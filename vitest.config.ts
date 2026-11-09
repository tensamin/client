import { defineConfig } from "vitest/config";
import { mtp } from "mtp/vite";

export default defineConfig({
  plugins: [
    mtp({
      typeMaps: "mtp-type-maps/type-maps.yaml",
      outDir: "apps/web/node_modules/.vite/mtp",
      release: true,
    }),
  ],
  test: {
    exclude: ["**/node_modules/**", "**/.direnv/**", "**/dist/**"],
  },
});
