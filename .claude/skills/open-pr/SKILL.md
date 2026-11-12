---
name: open-pr
description: Open or update a pull request in agentic-seo-check: the gates before it, the title, the body from the template, draft or ready, and the body after each push. Use when asked to open, create or update a PR, or when finished work is ready for review.
---

# Open a pull request

Two files hold the rules; read both before writing. CONTRIBUTING.md's "Opening the pull request" has the title's form and the scopes. `.github/pull_request_template.md` has the sections, the word budget, the definition of done, and the rules for agents in its closing comment. This skill is the order to apply them in, with the commands. `gh pr view 111` is a body that follows the template.

## 1. Gates

Each one holds before the pull request opens:

- **Issue.** The issue it closes exists; when none does, file it with the `open-issue` skill first. A new rule, option, tool, field or dependency has a maintainer's agreement there.
- **No duplicate.** `gh pr list --state open --search "<keywords>"` (drafts included) shows no other pull request making this change.
- **Branch.** The work is off `main`, on a remote branch named `<type>/<topic>`, such as `feat/hosted-error-tracking`. From a worktree whose local branch has another name: `git push -u origin HEAD:<type>/<topic>`. Commits take the title's Conventional Commits form.
- **Changeset.** A change users notice has one; the `add-changeset` skill writes it.
- **Docs.** The docs AGENTS.md's "Before you finish" names are true to the change.
- **Cleanup.** A diff of more than a few lines had a `/simplify` pass.
- **Verify.** `pnpm run verify` passed on the commit you push.

## 2. Title

`<type>(<scope>): <description>`, lowercase, no full stop, under 72 characters, with a scope from CONTRIBUTING.md. The description says what changes for the people affected, in plain words: `feat(hosted): save a website report as a PDF from the print dialog`, `fix(rules): three false positives the website's own audit found`. The squash merge makes it the commit on `main`.

## 3. Body

Start from the template, answer each section, and delete its guidance comments, the closing rules included. Then:

- **Problem** opens with who is affected and ends with `Closes #<number>`. A stacked pull request adds "Stacked on #<number>: review that first."
- **Release.** The changeset line names the bump of the file in `.changeset/`. Deploys on merge is yes when `git diff --name-only origin/main...HEAD` lists a path the `paths:` filter of `.github/workflows/deploy-hosted.yml` matches.
- **Agent context.** Agent is the tool and the session's exact model, such as "Claude Code, Opus 5.5". Skills lists every skill that ran.
- **Length.** About 150 words outside code blocks, diagrams and `<details>`. A body that needs far more is a reason to suggest a stack to the person directing the work.

## 4. Open it

```bash
gh api user --jq .login   # the assignee when the work is Human-driven
gh pr create --base main --head <type>/<topic> --title "<title>" --assignee <login> --body-file - <<'EOF'
<body>
EOF
```

- **Assignee.** The person directing the work when Autonomy is Human-driven; none when it is Fully autonomous.
- **Draft.** Add `--draft` while the work or the body is unfinished, and `gh pr ready <number>` once `pnpm run verify` passes.
- **Stack.** `--base` is the branch of the pull request below. Once that one merges: `git rebase --onto origin/main <old-base>`, push with `--force-with-lease`, and `gh pr edit <number> --base main`.

## 5. After each push

RIVI Bot reviews when the pull request opens or leaves draft, and after every push, and each review spends its budget: push in batches, not commit by commit.

- **Body.** Rewrite "More context for AI agents" to describe the pull request at the new commit, replacing stale bullets, and keep the other sections true: `gh pr view <number> --json body --jq .body`, edit it, then `gh pr edit <number> --body-file -`.
- **Review.** Work through review comments with the `answer-review` skill.
- **Report** the pull request's URL and the state of its `verify` check (`gh pr checks <number>`). Approving and merging stay with the code owner.
