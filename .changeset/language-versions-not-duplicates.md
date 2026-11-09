---
"@rivi-software/agentic-seo-check": patch
---

`site.duplicate-titles`, `site.duplicate-descriptions` and `site.duplicate-h1` no longer group the language versions of one page: pages that name each other as hreflang alternates under different codes (and the pages joined to them that way), such as `/contact` and `/nl/contact` both titled "Contact". A page that is no version of them and shares the value is still reported, and only that page gets the fix. A one-way hreflang link, or two pages that call each other by the same code, does not count. `site.duplicate-content` still reports language versions whose text is the same, as Google counts untranslated versions as duplicates.
