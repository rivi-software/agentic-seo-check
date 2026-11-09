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
  parseRobotsHeader,
  stripTags,
  typedNodes,
} from "../aeo/page.js";
import { isJsonObject, isString } from "../html/structured-data.js";
import type { JsonValue } from "../html/structured-data.js";
import { robotsDirectives } from "./indexing.js";
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
          evidence: { error: response.error },
        });
      }

      return response.status !== null && response.status >= 400
        ? make(`The page answers HTTP ${response.status}.`, {
            evidence: { status: response.status },
          })
        : null;
    }
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
            { evidence: { maxSnippet: limit } }
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
        { selector: metaSelector(sources), evidence: { sources } }
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
            "Page sets nocache, so Copilot may use only its URL, title and snippet."
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
            { selector: metaSelector(sources), evidence: { sources } }
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
      const { nosnippetWords, nosnippetElements, nosnippetSelectors } =
        page.answer;

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

      return make(
        `The HTML has ${page.wordCount} words of text and ${shell}. GPTBot, OAI-SearchBot, ClaudeBot and PerplexityBot do not run JavaScript, so they see an empty page.`,
        {
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
      const weak = page.answer.questions.filter(
        (q) =>
          q.sectionWords === 0 ||
          (q.firstBlockWords ?? q.sectionWords) > LONG_ANSWER_WORDS
      );

      return weak.length
        ? make(
            `${weak.length} of ${page.answer.questions.length} question heading(s) are not followed by a short direct answer.`,
            {
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
            { evidence: { wordCount: page.wordCount } }
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
      const missing = articles(page).filter(({ node }) => {
        const { author } = node;

        return (
          author === undefined ||
          author === null ||
          (Array.isArray(author) && author.length === 0) ||
          (isString(author) && !author.trim())
        );
      });

      return missing.length
        ? make(
            `${missing[0]?.types[0] ?? "Article"} structured data has no author.`,
            {
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
      const bare = articles(page).flatMap(({ node }) => {
        const authors = Array.isArray(node["author"])
          ? node["author"]
          : [node["author"]];

        return authors.flatMap((a) => {
          if (isString(a) && a.trim()) {
            return [a.trim()];
          }

          if (
            isJsonObject(a) &&
            a["url"] === undefined &&
            a["sameAs"] === undefined
          ) {
            return [nameOf(a) ?? "(unnamed author)"];
          }

          return [];
        });
      });

      return bare.length
        ? make(
            `Article author ${bare.map((n) => `"${n}"`).join(", ")} has no url or sameAs.`,
            {
              selector: 'script[type="application/ld+json"]',
              evidence: { authors: cap(bare) },
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

      return make(
        "Article has a date in its structured data, but none on the page.",
        {
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
        ? make("Home page has no Organization or Person structured data.")
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
