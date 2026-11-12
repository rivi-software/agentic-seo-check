/**
 * A page beside one to five competitors' pages (issue #129). Each page is requested once and both
 * audits read it, and each site's robots.txt and llms.txt are read once. What sets the pages apart
 * is read the same way on each (`signals`); what at least half of the competitors have and the page
 * lacks is a gap, with the fix of the rule that closes it on this page, and the reverse a lead. A gap
 * is no finding: a competitor's FAQ markup is no defect on this page. The caller brings the
 * competitors; the tool searches for none.
 */
import { auditAeoRecord, loadOriginFiles } from "./aeo/audit.js";
import type { OriginFiles } from "./aeo/audit.js";
import { articles } from "./aeo/page.js";
import { auditPageRecord } from "./audit.js";
import type { ProgressEvent } from "./audit.js";
import { mapConcurrent } from "./concurrency.js";
import { ExpectedError } from "./errors.js";
import {
  fetchPage,
  forAuditOf,
  RequestRefusedError,
  toResponseInfo,
} from "./fetch.js";
import type { FetchOptions, FetchResult } from "./fetch.js";
import {
  CORE_VITALS,
  FIELD_LABELS,
  fieldBand,
  fieldDataOptions,
  fieldValue,
  isFieldRecord,
} from "./field-data.js";
import type { FieldDataOptions } from "./field-data.js";
import { extractPage } from "./html/extract.js";
import { includesKeyword, keywordOccurrences } from "./html/text.js";
import { insertBefore } from "./recheck.js";
import { answersFirst, bareAuthors, hasNoAuthor } from "./rules/aeo.js";
import { cap } from "./rules/rule.js";
import type { PageRecord } from "./site-rules.js";
import type {
  AeoAudit,
  ComparedPage,
  Comparison,
  ComparisonGap,
  ComparisonLead,
  ExtractedPage,
  Finding,
  PageAudit,
  PageSignals,
  SkippedPage,
} from "./types.js";
import { isHttpUrl } from "./url.js";

/** The most competitors one comparison takes. */
export const MAX_COMPETITORS = 5;

/** Competitors' pages read at a time, once the page itself has answered. */
const CONCURRENCY = 3;

/** The longest title or `<h1>` a compared page lists: they are another site's text. */
const MAX_TEXT = 200;

export interface CompareOptions {
  /** Whether each page has this phrase in its title, `<h1>`, meta description and text. */
  keyword?: string;
  /** Each page's Core Web Vitals of real visits on phones, from the Chrome UX Report (issue #130). */
  fieldData?: boolean | FieldDataOptions;
  /**
   * How to send the requests. The user's `headers` go to the page's own origin alone, never to a
   * competitor's.
   */
  fetch?: FetchOptions;
  onProgress?: (event: ProgressEvent) => void;
}

/** A page that was read: its entry, and both audits' findings, which hold the fixes of its gaps. */
interface ReadPage {
  entry: ComparedPage;
  findings: Finding[];
}

type Role = ComparedPage["role"];

/**
 * What the competitors are, in the order given: each once, and never the page itself. Throws when
 * none is left, or more than MAX_COMPETITORS, so a server can check a call before it counts.
 */
export const competitorsOf = (
  url: string,
  competitors: readonly string[]
): string[] => {
  for (const target of [url, ...competitors]) {
    if (!isHttpUrl(target)) {
      throw new ExpectedError(
        `"${target}" is not an http(s) URL: a comparison reads live pages.`
      );
    }
  }

  const seen = new Set([new URL(url).href]);
  const list: string[] = [];

  for (const competitor of competitors) {
    const key = new URL(competitor).href;

    if (!seen.has(key)) {
      seen.add(key);
      list.push(competitor);
    }
  }

  if (list.length === 0) {
    throw new ExpectedError(
      "Name at least one competitor's page other than the page itself."
    );
  }

  if (list.length > MAX_COMPETITORS) {
    throw new ExpectedError(
      `Compare with at most ${MAX_COMPETITORS} competitors' pages; ${list.length} were given.`
    );
  }

  return list;
};

/** Why a page that was fetched cannot be compared, or null when it can. */
const unreadable = (
  url: string,
  res: FetchResult
): SkippedPage["skipped"] | null => {
  if (res.status === null) {
    return {
      reason: "unreachable",
      message: `${url} did not answer${res.error ? `: ${res.error}` : ""}.`,
    };
  }

  return res.status >= 400
    ? { reason: "http-error", message: `${url} answered HTTP ${res.status}.` }
    : null;
};

const cut = (text: string | null | undefined): string | null =>
  text ? text.slice(0, MAX_TEXT) : null;

/**
 * Who the page's Article markup names as its author, as the aeo.article-author-* rules read it:
 * `none` for no Article, or one without an author, and `name` for an author without url or sameAs.
 */
const authorOf = (page: ExtractedPage): PageSignals["author"] => {
  const list = articles(page);

  if (list.length === 0 || list.some(({ node }) => hasNoAuthor(node))) {
    return "none";
  }

  return bareAuthors(page).length > 0 ? "name" : "linked";
};

/** The Article's dates as the AEO audit's summary read them, and a date the page shows. */
const datesOf = (page: ExtractedPage, aeo: AeoAudit): PageSignals["dates"] => ({
  published: Boolean(aeo.summary.page?.datePublished),
  modified: Boolean(aeo.summary.page?.dateModified),
  visible: page.answer.timeElements > 0 || page.answer.mentionsDate,
});

const aiBotsOf = (aeo: AeoAudit): PageSignals["aiBots"] => {
  const { crawlers } = aeo;

  if (!crawlers || crawlers.status === "unreachable") {
    return null;
  }

  const allowed = crawlers.bots.filter((b) => b.allowed).length;

  return {
    allowed,
    blocked: crawlers.bots.length - allowed,
    searchCrawlersBlocked: aeo.summary.searchCrawlersBlocked,
    answerBotsBlocked: aeo.summary.answerBotsBlocked,
  };
};

const coreWebVitalsOf = (
  seo: PageAudit
): NonNullable<PageSignals["coreWebVitals"]> | null => {
  const field = seo.fieldData;

  return isFieldRecord(field)
    ? {
        lcpMs: field.lcpMs?.p75 ?? null,
        inpMs: field.inpMs?.p75 ?? null,
        cls: field.cls?.p75 ?? null,
      }
    : null;
};

const signalsOf = (
  record: PageRecord,
  audits: { seo: PageAudit; aeo: AeoAudit },
  options: { keyword: string | undefined; fieldData: boolean }
): PageSignals => {
  const { page, response } = record;
  const { questions } = page.answer;
  const { keyword } = options;

  let signals: PageSignals = {
    words: page.wordCount,
    headings: {
      h2: page.headings.filter((h) => h.level === 2).length,
      questions: questions.length,
      answered: questions.filter(answersFirst).length,
    },
    tables: page.answer.tables,
    lists: page.answer.lists,
    structuredData: [...new Set(page.structuredData.flatMap((i) => i.types))],
    author: authorOf(page),
    dates: datesOf(page, audits.aeo),
    aiBots: aiBotsOf(audits.aeo),
    llmsTxt: audits.aeo.llmsTxt ? audits.aeo.llmsTxt.status === "found" : null,
    responseMs: response?.timeMs ?? null,
    htmlKb: Math.round(page.htmlBytes / 1024),
  };

  if (keyword !== undefined) {
    // Beside the page's other text signals, where a reader looks for it.
    signals = insertBefore(signals, "aiBots", "keywordIn", {
      title: includesKeyword(page.title, keyword),
      h1: page.h1s.some((h) => includesKeyword(h, keyword)),
      description: includesKeyword(page.metaDescription, keyword),
      body: keywordOccurrences(page.text, keyword) > 0,
    });
  }

  if (options.fieldData) {
    signals.coreWebVitals = coreWebVitalsOf(audits.seo);
  }

  return signals;
};

/* ---------------------------------------------------------------------------
 * Gaps and leads
 * ------------------------------------------------------------------------- */

/** One signal two pages are compared on. */
interface Check {
  signal: string;
  type?: string;
  /** What the better page has, as a message starts. */
  label: string;
  /** The signal is the site's, not the page's: robots.txt and llms.txt. */
  site?: boolean;
  /** Whether `a` has what `b` lacks; false when either page's value was not read. */
  ahead: (a: PageSignals, b: PageSignals) => boolean;
  /** A page's value, shown beside the pages a message names when it says more than the label. */
  value?: (s: PageSignals) => string | undefined;
  /** The rules whose findings on the page close the gap. */
  rules: readonly string[];
}

const count = (n: number): string => n.toLocaleString("en-US");

/** The search crawlers and answer bots robots.txt keeps out: training bots are the owner's choice. */
export const keptOut = (s: PageSignals): string[] | null =>
  s.aiBots
    ? [...s.aiBots.searchCrawlersBlocked, ...s.aiBots.answerBotsBlocked]
    : null;

/** A rank where a lower number is better: good, needs improvement, poor. */
const BAND_RANK = { good: 0, "needs improvement": 1, poor: 2 } as const;

type Vital = (typeof CORE_VITALS)[number];

const vitalOf = (s: PageSignals, key: Vital): number | null =>
  s.coreWebVitals?.[key] ?? null;

const vitalChecks = (): Check[] =>
  CORE_VITALS.map((key) => {
    const name = key.replace(/Ms$/u, "");

    return {
      signal: `coreWebVitals.${key}`,
      label: `A better ${FIELD_LABELS[key]} for real visits on phones`,
      ahead: (a, b) => {
        const va = vitalOf(a, key);
        const vb = vitalOf(b, key);

        return (
          va !== null &&
          vb !== null &&
          BAND_RANK[fieldBand(key, va)] < BAND_RANK[fieldBand(key, vb)]
        );
      },
      value: (s) => {
        const v = vitalOf(s, key);

        return v === null
          ? undefined
          : `${fieldValue(key, v)}, ${fieldBand(key, v)}`;
      },
      rules: [
        `perf.field-${name}-poor`,
        `perf.field-${name}-needs-improvement`,
      ],
    };
  });

const keywordChecks = (keyword: string): Check[] =>
  (
    [
      ["title", "the title", "keyword.not-in-title"],
      ["h1", "an <h1>", "keyword.not-in-h1"],
      ["description", "the meta description", "keyword.not-in-description"],
      ["body", "the text", "keyword.not-in-body"],
    ] as const
  ).map(([key, where, rule]) => ({
    signal: `keywordIn.${key}`,
    label: `"${keyword}" in ${where}`,
    ahead: (a, b) =>
      a.keywordIn?.[key] === true && b.keywordIn?.[key] === false,
    rules: [rule],
  }));

/** The rules whose fix adds markup of a type, where one does. */
const TYPE_RULES: ReadonlyMap<string, readonly string[]> = new Map([
  ["Organization", ["aeo.organization-missing"]],
  ["WebSite", ["structured-data.site-name-missing"]],
]);

const typeChecks = (pages: readonly PageSignals[]): Check[] =>
  [...new Set(pages.flatMap((s) => s.structuredData))]
    .toSorted()
    .map((type) => ({
      signal: "structuredData",
      type,
      label: `${type} markup`,
      ahead: (a, b) =>
        a.structuredData.includes(type) && !b.structuredData.includes(type),
      rules: TYPE_RULES.get(type) ?? [],
    }));

/** What a page's Article markup leaves out of its dates. */
const missingDates = (s: PageSignals): string[] => [
  ...(s.dates.published ? [] : ["datePublished"]),
  ...(s.dates.modified ? [] : ["dateModified"]),
];

const AUTHOR_VALUE: Record<PageSignals["author"], string | undefined> = {
  none: "none",
  name: "a bare name",
  linked: undefined,
};

/** The signals two pages are compared on, the content first and the site and speed last. */
const checksFor = (
  pages: readonly PageSignals[],
  keyword: string | undefined
): Check[] => [
  {
    signal: "words",
    label: "More text",
    ahead: (a, b) => a.words >= b.words * 1.5 && a.words - b.words >= 200,
    value: (s) => `${count(s.words)} words`,
    rules: ["content.thin"],
  },
  {
    signal: "headings.answered",
    label: "A short answer right under each question heading",
    ahead: (a, b) =>
      a.headings.questions > 0 &&
      a.headings.answered === a.headings.questions &&
      b.headings.answered < b.headings.questions,
    value: (s) =>
      `${s.headings.answered} of ${s.headings.questions} questions answered`,
    rules: ["aeo.question-not-answered-first"],
  },
  {
    signal: "headings.questions",
    label: "Headings phrased as questions",
    ahead: (a, b) => a.headings.questions > 0 && b.headings.questions === 0,
    value: (s) => count(s.headings.questions),
    rules: [],
  },
  {
    signal: "headings.h2",
    label: "<h2> subheadings",
    ahead: (a, b) => a.headings.h2 > 0 && b.headings.h2 === 0,
    value: (s) => count(s.headings.h2),
    rules: ["aeo.unstructured-text"],
  },
  {
    signal: "tables",
    label: "Tables",
    ahead: (a, b) => a.tables > 0 && b.tables === 0,
    value: (s) => count(s.tables),
    rules: [],
  },
  {
    signal: "lists",
    label: "Lists",
    ahead: (a, b) => a.lists > 0 && b.lists === 0,
    value: (s) => count(s.lists),
    rules: [],
  },
  {
    signal: "author",
    label: "An author in the Article markup, with a url or sameAs",
    ahead: (a, b) => a.author === "linked" && b.author !== "linked",
    value: (s) => AUTHOR_VALUE[s.author],
    rules: ["aeo.article-author-missing", "aeo.article-author-incomplete"],
  },
  {
    signal: "dates",
    label: "datePublished and dateModified in the Article markup",
    ahead: (a, b) =>
      (a.dates.published && !b.dates.published) ||
      (a.dates.modified && !b.dates.modified),
    value: (s) => {
      const missing = missingDates(s);

      return missing.length > 0 ? `no ${missing.join(" or ")}` : undefined;
    },
    rules: ["aeo.article-dates-missing"],
  },
  {
    signal: "dates.visible",
    label: "A date the reader sees",
    ahead: (a, b) => a.dates.visible && !b.dates.visible,
    rules: ["aeo.article-date-not-visible"],
  },
  ...typeChecks(pages),
  ...(keyword === undefined ? [] : keywordChecks(keyword)),
  {
    signal: "aiBots",
    label: "Every AI search crawler and answer bot let in by robots.txt",
    site: true,
    ahead: (a, b) => keptOut(a)?.length === 0 && (keptOut(b)?.length ?? 0) > 0,
    value: (s) => {
      const names = keptOut(s) ?? [];

      return names.length > 0 ? `keeps out ${names.join(", ")}` : undefined;
    },
    rules: ["aeo.robots-blocks-search-crawler", "aeo.robots-blocks-answer-bot"],
  },
  {
    signal: "llmsTxt",
    label: "An /llms.txt",
    site: true,
    ahead: (a, b) => a.llmsTxt === true && b.llmsTxt === false,
    rules: ["aeo.llms-txt-missing", "aeo.llms-txt-invalid"],
  },
  {
    signal: "responseMs",
    label: "A faster HTML response, timed from where the comparison ran",
    ahead: (a, b) =>
      a.responseMs !== null &&
      b.responseMs !== null &&
      b.responseMs >= a.responseMs * 2 &&
      b.responseMs - a.responseMs >= 500,
    value: (s) =>
      s.responseMs === null ? undefined : `${count(s.responseMs)} ms`,
    rules: ["response.slow"],
  },
  ...vitalChecks(),
];

/** The pages' values, as " (a; b)", or nothing when the check shows none. */
const valuesOf = (check: Check, pages: readonly ReadPage[]): string => {
  const shown = pages.flatMap((p) => check.value?.(p.entry.signals) ?? []);

  return shown.length > 0 ? ` (${shown.join("; ")})` : "";
};

/** "this page (0)" */
const ownPhrase = (check: Check, page: ReadPage): string =>
  `${check.site ? "this site" : "this page"}${valuesOf(check, [page])}`;

/** "2 of 3 competitors (1; 3)" */
const competitorsPhrase = (
  check: Check,
  pages: readonly ReadPage[],
  of: number
): string =>
  `${pages.length} of ${of} ${check.site ? "competitor site" : "competitor"}${of === 1 ? "" : "s"}${valuesOf(check, pages)}`;

/** The competitors that pass `test`, when at least half of them do: one of one, one of two, two of three. */
const atLeastHalf = (
  competitors: readonly ReadPage[],
  test: (competitor: ReadPage) => boolean
): ReadPage[] | null => {
  const passing = competitors.filter(test);

  return passing.length > 0 &&
    passing.length >= Math.ceil(competitors.length / 2)
    ? passing
    : null;
};

/** The findings on the page that close a gap, and their fix: each rule's edits once, at most 10. */
const closing = (
  check: Check,
  findings: readonly Finding[]
): Pick<ComparisonGap, "rules" | "fix"> => {
  const hits = findings.filter((f) => check.rules.includes(f.rule));

  return {
    rules: [...new Set(hits.map((f) => f.rule))],
    fix: cap(hits.flatMap((f) => f.fix ?? [])),
  };
};

/** What a comparison found: the gaps and the leads, each list most competitors first. */
interface GapsAndLeads {
  gaps: ComparisonGap[];
  leads: ComparisonLead[];
}

/** Most competitors first; the checks' own order between equals. */
const mostFirst = (a: ComparisonLead, b: ComparisonLead): number =>
  b.competitors.length - a.competitors.length;

/** The item, with the check's structured data type before its message where it has one. */
const withType = <T extends ComparisonLead>(item: T, check: Check): T =>
  check.type === undefined
    ? item
    : insertBefore(item, "message", "type", check.type);

const urlsOf = (pages: readonly ReadPage[]): string[] =>
  pages.map((p) => p.entry.url);

const gapsAndLeads = (
  page: ReadPage,
  competitors: readonly ReadPage[],
  keyword: string | undefined
): GapsAndLeads => {
  const gaps: ComparisonGap[] = [];
  const leads: ComparisonLead[] = [];
  const mine = page.entry.signals;
  const of = competitors.length;

  const checks = checksFor(
    [mine, ...competitors.map((c) => c.entry.signals)],
    keyword
  );

  for (const check of checks) {
    const haves = atLeastHalf(competitors, (c) =>
      check.ahead(c.entry.signals, mine)
    );

    if (haves) {
      gaps.push(
        withType(
          {
            signal: check.signal,
            message: `${check.label}: ${competitorsPhrase(check, haves, of)}, not ${ownPhrase(check, page)}.`,
            competitors: urlsOf(haves),
            ...closing(check, page.findings),
          },
          check
        )
      );

      // A signal that is a gap is never also a lead, as one of two competitors can make it both.
      continue;
    }

    const lacks = atLeastHalf(competitors, (c) =>
      check.ahead(mine, c.entry.signals)
    );

    if (lacks) {
      leads.push(
        withType(
          {
            signal: check.signal,
            message: `${check.label}: ${ownPhrase(check, page)}, not ${competitorsPhrase(check, lacks, of)}.`,
            competitors: urlsOf(lacks),
          },
          check
        )
      );
    }
  }

  return { gaps: gaps.toSorted(mostFirst), leads: leads.toSorted(mostFirst) };
};

/* ---------------------------------------------------------------------------
 * Reading the pages
 * ------------------------------------------------------------------------- */

interface Reader {
  keyword: string | undefined;
  fieldData: FieldDataOptions | undefined;
  fetch: FetchOptions;
  onProgress: CompareOptions["onProgress"];
  /** Each site's robots.txt and llms.txt, read once. */
  origins: Map<string, Promise<OriginFiles>>;
}

const filesOf = (
  reader: Reader,
  pageUrl: string,
  fetch: FetchOptions
): Promise<OriginFiles> => {
  const { origin } = new URL(pageUrl);
  let pending = reader.origins.get(origin);

  if (!pending) {
    pending = loadOriginFiles(pageUrl, {
      fetch,
      onProgress: reader.onProgress,
    });
    reader.origins.set(origin, pending);
  }

  return pending;
};

/** A page that answered as a page, and the fetch options its other requests go with. */
interface Fetched {
  url: string;
  role: Role;
  res: FetchResult;
  fetch: FetchOptions;
}

/**
 * Requests one page, or says why it cannot be compared. A request the hosted server's gate refuses
 * throws, as a RequestRefusedError.
 */
const fetchFor = async (
  url: string,
  role: Role,
  reader: Reader
): Promise<Fetched | SkippedPage["skipped"]> => {
  // The user's headers are for the page's own origin; a competitor gets none.
  const fetch: FetchOptions =
    role === "page"
      ? forAuditOf(reader.fetch, url)
      : { ...reader.fetch, headers: undefined, headersOrigin: undefined };

  reader.onProgress?.({ phase: "compare", message: `Reading ${url}` });

  const res = await fetchPage(url, fetch);

  return unreadable(url, res) ?? { url, role, res, fetch };
};

/**
 * Both audits of a page that was fetched, its signals, and for the page itself the findings that
 * hold its gaps' fixes. The SEO audit needs no robots.txt or llms.txt, so it runs while they load.
 */
const auditFetched = async (
  { url, role, res, fetch }: Fetched,
  reader: Reader
): Promise<ReadPage> => {
  const record: PageRecord = {
    url: res.finalUrl,
    requestedUrl: url,
    page: extractPage(res.body ?? "", { url: res.finalUrl }),
    response: toResponseInfo(res),
    depth: 0,
  };

  const [seo, aeo] = await Promise.all([
    auditPageRecord(record, {
      keyword: reader.keyword,
      fieldData: reader.fieldData,
      fetch,
    }),
    filesOf(reader, res.finalUrl, fetch).then(
      async (files) => await auditAeoRecord(record, files, { fetch })
    ),
  ]);

  let entry: ComparedPage = {
    url,
    role,
    title: cut(record.page.title),
    h1: cut(record.page.h1s[0]),
    score: { seo: seo.score, aeo: aeo.score },
    signals: signalsOf(
      record,
      { seo, aeo },
      { keyword: reader.keyword, fieldData: reader.fieldData !== undefined }
    ),
  };

  if (res.finalUrl !== new URL(url).href) {
    entry = insertBefore(entry, "title", "finalUrl", res.finalUrl);
  }

  return {
    entry,
    // Only the page's own findings close a gap.
    findings: role === "page" ? [...seo.findings, ...aeo.findings] : [],
  };
};

const isRead = (outcome: ReadPage | SkippedPage): outcome is ReadPage =>
  "entry" in outcome;

/**
 * A competitor's page, or why it is left out of the gaps: robots.txt, the site or a limit refused
 * the request, and no other way round that is tried, or the page did not answer as a page.
 */
const readCompetitor = async (
  url: string,
  reader: Reader
): Promise<ReadPage | SkippedPage> => {
  try {
    const fetched = await fetchFor(url, "competitor", reader);

    return "res" in fetched
      ? await auditFetched(fetched, reader)
      : { url, role: "competitor", skipped: fetched };
  } catch (error) {
    if (error instanceof RequestRefusedError) {
      return {
        url,
        role: "competitor",
        skipped: { reason: "refused", message: error.message },
      };
    }

    throw error;
  }
};

/**
 * Compares a page with one to five competitors' pages: both audits of each, their signals, and the
 * gaps and leads. The page is requested first, so a page that cannot be read costs no competitor a
 * request; a competitor that cannot be read is listed with why and left out of the gaps.
 */
export const comparePages = async (
  url: string,
  competitors: readonly string[],
  options: CompareOptions = {}
): Promise<Comparison> => {
  const list = competitorsOf(url, competitors);
  const keyword = options.keyword?.trim() || undefined;

  const reader: Reader = {
    keyword,
    // The key is read before any request, so its absence fails the comparison at once.
    fieldData: fieldDataOptions(options.fieldData),
    fetch: options.fetch ?? {},
    onProgress: options.onProgress,
    origins: new Map(),
  };

  const fetched = await fetchFor(url, "page", reader);

  if (!("res" in fetched)) {
    throw new ExpectedError(
      `${fetched.message} There is nothing to compare: audit the page on its own to see why.`
    );
  }

  // The page answered: its audits and the competitors' requests go on together.
  const [own, others] = await Promise.all([
    auditFetched(fetched, reader),
    mapConcurrent(
      list,
      CONCURRENCY,
      async (competitor) => await readCompetitor(competitor, reader)
    ),
  ]);

  const { gaps, leads } = gapsAndLeads(own, others.filter(isRead), keyword);

  const comparison: Comparison = {
    schemaVersion: 1,
    kind: "comparison",
    url,
    auditedAt: new Date().toISOString(),
    pages: [own.entry, ...others.map((o) => (isRead(o) ? o.entry : o))],
    gaps,
    leads,
  };

  return keyword === undefined
    ? comparison
    : insertBefore(comparison, "auditedAt", "keyword", keyword);
};

/**
 * What a report says when no competitor could be read: no gap then means nothing was compared,
 * never that the page has what its competitors have.
 */
export const NOTHING_COMPARED =
  "Nothing was compared: no competitor's page could be read.";

/** How many competitors a comparison named, and how many of them it read. */
export interface CompetitorCounts {
  of: number;
  read: number;
}

export const competitorCounts = (comparison: Comparison): CompetitorCounts => {
  const named = comparison.pages.filter((p) => p.role === "competitor");

  return { of: named.length, read: named.filter((p) => "signals" in p).length };
};

/** Drops bulky detail to save tokens when an LLM reads the result: long lists of types. */
export const compactComparison = (comparison: Comparison): Comparison => ({
  ...comparison,
  pages: comparison.pages.map((p) =>
    "signals" in p
      ? {
          ...p,
          signals: {
            ...p.signals,
            structuredData: p.signals.structuredData.slice(0, 10),
          },
        }
      : p
  ),
});
