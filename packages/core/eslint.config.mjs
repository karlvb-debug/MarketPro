import { config } from "@repo/eslint-config/base";

/** @type {import("eslint").Linter.Config[]} */
export default [
  ...config,
  {
    // Generated drizzle-kit output — not hand-maintained source.
    ignores: ["drizzle/**"],
  },
  {
    // CommonJS tooling config at the package root.
    files: ["*.config.js"],
    languageOptions: {
      globals: { module: "writable", require: "readonly", __dirname: "readonly" },
    },
  },
];
