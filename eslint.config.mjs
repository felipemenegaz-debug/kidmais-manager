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
    "**/.next/**",
    ".next-*/**",
    ".local-*/**",
    ".tmp/**",
    ".backups/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Scripts de evidência da revisão independente do Funil: bytes fixados
    // em sha256.json do parecer; não podem receber eslint-disable.
    "docs/evidencias/funil-extra-independente-20261114/*.cjs",
  ]),
]);

export default eslintConfig;
