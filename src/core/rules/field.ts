/**
 * Real-user Core Web Vitals from the Chrome UX Report (`fieldData`, issue #130), judged by Google's
 * thresholds at the 75th percentile (web.dev, "Defining the Core Web Vitals metrics thresholds"):
 * LCP good up to 2.5 s and poor over 4 s, INP 200 ms and 500 ms, CLS 0.1 and 0.25. A page without
 * a record gets no finding: few visits say nothing against it.
 *
 * CrUX measures, it names no element, so each fix takes its edits from the page itself: what on
 * it is known to slow that metric (a lazy first image, scripts that block the parser, images
 * without a size, a page without a viewport). When the page shows none of that, the fix says
 * where to look, and Lighthouse (`--lighthouse`) or PageSpeed Insights names the element.
 */
import { FIELD_THRESHOLDS, fieldValue, sharePercent } from "../field-data.js";
import type { CORE_VITALS } from "../field-data.js";
import { cacheHtmlEdit, lcpFallbackEdit } from "../performance-fixes.js";
import type {
  ExtractedPage,
  FieldData,
  FieldMetric,
  FixEdit,
} from "../types.js";
import { hostOf } from "../url.js";
import { viewportEdit } from "./document.js";
import { addEdit, addHtml, rebuildEdit, slot } from "./fix.js";
import { sizeEdit, unsizedImages } from "./images.js";
import { deferEdits, eagerEdit, lazyFirstImage } from "./loading.js";
import { defineRule } from "./rule.js";
import type { Rule } from "./rule.js";

/** Google Search's page on Core Web Vitals, which says how it reads the Chrome UX Report. */
const DOCS =
  "https://developers.google.com/search/docs/appearance/core-web-vitals";

/** What a fix writes when real visits are slow: field data moves over four weeks. */
const LATER =
  "The Chrome UX Report covers 28 days, so a fix shows there over the next four weeks; check it now with --lighthouse on the local tool, or PageSpeed Insights, which also names the element.";

type MetricName = "lcp" | "inp" | "cls";

interface Vital {
  /** The key of the metric in `FieldData`. */
  key: (typeof CORE_VITALS)[number];
  /** Its name in a message. */
  label: string;
}

const VITALS: Record<MetricName, Vital> = {
  lcp: { key: "lcpMs", label: "Largest Contentful Paint (LCP)" },
  inp: { key: "inpMs", label: "Interaction to Next Paint (INP)" },
  cls: { key: "cls", label: "Cumulative Layout Shift (CLS)" },
};

/** Whose record a message speaks of. */
const whose = (field: FieldData): string =>
  field.source === "url"
    ? "for this URL"
    : "for the whole origin, as this URL has too few visits of its own";

/** LCP: the first screen's largest element, how early it is requested and how fast the server answers. */
const lcpEdits = (page: ExtractedPage, field: FieldData): FixEdit[] => {
  const edits: FixEdit[] = [];
  const lazy = lazyFirstImage(page);

  if (lazy) {
    edits.push(eagerEdit(lazy, true));
  }

  edits.push(...deferEdits(page));

  // A first byte slower than Google's good TTFB holds up everything LCP waits for.
  if (field.ttfbMs && field.ttfbMs.p75 > FIELD_THRESHOLDS.ttfbMs[0]) {
    edits.push(cacheHtmlEdit(field.ttfbMs.p75, "field"));
  }

  return edits.length ? edits : [lcpFallbackEdit()];
};

/** The scripts of the page on its own host and on others, by URL. */
const scriptsOf = (page: ExtractedPage) => {
  const host = hostOf(page.url);
  const scripts = page.resources.filter((r) => r.kind === "script");

  return {
    own: scripts.filter((r) => hostOf(r.url) === host).map((r) => r.url),
    others: scripts.filter((r) => hostOf(r.url) !== host).map((r) => r.url),
  };
};

const SPLIT_TASKS =
  "Find the long tasks that run when a visitor taps or types (a DevTools performance trace of a tap, or the Total Blocking Time of --lighthouse), and split them: await scheduler.yield() between the steps of an event handler, paint what the tap changes first and do the rest after it, and debounce input handlers.";

/**
 * INP: what keeps the main thread from answering a tap. A page without a viewport makes phones
 * wait for a double tap; scripts that block the parser, the page's own scripts and other sites'
 * are where the long tasks are.
 */
const inpEdits = (page: ExtractedPage, field: FieldData): FixEdit[] => {
  const p75 = field.inpMs?.p75 ?? 0;
  const edits: FixEdit[] = [];
  const viewport = viewportEdit(page);

  if (viewport) {
    edits.push(viewport);
  }

  edits.push(...deferEdits(page));

  const { own, others } = scriptsOf(page);

  for (const url of own.slice(0, 3)) {
    edits.push(
      rebuildEdit(
        url,
        "the script, its long tasks split as write says",
        `Real visits on phones wait ${Math.round(p75)} ms at the 75th percentile for the page to answer a tap or a key. If this script runs then: ${SPLIT_TASKS}`
      )
    );
  }

  for (const url of others.slice(0, 2)) {
    edits.push(
      rebuildEdit(
        url,
        "how the page loads this script, as write says",
        "A script from another site runs on the main thread that answers taps. If the page does not need it at once (a chat widget, a tag manager, an embed), load it after the load event or on the first interaction."
      )
    );
  }

  return edits.length
    ? edits
    : [
        addEdit(
          "html",
          "script",
          slot(
            "the page's inline scripts, their long tasks split as write says"
          ),
          { write: SPLIT_TASKS }
        ),
      ];
};

/**
 * CLS: what moves once it loads. An image without a size moves the text below it; space for what
 * a script inserts (a banner, an ad, an embed) is reserved in CSS.
 */
const clsEdits = (page: ExtractedPage): FixEdit[] => {
  const unsized = unsizedImages(page.images);

  return unsized.length
    ? unsized.map(sizeEdit)
    : [
        addHtml(
          "head",
          `<style>${slot("a CSS selector for the element that moves")} { min-height: ${slot("its height in px")}px; }</style>`,
          "The element that shifts the layout once it loads: a banner, an ad or an embed a script inserts gets a slot of its height in the HTML, or shows over the page with position: fixed; a web font gets font-display: optional. Lighthouse's layout shift culprits (--lighthouse) or the Layout shifts track of DevTools' Performance panel name it."
        ),
      ];
};

const FIXES: Record<
  MetricName,
  (page: ExtractedPage, field: FieldData) => FixEdit[]
> = { lcp: lcpEdits, inp: inpEdits, cls: clsEdits };

/** What real visits go through when a metric is over `threshold`, as a rule's description says it. */
const DESCRIBE: Record<MetricName, (threshold: string) => string> = {
  lcp: (t) =>
    `On phones, real visits wait more than ${t} for the largest element of the first screen at the 75th percentile`,
  inp: (t) =>
    `On phones, real visits wait more than ${t} for the page to answer a tap or a key at the 75th percentile`,
  cls: (t) =>
    `On phones, the layout of real visits shifts by more than ${t} at the 75th percentile`,
};

const RECOMMEND: Record<MetricName, string> = {
  lcp: 'Make the largest element of the first screen show sooner: never lazy-load it, give its image fetchpriority="high", defer the scripts in <head>, and speed up the server\'s first byte (cache the HTML at the edge).',
  inp: "Shorten the work a tap or a key starts: split long JavaScript tasks (await scheduler.yield()), defer scripts in <head>, load other sites' scripts after the page, and keep the viewport meta tag so phones answer a tap at once.",
  cls: "Give every image width and height, reserve the space of what a script inserts (banners, ads, embeds), and load web fonts with font-display: optional.",
};

/** The rule for one metric and band: `poor` (a warning) or `needs-improvement` (info). */
const fieldRule = (
  name: MetricName,
  band: "poor" | "needs-improvement"
): Rule => {
  const vital = VITALS[name];
  const [good, poor] = FIELD_THRESHOLDS[vital.key];
  const threshold = band === "poor" ? poor : good;
  const show = (value: number): string => fieldValue(vital.key, value);

  return defineRule(
    {
      id: `perf.field-${name}-${band}`,
      category: "performance",
      severity: band === "poor" ? "warning" : "info",
      description: `${DESCRIBE[name](show(threshold))}: ${vital.label} in the Chrome UX Report's last 28 days, for the page's URL or, when it has too few visits, its origin. Google rates it ${band === "poor" ? "poor" : "as needing improvement"}.`,
      recommendation: `${RECOMMEND[name]} ${LATER}`,
      docs: DOCS,
      requires: "field-data",
    },
    ({ page, fieldData: field }, make) => {
      const metric: FieldMetric | null | undefined = field?.[vital.key];

      if (!(field && metric) || metric.p75 <= threshold) {
        return null;
      }

      // A poor value is reported by the poor rule alone.
      if (band === "needs-improvement" && metric.p75 > poor) {
        return null;
      }

      return make(
        `On phones, the 75th percentile of ${vital.label} is ${show(metric.p75)} over 28 days of real Chrome visits ${whose(field)} (${band === "poor" ? "poor" : "needs improvement"}: over ${show(threshold)}); ${sharePercent(metric.poor)} of visits were poor.`,
        {
          fix: FIXES[name](page, field),
          evidence: {
            [vital.key]: metric.p75,
            source: field.source,
            period: field.period,
            good: metric.good,
            needsImprovement: metric.needsImprovement,
            poor: metric.poor,
          },
        }
      );
    }
  );
};

export const fieldRules: Rule[] = [
  fieldRule("lcp", "poor"),
  fieldRule("inp", "poor"),
  fieldRule("cls", "poor"),
  fieldRule("lcp", "needs-improvement"),
  fieldRule("inp", "needs-improvement"),
  fieldRule("cls", "needs-improvement"),
];
