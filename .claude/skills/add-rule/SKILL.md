---
name: add-rule
description: Add or change an audit rule in agentic-seo-check (SEO or AEO, page or site): the check, its fix, its tests and its docs. Use when asked to add a rule, change what a rule reports or how severe it is, or fix a wrong finding or a false positive.
---

# Add or change a rule

A rule's id, severity, message and recommendation are part of the contract, and a false positive sends every agent off to fix what nobody needed fixed (AGENTS.md, "What the tool promises"). A rule is done when it fires on the bad case, stays quiet on every valid variant, and its fix quotes the page as written. AGENTS.md's Layout says which file each kind of rule lives in and which list registers it. `ALL_RULES` collects every list, so `agentic-seo-check rules`, `seo_list_rules` and the website's rules page show the rule without more work.

## Steps

1. **Agree first.** A new rule, or a change to an id, severity or threshold, needs an issue with a maintainer's agreement: the feature form, or the wrong finding form for a false positive (the `open-issue` skill). A false-positive fix with its test can go straight to a pull request.

2. **Source it.** Find the search engine's or standard's own documentation of what it does with such a page. The rule judges by that, not by general SEO advice. Its URL is the rule's `docs`, from `GOOGLE_DOCS` in `src/core/rules/rule.ts` when it is there. Write down the cases the documentation calls fine: each one becomes a quiet test in step 5.

3. **Write the check** with `defineRule(meta, (ctx, make) => …)`:
   - `id` is `<category>.<what-is-wrong>` in kebab case, like its siblings in the file. An owner's deliberate choice, such as keeping AI training bots out, is `info` at most.
   - `message` names this page's instance; `recommendation` says what to change.
   - Read `ctx.page`, the `ExtractedPage`, never the raw HTML. A signal it lacks goes into `src/core/html/extract.ts` (an AEO answer signal into `answer.ts`).
   - A regular expression on page text stays linear on long input: no nested or overlapping quantifiers.
   - `make(message, { fix, selector, evidence, key })` builds the finding. Evidence lists go through `cap()`.

4. **Write the fix** with the builders in `src/core/rules/fix.ts` (`addHtml`, `replaceHtml`, `removeHtml`, `slot`, `withContent`):
   - `current` quotes `page.markup` or a tag the extractor kept, never the joined page text.
   - Words only the author can write go in a `slot("…")`, with a `write` that says what belongs there.
   - Of two ways out, take the one that cannot hurt: the fix never deletes content or lifts a block the owner may want.
   - `fix: []` is only for a finding about the audit itself, and such a rule joins `RULES_WITHOUT_FIX` in `test/helpers/fixes.ts`.

5. **Test it.** For a wrong finding, write the test first: the reported HTML at its smallest, expecting the rule quiet, and watch it fail.
   - **Fires.** A case in the test file of the rule's area (`grep -l "<a sibling rule's id>" test/`), or in `test/fixtures/bad-page.html`.
   - **Quiet.** Each valid variant from step 2, as its own case, and `test/fixtures/good-page.html`; an AEO rule also `aeo-good-page.html`. The "a well-formed page has no errors or warnings" test in `test/rules.test.ts` only catches warnings and errors, so an `info` rule needs its own quiet check.
   - **Fix.** The `fixes-*.test.ts` sweep that covers the rule runs `withoutFix`, `incompleteEdits` and `unquotedEdits` from `test/helpers/fixes.ts`. `fixes-page-a` covers whole categories (its `RULES`). `fixes-page-b` covers the categories its `MY_RULES` pattern names, plus a list of ids, and fails until each of its rules fires in one of its cases. `fixes-aeo` does the same for every AEO rule. A rule outside every sweep joins the nearest one's list, with a case it fires in.

6. **Docs and changeset.**
   - Under "What it checks" in the README, the row of the rule's area names what it catches. The headers count the rules: the AEO table has `pnpm run --silent dev rules --category aeo -f json | jq .count`, and the SEO table has `dev rules -f json | jq .count` minus that.
   - `skills/seo-audit/SKILL.md` changes only when an agent would act differently on the finding.
   - A changeset (the `add-changeset` skill): `minor` for a new rule, `patch` for a false positive gone.

7. **Run it on real pages.** `pnpm run dev audit <a public page with the problem>` reports it, and a page without it stays quiet; set `AGENTIC_SEO_CHECK_TELEMETRY=0` first. A rule behind `--render` or `--lighthouse` needs this run, since the tests launch no browser. Then `pnpm run verify`.
