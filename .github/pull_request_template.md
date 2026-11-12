<!--
The description stands on its own: a reader who opens no file still knows why the change is needed and what it does. Aim for 150 words, table cells included; code blocks, diagrams and <details> blocks do not count. A section with nothing to say gets one bullet: "- None."
CONTRIBUTING.md has what a pull request needs: https://github.com/rivi-software/agentic-seo-check/blob/main/CONTRIBUTING.md#your-pull-request
-->

## Problem

<!-- First line: who is affected and what is wrong for them today, such as an agent fixing a site, a site owner, a CI pipeline or a visitor to the website. A fix says what breaks; a feature names the goal and what stands in its way; a chore says who is blocked. It stays true under a different solution, so the code path goes under Changes. Take it from the issue this closes, when there is one. -->

Closes #

## Changes

<!-- For each change someone can notice, what they now see or do differently: a finding that appears or goes quiet, a new option, tool or field, a different report, a page on the website. Then, briefly, the code that does it. Mark the rest as mechanical, so a reviewer knows nothing users notice hides in it. -->
<!-- Show it. A rule: the finding before and after, on a real page or a fixture. The text report: the terminal output. The website: screenshots before and after, in light and dark. -->
<!-- A change to how parts fit together (the two Workers and the Durable Object, the crawl and the fetch gate, a pipeline in CI): one sentence that states the change, then a Mermaid flowchart before and one after. -->

## How did you test this code?

<!-- What you ran and what it showed, then what you did not check. List only the checks you actually ran. -->
<!-- The tests launch no browser, so a change to --render or --lighthouse needs a run by hand against a real page, or a line saying it had none. -->
<!-- CI's `CI / verify` check reports the pass counts. Link the evidence it cannot give (a run, a permalink, a shared report), and put long output in a <details> block. -->

**Test rationale:** <!-- For each group of new or changed tests: the regression it catches, the closest existing test, and why that one missed it. A new or changed rule: it fires on a bad page, stays quiet on good-page.html (an AEO rule on aeo-good-page.html too), and its fix quotes the page as written (test/helpers/fixes.ts). No new test: name the coverage that already holds the change, or why a test would not help. -->

## Release

<!-- Keep one option on each line. -->

**Changeset:** `patch` / `minor` / `major` / none, because …
**Contract:** unchanged / extended / broken, agreed in #
**Deploys on merge:** yes / no

<!-- Contract: a rule's id, severity, message and recommendation, the MCP tools' names and input schemas (local and hosted), the CLI's flags and exit codes, and the audit JSON. Extended is a new rule, option, tool or field, and a minor changeset. Broken is a rename, a removal or a change in meaning, a major changeset, and needs a maintainer's agreement in an issue first. -->
<!-- Deploys: yes when the diff changes a path in the `paths:` filter of .github/workflows/deploy-hosted.yml, which decides: both Workers then deploy with the merge. Most often that is src/, hosted/ outside its tests and docs, or package.json; check the filter for the rest. -->

## Docs update

<!-- The docs that changed with the code: the README (its Telemetry section for a new event or property), skills/seo-audit/SKILL.md when an agent would use the tool differently, AGENTS.md, CONTRIBUTING.md, hosted/README.md. -->

## Left for a maintainer

<!-- What only someone with access can do, and when: a Worker secret, a Cloudflare or PostHog setting, the privacy policy for a new kind of data, a directory listing that describes the tools. -->

- None.

## Agent context

<!-- Fill this in when an agent wrote or co-wrote the change; delete it when a person wrote it alone. -->

<!-- Autonomy, keep one: "Human-driven (agent-assisted)" when a person directed the work, who is then the pull request's assignee; "Fully autonomous" when nobody did, and the pull request stays unassigned. -->

**Autonomy:** Human-driven (agent-assisted) / Fully autonomous

<!-- The tool and the exact model, such as "Claude Code, Opus 5.5"; each model that wrote code, if more than one. -->

**Agent:** tool, model

<!-- Every skill that ran (/seo-audit, /simplify, /tdd …), so a reviewer sees where one shaped the code. "None" when none ran. -->

**Skills:** None

<!-- Definition of done (agents): the work is done when each gate holds. Check each against the file or command it names.
     - Issue: the issue this closes says why the change is needed, and a new rule, option, tool, field or dependency has a maintainer's agreement there.
     - No duplicate: `gh pr list --state open --search "<keywords>"` (drafts included) shows no other pull request making this change, or Decisions below says why this one is still needed.
     - Promises: each promise in AGENTS.md's "What the tool promises" that the diff touches still holds.
     - Verify: `pnpm run verify` passed on the last commit pushed. On a diff of more than a few lines, a cleanup pass (Claude Code's /simplify) ran before it.
     - Reviews: every RIVI Bot comment is fixed, or answered with the reason it does not apply.
     - Public: code, fixtures, comments, commit messages and this description carry only public material. A secret, a key, or a private site audited in the session stays in the session.
-->

<details>
<summary>More context for AI agents</summary>

<!-- Collapsed, and outside the 150 words. Rewrite it on every push to describe the pull request at that commit: replace stale bullets rather than append a log. Keep the fields in this order, one line per bullet under 25 words, ten bullets at most; delete a field with nothing in it.
     This block alone may say what the pull request looked like before its present state. Paraphrase the intent of the prompts, and leave out tool output. -->

- **Session:** tools used, and a link where there is one
- **Decisions:** one bullet per decision taken along the way
- **Follow-ups:** work left for a later pull request, with its issue
- **Read closely:** files or lines that need a careful review

</details>

<!-- Rules for agents opening a pull request here:
- Issue first: every pull request an agent opens closes an issue, a typo or a bug fix too, which is stricter than CONTRIBUTING.md asks of people. File it from .github/ISSUE_TEMPLATE/ before opening the pull request.
- Title: `<type>(<scope>): <description>`, Conventional Commits with a scope from CONTRIBUTING.md, which only a change with no area of its own leaves out (`docs: …`, `ci: …`); lowercase, no full stop, under 72 characters. The squash merge makes it the commit on main.
    Right: feat(rules): flag a canonical that redirects
    Wrong: feat: Added canonical redirect check.   (capital, full stop, and no scope on a change to the rules)
- Voice: the change is the subject of every sentence. Authorship is one fact, under Agent context, so the body has no "I", "me" or "my".
- Body: pass it to `gh pr create --body-file -` on stdin, which keeps Markdown and newlines as written.
- Draft: open a draft while the work or the body is unfinished, and open it ready once `pnpm run verify` passes locally. RIVI Bot reviews a pull request when it opens or leaves draft, and after every push, and each review spends its budget.
- Stack: two separable steps (a refactor, then the behaviour on top) are a stack of pull requests, each naming the one it is stacked on. A body that needs more than 150 words is a reason to suggest a stack to the person directing the work.
- Mentions: GitHub notifies whoever a mention names, so mention only a handle verified in this session (`gh api user`, `gh pr view --json author,assignees`). Roles and package names that start with the at sign go in backticks.
- Review: a person reviews every pull request an agent wrote, and the code owner's approval merges it, so approving and merging stay with them.
-->
