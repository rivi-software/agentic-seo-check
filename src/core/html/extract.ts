import { load, type CheerioAPI } from 'cheerio';
import type { ExtractedPage, HeadingInfo, HreflangInfo, ImageInfo, LinkInfo } from '../types.js';
import { isSameSite, resolveUrl, hostOf } from '../url.js';
import { collapseWhitespace, wordCount } from './text.js';
import { extractStructuredData } from './structured-data.js';

export interface ExtractOptions {
  /** Absolute URL of the document; relative links are resolved against it (or against <base href>). */
  url: string;
  /** Treat subdomains of the site host as internal. */
  includeSubdomains?: boolean;
  /** Host used to classify links as internal. Defaults to the host of `url`. */
  siteHost?: string;
}

export function extractPage(html: string, options: ExtractOptions): ExtractedPage {
  const $ = load(html);
  const hasDoctype = /^\s*<!doctype\s+html/i.test(html);
  const baseHref = $('base[href]').first().attr('href');
  const base = (baseHref && resolveUrl(baseHref, options.url)) || options.url;
  const siteHost = options.siteHost ?? hostOf(options.url) ?? '';

  const titles = $('title')
    .toArray()
    .map((el) => collapseWhitespace($(el).text()));

  const metaDescriptions = $('meta[name]')
    .toArray()
    .filter((el) => ($(el).attr('name') ?? '').trim().toLowerCase() === 'description')
    .map((el) => collapseWhitespace($(el).attr('content') ?? ''));

  const metaRobots = $('meta[name]')
    .toArray()
    .filter((el) => ['robots', 'googlebot', 'googlebot-news', 'bingbot'].includes(($(el).attr('name') ?? '').trim().toLowerCase()))
    .map((el) => collapseWhitespace($(el).attr('content') ?? '').toLowerCase())
    .filter(Boolean);

  const canonicals = $('link[rel]')
    .toArray()
    .filter((el) => relList($(el).attr('rel')).includes('canonical'))
    .map((el) => ($(el).attr('href') ?? '').trim());

  const headings: HeadingInfo[] = $('h1, h2, h3, h4, h5, h6')
    .toArray()
    .map((el) => ({ level: Number(el.tagName.slice(1)), text: collapseWhitespace($(el).text()) }));

  const og: Record<string, string> = {};
  const twitter: Record<string, string> = {};
  $('meta[property], meta[name]').each((_, el) => {
    const key = ($(el).attr('property') ?? $(el).attr('name') ?? '').trim().toLowerCase();
    const content = collapseWhitespace($(el).attr('content') ?? '');
    if (!key) return;
    if (key.startsWith('og:') && !(key in og)) og[key.slice(3)] = content;
    else if (key.startsWith('twitter:') && !(key in twitter)) twitter[key.slice(8)] = content;
  });

  const images: ImageInfo[] = $('img')
    .toArray()
    .map((el) => ({
      src: $(el).attr('src') ?? $(el).attr('data-src') ?? null,
      alt: $(el).attr('alt') ?? null,
      width: $(el).attr('width') ?? null,
      height: $(el).attr('height') ?? null,
      loading: $(el).attr('loading') ?? null,
    }));

  const links: LinkInfo[] = $('a[href]')
    .toArray()
    .map((el) => {
      const href = ($(el).attr('href') ?? '').trim();
      // Fragment-only and empty hrefs are not links to other documents.
      const url = href === '' || href.startsWith('#') ? null : resolveUrl(href, base);
      const rel = $(el).attr('rel') ?? null;
      const relTokens = relList(rel);
      const text = collapseWhitespace($(el).text());
      const ariaLabel = collapseWhitespace($(el).attr('aria-label') ?? '');
      const title = collapseWhitespace($(el).attr('title') ?? '');
      const imgAlt = $(el)
        .find('img[alt]')
        .toArray()
        .map((img) => collapseWhitespace($(img).attr('alt') ?? ''))
        .find(Boolean);
      return {
        href,
        url,
        text,
        rel,
        internal: url ? isSameSite(url, siteHost, options.includeSubdomains) : false,
        nofollow: relTokens.includes('nofollow'),
        hasAccessibleName: Boolean(text || ariaLabel || title || imgAlt),
      };
    });

  const hreflang: HreflangInfo[] = $('link[rel]')
    .toArray()
    .filter((el) => relList($(el).attr('rel')).includes('alternate') && $(el).attr('hreflang'))
    .map((el) => {
      const href = ($(el).attr('href') ?? '').trim();
      return { lang: ($(el).attr('hreflang') ?? '').trim(), href, url: resolveUrl(href, base) };
    });

  const structured = extractStructuredData($);

  const text = visibleText($);

  return {
    url: options.url,
    hasDoctype,
    lang: attrOrNull($('html').attr('lang')),
    charset: detectCharset($),
    viewport: attrOrNull($('meta[name="viewport" i]').first().attr('content')),
    titles,
    title: firstNonEmpty(titles),
    metaDescriptions,
    metaDescription: firstNonEmpty(metaDescriptions),
    metaRobots,
    canonicals,
    canonical: canonicals[0] ? resolveUrl(canonicals[0], base) : null,
    headings,
    h1s: headings.filter((h) => h.level === 1).map((h) => h.text),
    og,
    twitter,
    images,
    links,
    hreflang,
    structuredData: structured.items,
    structuredDataErrors: structured.errors,
    text,
    wordCount: wordCount(text),
    htmlBytes: Buffer.byteLength(html, 'utf8'),
    hasBaseHref: Boolean(baseHref),
  };
}

function relList(rel: string | null | undefined): string[] {
  return (rel ?? '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

function attrOrNull(value: string | undefined): string | null {
  const v = value?.trim();
  return v ? v : null;
}

function firstNonEmpty(values: string[]): string | null {
  for (const v of values) if (v) return v;
  return null;
}

function detectCharset($: CheerioAPI): string | null {
  const direct = $('meta[charset]').first().attr('charset');
  if (direct) return direct.trim();
  const httpEquiv = $('meta[http-equiv]')
    .toArray()
    .find((el) => ($(el).attr('http-equiv') ?? '').toLowerCase() === 'content-type');
  const content = httpEquiv ? $(httpEquiv).attr('content') : undefined;
  const match = content?.match(/charset=([\w-]+)/i);
  return match?.[1] ?? null;
}

function visibleText($: CheerioAPI): string {
  const body = $('body').clone();
  body.find('script, style, noscript, template, svg, iframe, head').remove();
  // Insert spaces at block boundaries so words don't fuse.
  body.find('p, div, li, h1, h2, h3, h4, h5, h6, br, tr, td, th, section, article, header, footer, nav, blockquote, pre, dd, dt, figcaption').each((_, el) => {
    $(el).prepend(' ').append(' ');
  });
  return collapseWhitespace(body.text());
}
