import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Nothing the tests run sends telemetry (issue #57), the CLIs they start included.
    env: { AGENTIC_SEO_CHECK_TELEMETRY: "0" },
    testTimeout: 60_000,
    hookTimeout: 30_000,
  },
});
