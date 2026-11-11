import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import * as tsParser from "@typescript-eslint/parser";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  inlineSingleUseDeclarations,
  noMarginUtilities,
  noReactNamespaceImport,
  noWindowLocationReload,
} from "./utils/eslint-rules/index.js";

const tsconfigRootDir = dirname(fileURLToPath(import.meta.url));

export default [
  {
    ignores: ["**/dist/**", "**/node_modules/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        tsconfigRootDir,
      },
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    plugins: {
      "react-hooks": reactHooks,
      tensamin: {
        rules: {
          "inline-single-use-declarations": inlineSingleUseDeclarations,
          "no-margin-utilities": noMarginUtilities,
          "no-react-namespace-import": noReactNamespaceImport,
          "no-window-location-reload": noWindowLocationReload,
        },
      },
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-hooks/set-state-in-effect": "off",
      "tensamin/inline-single-use-declarations": "error",
      "tensamin/no-react-namespace-import": "error",
      "tensamin/no-window-location-reload": "error",
    },
  },
  {
    files: [
      "apps/web/src/routes/**/*.tsx",
      "packages/settings/src/pages/**/*.tsx",
      "packages/login/src/ui/**/*.tsx",
      "packages/onboarding/src/**/*.tsx",
      "packages/*/src/screen.tsx",
      "packages/call/src/views/**/*.tsx",
    ],
    rules: {
      "tensamin/no-margin-utilities": "error",
    },
  },
];
