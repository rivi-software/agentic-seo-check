---
name: add-changeset
description: Write a changeset for agentic-seo-check as a file, without the interactive prompt, in the changelog's voice. Use when a change users notice needs one, or when asked to add a changeset or a changelog entry.
---

# Add a changeset

`pnpm changeset` asks its questions in a terminal. An agent writes the file it would have written. The release workflow turns waiting changesets into `CHANGELOG.md`, the GitHub release and the version; `version` in `package.json` is never edited by hand.

## Steps

1. **Decide whether the change needs one.** The changelog belongs to the npm package. A change under `src/` or `skills/` that users of the CLI, the MCP servers or the library notice needs one, and that includes the hosted server's tools, which live in `src/`. A change only to the website or the Worker under `hosted/`, to tests, CI or the repository's own docs needs none (#98 and #104 had none). When unsure, write it and say so on the pull request's Release line; a maintainer settles it.

2. **Pick the bump.**
   - `patch`: a fix, such as a false positive gone.
   - `minor`: a feature, or an extended contract (a new rule, option, tool or field). Before 1.0 a breaking change is `minor` too, and it needs a maintainer's agreement in an issue first.

3. **Write `.changeset/<topic-in-kebab-case>.md`:**

   ```markdown
   ---
   "@rivi-software/agentic-seo-check": minor
   ---

   <the entry>
   ```

4. **Write the entry for the people who use the tool.** It reaches CHANGELOG.md and the GitHub release as written:
   - The first sentence says what they now see or can do, in the present tense, with the issue: `(issue #93)`.
   - Rule ids, options, tools and fields go in backticks. Several rules are bullets: `` - `canonical.paginated-to-first`: page 2 or later of a series names the first page as canonical. ``
   - A changed behaviour says what happened before: "Before, the caller was told a limit had been hit."
   - What stays the same, when a reader would wonder: "The local server and the CLI are unchanged."
   - A change to the library's API comes last, in a paragraph of its own: "In the library, …".

   CHANGELOG.md's 0.13.0 shows the voice: its minor changes for new rules, its patch changes for false positives.
