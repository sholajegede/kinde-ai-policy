import { existsSync, readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

// Live and contract tests read their keys from .env.local, which is never committed. Shell variables win.
function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const env: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match || line.trimStart().startsWith("#")) continue;
    const value = match[2]!.replace(/^(['"])(.*)\1$/, "$2");
    if (value !== "") env[match[1]!] = value;
  }
  return env;
}

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 60000,
    env: { ...readEnvFile(".env.local"), ...(process.env as Record<string, string>) },
  },
});
