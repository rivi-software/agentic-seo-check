# Contributing

Contributions are welcome from anyone: a bug report, a fix, a new rule, a test, a clearer README. This guide covers how to propose a change, how to set up the repository, and what a pull request needs before it can merge. [For maintainers](#for-maintainers) covers reviews, releases and the repository's rules.

Everyone who takes part follows the [code of conduct](CODE_OF_CONDUCT.md).

## Questions, bugs and ideas

[Open an issue](https://github.com/rivi-software/agentic-seo-check/issues/new/choose), after a look through the [existing ones](https://github.com/rivi-software/agentic-seo-check/issues?q=is%3Aissue).

- **A wrong finding.** A rule that fires on a page that is fine, or misses a real problem. Name the rule id, the version, and the URL or the smallest HTML that shows it. A false positive costs agents a fix nobody needed, so these get fixed first.
- **A bug.** Name how you ran it (the CLI, the MCP server on your machine or the hosted one and which client, the website, or the library), the version, the Node version, and what you expected and what happened instead. The hosted server and the website run the latest `main`: for them, give the date and time you saw it, in UTC.
- **A new rule or a feature.** Describe the problem first: what a search engine, an AI answer engine or a crawler does with the page, with a link to its documentation. Agreeing on it in the issue saves you a pull request that does not merge.
- **A question.** Open an issue too: a question often shows where the README falls short.
- **A task.** Docs, CI, tooling or a refactor that users of the tool do not notice: say what to change, why, and how to tell it is done.
- **Requests to your site from the hosted server.** Not an issue: [the page for site owners](https://mcp.agentic-seo.rivi.software/crawler) says how to recognise and block them, and where to report too many.
- **A vulnerability.** Never in a public issue: [SECURITY.md](SECURITY.md) says how to report one privately.

Issues and pull requests in this repository show up on [RIVI Open Source](https://github.com/orgs/rivi-software/projects/2), the project board for all of RIVI Software's public repositories.

### Labels

Each issue has a type: **Bug** (something does not do what the README says, or a rule is wrong), **Feature** (new behaviour, or a change users notice) or **Task** (a chore, refactor, docs, CI or tooling change users do not notice). Labels add the rest:

| Family | Values | Meaning |
| --- | --- | --- |
| Area | `area:rules`, `area:crawl`, `area:render`, `area:mcp`, `area:cli`, `area:skill` | Where the change lands: the page rules, crawl and site checks, rendering and Lighthouse, the MCP server, the command line, the agent skill |
| Topic | `false-positive`, `security`, `performance`, `documentation`, `breaking-change` | What else it is about. `breaking-change` needs a major (or, before 1.0, a minor) release, and only a maintainer adds it |
| Triage | `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `duplicate`, `wontfix` | Where an issue stands. `needs-triage` waits for a maintainer, `needs-info` for its author; `ready-for-agent` is specified well enough for a coding agent, `ready-for-human` needs a person |
| Contributors | `good first issue`, `help wanted` | Ready for someone outside the team to take |
| Bot | `rivi-bot:review` | A maintainer asks [RIVI Bot](#reviews-by-rivi-bot) to review an outside pull request |

## Your pull request

A typo, a broken link, a clearer sentence, or a bug fix with a test can go straight to a pull request. Anything bigger starts with an issue: a new rule, a change to a rule's id, severity or threshold, a new option, tool or command, a change to the JSON an audit returns, or a new dependency. Wait for a maintainer to agree on the approach there before you write it. A coding agent opening a pull request files an issue first in every case, as [the template's rules for agents](.github/pull_request_template.md) say.

Issues labeled [`good first issue`](https://github.com/rivi-software/agentic-seo-check/labels/good%20first%20issue) or [`help wanted`](https://github.com/rivi-software/agentic-seo-check/labels/help%20wanted) are ready to take. Say in the issue that you are on it, so nobody else starts the same work.

### Setup

Node 24 (`.node-version`; 22.19 and later work too) and pnpm 12 (`packageManager` in `package.json`; `corepack enable` installs it). Fork the repository, then:

```bash
git clone https://github.com/<your-username>/agentic-seo-check.git
cd agentic-seo-check
pnpm install
pnpm run verify
```

`verify` runs what CI runs, in order: `format:check` (Oxfmt), `lint` (Oxlint), `check` (TypeScript over the sources, tests and configs), `test` (Vitest), `build`, `check:package`, which packs the package as npm would get it and checks its types, its entry point and both commands from the tarball, and `hosted:verify`, the hosted server's typecheck, its bundle and its tests in workerd (`hosted/`). `pnpm run dev audit https://example.com` runs the CLI from source; `pnpm run mcp` starts the MCP server from source; `pnpm run hosted:dev` runs the hosted server locally, and `pnpm run site:dev`, beside it, the website.

`--render` and `--lighthouse` need a Chromium: Google Chrome, or `pnpm run dev install-browser`. The test suite does not launch a browser.

The lint and format rules are [Ultracite](https://www.ultracite.ai)'s presets: `oxlint.config.ts` extends its `core`, `vitest` and `anti-slop` presets, and `oxfmt.config.ts` takes its formatting, leaving Markdown and JSON alone. `pnpm run fix` applies Oxlint's fixes, then Oxfmt, and three things run it for you: lefthook's pre-commit hook over the staged files (`lefthook.yml`, put into `.git/hooks` by `pnpm install`; `LEFTHOOK=0 git commit` skips it), Claude Code's hook over each file it writes (`.claude/settings.json`), and VS Code with the Oxc extension on save (`.vscode/`). `fix` holds back (`-A`) the fixes that would change what the code does, such as `unicorn/prefer-type-error`, which changes the class of a thrown error; `pnpm run lint` still reports those rules.

When a rule is wrong for one line, suppress that line and say why: `// oxlint-disable-next-line eslint/no-await-in-loop -- each redirect needs the Location of the one before`. A type assertion needs a `// SAFETY:` comment just before its statement that names what makes it hold. `eslint/sort-keys` is off: the order of an object's keys is the order of the JSON an audit prints.

### Making the change

Work on a branch in your fork. One pull request makes one change. Two unrelated fixes are two pull requests.

- Changed behaviour comes with a test (Vitest, in `test/`). A bug fix comes with a test that fails without the fix. A rule gets a case that fires and a case that does not: `test/fixtures/` has a good and a bad page, and `test/helpers/fixture-server.ts` serves a site for crawl tests.
- A rule's id, severity, message and recommendation are what agents act on. A new rule lives in the file of its category under `src/core/rules/` (or `site-rules.ts`, `render-rules.ts`, `performance-rules.ts`), has a `docs` link to the search engine's own documentation where one exists, and recommends a fix someone can make, not only names the problem. Renaming a rule id or removing one is a breaking change: agents and CI configurations name rules in `disableRules`.
- The JSON an audit returns has a `schemaVersion`. A field may be added; a field renamed, removed or changed in meaning is a breaking change.
- When what the tool does changes, the README changes with it, and the agent skill (`skills/seo-audit/SKILL.md`) when it changes how an agent should use the tool.
- A change users notice comes with a changeset. Run `pnpm changeset`, pick the bump (`patch` for a fix, `minor` for a feature or, before 1.0, a breaking change), and write the line for the changelog, for the people who use the tool. Not sure of the bump? Say so in the pull request, and a maintainer settles it. A change only to tests, CI or the repository's own docs needs no changeset.
- A new runtime dependency ends up in every install, so it needs a maintainer's agreement in the issue first. pnpm runs a dependency's install script only when `pnpm-workspace.yaml` allows it, and takes no dependency from a git or tarball URL.
- `pnpm run verify` passes before you open the pull request.

### Opening the pull request

- **Title.** It follows [Conventional Commits](https://www.conventionalcommits.org), scoped to the area it changes: `fix(rules): …`, `feat(crawl): …`, `feat(mcp): …`, `chore(deps): …`. A change with no area of its own leaves the scope out: `docs: …`, `ci: …`. The scopes are `rules`, `fixes`, `crawl`, `render`, `lighthouse`, `report`, `cli`, `mcp`, `hosted`, `site`, `telemetry`, `skill`, `deps`, `ci` and `repo`. Keep it lowercase, without a full stop, and under 72 characters. Pull requests are squash-merged, and the title becomes the commit on `main`.
- **Description.** The [template](.github/pull_request_template.md) has the sections, and asks for a description that stands on its own in about 150 words: who is affected and what is wrong for them, with the issue it closes (`Closes #123`); what they now see or do differently; how you know it works, with the audit output before and after on a real page where that helps; what it means for a release; and the docs it changed. Its last sections are for an agent's work, and its closing comment holds the rules for agents.
- **Allow edits by maintainers.** Leave it checked. A maintainer can then push a small fix to your branch, such as a missing changeset, instead of asking you for it.
- **Draft.** Open the pull request as a draft if you want feedback before it is done.

### What happens next

1. **CI** runs `verify` on Node 22, 24 and 26, and its `verify` check must pass before the pull request can merge. Until a first pull request of yours has merged here, GitHub waits for a maintainer to approve each run before it starts.
2. **Review.** A maintainer reviews the pull request. They may also ask [RIVI Bot](#reviews-by-rivi-bot), an automated reviewer that runs Claude, to review it; it only reads the change and comments. Its comments are advice: fix what is right, and reply where it is wrong.
3. **Merge.** A maintainer squash-merges the pull request once the code owner ([`.github/CODEOWNERS`](.github/CODEOWNERS)) approves it and `verify` passes.
4. **Release.** The next release publishes your changeset to npm (see [Changes and releases](#changes-and-releases)).

### License

The repository is [MIT](LICENSE) licensed. When you open a pull request, you agree that your contribution is released under that license, and you confirm that you have the right to submit it. That means it is your own work, or you say where it came from and under which license. There is no contributor agreement to sign.

### AI tools

You may use AI tools to write an issue or a pull request, and you are its author all the same. Understand every line you submit, run `pnpm run verify` yourself, and say in the pull request what you checked. Fill in the template's Agent context: the tool, the model and the skills that ran. A maintainer may close a pull request that reads as unreviewed generated output, or a report that nobody can reproduce. [AGENTS.md](AGENTS.md) is the brief for coding agents working in this repository.

## For maintainers

### Pull requests from forks

- **CI runs.** Read the diff before you approve a CI run for a first-time contributor. CI runs the pull request's own code: its install, tests, build and scripts. It gets a read-only token and no secrets, but nothing should run that nobody has read. Look hardest at `.github/`, `scripts/`, the `scripts` in `package.json`, `lefthook.yml` and `pnpm-workspace.yaml`.
- **Secrets.** No workflow runs a fork's code with secrets. RIVI Bot's workflow runs on `pull_request_target`, which has them, and never runs the code it checks out.
- **Small fixes.** When a pull request lacks only a changeset or a Conventional Commits title, push the changeset to the branch or edit the title yourself. Don't send the contributor round again.

### Reviews by RIVI Bot

[RIVI Bot](https://github.com/rivi-software/tools/tree/main/rivi-bot#readme) is Claude on this repository's pull requests and issues, through the reusable workflow in `rivi-software/tools`. [`.github/workflows/rivi-bot.yml`](.github/workflows/rivi-bot.yml) calls it, and [`.github/rivi-bot.yml`](.github/rivi-bot.yml), read from `main`, says what it does here.

It reviews a pull request by someone with write access on its own: when it opens or leaves draft, and after every push. Any other pull request waits for a maintainer, who asks for reviews by adding the `rivi-bot:review` label. Read the pull request first: the reviews spend the API key's budget, and Claude reads everything in the pull request. Reviews of outside pull requests comment and never approve. Someone with write access can also ask it for more in a comment: `@rivi-bot describe`, `@rivi-bot triage`, or a question or a fix in plain words.

It needs the `ANTHROPIC_REVIEW_API_KEY` secret, and for RIVI Bot's own name the `AUTOMATION_APP_PRIVATE_KEY` secret of the RIVI Bot App.

### Changes and releases

A change users notice comes with a changeset ([Making the change](#making-the-change)).

On `main`, the release workflow ([`.github/workflows/release.yml`](.github/workflows/release.yml)) keeps a "Version packages" pull request open while changesets wait. It bumps `version` in `package.json`, which the CLI, the MCP server and the User-Agent read, and writes `CHANGELOG.md`. Merging it publishes the version to npm through [trusted publishing](https://docs.npmjs.com/trusted-publishers) with provenance, tags it `v<version>` and makes a GitHub release.

RIVI Bot opens and updates that pull request, and writes the tag and the GitHub release, with a token the workflow mints from the RIVI Bot App's private key (`AUTOMATION_APP_PRIVATE_KEY`). The App needs **Contents: write** and **Pull requests: write** here. Because the App pushes the commits, CI starts on the pull request by itself.

npm takes the publish only from this repository's `release.yml`: on npmjs.com, the package's **Settings → Trusted publishing** names GitHub Actions with organization `rivi-software`, repository `agentic-seo-check` and workflow `release.yml`, and **Publishing access** requires two-factor authentication and disallows tokens. 0.1.0 was published by hand, before the trusted publisher existed.

### Rulesets

GitHub enforces the repository's rulesets; [`.github/rulesets/`](.github/rulesets) holds them and is their source of truth.

- **`main.json`.** `main` changes only through pull requests, squashed, once the `verify` check passes: CI's job that passes when every Node version passed, and the code owner approves. Nobody pushes to `main` directly, force-pushes or deletes it.
  - [`.github/CODEOWNERS`](.github/CODEOWNERS) makes `rikvisser-dev` the owner of every file, so every pull request needs their approval. A review by anyone else, RIVI Bot's included, is advice.
  - `rikvisser-dev` can bypass the rules in a pull request only. GitHub does not let an author approve their own pull request, so they bypass the approval to merge their own. A bypass merges without waiting for any rule, `verify` included, so wait for `verify` first.
- **`release-tags.json`.** A release tag (`v*`) is created once and is never moved or deleted, because users pin to it.

To change a ruleset, edit its file in a pull request, then apply it:

```bash
gh api repos/rivi-software/agentic-seo-check/rulesets --jq '.[] | "\(.id) \(.name)"'
gh api -X PUT repos/rivi-software/agentic-seo-check/rulesets/<id> --input .github/rulesets/main.json
```

To add a new ruleset: `gh api -X POST repos/rivi-software/agentic-seo-check/rulesets --input .github/rulesets/<name>.json`.
