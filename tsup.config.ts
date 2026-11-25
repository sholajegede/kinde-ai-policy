import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "openai-compatible": "src/openai-compatible.ts",
    openrouter: "src/openrouter.ts",
    vercel: "src/vercel.ts",
    "ai-sdk": "src/ai-sdk.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  target: "node20",
  sourcemap: true,
  external: ["jose", "ai"],
});
