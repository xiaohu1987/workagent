import path from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

const root = path.resolve(__dirname, "../..");

const alias = {
  "@shared-types": path.resolve(root, "packages/shared-types/src/index.ts"),
  "@agent-runtime": path.resolve(root, "packages/agent-runtime/src/index.ts"),
  "@browser-runtime": path.resolve(root, "packages/browser-runtime/src/index.ts"),
  "@tool-runtime": path.resolve(root, "packages/tool-runtime/src/index.ts"),
  "@skills-runtime": path.resolve(root, "packages/skills-runtime/src/index.ts"),
  "@knowledge-runtime": path.resolve(root, "packages/knowledge-runtime/src/index.ts"),
  "@mcp-runtime": path.resolve(root, "packages/mcp-runtime/src/index.ts"),
  "@plugin-runtime": path.resolve(root, "packages/plugin-runtime/src/index.ts"),
  "@provider-adapters": path.resolve(root, "packages/provider-adapters/src/index.ts"),
  "@database-runtime": path.resolve(root, "packages/database-runtime/src/index.ts"),
  "@shared-types/": path.resolve(root, "packages/shared-types/src/"),
  "@agent-runtime/": path.resolve(root, "packages/agent-runtime/src/"),
  "@browser-runtime/": path.resolve(root, "packages/browser-runtime/src/"),
  "@tool-runtime/": path.resolve(root, "packages/tool-runtime/src/"),
  "@skills-runtime/": path.resolve(root, "packages/skills-runtime/src/"),
  "@knowledge-runtime/": path.resolve(root, "packages/knowledge-runtime/src/"),
  "@mcp-runtime/": path.resolve(root, "packages/mcp-runtime/src/"),
  "@plugin-runtime/": path.resolve(root, "packages/plugin-runtime/src/"),
  "@provider-adapters/": path.resolve(root, "packages/provider-adapters/src/"),
  "@database-runtime/": path.resolve(root, "packages/database-runtime/src/")
};

export default defineConfig({
  main: {
    root,
    plugins: [externalizeDepsPlugin()],
    resolve: { alias },
    build: {
      outDir: "dist/main",
      rollupOptions: {
        external: ["electron"],
        input: path.resolve(root, "apps/desktop/src/main/index.ts")
      }
    }
  },
  preload: {
    root,
    plugins: [externalizeDepsPlugin()],
    resolve: { alias },
    build: {
      outDir: "dist/preload",
      rollupOptions: {
        external: ["electron"],
        input: path.resolve(root, "apps/desktop/src/preload/index.ts"),
        output: {
          format: "cjs",
          entryFileNames: "index.cjs"
        }
      }
    }
  },
  renderer: {
    root: path.resolve(root, "apps/desktop/src/renderer"),
    plugins: [react()],
    resolve: { alias },
    build: {
      outDir: path.resolve(root, "dist/renderer"),
      rollupOptions: {
        input: path.resolve(root, "apps/desktop/src/renderer/index.html")
      }
    }
  }
});
