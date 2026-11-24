import { defineConfig } from "vitest/config";

import { defines } from "./scripts/defines.ts";

export default defineConfig({
  // `pnpm run hosted:test` runs from the repository's root.
  root: import.meta.dirname,
  // The rate limits Wrangler builds in, for the tests that import the Worker's modules in Node
  // (where src/version.ts reads the version from package.json itself).
  define: { HOSTED_RATE_LIMITS: defines().HOSTED_RATE_LIMITS },
  // limits.ts and callers.ts ask for the Durable Object through state.ts, which imports
  // `cloudflare:workers`, a module only workerd has, and crawls.ts `cloudflare:workflows` too.
  resolve: {
    alias: {
      "cloudflare:workers": new URL(
        "test/stubs/cloudflare-workers.ts",
        import.meta.url
      ).pathname,
      "cloudflare:workflows": new URL(
        "test/stubs/cloudflare-workflows.ts",
        import.meta.url
      ).pathname,
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    // The OAuth provider (src/premium/) imports `cloudflare:workers` too: taken through Vite, so
    // the alias above reaches it.
    server: { deps: { inline: ["@cloudflare/workers-oauth-provider"] } },
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
