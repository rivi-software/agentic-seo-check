/**
 * What src/crawls.ts takes from `cloudflare:workflows`, a module only workerd has, for the tests
 * that import it in Node (vitest.config.ts) and scripts/assets.ts.
 */
export class NonRetryableError extends Error {
  override name = "NonRetryableError";
}
