---
name: open-issue
description: File a GitHub issue in agentic-seo-check from its issue forms, with gh. Use before opening any pull request that has no issue yet, or when asked to file or report a bug, a wrong finding, a feature, a task or a question.
---

# Open an issue

Every pull request an agent opens here closes an issue, a typo fix too. The forms in `.github/ISSUE_TEMPLATE/` say what each kind of issue holds; they only fill in through a browser, so this skill turns one into a `gh issue create` call. A well-made bug is #94 and a well-made task is #112: `gh issue view 94`.

## Steps

1. **Search.** `gh issue list --state all --search "<keywords>"`. An open issue that covers the work is the issue: use it and skip to step 6. A closed one that covers it: name it, and ask whether to reopen it or file a follow-up that links it.

2. **Pick the form.** Each form's `name` and `description` say what it is for. A vulnerability goes in no issue: SECURITY.md's private report. Take `type:` and `labels:` from the form's header, then add one label for where the change lands, from CONTRIBUTING.md's Labels table:
   - The hosted MCP server and the website take `area:mcp`; there is no `area:hosted`.
   - A change to the repository's own docs or tooling takes `documentation` when it is docs, and no area otherwise.
   - `breaking-change`, `ready-for-agent` and `ready-for-human` are a maintainer's to add.

3. **Write the title.** A plain sentence with a capital letter and no full stop or type prefix; the Conventional Commits form belongs to the pull request. A bug says what is wrong ("The hosted server's analytics give no reason for a crawl that a refusal stops partway"). A feature or a task says the outcome ("Save a report from the website as a PDF").

4. **Write the body** as GitHub builds it from the form: each field's `label` as a `### ` heading, in the form's order, then the answer. A dropdown's answer is one of its options, word for word. An optional field with nothing to say gets `_No response_`. A `markdown` field is guidance for you, never a heading. Answer as the field's `description` asks:
   - **Sourced.** Name files and symbols in backticks (`src/core/crawl.ts`, `trackRefusals`), link the search engine's own documentation for a rule, and link the issue, pull request or review comment it follows from.
   - **A bug** says what was expected and what happened, and reproduces it on a public URL, the smallest HTML, or a test in `test/`. Its version is `version` in `package.json` when it runs from source; for the hosted server or the website, the date and time in UTC.
   - **A feature** states the problem so it stays true under another solution, then proposes: for a rule, its id, severity and the fix it would recommend. What the maintainer must settle goes under Open questions.
   - **A task** ends with Done when: checks someone can run or read.
   - **Would you write the pull request?** "Yes, once we agree on the approach" when an agent is to build it.
   - **Public.** The issue holds public material only: no secret, key, private site, or audit of a private site from the session. A `@name` is only a handle verified in this session; roles and package names go in backticks.

5. **File it.** Write the body to a file outside the repository, then:

   ```bash
   gh issue create --title "<title>" --body-file <file> --type <Bug|Feature|Task> --label needs-triage --label <area>
   ```

   A question takes no `--type`.

6. **Report** the issue's URL. When the request was to file the issue, the work ends here. When it asked for the change itself, build it, then open the pull request with the `open-pr` skill and `Closes #<number>`.
