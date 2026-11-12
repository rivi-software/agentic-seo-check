/**
 * The edits that fix what Lighthouse found. Lighthouse sees the rendered DOM, not the source, so
 * HTML edits point at its CSS selector (`at`) and say what to add or remove there; they quote an
 * attribute (`loading="lazy"`), never Lighthouse's snippet, whose long values it cuts short.
 * Measurements go into `write`, so the agent knows how much an edit is worth.
 */
import {
  addEdit,
  addHtml,
  escapeAttribute,
  rebuildEdit,
  removeEdit,
  replaceEdit,
  slot,
} from "./rules/fix.js";
import type {
  FixEdit,
  LcpElement,
  LighthouseAuditSummary,
  LighthouseItem,
  LighthouseNode,
  LighthouseOpportunity,
  PerformanceResult,
} from "./types.js";

const kib = (bytes: number): string =>
  `${Math.max(1, Math.round(bytes / 1024))} KiB`;

const hostOf = (url: string): string | null => {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
};

/**
 * A selector for the <script> or stylesheet <link> that loads `url`: by its path on the page's own
 * host (the source may write it relative), by host and path on another one.
 */
const loaderSelector = (
  kind: "script" | "stylesheet",
  url: string,
  pageUrl: string
): string => {
  let part = url;

  try {
    const u = new URL(url);
    part = `${u.host === hostOf(pageUrl) ? "" : u.host}${u.pathname}`;
  } catch {
    // Not a URL: match it as written.
  }

  const value = part.replaceAll('"', String.raw`\"`);

  return kind === "script"
    ? `script[src*="${value}"]`
    : `link[rel="stylesheet"][href*="${value}"]`;
};

/** A script URL: a .js or .mjs file, or a path that ends in /js, like Google Maps' /maps/api/js. */
const isScriptUrl = (url: string): boolean => {
  try {
    return /(?:\.m?js|\/js)$/iu.test(new URL(url).pathname);
  } catch {
    return false;
  }
};

/** Edits that differ: two rules of one finding may arrive at the same edit. */
export const uniqueEdits = (edits: FixEdit[]): FixEdit[] => {
  const seen = new Set<string>();

  return edits.filter((e) => {
    const key = JSON.stringify(e);

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);

    return true;
  });
};

/** An edit for a change Lighthouse describes but names nothing to change, so the code is a slot. */
export const describedEdit = (title: string, description: string): FixEdit =>
  addHtml(
    "html",
    slot("the change Lighthouse describes"),
    `${title}: ${description}`
  );

/**
 * HTML a CDN may cache: the fix for a slow server answer when the page is the same for everyone.
 * `measured` says who waited `ms` for the first byte: Lighthouse, or real visits (field data).
 */
export const cacheHtmlEdit = (
  ms: number | null,
  measured: "lighthouse" | "field" = "lighthouse"
): FixEdit =>
  addEdit(
    "http",
    "Cache-Control",
    "Cache-Control: public, max-age=0, s-maxage=300, stale-while-revalidate=86400",
    {
      write: `${ms === null ? "The server answers slowly." : `${measured === "field" ? "Real visits on phones wait" : "Lighthouse waited"} ${Math.round(ms)} ms for the first byte of the HTML${measured === "field" ? " at the 75th percentile" : ""}.`} This header lets a CDN serve the HTML from its cache for 5 minutes and refresh it in the background; replace the Cache-Control the HTML has now. Use it only when the HTML is the same for every visitor, never on pages that show a signed-in user's data; for those, speed up the server work for this URL instead (slow queries, uncached API calls).`,
    }
  );

/**
 * The scripts and stylesheets that block the first paint: `defer` on each script, and the
 * stylesheets' CSS inlined in <head>.
 */
export const renderBlockingEdits = (
  items: LighthouseItem[],
  pageUrl: string
): FixEdit[] => {
  const withUrl = items.flatMap((i) => (i.url ? [{ ...i, url: i.url }] : []));
  const scripts = withUrl.filter((i) => isScriptUrl(i.url));
  const sheets = withUrl.filter((i) => !isScriptUrl(i.url));

  const edits = scripts.map((i) =>
    addHtml(
      loaderSelector("script", i.url, pageUrl),
      "defer",
      `${i.url} blocks the first paint${i.wastedMs ? ` for about ${i.wastedMs} ms` : ""}; defer runs it after the HTML is parsed. Leave it blocking only if an inline script in the HTML calls it before the page has loaded.`
    )
  );

  if (sheets.length) {
    const total = sheets.reduce((n, i) => n + (i.totalBytes ?? 0), 0);
    const small = total > 0 && total <= 14 * 1024;

    const list = sheets
      .map((i) => `${i.url}${i.totalBytes ? ` (${kib(i.totalBytes)})` : ""}`)
      .join(", ");

    edits.push(
      addHtml(
        "head",
        `<style>${slot(small ? "the CSS of the stylesheets listed below" : "the rules from the stylesheets below that style the first screen")}</style>`,
        small
          ? `These stylesheets block the first paint and come to ${kib(total)}: put their CSS in this <style> and remove their <link rel="stylesheet"> tags: ${list}.`
          : `These stylesheets block the first paint${total ? ` (${kib(total)})` : ""}: inline the rules the first screen needs, then load each stylesheet without blocking (<link rel="preload" as="style" href="…" onload="this.rel='stylesheet'">): ${list}.`
      )
    );
  }

  return edits;
};

/** width and height on an image, from the size Lighthouse saw it at. */
const sizeEdit = (node: LighthouseNode, url?: string): FixEdit =>
  node.width && node.height
    ? addHtml(
        node.selector,
        `width="${node.width}" height="${node.height}"`,
        `Lighthouse saw ${url ?? "this image"} at ${node.width}×${node.height} CSS px. width and height let the browser reserve its space before it loads; if the file's own pixel size has another aspect ratio, write that size instead, and keep height: auto in the CSS.`
      )
    : addHtml(
        node.selector,
        `width="${slot("width in px")}" height="${slot("height in px")}"`,
        `The pixel size of ${url ?? "this image"} (or any size with its aspect ratio), so the browser reserves its space before it loads; keep height: auto in the CSS.`
      );

/**
 * Lighthouse's selector when it is valid CSS as written: tags, ids and classes of plain letters.
 * It does not escape ids (React's ":r1:", one that starts with a digit) and may be cut short, and
 * the element is often a third party's, so anything else could break the <style> it goes into.
 */
const plainSelector = (selector: string): string | null =>
  /^[\w\s>.#-]+$/u.test(selector) && !/[#.]-?\d/u.test(selector)
    ? selector
    : null;

/** The space an element takes, reserved before its content arrives. */
const reserveEdit = (node: LighthouseNode): FixEdit => {
  const plain = plainSelector(node.selector);
  const selector = plain ?? slot("a CSS selector for this element");
  const height = node.height ? String(node.height) : slot("height in px");

  const named = plain
    ? ""
    : ` Lighthouse names it ${node.selector}, which is not a CSS selector as written: write one that selects it.`;

  return addHtml(
    "head",
    `<style>${selector} { min-height: ${height}px; }</style>`,
    node.height
      ? `Lighthouse saw this element shift the layout: ${node.snippet}. This reserves the ${node.height} px it takes. If a script inserts it (a banner, an ad, an embed), give it a slot of that height in the HTML, or show it over the page with position: fixed so it pushes nothing.${named}`
      : `The height this element takes once loaded (${node.snippet}), so the page reserves it before its content arrives.${named}`
  );
};

const fontDisplayEdit = (url: string, value: "optional" | "swap"): FixEdit =>
  addEdit("asset", "@font-face", `font-display: ${value};`, {
    url,
    write: `Add it to the @font-face rule that loads this font${value === "optional" ? ": the page keeps the fallback font when the web font arrives late, so the text does not move" : ": text shows in a fallback font at once instead of staying invisible"}. For Google Fonts, add &display=${value} to the stylesheet URL instead.`,
  });

/** What makes the layout shift: unsized images, late web fonts, elements inserted above content. */
export const clsEdits = (result: PerformanceResult): FixEdit[] => {
  const edits: FixEdit[] = [];
  const seen = new Set<string>();

  for (const image of result.unsizedImages ?? []) {
    if (image.node && !seen.has(image.node.selector)) {
      seen.add(image.node.selector);
      edits.push(sizeEdit(image.node, image.url));
    }
  }

  for (const shift of result.layoutShifts ?? []) {
    if (!shift.node || seen.has(shift.node.selector)) {
      continue;
    }

    seen.add(shift.node.selector);
    const cause = shift.text ?? "";

    if (/font/iu.test(cause) && shift.url) {
      edits.push(fontDisplayEdit(shift.url, "optional"));
    } else if (shift.node.name === "img" || /image/iu.test(cause)) {
      edits.push(sizeEdit(shift.node, shift.url));
    } else {
      edits.push(reserveEdit(shift.node));
    }
  }

  return edits;
};

/** How the LCP image is requested: at once, early, and before other images. */
const lcpImageEdits = (e: LcpElement): FixEdit[] => {
  const at = e.node.selector;
  const edits: FixEdit[] = [];

  if (e.notLazy === false) {
    edits.push(
      removeEdit("html", 'loading="lazy"', {
        at,
        write:
          "The largest image of the first screen waits for layout when it is lazy; load it at once.",
      })
    );
  }

  if (e.fetchpriorityHigh === false) {
    edits.push(
      addHtml(
        at,
        'fetchpriority="high"',
        "Fetches the largest image of the first screen before the other images."
      )
    );
  }

  if (e.discoverable === false) {
    edits.push(
      e.imageUrl && !e.hasSrcset
        ? addHtml(
            "head",
            `<link rel="preload" as="image" href="${escapeAttribute(e.imageUrl)}" fetchpriority="high">`,
            "The browser finds this image only after CSS or JavaScript runs; the preload requests it with the HTML. Better still, render the <img> in the server HTML."
          )
        : addHtml(
            "head",
            `<link rel="preload" as="image" imagesrcset="${slot("the img's srcset")}" imagesizes="${slot("the img's sizes")}" fetchpriority="high">`,
            "Copy srcset and sizes from the <img> at the selector, so the preload fetches the file the image uses. The browser finds the image only after CSS or JavaScript runs; better still, render the <img> in the server HTML."
          )
    );
  }

  return edits;
};

/** The part of the LCP time Lighthouse found largest, and the edit that shortens it. */
const lcpPhaseEdits = (
  result: PerformanceResult,
  pageUrl: string
): FixEdit[] => {
  const e = result.lcpElement;

  const phases = Object.entries(e?.phases ?? {}).toSorted(
    (a, b) => b[1] - a[1]
  );

  const [largest] = phases[0] ?? [];

  if (largest === "timeToFirstByte") {
    return [
      cacheHtmlEdit(
        result.metrics.ttfbMs ?? e?.phases["timeToFirstByte"] ?? null
      ),
    ];
  }

  if (largest === "resourceLoadDuration" && e?.imageUrl) {
    return [
      rebuildEdit(
        e.imageUrl,
        "the image, re-encoded as write says",
        `Downloading the LCP image takes ${e.phases["resourceLoadDuration"]} ms, most of the LCP time. Serve it as WebP or AVIF at the size it is shown${e.node.width ? ` (${e.node.width} CSS px, so ${e.node.width * 2} px wide or less for high-density screens)` : ""}, through srcset.`
      ),
    ];
  }

  if (largest === "elementRenderDelay" || largest === "resourceLoadDelay") {
    return renderBlockingEdits(result.renderBlocking ?? [], pageUrl);
  }

  return [];
};

export const lcpEdits = (
  result: PerformanceResult,
  pageUrl: string
): FixEdit[] => {
  const e = result.lcpElement;

  return uniqueEdits([
    ...(e?.node.name === "img" ? lcpImageEdits(e) : []),
    ...lcpPhaseEdits(result, pageUrl),
  ]);
};

/** When Lighthouse names no LCP element: preload the largest image of the first screen. */
export const lcpFallbackEdit = (): FixEdit =>
  addHtml(
    "head",
    `<link rel="preload" as="image" href="${slot("URL of the largest image in the first screen")}" fetchpriority="high">`,
    'When the largest element of the first screen is an image, preload it and give its <img> fetchpriority="high" (never loading="lazy"). When it is text, preload its web font instead: <link rel="preload" as="font" type="font/woff2" crossorigin href="…">.'
  );

/** The scripts with the most main-thread time, each with what to do about it. */
export const scriptEdits = (
  scripts: LighthouseItem[],
  pageUrl: string
): FixEdit[] =>
  scripts
    .filter((s) => s.url && (s.wastedMs ?? 0) >= 50)
    .slice(0, 5)
    .map((s) => {
      const url = s.url ?? "";
      const own = hostOf(url) === hostOf(pageUrl);

      return rebuildEdit(
        url,
        own
          ? "the script, split as write says"
          : "how the page loads this script, as write says",
        `${s.wastedMs} ms of script evaluation on the main thread; aim for tasks under 50 ms. ${
          own
            ? "Split it so the page loads only the code it runs (dynamic import() per route or component), and break long work into tasks under 50 ms (await scheduler.yield() between steps)."
            : "A third-party script: load it after the page is interactive (after the load event, or on first interaction), or remove it if the page does not need it."
        }`
      );
    });

const BYTE_ADVICE = new Map([
  [
    "unused-javascript",
    "Remove the code this page does not run: split the bundle per route with dynamic import(), drop unused dependencies, or load the script only on the pages that use it.",
  ],
  [
    "unused-css-rules",
    "Remove the rules no page uses, or split the stylesheet per page.",
  ],
  [
    "legacy-javascript-insight",
    "Build it for current browsers: drop the polyfills and transforms for features they support (the bundler's target or browserslist).",
  ],
  [
    "legacy-javascript",
    "Build it for current browsers: drop the polyfills and transforms for features they support (the bundler's target or browserslist).",
  ],
  [
    "duplicated-javascript-insight",
    "Bundle one copy of the module this file repeats (deduplicate the dependency versions).",
  ],
  ["unminified-javascript", "Minify it in the build."],
  ["unminified-css", "Minify it in the build."],
]);

/** Files that carry bytes the page does not need, each with the size to aim for. */
const THIRD_PARTY_BYTES =
  "Another site's file: load it only on the pages that need it, ask its provider for a smaller or modern build, or remove it if the page does without it.";

const byteEdits = (opp: LighthouseOpportunity, pageUrl: string): FixEdit[] =>
  (opp.items ?? []).flatMap((i) => {
    if (!i.url || !(i.totalBytes ?? i.wastedBytes)) {
      return [];
    }

    const total = i.totalBytes ?? 0;
    const wasted = i.wastedBytes ?? 0;

    const size = total
      ? `${kib(total)}${wasted ? `, ${kib(wasted)} of it not needed` : ""}`
      : `${kib(wasted)} not needed`;

    const goal =
      total && wasted ? `; aim for ${kib(total - wasted)} or less` : "";

    return [
      rebuildEdit(
        i.url,
        "the file, rebuilt as write says",
        `${size}${goal}. ${
          hostOf(i.url) === hostOf(pageUrl)
            ? (BYTE_ADVICE.get(opp.id) ?? opp.description)
            : THIRD_PARTY_BYTES
        }`
      ),
    ];
  });

/** Images larger than they are shown, or in an old format. */
const imageEdits = (opp: LighthouseOpportunity): FixEdit[] =>
  (opp.items ?? []).flatMap((i) => {
    if (!i.url) {
      return [];
    }

    const width = i.node?.width;

    const target = [
      "WebP or AVIF",
      width ? `${width * 2} px wide or less` : null,
      i.totalBytes && i.wastedBytes
        ? `${kib(i.totalBytes - i.wastedBytes)} or less`
        : null,
    ]
      .filter(Boolean)
      .join(", ");

    return [
      rebuildEdit(
        i.url,
        "the image, re-encoded as write says",
        `${i.totalBytes ? `${kib(i.totalBytes)} as served; aim` : "Aim"} for ${target}. Serve it in a modern format at the size it is shown${width ? ` (${width} CSS px, twice that for high-density screens)` : ""}, through srcset${i.text ? `. Lighthouse: ${i.text}` : ""}.`
      ),
    ];
  });

/** A long cache lifetime for the site's own static files; other sites' files are theirs to set. */
const cacheLifetimeEdits = (
  opp: LighthouseOpportunity,
  pageUrl: string
): FixEdit[] => {
  const own = (opp.items ?? []).filter(
    (i) => i.url && hostOf(i.url) === hostOf(pageUrl)
  );

  return own.map((i) =>
    addEdit(
      "http",
      "Cache-Control",
      "Cache-Control: public, max-age=31536000, immutable",
      {
        url: i.url,
        write:
          "For a file whose URL changes when its content does (a hash in the file name). For a file without one, use max-age=86400 instead.",
      }
    )
  );
};

const modernHttpEdits = (opp: LighthouseOpportunity): FixEdit[] => {
  const origins = [
    ...new Set(
      (opp.items ?? []).flatMap((i) => {
        try {
          return i.url ? [new URL(i.url).origin] : [];
        } catch {
          return [];
        }
      })
    ),
  ].slice(0, 5);

  return origins.map((origin) =>
    replaceEdit("http", "HTTP/1.1", "HTTP/2", {
      url: origin,
      at: "protocol",
      write:
        "Turn on HTTP/2 (or HTTP/3) at the server or CDN that serves this origin, so its files load over one connection in parallel.",
    })
  );
};

const VIEWPORT = addHtml(
  "head",
  '<meta name="viewport" content="width=device-width, initial-scale=1">',
  "Replace the viewport meta tag the page has, if any: Lighthouse found it does not fit the page to the screen."
);

const LCP_AUDITS = new Set([
  "lcp-discovery-insight",
  "lcp-breakdown-insight",
  "prioritize-lcp-image",
  "largest-contentful-paint-element",
]);

const CLS_AUDITS = new Set([
  "cls-culprits-insight",
  "unsized-images",
  "layout-shifts",
  "cumulative-layout-shift",
]);

const SCRIPT_AUDITS = new Set([
  "bootup-time",
  "mainthread-work-breakdown",
  "long-tasks",
  "forced-reflow-insight",
  "third-parties-insight",
  "inp-breakdown-insight",
]);

const IMAGE_AUDITS = new Set([
  "image-delivery-insight",
  "modern-image-formats",
  "uses-optimized-images",
  "uses-responsive-images",
  "efficient-animated-content",
]);

type OpportunityFixer = (
  opp: LighthouseOpportunity,
  result: PerformanceResult,
  pageUrl: string
) => FixEdit[];

const scriptAuditEdits: OpportunityFixer = (opp, result, pageUrl) => {
  const fromAudit = (opp.items ?? []).filter((i) => i.url && i.wastedMs);

  return scriptEdits(
    fromAudit.length ? fromAudit : (result.scripts ?? []),
    pageUrl
  );
};

/** Which fixer handles which Lighthouse audits; the rest name files with bytes to drop. */
const OPPORTUNITY_FIXERS: [ReadonlySet<string>, OpportunityFixer][] = [
  [
    new Set(["render-blocking-insight", "render-blocking-resources"]),
    (opp, result, pageUrl) =>
      // `items` is a list, often empty: fall back to the blocking resources the report lists.
      renderBlockingEdits(
        opp.items?.length ? opp.items : (result.renderBlocking ?? []),
        pageUrl
      ),
  ],
  [LCP_AUDITS, (_opp, result, pageUrl) => lcpEdits(result, pageUrl)],
  [CLS_AUDITS, (_opp, result) => clsEdits(result)],
  [
    new Set(["document-latency-insight", "server-response-time"]),
    (_opp, result) => [cacheHtmlEdit(result.metrics.ttfbMs)],
  ],
  [SCRIPT_AUDITS, scriptAuditEdits],
  [IMAGE_AUDITS, (opp) => imageEdits(opp)],
  [
    new Set(["cache-insight", "uses-long-cache-ttl"]),
    (opp, _result, pageUrl) => cacheLifetimeEdits(opp, pageUrl),
  ],
  [
    new Set(["font-display-insight", "font-display"]),
    (opp) =>
      (opp.items ?? []).flatMap((i) =>
        i.url ? [fontDisplayEdit(i.url, "swap")] : []
      ),
  ],
  [new Set(["viewport-insight"]), () => [VIEWPORT]],
  [new Set(["modern-http-insight"]), (opp) => modernHttpEdits(opp)],
];

/** The edits for one Lighthouse opportunity, from the rows it names. */
export const opportunityEdits: OpportunityFixer = (opp, result, pageUrl) => {
  const fixer = OPPORTUNITY_FIXERS.find(([ids]) => ids.has(opp.id))?.[1];

  return fixer ? fixer(opp, result, pageUrl) : byteEdits(opp, pageUrl);
};

/** The role an element's snippet gives it, such as `role="dialog"`. */
const roleOf = (snippet: string): string | null =>
  /\srole="(?<role>[^"]*)"/u.exec(snippet)?.groups?.role ?? null;

/**
 * A problem that says the element does not allow its role: axe's "ARIA role should be appropriate
 * for the element" and "ARIA role x is not allowed for given element", or Lighthouse's "Uses ARIA
 * roles on incompatible elements". Other problems that name a role (required children or parent,
 * a role that is not a valid value) are not about the element, and its role may be right.
 */
const ROLE_NOT_ALLOWED =
  /appropriate for the element|not allowed (?:for|on) (?:the |given |this )?element|on incompatible elements/iu;

/** Elements with no closing tag, which a start tag swapped for "<div" would leave unclosed. */
const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);

/** An element that misleads an agent reading the accessibility tree: a missing name, a wrong role. */
const accessibleEdit = (node: LighthouseNode, problem: string): FixEdit => {
  const role = roleOf(node.snippet);
  const notAllowed = role !== null && ROLE_NOT_ALLOWED.test(problem);

  // A <div> allows every role, so it keeps what the role says. A void element cannot become one.
  if (
    notAllowed &&
    node.name &&
    node.name !== "div" &&
    !VOID_ELEMENTS.has(node.name)
  ) {
    return replaceEdit("html", `<${node.name}`, "<div", {
      at: node.selector,
      write: `${problem}: <${node.name}> does not allow role="${role}". Make the element a <div> (and its closing tag </div>), which keeps the role, or use the element that has the role natively (<dialog> for role="dialog"). The element: ${node.snippet}`,
    });
  }

  if (notAllowed) {
    return removeEdit("html", `role="${role}"`, {
      at: node.selector,
      write: `${problem}. Remove the role, or use the element that has it natively (<dialog> for role="dialog"). The element: ${node.snippet}`,
    });
  }

  if (/name|label|discernible|text/iu.test(problem)) {
    return addHtml(
      node.selector,
      `aria-label="${slot("what the element does")}"`,
      `${problem}. Name it with visible text or this aria-label. The element: ${node.snippet}`
    );
  }

  return addHtml(
    node.selector,
    slot("the change the problem asks for"),
    `${problem}. The element: ${node.snippet}`
  );
};

const LLMS_TXT = [
  `# ${slot("site name")}`,
  "",
  `> ${slot("what the site is, in one or two sentences")}`,
  "",
  `## ${slot("a section, such as Docs")}`,
  "",
  `- [${slot("page title")}](${slot("page URL")}): ${slot("what the page covers")}`,
].join("\n");

/** The edits for a failed Lighthouse SEO or agentic-browsing audit. */
export const failedAuditEdits = (
  audit: LighthouseAuditSummary,
  result: PerformanceResult
): FixEdit[] => {
  const items = audit.items ?? [];

  if (audit.id === "robots-txt") {
    const lines = items.filter((i) => i.line);

    return lines.length
      ? lines.map((i) =>
          replaceEdit(
            "robots.txt",
            i.line ?? "",
            slot("the line as a valid rule"),
            {
              at: i.lineNumber ? `line ${i.lineNumber}` : undefined,
              write: `Lighthouse: ${i.text ?? "not a valid rule"}. Write it as one valid rule (User-agent:, Allow:, Disallow:, Sitemap:), or delete the line.`,
            }
          )
        )
      : [
          addEdit("robots.txt", "/robots.txt", "User-agent: *\nAllow: /", {
            write:
              "Lighthouse could not read the site's robots.txt. Serve one that answers 200 with plain text (or 404 when the site has none).",
          }),
        ];
  }

  if (audit.id === "crawlable-anchors") {
    return items.flatMap((i) =>
      i.node
        ? [
            addHtml(
              i.node.selector,
              `href="${slot("URL the link goes to")}"`,
              `Give this link a real URL in href so crawlers can follow it; keep a click handler if it needs one. The link: ${i.node.snippet}`
            ),
          ]
        : []
    );
  }

  if (audit.id === "llms-txt") {
    const problems = items.flatMap((i) => (i.text ? [i.text] : [])).join("; ");

    return [
      addEdit("llms.txt", "/llms.txt", LLMS_TXT, {
        write: `${problems ? `Lighthouse: ${problems}. ` : ""}Markdown at /llms.txt: an H1 with the site name, a blockquote summary, then sections listing the pages an agent needs, each with a link and what it covers.`,
      }),
    ];
  }

  if (CLS_AUDITS.has(audit.id)) {
    return clsEdits(result);
  }

  return items.flatMap((i) =>
    i.node ? [accessibleEdit(i.node, i.text ?? audit.title)] : []
  );
};
