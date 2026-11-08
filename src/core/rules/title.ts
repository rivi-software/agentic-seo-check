import { isGenericTitle } from '../html/text.js';
import { defineRule, GOOGLE_DOCS } from './rule.js';

export const titleRules = [
  defineRule(
    {
      id: 'title.missing',
      category: 'title',
      severity: 'error',
      description: 'The page has no <title> element or it is empty.',
      recommendation: 'Add a unique, descriptive <title> in <head> (about 30-60 characters) that states what the page is about.',
      docs: GOOGLE_DOCS.titles,
    },
    ({ page }, make) => (page.title ? null : make('Page has no <title> or the title is empty.', { selector: 'head > title' })),
  ),
  defineRule(
    {
      id: 'title.multiple',
      category: 'title',
      severity: 'warning',
      description: 'More than one <title> element is present.',
      recommendation: 'Keep exactly one <title>. Browsers and crawlers may pick different ones when several exist.',
      docs: GOOGLE_DOCS.titles,
    },
    ({ page }, make) =>
      page.titles.length > 1
        ? make(`Page has ${page.titles.length} <title> elements.`, { selector: 'title', evidence: { titles: page.titles } })
        : null,
  ),
  defineRule(
    {
      id: 'title.too-long',
      category: 'title',
      severity: 'warning',
      description: 'Title is longer than the configured maximum (default 60 characters) and will be truncated in search results.',
      recommendation: 'Shorten the title to roughly 60 characters or fewer, keeping the most important words first.',
      docs: GOOGLE_DOCS.titles,
    },
    ({ page, thresholds }, make) =>
      page.title && page.title.length > thresholds.titleMaxChars
        ? make(`Title is ${page.title.length} characters (max ${thresholds.titleMaxChars}).`, {
            selector: 'head > title',
            evidence: { title: page.title, length: page.title.length, max: thresholds.titleMaxChars },
          })
        : null,
  ),
  defineRule(
    {
      id: 'title.too-short',
      category: 'title',
      severity: 'info',
      description: 'Title is shorter than the configured minimum (default 30 characters).',
      recommendation: 'Consider a more descriptive title that includes the page topic and, where sensible, the brand.',
      docs: GOOGLE_DOCS.titles,
    },
    ({ page, thresholds }, make) =>
      page.title && page.title.length < thresholds.titleMinChars
        ? make(`Title is only ${page.title.length} characters (recommended at least ${thresholds.titleMinChars}).`, {
            selector: 'head > title',
            evidence: { title: page.title, length: page.title.length, min: thresholds.titleMinChars },
          })
        : null,
  ),
  defineRule(
    {
      id: 'title.generic',
      category: 'title',
      severity: 'warning',
      description: 'Title is a framework default or placeholder such as "React App", "Create Next App", "Home" or "Untitled".',
      recommendation: 'Replace the placeholder with a title that describes this page. In frameworks, set it per route (metadata export, <Head>, useHead, <svelte:head>, etc.).',
      docs: GOOGLE_DOCS.titles,
    },
    ({ page }, make) =>
      page.title && isGenericTitle(page.title)
        ? make(`Title "${page.title}" looks like a placeholder or framework default.`, { selector: 'head > title', evidence: { title: page.title } })
        : null,
  ),
];
