/**
 * What `playwright`, `lighthouse` and `chrome-launcher` resolve to in the hosted build
 * (wrangler.jsonc's `alias`): a module that fails to load, as a missing package does, so render.ts
 * and lighthouse.ts answer with RenderUnavailableError and LighthouseUnavailableError, and the
 * bundle leaves the packages out. The hosted tools never ask for either.
 */
throw new Error(
  "Rendering and Lighthouse are not part of the hosted server; the local server runs them."
);
