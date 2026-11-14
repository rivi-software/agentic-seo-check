---
"@rivi-software/agentic-seo-check": patch
---

`structured-data.missing-context` reads the host of a JSON-LD `@context`, so a context such as `https://example.com/schema.org` now gets the finding (issue #174). Before, any context with `schema.org` anywhere in it passed. `https://schema.org`, `http://schema.org/`, `www.schema.org`, `//schema.org` and a bare `schema.org` still pass.

JSON-LD wrapped in an HTML comment that ends in `--!>` is read as it is with `-->`, rather than reported as invalid JSON.
