import { normalizeUrl } from '../url.js';
import { defineRule, GOOGLE_DOCS } from './rule.js';

const OG_CORE = ['title', 'description', 'image'] as const;
const OG_RECOMMENDED = ['title', 'description', 'image', 'url', 'type'] as const;
const TWITTER_CARDS = new Set(['summary', 'summary_large_image', 'app', 'player']);

export const socialRules = [
  defineRule(
    {
      id: 'og.missing',
      category: 'social',
      severity: 'warning',
      description: 'No Open Graph tags (og:title, og:description, og:image) are present.',
      recommendation: 'Add og:title, og:description, og:image (absolute URL, at least 1200x630), og:url and og:type so shares on social platforms and chat apps render a rich preview.',
      docs: GOOGLE_DOCS.og,
    },
    ({ page }, make) => (OG_CORE.some((k) => page.og[k]) ? null : make('Page has no Open Graph tags.', { selector: 'head > meta[property^="og:"]' })),
  ),
  defineRule(
    {
      id: 'og.incomplete',
      category: 'social',
      severity: 'info',
      description: 'Some Open Graph tags are present but one or more of og:title, og:description, og:image, og:url, og:type is missing.',
      recommendation: 'Fill in the missing Open Graph properties. og:image and og:description have the biggest effect on share previews.',
      docs: GOOGLE_DOCS.og,
    },
    ({ page }, make) => {
      if (!OG_CORE.some((k) => page.og[k])) return null;
      const missing = OG_RECOMMENDED.filter((k) => !page.og[k]);
      return missing.length ? make(`Open Graph is missing: ${missing.map((m) => `og:${m}`).join(', ')}.`, { selector: 'head > meta[property^="og:"]', evidence: { missing, present: Object.keys(page.og) } }) : null;
    },
  ),
  defineRule(
    {
      id: 'og.image-not-absolute',
      category: 'social',
      severity: 'warning',
      description: 'og:image is not an absolute URL.',
      recommendation: 'Use a full https:// URL for og:image; most platforms ignore relative image paths.',
      docs: GOOGLE_DOCS.og,
    },
    ({ page }, make) => {
      const img = page.og['image'];
      return img && !/^https?:\/\//i.test(img) ? make(`og:image "${img}" is not an absolute URL.`, { selector: 'head > meta[property="og:image"]', evidence: { image: img } }) : null;
    },
  ),
  defineRule(
    {
      id: 'og.url-mismatch',
      category: 'social',
      severity: 'info',
      description: 'og:url differs from the canonical URL.',
      recommendation: 'Set og:url to the same URL as the canonical so share counts and previews consolidate.',
      docs: GOOGLE_DOCS.og,
    },
    ({ page }, make) => {
      const ogUrl = page.og['url'];
      if (!ogUrl || !page.canonical) return null;
      const a = normalizeUrl(ogUrl);
      const b = normalizeUrl(page.canonical);
      return a && b && a !== b ? make('og:url does not match the canonical URL.', { selector: 'head > meta[property="og:url"]', evidence: { ogUrl, canonical: page.canonical } }) : null;
    },
  ),
  defineRule(
    {
      id: 'twitter.card-missing',
      category: 'social',
      severity: 'info',
      description: 'No twitter:card meta tag is present.',
      recommendation: 'Add <meta name="twitter:card" content="summary_large_image">; X/Twitter falls back to Open Graph for the other fields.',
      docs: GOOGLE_DOCS.twitter,
    },
    ({ page }, make) => (page.twitter['card'] ? null : make('Page has no twitter:card tag.', { selector: 'head > meta[name="twitter:card"]' })),
  ),
  defineRule(
    {
      id: 'twitter.card-invalid',
      category: 'social',
      severity: 'warning',
      description: 'twitter:card has a value other than summary, summary_large_image, app or player.',
      recommendation: 'Use one of the supported card types, usually summary_large_image.',
      docs: GOOGLE_DOCS.twitter,
    },
    ({ page }, make) => {
      const card = page.twitter['card'];
      return card && !TWITTER_CARDS.has(card.toLowerCase()) ? make(`twitter:card "${card}" is not a valid card type.`, { selector: 'head > meta[name="twitter:card"]', evidence: { card } }) : null;
    },
  ),
];
