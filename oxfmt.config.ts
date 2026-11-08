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
  ],
  // Keep the line breaks of YAML's folded scalars, which Ultracite's "never" joins into one line.
  proseWrap: "preserve",
});
