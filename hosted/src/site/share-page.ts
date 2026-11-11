/**
 * Sharing a report (issue #54): the Share menu in the report's bar, and the page a share link
 * opens. Both show the result a share link holds (share.ts) and nothing else: the findings quote
 * the audited page, and the site keeps no report to show them from.
 */
import { PRODUCT_NAME } from "../../../src/brand.js";
import { AEO_RULES, SEO_RULES } from "../../../src/core/rules/index.js";
import { icon } from "../ui/icons.js";
import type { IconName } from "../ui/icons.js";
import { esc } from "./html.js";
import { layout, publisher, SITE_ORIGIN } from "./layout.js";
import { scoreCard } from "./report.js";
import {
  dayText,
  scoresText,
  shareImageAlt,
  shareImagePath,
  sharePath,
  shareTargets,
  subject,
} from "./share.js";
import type { ShareLink, ShareResult } from "./share.js";

const external = (href: string, label: string): string =>
  `<a href="${esc(href)}" target="_blank" rel="noopener">${label}${icon("external")}</a>`;

/**
 * The report's Share button: a <details> menu, so the networks' links work without the script.
 * Each opens the network's own page for a new post, with the post filled in. The script adds the
 * system's share sheet where the browser has one, and the copy button on the link.
 */
export const shareMenu = (link: ShareLink): string => {
  const targets = shareTargets(link);

  return `<details class="share-menu">
<summary class="btn btn-secondary btn-sm">${icon("share")}<span>Share</span></summary>
<div class="share-panel">
<p class="share-panel-head">Share the scores</p>
${external(targets.x, "Post on X")}
${external(targets.linkedin, "Share on LinkedIn")}
${external(targets.bluesky, "Post on Bluesky")}
<button class="share-native" type="button" hidden data-share-text="${esc(targets.text)}" data-share-url="${esc(targets.url)}">More…${icon("share")}</button>
<div class="install share-url" data-copy><code>${esc(targets.url)}</code></div>
<p class="share-panel-note">The link holds the address and the scores, not the findings. <a href="${esc(sharePath(link.token))}" target="_blank" rel="noopener">Open it</a></p>
</div>
</details>`;
};

/** The address as the heading shows it: the hostname, then the rest of the address, muted. */
const addressHeading = (result: ShareResult): string => {
  const url = new URL(result.url);

  const rest =
    url.pathname === "/" && !url.search ? "" : `${url.pathname}${url.search}`;

  return `${esc(url.hostname)}${rest ? `<span class="hero-accent">${esc(rest)}</span>` : ""}`;
};

/** The longest title a page of the site has, as the tool's own title rule holds it. */
const MAX_TITLE_CHARS = 60;

/** What the two scores measure and how they are counted, for someone who follows a shared link. */
const MEANING: [iconName: IconName, title: string, text: string][] = [
  [
    "search",
    "SEO: search engines",
    `What Google, Bing and answer engines read: the title, canonical, indexing, headings, structured data, links and the response. ${SEO_RULES.length} rules.`,
  ],
  [
    "bot",
    "AEO: AI answer engines",
    `Whether AI crawlers such as OAI-SearchBot and PerplexityBot may fetch the page, and answer engines quote it. ${AEO_RULES.length} rules.`,
  ],
  [
    "list",
    "How a score is counted",
    "A page starts at 100: an error takes 15 points, a warning 5, an info finding 1. A site's score averages its pages, less the site-wide findings. 90 and up is good, under 50 poor.",
  ],
];

/** The page a share link opens: the result's address, day and scores, and the way to the form. */
export const sharePage = (link: ShareLink): string => {
  const { result } = link;
  const day = dayText(result.day);
  const what = result.kind === "site" ? "site" : "page";
  const named = `${subject(result)}: ${scoresText(result)}`;
  const branded = `${named} | ${PRODUCT_NAME}`;
  const title = branded.length > MAX_TITLE_CHARS ? named : branded;

  const description =
    result.kind === "site"
      ? `The SEO and AEO scores ${PRODUCT_NAME} gave ${new URL(result.url).hostname}, a crawl of ${result.pages} ${result.pages === 1 ? "page" : "pages"}, on ${day}. Audit your own site for free.`
      : `The SEO and AEO scores ${PRODUCT_NAME} gave ${subject(result)} on ${day}. Audit your own page for free.`;

  const label =
    result.kind === "site"
      ? `Site audit, ${result.pages} ${result.pages === 1 ? "page" : "pages"}`
      : "Page audit";

  return layout({
    path: sharePath(link.token),
    title,
    description,
    noindex: true,
    image: {
      url: `${SITE_ORIGIN}${shareImagePath(link.token)}`,
      alt: shareImageAlt(result),
    },
    data: {
      "@type": "WebPage",
      name: title,
      description,
      publisher,
    },
    body: `<section class="hero hero-glow share-hero" aria-labelledby="share-title">
<div class="wrap">
<div class="hero-copy">
<p class="pill rise"><span class="dot" aria-hidden="true"></span>${label}, ${day}</p>
<h1 class="share-title rise" id="share-title" style="--d:60ms">${addressHeading(result)}</h1>
<p class="lede rise" style="--d:120ms">The scores ${PRODUCT_NAME} gave this ${what} on ${day}, for search engines and for AI answer engines.</p>
</div>
<div class="scores share-scores rise" style="--d:180ms">${scoreCard(null, "SEO: search engines", result.seo.score, result.seo.counts)}${scoreCard(null, "AEO: AI answer engines", result.aeo.score, result.aeo.counts)}</div>
<div class="cta-actions share-actions rise" style="--d:240ms"><a class="btn btn-primary" href="/?${new URLSearchParams({ url: result.url })}#audit">Run this audit again${icon("arrow", "arrow")}</a><a class="btn btn-secondary" href="/">Audit your own ${what}</a></div>
<p class="share-note">${icon("info")}<span>The site keeps no report: run the audit again for the findings and their fixes.</span></p>
</div>
</section>
<section class="section section-tight" aria-labelledby="meaning-title">
<div class="wrap">
<div class="section-head">
<p class="kicker">The scores</p>
<h2 id="meaning-title">What the two scores measure.</h2>
<p>${PRODUCT_NAME} is a free, open source audit by RIVI Software, with no AI model: the same page gets the same findings every time.</p>
</div>
<ul class="cards share-meaning">${MEANING.map(([iconName, heading, text]) => `<li class="card"><span class="card-icon">${icon(iconName)}</span><h3>${heading}</h3><p>${text}</p></li>`).join("")}</ul>
</div>
</section>`,
  });
};
