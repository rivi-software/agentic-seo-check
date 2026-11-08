# Changesets

A change users of `@rivi-software/agentic-seo-check` notice comes with a changeset, which names the semver bump and the line for the changelog:

```bash
pnpm changeset
```

The release workflow keeps a "Version packages" pull request open while changesets wait on `main`; merging it publishes the new version to npm. See [CONTRIBUTING.md](../CONTRIBUTING.md#changes-and-releases).
