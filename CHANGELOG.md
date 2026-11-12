# @rivi-software/agentic-seo-check

## 0.17.0

### Minor Changes

- 98d1815: The hosted MCP server asks agents what a call is for, and hears more of what they do ([#101](https://github.com/rivi-software/agentic-seo-check/issues/101)). Its audit tools list `context` as required, though a call without it still works, and every tool takes an optional `llm_model` and `conversation_id`. Each answer ends with a second text block, `{"conversation_id":"…"}`, which the agent sends back with its next call, so the calls of one conversation share a session in the analytics across connections; the audit and `structuredContent` are unchanged. A fifth tool, `send_feedback`, lets an agent tell the developers about a capability it missed, a tool that failed or misled it, or something that worked well. Its analytics also name the model, the tool's description and the argument names (`$mcp_input_keys`), and a call to a tool the server lacks. The local server and the CLI are unchanged.

## 0.16.0

### Minor Changes

- 99619e6: The hosted server's `$mcp_tool_call` event now gives the `reason` when a refusal stops a crawl partway, such as `http_429`, `challenge`, `crawl_delay` or `site_requests` (issue #94). Such a crawl answers with the pages it read and `site.crawl-stopped` (`aeo.crawl-stopped` in the AEO audit), so its call is no error, and until now its event had no `reason`. In the library, `RequestGate` gains `crawlStopped`: a crawl calls it once with the refusal that stopped it.

## 0.15.0

### Minor Changes

- db8f8f7: The hosted server's tools take an optional `context`: a few words from the agent on what the call is for, such as "re-check the title fixes" (issue #84). No tool reads it, and the audit is the same with or without it. It goes to the hosted server's usage analytics in PostHog, as `$mcp_intent`, with every URL, path, quoted text, hostname, email and IP address replaced, cut to 300 characters. The tool's own rule ids stay. The same cleaning now also takes out hostnames in any script, such as `bäckerei-müller.de`, emails with non-ASCII characters, and IPv6 addresses. It applies to the messages of error reports too. A `context` longer than 1,000 characters is refused, as every capped input is.
  
  The hosted server's `$mcp_tool_call` event now also says what the call did:
  
  - the audit's score, finding counts and the ids of the rules that fired, as the CLI's `cli_command` lists them
  - for a re-check, the counts of fixed, open and new findings
  - the names of the arguments the call gave and its `format`, `detail` and `page_detail`, never an argument's value
  - from a fixed list, the limit or refusal that stopped it
  
  Never the hostname or anything from a page. The local server and the CLI send what they sent before.
  
  In the library, a `Refusal` and a `RequestRefusedError` have an optional `reason` from a fixed list (`robots_txt`, `http_403`, `http_429`, `challenge`, `address`, …), which the hosted gate sets.

## 0.14.0

### Minor Changes

- 56b478c: Error tracking in the CLI and the local MCP server now hears more of the tool's own bugs, and stops reporting the user's mistakes as crashes (issue #85). A rule that throws is reported with the rule's id. A page that a crawl leaves out because the audit failed on it is reported too, and the user is told in a new `tool.page-error` info finding, in the SEO and the AEO audit of a crawl. A bug met more than once in a run or a tool call sends one `$exception`, with `occurrences` counting it. A stack's files of the build are named by their TypeScript source, through the source maps the package ships. The CLI's error events carry the run's flag names, kind of target and format. An `--include` or `--exclude` pattern (`includePatterns`, `excludePatterns`) that is no regular expression now fails before any request, with a message that names it. An `-o` file the CLI cannot write fails with the reason. Neither is reported. Output piped into a reader that stops early, such as `| head`, no longer crashes the CLI with an `EPIPE` stack: the run ends with its own exit code.

## 0.13.1

### Patch Changes

- fdd7cca: The hosted server keeps what it counts in the EU (issue #78): the hashes of each caller's address and of the sites it audited today, the day's count of requests, and ChatGPT's address ranges. They are in one Cloudflare Durable Object in the `eu` jurisdiction, which runs and stores its data in the EU only. The README and the server's privacy notice say so.

## 0.13.0

### Minor Changes

- 9c8f02d: Thirteen more SEO rules, each from a search engine's or a standard's own documentation: Google Search Central, Bing, the sitemaps protocol and RFC 9309 (issue #77).
  
  - `canonical.paginated-to-first`: page 2 or later of a series names the first page as canonical.
  - `hreflang.canonical-other-language`: the canonical names the page's version in another language.
  - `links.hash-route`: links route through the URL fragment (`#/products`), which Google cannot read as pages. `links.missing-fragment` leaves these links to it.
  - `robots.unavailable-after`: an `unavailable_after` date that has passed (warning) or cannot be read (info).
  - `robots.max-image-preview-missing`: an article without `max-image-preview:large`, so Google Discover shows a small image.
  - `img.unsupported-format`: images in a format Google Images does not index (HEIC, TIFF, JPEG XL, PSD).
  - `structured-data.paywall-invalid`: paywalled content markup without a `.class` section Google can check.
  - `structured-data.self-serving-review`: an organization's review stars about itself, on its own site, which Google does not show.
  - `structured-data.site-name-missing`: a home page with structured data but no WebSite item for the site name.
  - `site.robots-txt-invalid-rule`: robots.txt paths that match nothing, rules above the first `User-agent`, and relative `Sitemap:` lines.
  - `site.sitemap-invalid-url`: sitemap `<loc>` values that are not full URLs, or are 2,048 characters or longer.
  - `site.sitemap-lastmod-missing` and `site.sitemap-lastmod-uniform`: a sitemap without `lastmod`, or with the same build time on every URL.
  
  `structured-data.invalid-value` now also checks `availability`, `itemCondition`, `eventStatus`, `eventAttendanceMode` and `employmentType` against the values Google lists, and `structured-data.retired-type` also reports Estimated Salary, Learning Video and Book Actions markup, which Google phased out in 2025.

### Patch Changes

- e78a869: Three findings no longer fire on pages that are fine:
  
  - `content.placeholder-text` looks for filler as templates write it ("Lorem ipsum dolor sit amet", "consectetur adipiscing"), or a paragraph, list item or heading that opens with "Lorem ipsum". A page that only mentions the words, such as an article about placeholder copy or the website's rules page, passes.
  - `loading.no-compression` says nothing when the audit runs in a Cloudflare Worker, the hosted server included. There the site's `Content-Encoding` never reaches the audit, so the rule flagged every page, compressed or not.
  - Cloudflare's HTTP 409 with `error code: 1001`, its answer for a name that does not resolve, is a DNS error, as Node's fetch reports one. The hosted server no longer reports `site.host-variant-not-redirected` for a www host that has no DNS record.
- 45c6438: The hosted server and the website crawl up to 100 pages, 5 links deep, with 100 link checks, where they crawled 25 pages, 3 deep, with 50 (issue #73). `seo_crawl_site` and `seo_aeo_audit` with `crawl` take these as their default and their maximum. One site may get 600 requests a minute from the hosted server, from all callers together, where it got 300.
  
  Each caller may now audit 10 different sites a day on the hosted server: an IP address, through the MCP server or the website's form. claude.ai's users together may audit 100, and ChatGPT's users 100. A site is its hostname, with `www.` counted as the same site. A page audit whose page redirects to another hostname, a subdomain included, uses a site for that hostname too, so `example.com` redirecting to `shop.example.com` uses two; a caller with no sites left gets a refusal for that audit. A caller may audit a site it already audited that day as often as it likes, so it can always check a fix again. The count starts again at 00:00 UTC. Audits of inline `html` and `seo_list_rules` count no site.
  
  To count the sites, the server keeps a hash of the caller's address and of each hostname. It makes both hashes with a random key that is new each day, and deletes them, with the key, at 00:00 UTC. The README, the server's landing page and the skill now list these limits.

## 0.12.0

### Minor Changes

- e0f2b2e: The CLI has a report for people who run it without a coding agent (issue #65). `--format text` is the new default on a terminal, where `md` was. It opens with the score and its band (good, fair or poor) and the counts. The page's facts follow in two columns. Errors and warnings come in full: each with what to do, and each edit as a `-` line for what is there now and a `+` line for what to write. Info findings take one line each, the evidence is left out, and the report ends with what to fix first and the commands to run next. A crawl lists its site-wide findings, the page findings by rule and the 10 pages that score lowest. `aeo` shows one line for the AI crawlers of each purpose that robots.txt lets in, and a line for each one it keeps out. `rules` lists the rules by category, or one rule in full.
  
  Colour follows the terminal (`NO_COLOR` and `FORCE_COLOR` work as usual). In terminals known to support OSC 8 hyperlinks, rule ids link to their documentation. Progress during a crawl takes one line on stderr, which each step rewrites. `--help` for each command ends with examples. Output that is piped stays JSON, `-f md` and `-f json` are unchanged, and `-o report.txt` writes the text report. The layout of `text` is not part of the contract: scripts and agents should read `json`. Text from the audited page has its control characters removed before it is printed. The library exports `renderText`, `renderAeoText` and `renderRulesText`. The `cli_command` event now also records the report's format.

### Patch Changes

- 8c683ae: The MCP servers' `$mcp_initialize` event no longer carries `$session_id`, so PostHog counts a session only once a tool is called: most connections, such as a chat that loads the hosted server's connector, call none. The hosted server now answers `initialize` with an `Mcp-Session-Id` header, a token with the session's id and the client's name, version and protocol revision that the client sends back with each request, so the calls of one connection share a session and name their client. The server keeps nothing, and the tools and their answers are unchanged.

## 0.11.0

### Minor Changes

- d8981c3: The AEO audit reads robots.txt for eight more AI crawlers, each from its operator's own documentation (issue #34): the answer bots Amzn-SearchBot and Amzn-User (Amazon, Alexa), meta-webindexer and meta-externalfetcher (Meta AI), MistralAI-Index (Mistral search) and YandexAdditional (Yandex AI answers), and the training bots Amazonbot and MistralAI-Training. Each is a new entry in `crawlers.bots`, so a site that blocks a new answer bot now gets an `aeo.robots-blocks-answer-bot` warning and a lower AEO score; a blocked training bot is info. A `YandexAdditionalBot` group counts as YandexAdditional's own, as Yandex reads either name, and the page is blocked when either group blocks it; `AiBot` has a new `aliases` field for such names. With `--ai-bots`, the probe also requests the page as each new bot that has a User-Agent, and sends PerplexityBot's and Perplexity-User's User-Agents in the form Perplexity documents now. MistralAI-User's `usedFor` names Vibe, and Perplexity-User's says robots.txt may not apply.

## 0.10.0

### Minor Changes

- 6c8c5dc: The CLI and the local MCP server report unexpected errors to RIVI Software's PostHog project (EU) as `$exception` events, so bugs show up without anyone opening an issue (issue #60). An event carries the error's type, its message with every URL, path, quoted text, hostname and address taken out, and its stack with each file named by its place in the package or in `node_modules`, never the directories above it. Failures the tool expects and explains, such as a refused request, a missing browser or a bad argument, are not reported. The same switches turn it off as the rest of the telemetry, and the first-run notice, which now names errors, shows once more to those who saw the old one. Errors the core throws for such failures are now `ExpectedError`s, a new export that `RequestRefusedError`, `RenderUnavailableError` and `LighthouseUnavailableError` extend.

## 0.9.0

### Minor Changes

- c181dc7: The CLI and the local MCP server send anonymous usage data to RIVI Software, in PostHog's EU cloud (issue #57): one `cli_command` event per run of `audit`, `crawl`, `aeo` and `rules` (the command, the names of the flags, the kind of target, the exit code, the duration, the counts and the ids of the rules that fired), and one `$mcp_tool_call` event per tool call of the local server (the tool, whether and how it failed, the duration, the MCP client). Never a URL, a hostname, a path, the HTML or anything from a page, and no id that outlives a run or a session. The first run says so on stderr. Turn it off with the new `agentic-seo-check telemetry disable`, or `DO_NOT_TRACK=1` or `AGENTIC_SEO_CHECK_TELEMETRY=0`; it is off wherever `CI` is set. The library sends nothing, and `startMcpServer` takes an optional `analytics` for those who want their own.

## 0.8.2

### Patch Changes

- cea5d09: The tool is called Agentic SEO Check wherever its name is text: the MCP server's title (`Agentic SEO Check by RIVI Software`), the Markdown report's footer, the CLI's `--help`, the prefix of an MCP tool's error (`Agentic SEO Check error: …`), the website and the hosted server's pages, llms.txt and the share images. Everything you type or match keeps its name: the package, the `agentic-seo-check` and `agentic-seo-check-mcp` commands, the MCP server's `name`, the User-Agent tokens and their robots.txt groups, so no config or script needs a change.

## 0.8.1

### Patch Changes

- e6bd2d5: Every MCP tool, on the local and the hosted server, now has its title in `annotations.title` as well, where directory listings read it, and each audit tool's description ends with links to its documentation: the README's section on that server and the rules page, where each rule links to the search engine's own documentation. `seo_lighthouse` also links to Lighthouse's documentation.

## 0.8.0

### Minor Changes

- 8d128e7: The CLI, the local MCP server and the library now send the product token `agentic-seo-check-local` in their User-Agent, and their crawls obey the robots.txt group for `agentic-seo-check-local`, or `*`. `agentic-seo-check` is the hosted server's token alone, so a robots.txt group for it no longer applies to crawls from your machine. The hosted server now obeys robots.txt for every request, an audit of one page included, waits between a crawl's requests as `Crawl-delay` asks, signs its requests with Web Bot Auth, and answers a site that turns it away with the site's answer alone (#41). For the library, `FetchOptions` gains `sign` and `RequestGate` gains `robotsTxt`.

## 0.7.1

### Patch Changes

- 54a4ccc: The hosted MCP server moved to `https://mcp.agentic-seo.rivi.software/mcp`, and the website to `https://agentic-seo.rivi.software`. The former address, `https://mcp.agentic-seo-check.rivi.software/mcp`, keeps working, so clients set up with it need no change; its pages redirect to the new hostname.

## 0.7.0

### Minor Changes

- a11d4e8: A hosted MCP server: RIVI Software runs the MCP server on Cloudflare at `https://mcp.agentic-seo-check.rivi.software/mcp`, free and with no install, account or key, for claude.ai, Cowork, ChatGPT and any client that connects over Streamable HTTP. It serves `seo_audit_page`, `seo_crawl_site`, `seo_aeo_audit` and `seo_list_rules` with the local server's names and options, less what needs your machine (`localhost`, build directories, rendering, Lighthouse, your headers and User-Agent, AI bot probes), and keeps each site and each caller to limits it states; the README's "Hosted server" section has each client's setup, the limits and what it cannot do. It deploys with every release.
  
  What the package gains for it, and what changes for everyone:
  
  - `createMcpServer({ hosted })` serves the hosted server's tools, through a profile that starts each call and gates its requests. `createMcpServer()` serves the local server's tools as before.
  - `FetchOptions.gate` is asked before every request and every redirect, and shown each answer; `fetchPage` throws `RequestRefusedError` for what it refuses. A crawl leaves a link, image or sitemap it was refused unchecked, never broken or missing, and stops at a refusal for the whole site with `site.crawl-stopped` (`aeo.crawl-stopped` in the AEO audit), without reporting orphan pages it could not see.
  - `response.truncated` and `aeo.page-truncated` (info) say when a page was larger than the audit reads (5 MB), so only its first part was audited; the audit's `response` then has `truncated: true`. The read now stops at the cap to the byte.
  - Crawls obey a robots.txt group for `agentic-seo-check`, falling back to `*` as RFC 9309 says. robots-parser read the audit's User-Agent as `Mozilla`, so such a group never applied before. A group that keeps out this tool alone is not reported as `site.robots-blocked-pages`, and one that keeps it from the start URL ends the crawl with an error that says so. The soft-404, http and www probes, too, ask only for what robots.txt lets the crawl request, so a site that disallows `/` gets none of them.
  - The `maxSitemaps` and `maxSitemapBytes` crawl options set how many sitemaps a crawl reads and how much of each; `site.sitemap-too-large` names the size the audit read up to.

## 0.6.1

### Patch Changes

- f2c0c57: `site.duplicate-titles`, `site.duplicate-descriptions` and `site.duplicate-h1` no longer group the language versions of one page: pages that name each other as hreflang alternates under different codes (and the pages joined to them that way), such as `/contact` and `/nl/contact` both titled "Contact". A page that is no version of them and shares the value is still reported, and only that page gets the fix. A one-way hreflang link, or two pages that call each other by the same code, does not count. `site.duplicate-content` still reports language versions whose text is the same, as Google counts untranslated versions as duplicates.

## 0.6.0

### Minor Changes

- f07c6d9: Playwright now installs with the tool as an optional dependency instead of being a peer, so `--render` works under `npx` and in a global install on any machine with Google Chrome or Edge. The new `install-browser` command downloads the Chromium build that the bundled Playwright expects, for a machine without Chrome (`npx @rivi-software/agentic-seo-check install-browser`; `--with-deps` also installs Chromium's system libraries on Linux).
  
  Lighthouse and chrome-launcher stay optional peers, since they add some 180 MB to every install. `tool.lighthouse-unavailable` now gives the command that adds them in a project, in a global install and with `npx -p`, and both `tool.*` findings point to `install-browser` when no Chromium launches.

## 0.5.0

### Minor Changes

- 65e3119: Findings now carry a `fix`: the exact edits that resolve them on this page, each saying where (`html`, `http`, `robots.txt`, `sitemap`, `llms.txt` or `asset`), what to do (`add`, `replace`, `remove`), the code there now as the server sent it and the code to write instead, with `{{…}}` slots for words only the author can write. The title and meta description rules have theirs; the other rules follow.
  
  Every finding also has a stable `id`, and the audits take two new options for checking a fix: `--rule` / `rules` runs only the named rules, and `--baseline` (an earlier audit's JSON) / `baseline` (its finding ids) adds `baseline` to the result with the findings since fixed, still open and new. A finding counts as fixed only when its rule ran again on its page. The Markdown report shows each edit and a Re-check section.
- b1b4fbf: Every AEO rule now carries a `fix`. robots.txt fixes quote the lines that block a bot and give it its own group, without touching a training bot that shares the group (when only AI bots share it, the fix quotes the group's user-agent lines whole, so the answer and training fixes applied together cannot leave its rules without a user-agent line); training opt-outs, Content-Signal and `__usage_ai-training` fixes say it is the site owner's choice. Opt-out fixes rewrite the robots meta tag or `X-Robots-Tag` without the directive, llms.txt fixes give the file with a link line per audited page, and answer-ready fixes add the paragraph under a question heading or the JSON-LD author and dates. `aeo.bot-probe-inconclusive` has no fix: it is about the audit.
- 9c6c328: Every page rule's finding now carries a `fix`: canonical, document, head, headings, hreflang, images, indexing, links, URL, loading, social, structured data, content, keyword and response rules, and `response.fetch-failed`. Edits quote the tag as the page writes it and give the rewritten tag: an absolute canonical or hreflang URL, `defer` on the blocking script, an `<h1>` turned into an `<h2>`, a price written as `19.99` with `priceCurrency`, a `301` in place of a meta refresh. Where a finding has two ways out, the fix takes the one that cannot hurt: it never deletes content, and indexing fixes say to keep a noindex that is deliberate. `structured-data.retired-type` has no fix, since the markup stays.
- aed5248: Every crawl and directory rule (`site.*`), every `--render` rule (`rendering.*`) and every `--lighthouse` rule now carries a `fix`. Site fixes name the file or response they change with `url`: the robots.txt line that blocks a page, the sitemap `<loc>` to remove or repoint, the `<a>` tag on the linking page with the final URL of a redirect, the response a redirect hop should send. A page blocked by robots.txt is taken out of the sitemap rather than unblocked, and a noindex page out of the sitemap rather than made indexable. Render fixes quote the tag the rendered page has, to send from the server; Lighthouse fixes name the LCP image, the unsized images and the blocking resources Lighthouse found. A file to rebuild (a script to split, an image to re-encode) is an `asset` replace at `whole file`, with no `current` and the size or time to aim for in `write`. `site.crawl-limit-reached` has no fix: it is about the audit.
  
  `performance` (with `--lighthouse`) now also lists what those fixes are built from: `lcpElement`, `unsizedImages`, `layoutShifts`, `renderBlocking`, `scripts`, and up to 10 `items` per opportunity and failed audit.
  
  `site.hreflang-no-return-link` no longer reports a page whose canonical names another URL (a parameter variant is folded into that URL, so nothing should link back to it), and counts a page whose `en` and `x-default` links name the same alternate once.
  
  A crawl now keeps its pages in the order a one-at-a-time breadth-first crawl reaches them, whatever order parallel requests finish in, so `site.url-variant-duplicate` and the duplicate rules call the same URL the page (and the other the variant) on every run.

## 0.4.0

### Minor Changes

- f89e16d: Findings now quote the text they are about, so an agent can show a reviewer the mistake it fixed. `meta-description.same-as-title` adds `description` to its evidence and `keyword.not-in-description` adds `description`. `site.duplicate-titles`, `site.duplicate-descriptions` and `site.duplicate-h1` quote the shared value as the first page writes it, not lowercased. The `seo-audit` skill now tells agents to put each title, description or canonical the audit found next to the value they changed it to in their pull request, with page text kept in code spans.

## 0.3.0

### Minor Changes

- d970018: Site audits now follow canonicals and hreflang links to where they point. Six rules: `site.canonical-target-broken`, `site.canonical-target-redirects`, `site.canonical-target-noindex` and `site.canonical-chain` for canonicals that point to a 4xx/5xx, a redirect, a noindex page or a page that names yet another canonical; `site.hreflang-target-invalid` for alternates that are broken, redirect, are noindex or are not canonical (an `x-default` that redirects to the visitor's language is fine); and `site.links-to-noindex` (info) for noindex pages the site links to, cart, search and account pages aside. A crawl probes same-site canonical and hreflang targets no link led to, within `maxLinkChecks`, and a directory audit checks them against the files when `baseUrl` is the production host.
- 1bdb19a: Add seven SEO rules for the head of a page and its indexing signals: `head.closed-early` (an element that does not belong in `<head>`, such as a pixel `<img>` or stray text, ends it, and Google ignores the metadata after it), `head.metadata-in-body`, `meta-refresh.redirect`, `charset.late`, `robots.conflicting`, `robots.malformed-directive` and `canonical.header-conflict` (an HTTP `Link` canonical that disagrees with the HTML one). Metadata that Next.js (15.2+) or React streams into a hidden part of `<body>` is reported as info, since Google reads it after rendering. Fixes: an inline SVG icon's `<title>` no longer counts as a second page title (`title.multiple`); `canonical.missing` and `charset.missing` accept a canonical in the `Link` header and a charset in the `Content-Type` header; and an `X-Robots-Tag` for one other crawler (`GPTBot: noindex`) no longer makes the page noindex for search engines.
- 56691ea: Add five rules for how a page loads, read from the HTML and its headers without a browser: `loading.no-compression` (HTML sent without gzip or Brotli), `loading.render-blocking-script` (scripts in `<head>` without `async`, `defer` or `type="module"`), `img.lazy-above-fold` (`loading="lazy"` on the first large image, or together with `fetchpriority="high"`), `img.srcset-missing` (images 640 pixels wide or more without `srcset`) and `favicon.missing` (the home page links to no icon for Google's search results). The `Content-Encoding` response header now appears in `response.headers`.
- 04976b1: Check robots.txt and sitemaps against what Google reads of them. Eight site rules: `site.robots-txt-too-large` (over 500 KiB), `site.robots-txt-unsupported-rule` (`noindex:` and `nofollow:` lines Google stopped reading in 2019, and `crawl-delay`, which it ignores), `site.robots-blocks-resources` (scripts and stylesheets the pages load that robots.txt keeps from Googlebot), `site.sitemap-too-large`, `site.sitemap-index-nested`, `site.sitemap-lastmod-invalid`, `site.sitemap-lastmod-future` and `site.sitemap-other-host`. Gzip sitemaps (`.xml.gz`) are now read instead of reported as an error, an empty `<urlset>` is a valid sitemap with no URLs, a sitemap larger than the 15 MB the audit reads (uncompressed) is reported as such instead of as unparsable or missing, and a directory audit no longer reads a sitemap path that leads outside the output directory. `robotsTxt.bytes` and `sitemaps.problems` are new in the site audit JSON.
- a553864: Check structured data values, not only which properties exist. `structured-data.invalid-value` reports prices with a currency symbol or a decimal comma, currencies that are not ISO 4217 codes, ratings outside their scale and breadcrumb trails with odd positions or crumbs without a URL; `structured-data.relative-url` and `structured-data.dangling-id` report relative URLs and `@id` references the page does not define. `structured-data.retired-type` says when markup asks for a rich result Google no longer shows (FAQPage since May 2026, HowTo, SpecialAnnouncement, ClaimReview, the sitelinks search box); the properties of such markup are no longer reported as missing. A review nested in a Recipe or Product no longer needs `itemReviewed`, and a Q&A page question may have only suggested answers.
- 6212406: Add seven SEO rules for URLs and links: `url.uppercase` and `url.underscores` (info, and they say not to rename URLs that are already indexed), `url.session-id`, `links.tracking-parameters` (campaign parameters on internal links), `links.local-host` (a canonical, `og:image`, image or script on localhost or a private address; info when only `<a>` links point there), `links.missing-fragment` (same-page links to ids the page lacks) and `https.mixed-content` (resources browsers block on an https page, and the ones they upgrade, which is all of them under `upgrade-insecure-requests`). The `Content-Security-Policy` response header now appears in `response.headers`.
- 656ffe6: Find URLs that serve one page twice. `site.url-variant-duplicate` reports a page that also answers 200 with its trailing slash toggled or its path in another case, without a redirect or a canonical back (a crawl requests these variants for a few pages, outside localhost, and reads the ones its links reached); `site.parameter-duplicates` reports URLs that differ only in their query string and show the same text; `site.broken-images` reports images that answer 4xx/5xx, with the pages that show them (up to 100 image URLs per crawl, and as files in build output). Fixes: pages that name another URL as canonical no longer count in `site.duplicate-content`, `site.duplicate-titles`, `site.duplicate-descriptions` and `site.duplicate-h1`, and a crawl no longer records one page twice when a link and a redirect reach it at the same time.

## 0.2.0

### Minor Changes

- db42662: Add an AEO (answer engine optimization) audit: the `agentic-seo-check aeo <target>` command and the `seo_aeo_audit` MCP tool check whether AI answer engines can reach, quote and trust a page, a crawled site or build output, with a separate score and 30 `aeo.*` rules. It reads robots.txt per AI crawler (search crawlers, answer bots such as OAI-SearchBot and PerplexityBot, training bots such as GPTBot), Content-Signal lines, the shared `__usage_ai-training` opt-out and `/llms.txt`; snippet and AI opt-outs (nosnippet, max-snippet, Bing's noarchive and nocache for Copilot, noai, data-nosnippet); answer-ready content (empty JavaScript app shells, questions without a direct answer, FAQ/HowTo markup the page does not show); and article authors, dates and entities. `--ai-bots` also requests the page with each AI bot's User-Agent to catch CDN or firewall blocks. The SEO audit and its score are unchanged.

## 0.1.1

### Patch Changes

- de8e754: `--help` and Markdown reports end with one line naming RIVI Software, and the MCP server introduces itself with a title, a description, a website and the RIVI mark as icons. The JSON an audit returns is unchanged. An unknown rule id inside the tool now fails with an error that names it, and a render or Lighthouse failure that throws something other than an `Error` is reported with its text instead of `undefined`.
