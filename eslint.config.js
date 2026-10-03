// ESLint 9+ flat config for tuxevil-rotator.
// Conservative ruleset: catches real bugs, low noise.

import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default [
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
    },
    rules: {
      // Allow unused vars that start with _ (convention for destructured-ignore)
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      // Allow `_` as a parameter name for unused positional args
      "@typescript-eslint/no-unused-expressions": "off",
      // We use `any` deliberately in a few places (e.g. JSON parse results)
      "@typescript-eslint/no-explicit-any": "off",
      // Empty interfaces are common in TypeScript "type vs interface" patterns
      "@typescript-eslint/no-empty-object-type": "off",
    },
  },
  {
    // Tests can be more permissive
    files: ["test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
  {
    // Generated / vendor dirs
    ignores: [
      "node_modules/**",
      "dist/**",
      "coverage/**",
      ".github/**",
      // The dashboard dev harness tracks the real wire types; keep it checked.
      "scripts/**/*",
      "!scripts/dashboard-dev.ts",
    ],
  },
];
