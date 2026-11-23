import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { mtp } from "mtp/vite";

// Brotli's ESM entry fetches its WASM, even under Node.
const brotliNode = createRequire(
  new URL("packages/crypto/package.json", import.meta.url),
).resolve("brotli-wasm");
const mtpOutDir = new URL("node_modules/.vite/mtp/", import.meta.url);

export default defineConfig({
  plugins: [
    mtp({
      typeMaps: "mtp-type-maps/type-maps.yaml",
      outDir: fileURLToPath(mtpOutDir),
      release: true,
    }),
    {
      name: "workspace-realpath-resolution",
      enforce: "post",
      config: () => ({ resolve: { preserveSymlinks: false } }),
    },
  ],
  resolve: { alias: { "brotli-wasm": brotliNode } },
  test: {
    provide: {
      mtpWasmPath: fileURLToPath(new URL("mtp_wasm_bg.wasm", mtpOutDir)),
    },
    server: { deps: { inline: ["@nonanium/ui"] } },
    exclude: ["**/node_modules/**", "**/.direnv/**", "**/dist/**"],
  },
});
