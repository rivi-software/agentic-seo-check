import {
  addProperty,
  directiveFixes,
  markupAt,
  scriptJson,
  statusLine,
} from "../aeo/fixes.js";
import type { DirectiveChange, MarkupTarget } from "../aeo/fixes.js";
import {
  articles,
  comparable,
  directivesFor,
  hasNoindex,
  hasNosnippet,
  isEntity,
  isHomePage,
  markedUpTexts,
  maxSnippet,
  nameOf,
  stripTags,
  typedNodes,
} from "../aeo/page.js";
import { isJsonObject, isString } from "../html/structured-data.js";
import type { JsonObject, JsonValue } from "../html/structured-data.js";
import { collapseWhitespace } from "../html/text.js";
import type { ExtractedPage, FixEdit, QuestionHeading } from "../types.js";
import {
  addHtml,
  escapeAttribute,
  escapeText,
  isCut,
  removeEdit,
  replaceEdit,
  replaceHtml,
  slot,
  withContent,
  withoutAttribute,
} from "./fix.js";
import { parseRobotsHeader, robotsDirectives } from "./indexing.js";
import { cap, defineRule, GOOGLE_DOCS } from "./rule.js";

/** Answer engines' own documentation for the AEO rules. */
export const AEO_DOCS = {
  googleAi: "https://developers.google.com/search/docs/appearance/ai-features",
  bing: "https://www.bing.com/webmasters/help/webmaster-guidelines-30fba23a",
  httpErrors:
    "https://developers.google.com/search/docs/crawling-indexing/http-network-errors",
  structuredDataPolicies:
    "https://developers.google.com/search/docs/appearance/structured-data/sd-policies",
  article:
    "https://developers.google.com/search/docs/appearance/structured-data/article",
  dates:
    "https://developers.google.com/search/docs/appearance/publication-dates",
  organization:
    "https://developers.google.com/search/docs/appearance/structured-data/organization",
} as const;

/** A question answered in more words than this does not start with a direct answer. */
const LONG_ANSWER_WORDS = 100;

/**
 * Whether a short, direct answer follows a question heading: text under it, whose first block is
 * at most LONG_ANSWER_WORDS long. A comparison (issue #129) counts the answered questions with it.
 */
export const answersFirst = (q: QuestionHeading): boolean =>
  q.sectionWords > 0 &&
  (q.firstBlockWords ?? q.sectionWords) <= LONG_ANSWER_WORDS;

const sourcesOf = (
  meta: { name: string; content: string }[],
  header: string | undefined,
  directive: (d: string) => boolean
): string[] => {
  const sources: string[] = [];

  for (const m of meta) {
    if (
      m.content.split(",").some((d) => directive(d.replaceAll(/\s+/gu, "")))
    ) {
      sources.push(`<meta name="${m.name}">`);
    }
  }

  if (header && parseRobotsHeader(header).some((d) => directive(d.directive))) {
    sources.push("X-Robots-Tag");
  }

  return [...new Set(sources)];
};

const metaSelector = (sources: string[]): string | undefined => {
  const meta = sources.find((s) => s.startsWith("<meta"));

  return meta
    ? `head > meta[name="${meta.slice('<meta name="'.length, -2)}"]`
    : undefined;
};

const isNoai = (d: string): boolean => d === "noai" || d === "noimageai";

const yearOf = (value: JsonValue | undefined): string | null =>
  isString(value) ? (/^\d{4}/u.exec(value.trim())?.[0] ?? null) : null;

/* ---------------------------------------------------------------------------
 * Fixes
 * ------------------------------------------------------------------------- */

const ENGINE_META = new Set(["robots", "googlebot", "bingbot"]);
const GOOGLE_META = new Set(["robots", "googlebot"]);
const BING_META = new Set(["robots", "bingbot"]);
const GOOGLE_HEADER = new Set([null, "googlebot"]);
const BING_HEADER = new Set([null, "bingbot"]);

/** Drops the directives `drop` names and keeps the rest. */
const without =
  (...drop: string[]): DirectiveChange["change"] =>
  (d) =>
    drop.includes(d) ? null : d;

/** noindex goes; "none" (noindex, nofollow) keeps its nofollow half. */
const allowIndexing = (d: string): string | null => {
  if (d === "noindex") {
    return null;
  }

  return d === "none" ? "nofollow" : d;
};

/** A max-snippet below 100 characters becomes -1, no limit. */
const liftSnippetLimit = (d: string): string => {
  if (!d.startsWith("max-snippet:")) {
    return d;
  }

  const n = Number(d.slice("max-snippet:".length));

  return Number.isInteger(n) && n > 0 && n < 100 ? "max-snippet:-1" : d;
};

const PAGE_ERROR_WRITE =
  "Serve the page's HTML with status 200. If the page moved, answer 301 with a Location header to its new URL instead; if it is gone for good, remove the links to it.";

/** Text from structured data as page text: tags stripped, whitespace collapsed, escaped for HTML. */
const asHtmlText = (value: string): string =>
  escapeText(collapseWhitespace(stripTags(value)));

/** Whether a structured data object comes from microdata rather than JSON-LD. */
const isMicrodata = (page: ExtractedPage, node: JsonObject): boolean =>
  page.structuredData.some((i) => i.source === "microdata" && i.data === node);

/** The heading element that asks `question`, as the HTML writes it, skipping ones already used. */
const headingTag = (
  page: ExtractedPage,
  question: Pick<QuestionHeading, "level" | "text">,
  used: Set<number>
): string | null => {
  const index = page.headings.findIndex(
    (h, i) =>
      !used.has(i) &&
      (question.level === 0 || h.level === question.level) &&
      comparable(h.text) === comparable(question.text)
  );

  const tag = page.markup.headings[index];

  if (index === -1 || tag === undefined) {
    return null;
  }

  used.add(index);

  return tag;
};

/**
 * The edit that writes `html` right after the element `tag` quotes, or at `at` when there is no
 * whole quote: a heading cut at 500 characters (an anchor icon's SVG makes one long) would be
 * written back cut, with the rest of it lost.
 */
const addAfter = (
  tag: string | null,
  at: string,
  html: string,
  write: string
): FixEdit =>
  tag && !isCut(tag)
    ? replaceHtml(tag, `${tag}\n${html}`, { at, write })
    : addHtml(at, html, write);

/** Edits that put an answer right under each question heading that lacks a short one. */
const answerFixes = (
  page: ExtractedPage,
  weak: QuestionHeading[]
): FixEdit[] => {
  const used = new Set<number>();

  return weak.map((q) => {
    const at = q.level === 0 ? "summary, dt" : `h${q.level}`;

    const write =
      q.sectionWords === 0
        ? `One or two sentences (under 60 words) that answer "${q.text}" directly.`
        : `One or two sentences (under 60 words) that answer "${q.text}" directly, before the longer text that follows it now.`;

    return addAfter(
      headingTag(page, q, used),
      at,
      `<p>${slot("direct answer")}</p>`,
      write
    );
  });
};

const SHOW_MARKED_UP =
  "Show this text on the page, built from the same data as the JSON-LD (an FAQ or steps section is a good place). If the page should not show it, remove the item from the JSON-LD instead. If JavaScript adds it, render it on the server too.";

/** Edits that put marked-up questions, answers and steps the page does not show on the page. */
const showMarkedUpFixes = (
  page: ExtractedPage,
  texts: { type: string; text: string }[],
  hidden: Set<{ type: string; text: string }>
): FixEdit[] => {
  const edits: FixEdit[] = [];
  const steps: string[] = [];
  const used = new Set<number>();
  let question: string | null = null;
  let block: string[] | null = null;

  const flush = () => {
    if (block) {
      edits.push(addHtml("body", block.join("\n"), SHOW_MARKED_UP));
      block = null;
    }
  };

  for (const t of texts) {
    if (t.type === "Question") {
      flush();
      question = t.text;

      if (hidden.has(t)) {
        block = [`<h3>${asHtmlText(t.text)}</h3>`];
      }

      continue;
    }

    if (!hidden.has(t)) {
      continue;
    }

    const html = `<p>${asHtmlText(t.text)}</p>`;

    if (t.type === "HowToStep") {
      steps.push(`  <li>${asHtmlText(t.text)}</li>`);
    } else if (block) {
      block.push(html);
    } else {
      // The question is on the page; its answer goes right under it.
      const tag = question
        ? headingTag(page, { level: 0, text: stripTags(question) }, used)
        : null;

      edits.push(addAfter(tag, "body", html, SHOW_MARKED_UP));
    }
  }

  flush();

  if (steps.length) {
    edits.push(
      addHtml("body", ["<ol>", ...steps, "</ol>"].join("\n"), SHOW_MARKED_UP)
    );
  }

  return edits;
};

const AUTHOR_WRITE =
  "The name of the person who wrote the article and the URL of their page on this site; with no person behind it, use an Organization with name and url. It replaces an empty author.";

/** The author property for an article in JSON-LD or microdata, with slots for who wrote it. */
const authorProperty = {
  json: `"author": {"@type": "Person", "name": "${slot("author's name")}", "url": "${slot("URL of the author's page")}"}`,
  microdata: `<div itemprop="author" itemscope itemtype="https://schema.org/Person"><a itemprop="url" href="${slot("URL of the author's page")}"><span itemprop="name">${slot("author's name")}</span></a></div>`,
};

/** The slot hint and the guidance for a date property an article lacks. */
interface DateGuide {
  hint: string;
  write: string;
}

const DATE_PROPERTY: ReadonlyMap<string, DateGuide> = new Map([
  [
    "datePublished",
    {
      hint: "YYYY-MM-DD the article was first published",
      write:
        "The date the article was first published, in ISO 8601: 2026-03-14, or 2026-03-14T09:30:00+01:00 with the time.",
    },
  ],
  [
    "dateModified",
    {
      hint: "YYYY-MM-DD of the last real change",
      write:
        "The date the content last changed materially (not every build), in ISO 8601; the same as datePublished if it never changed.",
    },
  ],
]);

/** The date an article states: datePublished, else dateModified, as written. */
const articleDate = (node: JsonObject): string => {
  for (const key of ["datePublished", "dateModified"]) {
    const value = node[key];

    if (isString(value) && value.trim()) {
      return value.trim();
    }
  }

  return "";
};

/** An author written as a bare name, or as an object without url or sameAs. */
interface BareAuthor {
  name: string;
  /** The author as JSON: the string as written, or null for an object. */
  json: string | null;
  target: MarkupTarget;
}

/** Article markup whose author is missing or empty, as aeo.article-author-missing reads it. */
export const hasNoAuthor = (node: JsonObject): boolean => {
  const { author } = node;

  return (
    author === undefined ||
    author === null ||
    (Array.isArray(author) && author.length === 0) ||
    (isString(author) && !author.trim())
  );
};

/** Authors with no url or sameAs, as aeo.article-author-incomplete reads them; a comparison too. */
export const bareAuthors = (page: ExtractedPage): BareAuthor[] =>
  articles(page).flatMap(({ node, types }) => {
    const target: MarkupTarget = {
      type: types[0] ?? "Article",
      microdata: isMicrodata(page, node),
      within: "author",
    };

    const authors = Array.isArray(node["author"])
      ? node["author"]
      : [node["author"]];

    return authors.flatMap((a): BareAuthor[] => {
      if (isString(a) && a.trim()) {
        return [{ name: a.trim(), json: JSON.stringify(a), target }];
      }

      if (
        isJsonObject(a) &&
        a["url"] === undefined &&
        a["sameAs"] === undefined
      ) {
        return [{ name: nameOf(a) ?? "(unnamed author)", json: null, target }];
      }

      return [];
    });
  });

/** The edits that give a bare author a url: the name becomes a Person, or the object gets a url. */
const authorUrlFix = (author: BareAuthor): FixEdit[] => {
  const url = slot(`URL of ${author.name}'s author page`);
  const write = `The URL of ${author.name}'s page on this site (or a profile that identifies them), and sameAs with their profiles elsewhere where they exist.`;

  if (author.json !== null && !author.target.microdata) {
    return [
      replaceHtml(
        author.json,
        `{"@type": "Person", "name": ${scriptJson(author.name)}, "url": "${url}"}`,
        { at: markupAt(author.target), write }
      ),
    ];
  }

  // A microdata author written as text has no item of its own: a <link itemprop="url"> inside it
  // would give the article the url. The author element has to become a Person item first.
  if (author.json !== null) {
    const at = markupAt(author.target);

    return [
      addHtml(
        at,
        'itemscope itemtype="https://schema.org/Person"',
        "These attributes on the author element itself, so it becomes a Person item that holds its name and url."
      ),
      replaceHtml(
        escapeText(author.name),
        `<span itemprop="name">${escapeText(author.name)}</span><link itemprop="url" href="${url}">`,
        { at, write }
      ),
    ];
  }

  return [
    addProperty(
      author.target,
      {
        json: `"url": "${url}"`,
        microdata: `<link itemprop="url" href="${url}">`,
      },
      write
    ),
  ];
};

/** Organization JSON-LD for a home page, named after og:site_name when the page has one. */
const organizationFix = (page: ExtractedPage): FixEdit => {
  const siteName = page.og["site_name"];

  const name = siteName
    ? scriptJson(siteName)
    : `"${slot("organization name")}"`;

  const code = [
    '<script type="application/ld+json">',
    "{",
    '  "@context": "https://schema.org",',
    '  "@type": "Organization",',
    `  "name": ${name},`,
    `  "url": ${scriptJson(new URL("/", page.url).href)},`,
    `  "logo": "${slot("absolute URL of the logo image")}",`,
    `  "sameAs": ["${slot("URL of an official profile")}"]`,
    "}",
    "</script>",
  ].join("\n");

  return addHtml(
    "head",
    code,
    `The organization's name, the absolute URL of its logo, and the URLs of its official profiles (LinkedIn, Wikipedia, Wikidata, social accounts). For a personal site use "@type": "Person" with the person's name.`
  );
};

export const aeoRules = [
  defineRule(
    {
      id: "aeo.page-error",
      category: "aeo",
      severity: "error",
      description:
        "The page answers with an error status or could not be fetched, so no crawler can read it.",
      recommendation:
        "Make the URL answer 200 with the page's HTML. Answer engines, like search engines, drop pages that fail.",
      docs: AEO_DOCS.httpErrors,
    },
    ({ response }, make) => {
      if (!response) {
        return null;
      }

      if (response.error) {
        return make(`The page could not be fetched: ${response.error}.`, {
          fix: [
            replaceEdit(
              "http",
              `no response (${response.error})`,
              "HTTP/1.1 200 OK",
              { at: "status line", write: PAGE_ERROR_WRITE }
            ),
          ],
          evidence: { error: response.error },
        });
      }

      return response.status !== null && response.status >= 400
        ? make(`The page answers HTTP ${response.status}.`, {
            fix: [
              replaceEdit(
                "http",
                statusLine(response.status),
                "HTTP/1.1 200 OK",
                {
                  at: "status line",
                  write: PAGE_ERROR_WRITE,
                }
              ),
            ],
            evidence: { status: response.status },
          })
        : null;
    }
  ),
  defineRule(
    {
      id: "aeo.page-truncated",
      category: "aeo",
      severity: "info",
      description:
        "The page is larger than the audit reads (5 MB; 2 MB on the hosted server), so only its first part was audited.",
      recommendation:
        "Findings about the rest of the page are missing. HTML this large is slow for crawlers too: move inline scripts, data and SVG into files the page loads. On the hosted server, the local server reads up to 5 MB.",
    },
    ({ page, response }, make) =>
      response?.truncated
        ? make(
            `The audit read the first ${(page.htmlBytes / 1_000_000).toFixed(1)} MB of the page and stopped there.`,
            // About the audit, not the page.
            { fix: [], evidence: { bytesRead: page.htmlBytes } }
          )
        : null
  ),
  defineRule(
    {
      id: "aeo.noindex",
      category: "aeo",
      severity: "warning",
      description:
        "The page is set to noindex, so answer engines that draw on a search index cannot cite it.",
      recommendation:
        "Remove noindex if answer engines should quote this page. Keep it on pages that should stay private (login, cart, internal search); preview hosts often add it with X-Robots-Tag, so check production first.",
      docs: AEO_DOCS.googleAi,
    },
    ({ page, response }, make) => {
      const r = robotsDirectives(page, response);

      return r.noindex
        ? make(
            `Page is set to noindex via ${r.sources.join(" and ")}, so Google AI Overviews and AI Mode, Copilot and other answer engines built on a search index cannot cite it.`,
            {
              fix: directiveFixes(
                page,
                response,
                {
                  metaNames: null,
                  headerAgents: new Set([
                    null,
                    "googlebot",
                    "googlebot-news",
                    "bingbot",
                  ]),
                  change: allowIndexing,
                },
                "Apply this only if answer engines should cite the page: keep noindex on login, cart, internal search and other private pages, and check production before you change a preview host's X-Robots-Tag."
              ),
              selector: r.sources.includes("meta")
                ? 'head > meta[name="robots"]'
                : undefined,
              evidence: { directives: r.directives, sources: r.sources },
            }
          )
        : null;
    }
  ),
  defineRule(
    {
      id: "aeo.nosnippet",
      category: "aeo",
      severity: "warning",
      description:
        "nosnippet (or max-snippet:0) keeps the page's text out of Google's AI Overviews and AI Mode and limits what Copilot can cite.",
      recommendation:
        "Remove nosnippet or max-snippet:0 if answer engines should quote this page. To hide one part only, wrap that part in an element with data-nosnippet.",
      docs: AEO_DOCS.googleAi,
    },
    ({ page, response }, make) => {
      const google = directivesFor("google", page, response);
      const bing = directivesFor("bing", page, response);

      const engines = [
        ...(hasNosnippet(google) && !hasNoindex(google) ? ["Google"] : []),
        ...(hasNosnippet(bing) && !hasNoindex(bing) ? ["Bing"] : []),
      ];

      if (!engines.length) {
        return null;
      }

      const sources = sourcesOf(
        page.answer.robotsMeta,
        response?.headers["x-robots-tag"],
        (d) => d === "nosnippet" || d === "max-snippet:0"
      );

      return make(
        `Page sets nosnippet for ${engines.join(" and ")} via ${sources.join(" and ")}, so its text cannot be quoted in AI answers.`,
        {
          fix: directiveFixes(
            page,
            response,
            {
              metaNames: ENGINE_META,
              headerAgents: new Set([null, "googlebot", "bingbot"]),
              change: without("nosnippet", "max-snippet:0"),
            },
            "Keep nosnippet if it is deliberate (a paywall, legal text). To hide one part of the page only, put data-nosnippet on that part instead."
          ),
          selector: metaSelector(sources),
          evidence: { engines, sources },
        }
      );
    }
  ),
  defineRule(
    {
      id: "aeo.max-snippet-short",
      category: "aeo",
      severity: "info",
      description:
        "max-snippet is below 100 characters, which also caps what Google quotes in AI Overviews and AI Mode.",
      recommendation:
        "Raise max-snippet, or set max-snippet:-1 for no limit, so answer engines can quote whole sentences.",
      docs: GOOGLE_DOCS.robotsMeta,
    },
    ({ page, response }, make) => {
      const directives = directivesFor("google", page, response);
      const limit = maxSnippet(directives);

      return limit !== null &&
        limit > 0 &&
        limit < 100 &&
        !hasNoindex(directives)
        ? make(
            `max-snippet:${limit} lets Google quote at most ${limit} characters of this page.`,
            {
              fix: directiveFixes(
                page,
                response,
                {
                  metaNames: GOOGLE_META,
                  headerAgents: GOOGLE_HEADER,
                  change: liftSnippetLimit,
                },
                "max-snippet:-1 lets Google quote as much as an answer needs; a limit of 160 or more works too. Keep the short limit if it is deliberate."
              ),
              evidence: { maxSnippet: limit },
            }
          )
        : null;
    }
  ),
  defineRule(
    {
      id: "aeo.noarchive",
      category: "aeo",
      severity: "warning",
      description:
        "noarchive keeps the page out of Microsoft Copilot answers; Bing still lists it in search.",
      recommendation:
        "Remove noarchive if the page should appear in Copilot answers. Paywalled pages can use nocache instead, which lets Copilot cite the URL, title and snippet. Google ignores noarchive.",
      docs: AEO_DOCS.bing,
    },
    ({ page, response }, make) => {
      const bing = directivesFor("bing", page, response);

      // Bing treats a page with both noarchive and nocache as nocache.
      if (
        !bing.includes("noarchive") ||
        bing.includes("nocache") ||
        hasNoindex(bing)
      ) {
        return null;
      }

      const sources = sourcesOf(
        page.answer.robotsMeta.filter((m) => m.name !== "googlebot"),
        response?.headers["x-robots-tag"],
        (d) => d === "noarchive"
      );

      return make(
        `Page sets noarchive via ${sources.join(" and ")}, so Copilot leaves it out of its answers.`,
        {
          fix: directiveFixes(
            page,
            response,
            {
              metaNames: BING_META,
              headerAgents: BING_HEADER,
              change: without("noarchive"),
            },
            "For a paywalled page, write nocache in place of noarchive: Copilot then cites its URL, title and snippet only. Keep noarchive if keeping the page out of Copilot is deliberate."
          ),
          selector: metaSelector(sources),
          evidence: { sources },
        }
      );
    }
  ),
  defineRule(
    {
      id: "aeo.nocache",
      category: "aeo",
      severity: "info",
      description:
        "nocache limits Microsoft Copilot to the page's URL, title and snippet.",
      recommendation:
        "Remove nocache if Copilot should quote the page's content, not only link to it.",
      docs: AEO_DOCS.bing,
    },
    ({ page, response }, make) => {
      const bing = directivesFor("bing", page, response);

      return bing.includes("nocache") && !hasNoindex(bing)
        ? make(
            "Page sets nocache, so Copilot may use only its URL, title and snippet.",
            {
              fix: directiveFixes(
                page,
                response,
                {
                  metaNames: BING_META,
                  headerAgents: BING_HEADER,
                  change: without("nocache"),
                },
                "Keep nocache if Copilot should link to the page without quoting it, as for a paywall."
              ),
            }
          )
        : null;
    }
  ),
  defineRule(
    {
      id: "aeo.noai",
      category: "aeo",
      severity: "info",
      description:
        "The page sets noai or noimageai, directives no major answer engine documents support for.",
      recommendation:
        "To opt out of AI training, say so in robots.txt (a `User-Agent: __usage_ai-training` group with `Disallow: /`, or groups for GPTBot, ClaudeBot and Google-Extended). If the page should appear in AI answers, remove noai to avoid mixed signals.",
    },
    ({ page, response }, make) => {
      const sources = sourcesOf(
        page.answer.robotsMeta,
        response?.headers["x-robots-tag"],
        isNoai
      );

      return sources.length
        ? make(
            `Page sets noai/noimageai via ${sources.join(" and ")}; Google, Bing, OpenAI and Anthropic do not document support for it.`,
            {
              fix: directiveFixes(
                page,
                response,
                {
                  metaNames: null,
                  headerAgents: null,
                  change: without("noai", "noimageai"),
                },
                "To keep the content out of AI training, say so in robots.txt instead: a `User-Agent: __usage_ai-training` group with `Disallow: /`, which Google, Microsoft, OpenAI and Anthropic back. Opting out of training is the owner's choice."
              ),
              selector: metaSelector(sources),
              evidence: { sources },
            }
          )
        : null;
    }
  ),
  defineRule(
    {
      id: "aeo.data-nosnippet",
      category: "aeo",
      severity: "info",
      description:
        "data-nosnippet hides a large share of the page's text (20% or more) from snippets and AI Overviews.",
      recommendation:
        "Keep data-nosnippet on boilerplate or paywalled parts only. The text answer engines should quote must be outside it.",
      docs: GOOGLE_DOCS.robotsMeta,
    },
    ({ page }, make) => {
      const {
        nosnippetWords,
        nosnippetElements,
        nosnippetSelectors,
        nosnippetTags,
      } = page.answer;

      if (!nosnippetWords || page.wordCount < 50) {
        return null;
      }

      const share = nosnippetWords / page.wordCount;

      if (share < 0.2) {
        return null;
      }

      return make(
        `data-nosnippet hides ${nosnippetWords} of ${page.wordCount} words (${Math.round(share * 100)}%) from snippets and AI Overviews.`,
        {
          severity: share >= 0.5 ? "warning" : "info",
          fix: nosnippetSelectors.map((at, i) => {
            const write =
              "Keep data-nosnippet on boilerplate and paywalled text; take it off the text answer engines should quote.";

            const tag = nosnippetTags[i];

            const rewritten = tag
              ? withoutAttribute(tag, "data-nosnippet")
              : null;

            return tag && rewritten
              ? replaceHtml(tag, rewritten, { at, write })
              : removeEdit("html", "data-nosnippet", {
                  at,
                  write: `Delete the data-nosnippet attribute, with its value if it has one, from this element. ${write}`,
                });
          }),
          selector: nosnippetSelectors[0],
          evidence: {
            elements: nosnippetElements,
            words: nosnippetWords,
            selectors: cap(nosnippetSelectors),
          },
        }
      );
    }
  ),
  defineRule(
    {
      id: "aeo.text-needs-javascript",
      category: "aeo",
      severity: "warning",
      description:
        "The HTML is an empty JavaScript app shell; most AI crawlers do not run JavaScript, so they see no content.",
      recommendation:
        "Render the content on the server (SSR or static generation) so the HTML carries it. `agentic-seo-check audit <url> --render` compares the HTML with the rendered page.",
      docs: GOOGLE_DOCS.javascript,
    },
    ({ page }, make) => {
      const { emptyAppRoot, noscriptAsksForJavaScript } = page.answer;

      if (
        page.wordCount >= 50 ||
        (!emptyAppRoot && !noscriptAsksForJavaScript)
      ) {
        return null;
      }

      const shell = emptyAppRoot
        ? `an empty app root (${emptyAppRoot})`
        : "a <noscript> message asking for JavaScript";

      const write =
        "The page's headings and text, rendered on the server: server-side rendering or static generation (Next.js server components, Nuxt SSR, SvelteKit or Astro prerendering, or a prerender step for a Vite or CRA app), so the HTML the server sends holds the content and the app hydrates it.";

      const content = slot("the page's content as HTML");
      const rootTag = page.answer.emptyAppRootTag;

      // A quote cut at 500 characters (a wordless SVG spinner or skeleton in the root) would be
      // written back cut, "…" and all: then the fix adds the content to the root instead.
      const filled =
        rootTag && !isCut(rootTag) ? withContent(rootTag, content) : null;

      const fix =
        rootTag && filled && emptyAppRoot
          ? replaceHtml(rootTag, filled, { at: emptyAppRoot, write })
          : addHtml(emptyAppRoot ?? "body", content, write);

      return make(
        `The HTML has ${page.wordCount} words of text and ${shell}. GPTBot, OAI-SearchBot, ClaudeBot and PerplexityBot do not run JavaScript, so they see an empty page.`,
        {
          fix: [fix],
          selector: emptyAppRoot ?? "noscript",
          evidence: {
            wordCount: page.wordCount,
            emptyAppRoot,
            noscriptAsksForJavaScript,
          },
        }
      );
    }
  ),
  defineRule(
    {
      id: "aeo.question-not-answered-first",
      category: "aeo",
      severity: "info",
      description:
        "A heading asks a question but no short, direct answer follows it.",
      recommendation:
        "Answer each question in the first sentence or two under its heading (under about 60 words), then add detail. A direct answer right under the question is the passage answer engines find easiest to quote.",
    },
    ({ page }, make) => {
      const weak = page.answer.questions.filter((q) => !answersFirst(q));

      return weak.length
        ? make(
            `${weak.length} of ${page.answer.questions.length} question heading(s) are not followed by a short direct answer.`,
            {
              fix: answerFixes(page, weak),
              evidence: {
                questions: cap(
                  weak.map((q) => ({
                    question: q.text,
                    firstBlockWords: q.firstBlockWords,
                    sectionWords: q.sectionWords,
                  }))
                ),
              },
            }
          )
        : null;
    }
  ),
  defineRule(
    {
      id: "aeo.unstructured-text",
      category: "aeo",
      severity: "info",
      description:
        "A long page (600+ words) has no subheadings, lists or tables.",
      recommendation:
        "Break the text into sections under descriptive subheadings, and use lists or tables for steps, options and comparisons, so answer engines can lift one self-contained passage.",
    },
    ({ page }, make) =>
      page.wordCount >= 600 &&
      !page.headings.some((h) => h.level >= 2) &&
      page.answer.lists === 0 &&
      page.answer.tables === 0
        ? make(
            `Page has ${page.wordCount} words without subheadings, lists or tables.`,
            {
              fix: [
                addHtml(
                  "p",
                  `<h2>${slot("what the next part covers")}</h2>`,
                  "Before each paragraph that starts a new topic (every 150-300 words), an <h2> that names it. Put steps, options and comparisons in <ol>, <ul> or <table>."
                ),
              ],
              evidence: { wordCount: page.wordCount },
            }
          )
        : null
  ),
  defineRule(
    {
      id: "aeo.schema-text-not-visible",
      category: "aeo",
      severity: "warning",
      description:
        "FAQPage, QAPage or HowTo structured data holds questions, answers or steps that are not in the page's HTML text.",
      recommendation:
        "Mark up only what the page shows: render every question, answer and step from the same data as the JSON-LD, or remove the items that are not on the page. Google's structured data guidelines forbid marking up content readers cannot see. If the page adds them with JavaScript, render them on the server too: most AI crawlers do not run JavaScript.",
      docs: AEO_DOCS.structuredDataPolicies,
    },
    ({ page }, make) => {
      if (page.wordCount === 0) {
        return null;
      }

      const texts = markedUpTexts(page);

      if (!texts.length) {
        return null;
      }

      const visible = ` ${comparable(page.text)} `;

      // Compare the first words only: answers and steps are often longer, or formatted, on the page.
      const hidden = texts.filter((t) => {
        const words = comparable(stripTags(t.text))
          .split(" ")
          .slice(0, 12)
          .join(" ");

        return words && !visible.includes(` ${words} `);
      });

      return hidden.length
        ? make(
            `${hidden.length} of ${texts.length} marked-up question(s), answer(s) or step(s) do not appear in the page's HTML text.`,
            {
              fix: showMarkedUpFixes(page, texts, new Set(hidden)),
              selector: 'script[type="application/ld+json"]',
              evidence: {
                missing: cap(
                  hidden.map((t) => ({
                    type: t.type,
                    text: t.text.slice(0, 120),
                  }))
                ),
              },
            }
          )
        : null;
    }
  ),
  defineRule(
    {
      id: "aeo.article-author-missing",
      category: "aeo",
      severity: "warning",
      description: "Article structured data names no author.",
      recommendation:
        "Add author as a Person (or Organization) with name and url, the url pointing to an author page. Answer engines weigh who stands behind the content.",
      docs: AEO_DOCS.article,
    },
    ({ page }, make) => {
      const missing = articles(page).filter(({ node }) => hasNoAuthor(node));

      return missing.length
        ? make(
            `${missing[0]?.types[0] ?? "Article"} structured data has no author.`,
            {
              fix: missing.map(({ node, types }) =>
                addProperty(
                  {
                    type: types[0] ?? "Article",
                    microdata: isMicrodata(page, node),
                  },
                  authorProperty,
                  AUTHOR_WRITE
                )
              ),
              selector: 'script[type="application/ld+json"]',
              evidence: { types: cap(missing.flatMap((m) => m.types)) },
            }
          )
        : null;
    }
  ),
  defineRule(
    {
      id: "aeo.article-author-incomplete",
      category: "aeo",
      severity: "info",
      description:
        "The article's author is a bare name, without a url or sameAs that identifies the person.",
      recommendation:
        'Write the author as {"@type": "Person", "name": ..., "url": ...}, with url pointing to an author page, and sameAs listing the person\'s profiles where they exist.',
      docs: AEO_DOCS.article,
    },
    ({ page }, make) => {
      const bare = bareAuthors(page);
      const names = bare.map((a) => a.name);

      return bare.length
        ? make(
            `Article author ${names.map((n) => `"${n}"`).join(", ")} has no url or sameAs.`,
            {
              fix: bare.flatMap(authorUrlFix),
              selector: 'script[type="application/ld+json"]',
              evidence: { authors: cap(names) },
            }
          )
        : null;
    }
  ),
  defineRule(
    {
      id: "aeo.article-dates-missing",
      category: "aeo",
      severity: "warning",
      description:
        "Article structured data lacks datePublished (warning) or dateModified (info), which tell answer engines how fresh the content is.",
      recommendation:
        "Add datePublished and dateModified in ISO 8601 (2026-03-14T09:30:00+01:00), and update dateModified when the content changes materially.",
      docs: AEO_DOCS.article,
    },
    ({ page }, make) => {
      const [article] = articles(page);

      if (!article) {
        return null;
      }

      const missing = ["datePublished", "dateModified"].filter((p) => {
        const value = article.node[p];

        return !(isString(value) && value.trim());
      });

      if (!missing.length) {
        return null;
      }

      return make(
        `${article.types[0] ?? "Article"} structured data has no ${missing.join(" or ")}.`,
        {
          severity: missing.includes("datePublished") ? "warning" : "info",
          fix: missing.map((property) => {
            const { hint, write } = DATE_PROPERTY.get(property) ?? {
              hint: "YYYY-MM-DD",
              write: "A date in ISO 8601.",
            };

            return addProperty(
              {
                type: article.types[0] ?? "Article",
                microdata: isMicrodata(page, article.node),
              },
              {
                json: `"${property}": "${slot(hint)}"`,
                microdata: `<meta itemprop="${property}" content="${slot(hint)}">`,
              },
              write
            );
          }),
          selector: 'script[type="application/ld+json"]',
          evidence: { missing },
        }
      );
    }
  ),
  defineRule(
    {
      id: "aeo.article-date-not-visible",
      category: "aeo",
      severity: "info",
      description:
        "The article's structured data has a date, but the page shows none.",
      recommendation:
        "Show the publish or update date near the title, matching the structured data; a <time datetime> element works well. Readers and answer engines use it to judge freshness.",
      docs: AEO_DOCS.dates,
    },
    ({ page }, make) => {
      const [article] = articles(page);

      if (!article || page.wordCount === 0) {
        return null;
      }

      const years = [
        yearOf(article.node["datePublished"]),
        yearOf(article.node["dateModified"]),
      ].filter((y): y is string => y !== null);

      if (
        !years.length ||
        page.answer.timeElements > 0 ||
        page.answer.mentionsDate ||
        years.some((y) => page.text.includes(y))
      ) {
        return null;
      }

      const date = articleDate(article.node);
      const h1 = page.headings.findIndex((h) => h.level === 1);

      return make(
        "Article has a date in its structured data, but none on the page.",
        {
          fix: [
            addAfter(
              page.markup.headings[h1] ?? null,
              h1 === -1 ? "body" : "h1",
              `<p><time datetime="${escapeAttribute(date)}">${slot("the date for readers")}</time></p>`,
              `${JSON.stringify(date)} written the way the page writes dates (14 March 2026), next to the title or byline, after a word such as "Published" or "Updated".`
            ),
          ],
          evidence: {
            datePublished: article.node["datePublished"] ?? null,
            dateModified: article.node["dateModified"] ?? null,
          },
        }
      );
    }
  ),
  defineRule(
    {
      id: "aeo.organization-missing",
      category: "aeo",
      severity: "info",
      description:
        "The home page has no Organization (or Person) structured data.",
      recommendation:
        "Add Organization JSON-LD to the home page (name, url, logo, and sameAs links to official profiles) so answer engines can tie the site to a known entity. Use Person for a personal site.",
      docs: AEO_DOCS.organization,
    },
    ({ page, source }, make) =>
      source !== "html" &&
      isHomePage(page.url) &&
      page.wordCount > 0 &&
      !typedNodes(page.structuredData).some(isEntity)
        ? make("Home page has no Organization or Person structured data.", {
            fix: [organizationFix(page)],
          })
        : null
  ),
  defineRule(
    {
      id: "aeo.entity-same-as-missing",
      category: "aeo",
      severity: "info",
      description:
        "Organization or Person structured data has no sameAs links to the entity's profiles elsewhere.",
      recommendation:
        "Add sameAs with the URLs of the entity's official profiles (Wikipedia, Wikidata, LinkedIn, social accounts) so answer engines can match it to the entity they know.",
      docs: AEO_DOCS.organization,
    },
    ({ page }, make) => {
      const bare = typedNodes(page.structuredData).filter(
        (n) => n.topLevel && isEntity(n) && n.node["sameAs"] === undefined
      );

      return bare.length
        ? make(
            `${bare[0]?.types[0] ?? "Organization"} "${nameOf(bare[0]?.node["name"]) ?? "unnamed"}" has no sameAs links.`,
            {
              fix: bare.map((n) => {
                const name = nameOf(n.node["name"]);

                return addProperty(
                  {
                    type: n.types[0] ?? "Organization",
                    name,
                    microdata: isMicrodata(page, n.node),
                  },
                  {
                    json: `"sameAs": ["${slot("URL of an official profile")}", "${slot("URL of another profile")}"]`,
                    microdata: `<link itemprop="sameAs" href="${slot("URL of an official profile")}">`,
                  },
                  `The URLs of ${name ?? "the entity"}'s official profiles: Wikipedia, Wikidata, LinkedIn, social accounts. List as many as exist; drop the second slot if there is only one.`
                );
              }),
              selector: 'script[type="application/ld+json"]',
              evidence: {
                entities: cap(
                  bare.map((n) => ({
                    type: n.types[0],
                    name: nameOf(n.node["name"]),
                  }))
                ),
              },
            }
          )
        : null;
    }
  ),
];
