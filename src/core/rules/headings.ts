import type { ExtractedPage, FixEdit } from "../types.js";
import {
  addHtml,
  removeEdit,
  replaceHtml,
  setAttributeEdit,
  slot,
  withContent,
} from "./fix.js";
import { innerOf, renamed } from "./quoted-tags.js";
import { cap, defineRule } from "./rule.js";

interface HeadingElement {
  level: number;
  text: string;
  /** The whole element as the HTML writes it. */
  outer: string;
}

const headingElements = (page: ExtractedPage): HeadingElement[] =>
  page.headings.map((h, i) => ({
    ...h,
    outer: page.markup.headings[i] ?? `<h${h.level}>`,
  }));

/** An h2-h6 with neither text nor markup, which headings.empty removes. */
const isRemovable = (h: HeadingElement): boolean =>
  h.level > 1 && !h.text && (innerOf(h.outer) ?? "").trim() === "";

const STYLE_NOTE =
  "If the heading should keep its look, give it a class that carries the old style.";

/** The edit that turns `h` into a heading of `level`, keeping its attributes and content. */
const relevel = (h: HeadingElement, level: number, write: string): FixEdit => {
  const code = renamed(h.outer, `h${h.level}`, `h${level}`);

  return code
    ? replaceHtml(h.outer, code, { write })
    : replaceHtml(h.outer, `<h${level}>${slot("heading text")}</h${level}>`, {
        write: `The same heading as an <h${level}>; its quote is cut short, so keep its attributes and content. ${write}`,
      });
};

/**
 * The edit that gives a heading without text its text: alt text for an image it holds, else the
 * text itself, beside any other markup it holds so nothing is lost.
 */
const nameHeading = (
  page: ExtractedPage,
  h: HeadingElement,
  hint: string,
  write: string
): FixEdit => {
  const image = page.images.find((img) => h.outer.includes(img.tag));

  if (image) {
    return setAttributeEdit(
      image.tag,
      `h${h.level} img`,
      "alt",
      slot(hint),
      `${write} The heading holds only this image, so its alt text is the heading.`
    );
  }

  const inner = innerOf(h.outer);
  const code = withContent(h.outer, `${slot(hint)}${inner ?? ""}`);

  return code
    ? replaceHtml(h.outer, code, { write })
    : addHtml(`h${h.level}`, slot(hint), write);
};

export const headingRules = [
  defineRule(
    {
      id: "h1.missing",
      category: "headings",
      severity: "warning",
      description: "The page has no <h1>.",
      recommendation:
        "Add one <h1> that states the main topic of the page. It is usually the visible page heading.",
    },
    ({ page }, make) =>
      page.h1s.length === 0
        ? make("Page has no <h1> heading.", {
            fix: [
              addHtml(
                "body",
                `<h1>${slot("page heading")}</h1>`,
                "The visible heading of the page, saying what it is about, at the top of its main content. If the page already shows its title in another element, make that element the <h1>."
              ),
            ],
            selector: "h1",
          })
        : null
  ),
  defineRule(
    {
      id: "h1.multiple",
      category: "headings",
      severity: "info",
      description: "The page has more than one <h1>.",
      recommendation:
        "Prefer a single <h1> for the main topic and use <h2>-<h6> for sections. Multiple H1s are valid HTML but make the main topic less clear.",
    },
    ({ page }, make) => {
      const h1s = headingElements(page).filter((h) => h.level === 1);

      // The first <h1> stays the main heading; the others become section headings.
      return h1s.length > 1
        ? make(`Page has ${page.h1s.length} <h1> headings.`, {
            fix: h1s
              .slice(1)
              .map((h) =>
                relevel(
                  h,
                  2,
                  `This keeps the first <h1>, "${h1s[0]?.text.slice(0, 60) ?? ""}", as the page's main heading. ${STYLE_NOTE}`
                )
              ),
            selector: "h1",
            evidence: { h1s: cap(page.h1s) },
          })
        : null;
    }
  ),
  defineRule(
    {
      id: "h1.empty",
      category: "headings",
      severity: "warning",
      description: "An <h1> exists but contains no text.",
      recommendation:
        "Put the page heading text inside the <h1>. If it wraps only an image, give the image descriptive alt text.",
    },
    ({ page }, make) =>
      page.h1s.length > 0 && page.h1s.every((h) => !h)
        ? make("All <h1> elements are empty.", {
            fix: headingElements(page)
              .filter((h) => h.level === 1)
              .slice(0, 1)
              .map((h) =>
                nameHeading(
                  page,
                  h,
                  "page heading",
                  "The visible heading of the page, saying what it is about."
                )
              ),
            selector: "h1",
          })
        : null
  ),
  defineRule(
    {
      id: "h1.too-long",
      category: "headings",
      severity: "info",
      description:
        "The <h1> is longer than the configured maximum (default 70 characters).",
      recommendation:
        "Keep the H1 concise; move detail into the intro paragraph.",
    },
    ({ page, thresholds }, make) => {
      const long = page.h1s.filter((h) => h.length > thresholds.h1MaxChars);

      const fix = headingElements(page)
        .filter((h) => h.level === 1 && h.text.length > thresholds.h1MaxChars)
        .map((h) => {
          const code = withContent(h.outer, slot("shorter heading"));
          const write = `The heading in at most ${thresholds.h1MaxChars} characters; move the detail into the paragraph below it.`;

          return code
            ? replaceHtml(h.outer, code, { write })
            : addHtml("h1", slot("shorter heading"), write);
        });

      return long.length
        ? make(
            `${long.length} <h1> heading(s) exceed ${thresholds.h1MaxChars} characters.`,
            { fix, selector: "h1", evidence: { h1s: cap(long) } }
          )
        : null;
    }
  ),
  defineRule(
    {
      id: "headings.empty",
      category: "headings",
      severity: "warning",
      description: "Heading elements (h2-h6) with no text content.",
      recommendation:
        "Remove empty heading tags or fill them with text. Empty headings confuse outline parsers and screen readers.",
    },
    ({ page }, make) => {
      const empty = page.headings.filter((h) => h.level > 1 && !h.text);

      // A heading with no text and no markup is removed; one that holds an icon or image gets a name.
      const fix = headingElements(page)
        .filter((h) => h.level > 1 && !h.text)
        .map((h) =>
          isRemovable(h)
            ? removeEdit("html", h.outer, { at: `h${h.level}:empty` })
            : nameHeading(
                page,
                h,
                "section heading",
                "The heading of the section below it."
              )
        );

      return empty.length
        ? make(`${empty.length} empty heading element(s) found.`, {
            fix,
            evidence: { levels: cap(empty.map((h) => `h${h.level}`)) },
          })
        : null;
    }
  ),
  defineRule(
    {
      id: "headings.skipped-level",
      category: "headings",
      severity: "info",
      description:
        "Heading levels are skipped (for example an <h2> followed directly by an <h4>).",
      recommendation:
        "Use heading levels in order (h1 > h2 > h3) so the document outline reflects the content structure.",
    },
    ({ page }, make) => {
      const skips: string[] = [];
      let prev = 0;

      for (const h of page.headings) {
        if (prev > 0 && h.level > prev + 1) {
          skips.push(`h${prev} → h${h.level} ("${h.text.slice(0, 40)}")`);
        }

        prev = h.level;
      }

      // Renumber so no level is skipped: a heading that skips moves up, and the headings under it
      // move with it, so the fix leaves no new skip behind.
      const fix: FixEdit[] = [];
      let prevNew = 0;

      for (const h of headingElements(page)) {
        // headings.empty removes an empty heading; renumbering it too would give two edits one tag.
        if (isRemovable(h)) {
          continue;
        }

        const level =
          prevNew > 0 && h.level > prevNew + 1 ? prevNew + 1 : h.level;

        if (level !== h.level) {
          fix.push(relevel(h, level, STYLE_NOTE));
        }

        prevNew = level;
      }

      return skips.length
        ? make(`${skips.length} heading level skip(s) found.`, {
            fix,
            evidence: { skips: cap(skips) },
          })
        : null;
    }
  ),
];
