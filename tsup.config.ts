import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts", "openai-compatible": "src/openai-compatible.ts" },
  format: ["esm", "cjs"],
  dts: true,
  target: "node20",
  sourcemap: true,
  external: ["jose"],
});
