/**
 * The shape of a shared report someone uploads (src/core/share.ts), checked before the website
 * keeps it and again before it renders it. An upload is anyone's JSON: the report renderer puts some
 * values in a page without `esc`, such as a score, a count, a severity in a class name or a status,
 * and they are safe only as the numbers and names the audit gives. So every value here has its
 * type, and every key the schemas do not name is dropped: the renderer only ever reads what passed.
 *
 * The schemas mirror src/core/types.ts, less what the website's report never shows (Lighthouse,
 * rendering, a re-check's baseline). The type checks at the end fail the build when an audit type
 * gains a key these lack, and hosted/test/shared-report.test.ts renders real audits both ways.
 */
import { z } from "zod";

import type {
  AeoAudit,
  Finding,
  PageAudit,
  SiteAudit,
} from "../../src/core/types.js";

const text = z.string();
const maybeText = z.string().nullable();
const count = z.number().int().min(0);
const maybeCount = count.nullable();
const score = z.number().min(0).max(100);
const texts = z.array(text);

const Severity = z.enum(["error", "warning", "info"]);

const Category = z.enum([
  "title",
  "meta",
  "headings",
  "canonical",
  "indexing",
  "document",
  "social",
  "images",
  "links",
  "international",
  "structured-data",
  "content",
  "keyword",
  "response",
  "rendering",
  "performance",
  "site",
  "aeo",
  "tool",
]);

const Counts = z.object({ error: count, warning: count, info: count });

const FixEdit = z.object({
  in: z.enum(["html", "http", "robots.txt", "sitemap", "llms.txt", "asset"]),
  action: z.enum(["add", "replace", "remove"]),
  url: text.optional(),
  at: text.optional(),
  current: text.optional(),
  code: text.optional(),
  write: text.optional(),
});

const FindingSchema = z.object({
  rule: text,
  severity: Severity,
  category: Category,
  message: text,
  recommendation: text,
  fix: z.array(FixEdit).optional(),
  selector: text.optional(),
  // Free-form JSON, which the report prints as JSON text through `esc`.
  evidence: z.record(z.string(), z.unknown()).optional(),
  docs: text.optional(),
  url: text.optional(),
  id: text.optional(),
});

const Heading = z.object({ level: count, text });

const ResponseInfo = z.object({
  status: maybeCount,
  finalUrl: text,
  redirectChain: z.array(z.object({ url: text, status: count })),
  timeMs: z.number().min(0).nullable(),
  contentType: maybeText,
  headers: z.record(z.string(), text),
  error: text.optional(),
  truncated: z.boolean().optional(),
});

const PageSummary = z.object({
  title: maybeText,
  titleLength: count,
  metaDescription: maybeText,
  metaDescriptionLength: count,
  canonical: maybeText,
  lang: maybeText,
  robots: texts,
  indexable: z.boolean(),
  h1: texts,
  headings: z.array(Heading),
  wordCount: count,
  images: z.object({ total: count, missingAlt: count }),
  links: z.object({ internal: count, external: count, nofollow: count }),
  openGraph: z.record(z.string(), text),
  twitterCard: maybeText,
  structuredDataTypes: texts,
  hreflangCount: count,
});

const FieldMetric = z.object({
  p75: z.number().min(0),
  good: z.number().min(0).max(1),
  needsImprovement: z.number().min(0).max(1),
  poor: z.number().min(0).max(1),
});

const FieldDataSchema = z.union([
  z.object({
    source: z.enum(["url", "origin"]),
    formFactor: z.literal("PHONE"),
    period: z.object({ firstDate: text, lastDate: text }),
    lcpMs: FieldMetric.nullable(),
    inpMs: FieldMetric.nullable(),
    cls: FieldMetric.nullable(),
    fcpMs: FieldMetric.nullable(),
    ttfbMs: FieldMetric.nullable(),
  }),
  z.object({
    source: z.null(),
    reason: z.enum(["no-data", "not-public", "unavailable"]),
    message: text,
  }),
]);

const auditedAt = z.string().datetime({ offset: true });

const PageAuditSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("page"),
  target: text,
  url: text,
  source: z.enum(["url", "file", "html"]),
  auditedAt,
  response: ResponseInfo.optional(),
  summary: PageSummary,
  findings: z.array(FindingSchema),
  counts: Counts,
  score,
  fieldData: FieldDataSchema.optional(),
  depth: count.optional(),
});

const Examples = z.object({ count, examples: texts });

const SiteAuditSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("site"),
  target: text,
  source: z.enum(["crawl", "directory"]),
  auditedAt,
  crawl: z.object({
    pagesCrawled: count,
    pagesDiscovered: count,
    linksChecked: count,
    maxPages: count,
    maxDepth: count,
    hitPageLimit: z.boolean(),
    durationMs: z.number().min(0),
    respectedRobots: z.boolean(),
  }),
  robotsTxt: z
    .object({
      url: text,
      status: maybeCount,
      found: z.boolean(),
      sitemaps: texts,
      text: maybeText,
      bytes: maybeCount,
      error: text.optional(),
    })
    .nullable(),
  sitemaps: z.object({
    sources: texts,
    urls: texts,
    urlCount: count,
    errors: texts,
    problems: z.object({
      oversized: z.array(
        z.object({
          sitemap: text,
          urls: maybeCount,
          bytes: maybeCount,
          overLimit: z.boolean(),
        })
      ),
      nestedIndexes: texts,
      invalidLastmod: Examples,
      futureLastmod: Examples,
      otherHost: Examples,
    }),
  }),
  pages: z.array(PageAuditSchema),
  siteFindings: z.array(FindingSchema),
  issues: z.array(
    z.object({
      rule: text,
      severity: Severity,
      category: Category,
      pages: count,
      message: text,
      recommendation: text,
      examples: texts,
    })
  ),
  counts: Counts,
  score,
});

const Purpose = z.enum(["search", "answer", "training"]);

const AeoPageSummary = z.object({
  indexable: z.boolean(),
  googleSnippets: z.enum(["allowed", "limited", "blocked"]),
  copilotAnswers: z.enum(["allowed", "snippet-only", "excluded"]),
  wordCount: count,
  questions: count,
  structuredDataTypes: texts,
  author: maybeText,
  datePublished: maybeText,
  dateModified: maybeText,
});

const TrainingPreference = z.enum(["allowed", "disallowed", "none"]);

const AeoAuditSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("aeo"),
  target: text,
  url: text,
  source: z.enum(["url", "file", "html", "crawl", "directory"]),
  score,
  counts: Counts,
  auditedAt,
  summary: z.object({
    pages: count,
    robotsTxt: z.enum(["found", "missing", "unreachable"]).nullable(),
    searchCrawlersBlocked: texts,
    answerBotsBlocked: texts,
    trainingBotsBlocked: texts,
    trainingPreference: TrainingPreference.nullable(),
    blockedByServer: texts.nullable(),
    llmsTxt: z.enum(["found", "missing", "invalid"]).nullable(),
    page: AeoPageSummary.nullable(),
  }),
  findings: z.array(FindingSchema),
  crawlers: z
    .object({
      robotsTxt: text,
      status: z.enum(["found", "missing", "unreachable"]),
      httpStatus: maybeCount,
      trainingPreference: TrainingPreference,
      contentSignals: z.array(
        z.object({
          userAgents: texts,
          path: maybeText,
          signals: z.record(z.string(), text),
        })
      ),
      bots: z.array(
        z.object({
          name: text,
          operator: text,
          purpose: Purpose,
          usedFor: text,
          robotsGroup: z.enum(["named", "googlebot", "wildcard", "none"]),
          allowed: z.boolean(),
          blockedPages: count,
          probe: z
            .object({
              status: maybeCount,
              blocked: z.boolean(),
              reason: maybeText,
            })
            .optional(),
        })
      ),
      probeBaseline: z
        .object({ userAgent: text, status: maybeCount })
        .optional(),
    })
    .nullable(),
  llmsTxt: z
    .object({
      url: text,
      status: z.enum(["found", "missing", "invalid"]),
      httpStatus: maybeCount,
      title: maybeText,
      summary: maybeText,
      sections: texts,
      links: count,
      bytes: count,
      problems: texts,
    })
    .nullable(),
  pages: z
    .array(
      z.object({
        url: text,
        depth: count.optional(),
        score,
        counts: Counts,
        summary: AeoPageSummary,
      })
    )
    .optional(),
  issues: SiteAuditSchema.shape.issues.optional(),
});

/** What an upload is: a page's two audits, or a site's with its start page's. */
export const SharedReportSchema = z.discriminatedUnion("kind", [
  z.object({
    schemaVersion: z.literal(1),
    kind: z.literal("page"),
    seo: PageAuditSchema,
    // A page's AEO audit is of the page too, so the report never shows a site's under a page.
    aeo: AeoAuditSchema.extend({ source: z.enum(["url", "file", "html"]) }),
  }),
  z.object({
    schemaVersion: z.literal(1),
    kind: z.literal("site"),
    seo: SiteAuditSchema,
    aeo: AeoAuditSchema.extend({ source: z.enum(["crawl", "directory"]) }),
    start: z.object({ seo: PageAuditSchema, aeo: AeoAuditSchema }).nullable(),
  }),
]);

export type CheckedReport = z.infer<typeof SharedReportSchema>;

// The schemas name every key of the audit types but those the report leaves out, with the same
// types: a key added to src/core/types.ts fails the build here until the schema has it too.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

type SameKeys<A, B> = Same<keyof A, keyof B>;

type Shown<T> = Omit<T, "performance" | "rendering" | "baseline">;

const checks: [
  Same<z.infer<typeof FindingSchema>, Finding>,
  SameKeys<z.infer<typeof FindingSchema>, Finding>,
  Same<z.infer<typeof PageAuditSchema>, Shown<PageAudit>>,
  SameKeys<z.infer<typeof PageAuditSchema>, Shown<PageAudit>>,
  Same<z.infer<typeof SiteAuditSchema>, Shown<SiteAudit>>,
  SameKeys<z.infer<typeof SiteAuditSchema>, Shown<SiteAudit>>,
  Same<z.infer<typeof AeoAuditSchema>, Shown<AeoAudit>>,
  SameKeys<z.infer<typeof AeoAuditSchema>, Shown<AeoAudit>>,
] = [true, true, true, true, true, true, true, true];

void checks;
