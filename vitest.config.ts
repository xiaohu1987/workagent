import path from "node:path";
import { defineConfig } from "vitest/config";

const root = path.resolve(__dirname);

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"]
  },
  resolve: {
    alias: {
      "@shared-types": path.resolve(root, "packages/shared-types/src/index.ts"),
      "@agent-runtime": path.resolve(root, "packages/agent-runtime/src/index.ts"),
      "@browser-runtime": path.resolve(root, "packages/browser-runtime/src/index.ts"),
      "@tool-runtime": path.resolve(root, "packages/tool-runtime/src/index.ts"),
      "@skills-runtime": path.resolve(root, "packages/skills-runtime/src/index.ts"),
      "@knowledge-runtime": path.resolve(root, "packages/knowledge-runtime/src/index.ts"),
      "@mcp-runtime": path.resolve(root, "packages/mcp-runtime/src/index.ts"),
      "@plugin-runtime": path.resolve(root, "packages/plugin-runtime/src/index.ts"),
      "@provider-adapters": path.resolve(root, "packages/provider-adapters/src/index.ts")
    }
  }
});
