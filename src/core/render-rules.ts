import {
  canonicalFix,
  consoleErrorFix,
  contentFix,
  descriptionFix,
  h1Fix,
  linksFix,
  noindexAddedFix,
  noindexRemovedFix,
  structuredDataFix,
  titleChangedFix,
  titleFix,
} from "./render-fixes.js";
import type { RenderPages } from "./render-fixes.js";
import { robotsDirectives } from "./rules/indexing.js";
import { finding, GOOGLE_DOCS } from "./rules/rule.js";
import type { FindingExtras } from "./rules/rule.js";
import type {
  ExtractedPage,
  Finding,
  RenderComparison,
  RenderSnapshot,
  ResponseInfo,
  RuleMeta,
} from "./types.js";

const meta = (
  id: string,
  severity: RuleMeta["severity"],
  description: string,
  recommendation: string
): RuleMeta => ({
  id,
  category: "rendering",
  severity,
  description,
  recommendation,
  docs: GOOGLE_DOCS.javascript,
  requires: "render",
});

const SSR_FIX =
  "Render this in the server HTML (SSR/SSG/prerender). Googlebot queues JavaScript rendering separately and other crawlers and link previews never run it.";

export const RENDER_RULES: RuleMeta[] = [
  meta(
    "rendering.title-client-only",
    "warning",
    "The <title> only exists after JavaScript runs.",
    SSR_FIX
  ),
  meta(
    "rendering.title-changed",
    "info",
    "JavaScript changes the <title> after load.",
    "Make the server HTML title match the final title so both agree."
  ),
  meta(
    "rendering.description-client-only",
    "warning",
    "The meta description only exists after JavaScript runs.",
    SSR_FIX
  ),
  meta(
    "rendering.canonical-client-only",
    "warning",
    "The canonical link only exists after JavaScript runs.",
    SSR_FIX
  ),
  meta(
    "rendering.canonical-changed",
    "warning",
    "JavaScript changes the canonical URL after load, sending conflicting signals.",
    "Emit the final canonical in the server HTML and do not modify it client-side."
  ),
  meta(
    "rendering.noindex-client-only",
    "error",
    "A noindex directive is injected by JavaScript. Google applies it when it renders the page, which removes the page from the index.",
    "Remove the client-side noindex (often a framework/head-manager default or an auth guard) or move the decision to the server."
  ),
  meta(
    "rendering.noindex-removed-by-js",
    "warning",
    "The server HTML says noindex but JavaScript removes it. Google honours the server noindex and skips rendering, so the page stays out of the index.",
    "Remove noindex from the server HTML if the page should be indexed."
  ),
  meta(
    "rendering.h1-client-only",
    "warning",
    "The <h1> only exists after JavaScript runs.",
    SSR_FIX
  ),
  meta(
    "rendering.content-client-only",
    "warning",
    "Most of the body text only exists after JavaScript runs.",
    SSR_FIX
  ),
  meta(
    "rendering.links-client-only",
    "warning",
    "Most internal links only exist after JavaScript runs, delaying discovery of the linked pages.",
    `${SSR_FIX} At minimum, render the main navigation and content links server-side.`
  ),
  meta(
    "rendering.structured-data-client-only",
    "info",
    "Structured data is only added by JavaScript.",
    "Google processes JSON-LD injected by JavaScript, but other consumers do not. Prefer emitting it in the server HTML."
  ),
  meta(
    "rendering.console-errors",
    "info",
    "The page logged JavaScript errors while rendering.",
    "Fix runtime errors; a failing script can leave crawlers with an incomplete page."
  ),
];

const byId = new Map(RENDER_RULES.map((r) => [r.id, r]));

const m = (id: string): RuleMeta => {
  const rule = byId.get(id);

  if (!rule) {
    throw new Error(`Unknown rendering rule: ${id}`);
  }

  return rule;
};

export const snapshot = (
  page: ExtractedPage,
  response?: ResponseInfo
): RenderSnapshot => ({
  title: page.title,
  metaDescription: page.metaDescription,
  canonical: page.canonical,
  robots: robotsDirectives(page, response).directives,
  h1Count: page.h1s.filter(Boolean).length,
  wordCount: page.wordCount,
  internalLinks: page.links.filter((l) => l.internal).length,
  structuredDataCount: page.structuredData.length,
});

/** The server HTML and the rendered DOM, read once, with what each says. */
interface Sides extends RenderPages {
  a: RenderSnapshot;
  b: RenderSnapshot;
}

const make = (id: string, message: string, extras: FindingExtras): Finding =>
  finding(m(id), message, extras);

/** Title and description: what the head says before and after JavaScript runs. */
const textFindings = (s: Sides): Finding[] => {
  const { a, b } = s;
  const findings: Finding[] = [];

  if (!a.title && b.title) {
    findings.push(
      make(
        "rendering.title-client-only",
        `Title "${b.title}" is only present after rendering.`,
        {
          fix: titleFix(s, b.title),
          selector: "head > title",
          evidence: { raw: a.title, rendered: b.title },
        }
      )
    );
  } else if (a.title && b.title && a.title !== b.title) {
    findings.push(
      make(
        "rendering.title-changed",
        "Title differs between server HTML and rendered DOM.",
        {
          fix: titleChangedFix(s, a.title, b.title),
          selector: "head > title",
          evidence: { raw: a.title, rendered: b.title },
        }
      )
    );
  }

  if (!a.metaDescription && b.metaDescription) {
    findings.push(
      make(
        "rendering.description-client-only",
        "Meta description is only present after rendering.",
        {
          fix: descriptionFix(s, b.metaDescription),
          selector: 'head > meta[name="description"]',
          evidence: { rendered: b.metaDescription },
        }
      )
    );
  }

  return findings;
};

/** Canonical and robots: the signals that decide which URL is indexed, before and after JavaScript. */
const indexingFindings = (s: Sides): Finding[] => {
  const { a, b } = s;
  const findings: Finding[] = [];

  if (!a.canonical && b.canonical) {
    findings.push(
      make(
        "rendering.canonical-client-only",
        `Canonical ${b.canonical} is only present after rendering.`,
        {
          fix: canonicalFix(s, null, b.canonical),
          selector: 'head > link[rel="canonical"]',
          evidence: { rendered: b.canonical },
        }
      )
    );
  } else if (a.canonical && b.canonical && a.canonical !== b.canonical) {
    findings.push(
      make(
        "rendering.canonical-changed",
        "Canonical differs between server HTML and rendered DOM.",
        {
          fix: canonicalFix(s, a.canonical, b.canonical),
          selector: 'head > link[rel="canonical"]',
          evidence: { raw: a.canonical, rendered: b.canonical },
        }
      )
    );
  }

  const rawNoindex = a.robots.some((d) => d === "noindex" || d === "none");
  const renderedNoindex = b.robots.some((d) => d === "noindex" || d === "none");

  if (!rawNoindex && renderedNoindex) {
    findings.push(
      make("rendering.noindex-client-only", "noindex is added by JavaScript.", {
        fix: noindexAddedFix(s),
        selector: 'head > meta[name="robots"]',
        evidence: { raw: a.robots, rendered: b.robots },
      })
    );
  }

  if (rawNoindex && !renderedNoindex) {
    findings.push(
      make(
        "rendering.noindex-removed-by-js",
        "Server HTML contains noindex; JavaScript removes it.",
        {
          fix: noindexRemovedFix(s),
          selector: 'head > meta[name="robots"]',
          evidence: { raw: a.robots, rendered: b.robots },
        }
      )
    );
  }

  return findings;
};

/** H1, words and links: what only the rendered body has. */
const contentFindings = (s: Sides): Finding[] => {
  const { a, b } = s;
  const findings: Finding[] = [];

  if (a.h1Count === 0 && b.h1Count > 0) {
    findings.push(
      make(
        "rendering.h1-client-only",
        "The <h1> is only present after rendering.",
        {
          fix: h1Fix(s),
          selector: "h1",
          evidence: { rawH1Count: a.h1Count, renderedH1Count: b.h1Count },
        }
      )
    );
  }

  if (b.wordCount - a.wordCount >= 100 && a.wordCount < b.wordCount * 0.5) {
    findings.push(
      make(
        "rendering.content-client-only",
        `Server HTML has ${a.wordCount} words; rendered DOM has ${b.wordCount}.`,
        {
          fix: contentFix(s, b.wordCount - a.wordCount),
          evidence: { rawWords: a.wordCount, renderedWords: b.wordCount },
        }
      )
    );
  }

  if (
    b.internalLinks - a.internalLinks >= 10 &&
    a.internalLinks < b.internalLinks * 0.5
  ) {
    findings.push(
      make(
        "rendering.links-client-only",
        `Server HTML has ${a.internalLinks} internal links; rendered DOM has ${b.internalLinks}.`,
        {
          fix: linksFix(s, b.internalLinks - a.internalLinks),
          evidence: {
            rawLinks: a.internalLinks,
            renderedLinks: b.internalLinks,
          },
        }
      )
    );
  }

  return findings;
};

/** Structured data and script errors that only the rendered page has. */
const scriptFindings = (s: Sides, consoleErrors: string[]): Finding[] => {
  const { a, b } = s;
  const findings: Finding[] = [];

  if (a.structuredDataCount === 0 && b.structuredDataCount > 0) {
    findings.push(
      make(
        "rendering.structured-data-client-only",
        `${b.structuredDataCount} structured data item(s) are only present after rendering.`,
        {
          fix: structuredDataFix(s),
          evidence: { renderedCount: b.structuredDataCount },
        }
      )
    );
  }

  if (consoleErrors.length) {
    findings.push(
      make(
        "rendering.console-errors",
        `${consoleErrors.length} JavaScript error(s) logged during render.`,
        {
          fix: consoleErrorFix(consoleErrors),
          evidence: { errors: consoleErrors.slice(0, 5) },
        }
      )
    );
  }

  return findings;
};

export interface RenderCompareResult {
  comparison: RenderComparison;
  findings: Finding[];
}

export const compareRender = (
  raw: ExtractedPage,
  rendered: ExtractedPage,
  renderedUrl: string,
  consoleErrors: string[],
  rawResponse?: ResponseInfo
): RenderCompareResult => {
  const a = snapshot(raw, rawResponse);
  const b = snapshot(rendered);
  const url = rawResponse?.finalUrl ?? raw.url;
  const sides: Sides = { raw, rendered, response: rawResponse, a, b };

  const findings = [
    ...textFindings(sides),
    ...indexingFindings(sides),
    ...contentFindings(sides),
    ...scriptFindings(sides, consoleErrors),
  ];

  // Set in place: a copy would lose the key a finding's id is made from.
  for (const f of findings) {
    f.url = url;
  }

  return {
    comparison: {
      tool: "playwright",
      renderedUrl,
      consoleErrors: consoleErrors.slice(0, 20),
      raw: a,
      rendered: b,
    },
    findings,
  };
};
