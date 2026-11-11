import { defineConfig } from "vitest/config";

import { defines } from "./scripts/defines.ts";

export default defineConfig({
  // `pnpm run hosted:test` runs from the repository's root.
  root: import.meta.dirname,
  // The rate limits Wrangler builds in, for the tests that import the Worker's modules in Node
  // (where src/version.ts reads the version from package.json itself).
  define: { HOSTED_RATE_LIMITS: defines().HOSTED_RATE_LIMITS },
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
    // Starting workerd and building the Worker takes a few seconds.
    hookTimeout: 120_000,
    env: {
      // A test that leaves the body of an answer from workerd unread while it awaits something
      // else fails at once, instead of now and then: undici may find the body cancelled by the
      // time it is read, and says "Body has already been read" (CI, 2026-11-11).
      MINIFLARE_ASSERT_BODIES_CONSUMED: "true",
    },
  },
});
