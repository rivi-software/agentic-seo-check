import { defineRule, GOOGLE_DOCS } from './rule.js';

const BCP47 = /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/;

export const documentRules = [
  defineRule(
    {
      id: 'html.lang-missing',
      category: 'document',
      severity: 'warning',
      description: 'The <html> element has no lang attribute.',
      recommendation: 'Set <html lang="xx"> (for example "en", "nl", "en-GB") so search engines and screen readers know the content language.',
    },
    ({ page }, make) => (page.lang ? null : make('<html> has no lang attribute.', { selector: 'html' })),
  ),
  defineRule(
    {
      id: 'html.lang-invalid',
      category: 'document',
      severity: 'warning',
      description: 'The <html lang> value is not a valid BCP 47 language tag.',
      recommendation: 'Use a BCP 47 tag such as "en", "en-US" or "pt-BR".',
    },
    ({ page }, make) => (page.lang && !BCP47.test(page.lang) ? make(`<html lang="${page.lang}"> is not a valid language tag.`, { selector: 'html', evidence: { lang: page.lang } }) : null),
  ),
  defineRule(
    {
      id: 'viewport.missing',
      category: 'document',
      severity: 'warning',
      description: 'No <meta name="viewport"> is present, so the page is not mobile-friendly.',
      recommendation: 'Add <meta name="viewport" content="width=device-width, initial-scale=1"> to <head>. Google indexes the mobile version of pages first.',
      docs: GOOGLE_DOCS.mobile,
    },
    ({ page }, make) => (page.viewport ? null : make('Page has no viewport meta tag.', { selector: 'head > meta[name="viewport"]' })),
  ),
  defineRule(
    {
      id: 'viewport.not-scalable',
      category: 'document',
      severity: 'info',
      description: 'The viewport disables user zoom (user-scalable=no or maximum-scale=1).',
      recommendation: 'Remove user-scalable=no and maximum-scale limits; blocking zoom is an accessibility problem flagged by Lighthouse.',
    },
    ({ page }, make) => {
      const v = (page.viewport ?? '').toLowerCase().replace(/\s/g, '');
      return /user-scalable=(no|0)/.test(v) || /maximum-scale=1(\.0*)?(,|$)/.test(v)
        ? make('Viewport prevents users from zooming.', { selector: 'head > meta[name="viewport"]', evidence: { viewport: page.viewport } })
        : null;
    },
  ),
  defineRule(
    {
      id: 'charset.missing',
      category: 'document',
      severity: 'info',
      description: 'No character encoding is declared.',
      recommendation: 'Add <meta charset="utf-8"> as the first element in <head>.',
    },
    ({ page }, make) => (page.charset ? null : make('No <meta charset> declaration found.', { selector: 'head > meta[charset]' })),
  ),
  defineRule(
    {
      id: 'doctype.missing',
      category: 'document',
      severity: 'info',
      description: 'The document does not start with <!DOCTYPE html>.',
      recommendation: 'Start the document with <!DOCTYPE html> to avoid quirks-mode rendering.',
    },
    ({ page }, make) => (page.hasDoctype ? null : make('Document has no HTML5 doctype.')),
  ),
  defineRule(
    {
      id: 'document.html-too-large',
      category: 'document',
      severity: 'info',
      description: 'The HTML document is larger than 1.5 MB.',
      recommendation: 'Reduce inline scripts/styles/data (large JSON state, inline SVG sprites). Very large documents slow parsing and may be truncated by crawlers.',
    },
    ({ page }, make) =>
      page.htmlBytes > 1_500_000 ? make(`HTML is ${(page.htmlBytes / 1_000_000).toFixed(1)} MB.`, { evidence: { bytes: page.htmlBytes } }) : null,
  ),
];
