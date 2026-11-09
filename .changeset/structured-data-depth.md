---
"@rivi-software/agentic-seo-check": minor
---

Check structured data values, not only which properties exist. `structured-data.invalid-value` reports prices with a currency symbol or a decimal comma, currencies that are not ISO 4217 codes, ratings outside their scale and breadcrumb trails with odd positions or crumbs without a URL; `structured-data.relative-url` and `structured-data.dangling-id` report relative URLs and `@id` references the page does not define. `structured-data.retired-type` says when markup asks for a rich result Google no longer shows (FAQPage since May 2026, HowTo, SpecialAnnouncement, ClaimReview, the sitelinks search box); the properties of such markup are no longer reported as missing. A review nested in a Recipe or Product no longer needs `itemReviewed`, and a Q&A page question may have only suggested answers.
