import { cap, defineRule } from './rule.js';

export const headingRules = [
  defineRule(
    {
      id: 'h1.missing',
      category: 'headings',
      severity: 'warning',
      description: 'The page has no <h1>.',
      recommendation: 'Add one <h1> that states the main topic of the page. It is usually the visible page heading.',
    },
    ({ page }, make) => (page.h1s.length === 0 ? make('Page has no <h1> heading.', { selector: 'h1' }) : null),
  ),
  defineRule(
    {
      id: 'h1.multiple',
      category: 'headings',
      severity: 'info',
      description: 'The page has more than one <h1>.',
      recommendation: 'Prefer a single <h1> for the main topic and use <h2>-<h6> for sections. Multiple H1s are valid HTML but make the main topic less clear.',
    },
    ({ page }, make) =>
      page.h1s.length > 1 ? make(`Page has ${page.h1s.length} <h1> headings.`, { selector: 'h1', evidence: { h1s: cap(page.h1s) } }) : null,
  ),
  defineRule(
    {
      id: 'h1.empty',
      category: 'headings',
      severity: 'warning',
      description: 'An <h1> exists but contains no text.',
      recommendation: 'Put the page heading text inside the <h1>. If it wraps only an image, give the image descriptive alt text.',
    },
    ({ page }, make) => (page.h1s.length > 0 && page.h1s.every((h) => !h) ? make('All <h1> elements are empty.', { selector: 'h1' }) : null),
  ),
  defineRule(
    {
      id: 'h1.too-long',
      category: 'headings',
      severity: 'info',
      description: 'The <h1> is longer than the configured maximum (default 70 characters).',
      recommendation: 'Keep the H1 concise; move detail into the intro paragraph.',
    },
    ({ page, thresholds }, make) => {
      const long = page.h1s.filter((h) => h.length > thresholds.h1MaxChars);
      return long.length ? make(`${long.length} <h1> heading(s) exceed ${thresholds.h1MaxChars} characters.`, { selector: 'h1', evidence: { h1s: cap(long) } }) : null;
    },
  ),
  defineRule(
    {
      id: 'headings.empty',
      category: 'headings',
      severity: 'warning',
      description: 'Heading elements (h2-h6) with no text content.',
      recommendation: 'Remove empty heading tags or fill them with text. Empty headings confuse outline parsers and screen readers.',
    },
    ({ page }, make) => {
      const empty = page.headings.filter((h) => h.level > 1 && !h.text);
      return empty.length ? make(`${empty.length} empty heading element(s) found.`, { evidence: { levels: cap(empty.map((h) => `h${h.level}`)) } }) : null;
    },
  ),
  defineRule(
    {
      id: 'headings.skipped-level',
      category: 'headings',
      severity: 'info',
      description: 'Heading levels are skipped (for example an <h2> followed directly by an <h4>).',
      recommendation: 'Use heading levels in order (h1 > h2 > h3) so the document outline reflects the content structure.',
    },
    ({ page }, make) => {
      const skips: string[] = [];
      let prev = 0;
      for (const h of page.headings) {
        if (prev > 0 && h.level > prev + 1) skips.push(`h${prev} → h${h.level} ("${h.text.slice(0, 40)}")`);
        prev = h.level;
      }
      return skips.length ? make(`${skips.length} heading level skip(s) found.`, { evidence: { skips: cap(skips) } }) : null;
    },
  ),
];
