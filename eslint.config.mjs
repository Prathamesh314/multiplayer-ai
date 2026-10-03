import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    ".next-handoff-test/**",
    "out/**",
    "build/**",
    ".desktop-build/**",
    ".runner-build/**",
    "desktop-dist/**",
    "artifacts/**",
    "next-env.d.ts",
    // Compiled output for the presence tests.
    ".test-build/**",
    // Session repos and working copies — a runtime cache, not our source.
    ".multiplayer-ai/**",
  ]),
  {
    // Node test harnesses, run directly rather than bundled. CommonJS is what
    // lets them require the compiled TypeScript without an extension dance.
    files: ["tests/**/*.cjs", "desktop/**/*.js", "desktop/**/*.cjs"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
]);

export default eslintConfig;
