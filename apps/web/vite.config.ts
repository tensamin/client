import { createReadStream, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { mtp } from "mtp/vite";
import { nonaniumUi } from "@nonanium/ui/vite";

const host = process.env.TAURI_DEV_HOST;
const appDir = dirname(fileURLToPath(import.meta.url));

function deepFilterAssetHeaders(rootDir: string): Plugin {
  const serveModel = (
    req: IncomingMessage,
    res: ServerResponse,
    next: () => void,
  ) => {
    const url = req.url ? new URL(req.url, "http://localhost") : null;
    if (url?.pathname !== "/assets/v3/models/DeepFilterNet3_onnx.tar.gz") {
      next();
      return;
    }

    const modelPath = resolve(
      rootDir,
      "assets/v3/models/DeepFilterNet3_onnx.tar.gz",
    );
    const stat = statSync(modelPath);
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/gzip");
    res.setHeader("Content-Length", stat.size.toString());
    res.setHeader("Cache-Control", "no-cache");
    createReadStream(modelPath).pipe(res);
  };

  return {
    name: "deepfilter-asset-headers",
    configureServer(server) {
      server.middlewares.use(serveModel);
    },
    configurePreviewServer(server) {
      server.middlewares.use(serveModel);
    },
  };
}

export default defineConfig({
  base: process.env.TENSAMIN_WEB_BASE ?? "/",
  clearScreen: false,
  resolve: {
    tsconfigPaths: true,
    dedupe: [
      "react",
      "react-dom",
      "react-redux",
      "use-sync-external-store",
      "@tanstack/history",
      "@tanstack/react-router",
      "@tanstack/router-core",
      "@tensamin/crypto",
      "@tensamin/settings",
      "@tensamin/storage",
      "@tensamin/mtp",
      "@tensamin/login",
      "@tensamin/identity",
      "@tensamin/tauri",
      "@tensamin/chat",
    ],
  },
  server: {
    port: 3000,
    strictPort: true,
    host: "0.0.0.0",
    hmr: host
      ? {
          protocol: "ws",
          host,
          clientPort: 3000,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
      usePolling: true,
      interval: 100,
    },
  },
  envPrefix: ["VITE_", "TAURI_ENV_*", "TENSAMIN_CHANNEL"],
  optimizeDeps: {
    include: [
      "react-redux",
      "use-sync-external-store/shim/with-selector",
      "use-sync-external-store/with-selector",
      "decimal.js-light",
      "eventemitter3",
      "react-is",
    ],
    exclude: [
      "mtp",
      "mtp/raw",
      "mtp/type-map",
      "@tensamin/call",
      "@tensamin/call/utils",
      "@tensamin/chat",
      "@tensamin/crypto",
      "@tensamin/crypto/context",
      "@tensamin/hotkeys",
      "@tensamin/mtp",
      "@tensamin/login",
      "@tensamin/notifications",
      "@tensamin/onboarding",
      "@tensamin/shared",
      "@tensamin/shared/data",
      "@tensamin/shared/log",
      "@tensamin/settings",
      "@tensamin/storage",
      "@tensamin/storage/context",
      "@tensamin/tauri",
      "@tensamin/tauth",
      "@tensamin/identity",
    ],
  },
  build: {
    minify: !process.env.TAURI_ENV_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    chunkSizeWarningLimit: 550,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: "codemirror-core",
              test: /node_modules\/.pnpm\/@codemirror\+(?:state|view|language)@/,
              priority: 20,
            },
            {
              name: "codemirror-editor",
              test: /node_modules\/.pnpm\/@codemirror\+(?:autocomplete|commands|lang-markdown)@|node_modules\/.pnpm\/codemirror@/,
              priority: 20,
            },
            {
              name: "livekit-client",
              test: /node_modules\/.pnpm\/livekit-client@/,
              priority: 20,
            },
            {
              name: "livekit-support",
              test: /node_modules\/.pnpm\/@livekit\+/,
              priority: 20,
            },
          ],
        },
      },
    },
  },
  plugins: [
    nonaniumUi({ defaultThemeId: "tensamin" }),
    deepFilterAssetHeaders(resolve(appDir, "public")),
    mtp({
      typeMaps: resolve(appDir, "../../mtp-type-maps/type-maps.yaml"),
    }),
    {
      name: "workspace-realpath-resolution",
      enforce: "post",
      config() {
        return {
          resolve: {
            preserveSymlinks: false,
          },
        };
      },
    },
    react(),
    tailwindcss(),
  ],
  worker: {
    format: "es",
  },
});
