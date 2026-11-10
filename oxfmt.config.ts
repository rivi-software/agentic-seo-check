import { defineConfig } from "oxfmt";
import ultracite from "ultracite/oxfmt";

export default defineConfig({
  ...ultracite,
  ignorePatterns: [
    ...(ultracite.ignorePatterns ?? []),
    "**/*.md",
    "**/*.json",
    "**/*.jsonc",
    "test/fixtures/**",
    "hosted/worker-configuration.d.ts",
  ],
  // Keep the line breaks of YAML's folded scalars, which Ultracite's "never" joins into one line.
  proseWrap: "preserve",
});
