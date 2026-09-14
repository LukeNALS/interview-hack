import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores của eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Không thuộc source app chính — xem CLAUDE.md/README.md.
    "init docs/**",
    ".gitnexus/**",
    "poc/**",
    "supabase/.temp/**",
    "playwright-report/**",
    "test-results/**",
  ]),
]);

export default eslintConfig;
