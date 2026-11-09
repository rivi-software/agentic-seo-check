import { hasChildren, isTag, isText } from "domhandler";

import type { AnswerSignals, QuestionHeading } from "../types.js";
import {
  attr,
  childElements,
  HIDDEN_ELEMENTS,
  queryAll,
  queryOne,
  sourceOf,
  text,
  visibleText,
} from "./dom.js";
import type { AnyNode, Document, Element } from "./dom.js";
import { collapseWhitespace, wordCount } from "./text.js";

/** Meta names whose content holds robots directives for one crawler or for all of them. */
const ROBOTS_META_NAMES = new Set([
  "robots",
  "googlebot",
  "googlebot-news",
  "bingbot",
]);

/** Containers FAQ widgets put a question in when it is not a heading. */
const QUESTION_CONTAINERS = new Set(["summary", "dt"]);

/** Elements an answer usually starts with. */
const ANSWER_BLOCKS = new Set([
  "p",
  "li",
  "dd",
  "blockquote",
  "td",
  "figcaption",
  "pre",
]);

/** Page chrome: lists and tables here are navigation, not content. */
const CHROME = new Set(["nav", "header", "footer", "aside"]);

/** Roots JavaScript frameworks render into; empty in the HTML when the page renders client-side. */
const APP_ROOTS = [
  "#root",
  "#app",
  "#__next",
  "#__nuxt",
  "#___gatsby",
  "#svelte",
  "app-root",
  "[data-reactroot]",
  "[ng-app]",
];

/*
 * Written dates in the visible text. Every quantifier is bounded and every alternative is a fixed
 * word, so each regular expression stays linear on long page text.
 */
const DATE_PATTERNS = [
  /\b\d{4}-\d{2}-\d{2}\b/u,
  /\b\d{1,2}[./-]\d{1,2}[./-]\d{4}\b/u,
  /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.? \d{1,2}(?:st|nd|rd|th)?,? \d{4}\b/iu,
  /\b\d{1,2}(?:st|nd|rd|th)?\.? (?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?,? \d{4}\b/iu,
];

const MAX_QUESTIONS = 100;

/** A question ends with a question mark; a long "heading" is a paragraph styled as one. */
const isQuestion = (value: string): boolean =>
  value.length > 0 && value.length <= 300 && /[?？]$/u.test(value);

const isHeading = (el: Element): boolean => /^h[1-6]$/u.test(el.name);

const inChrome = (el: Element): boolean => {
  for (let p = el.parent; p && isTag(p); p = p.parent) {
    if (CHROME.has(p.name)) {
      return true;
    }
  }

  return false;
};

/**
 * What a heading, `<summary>` or `<dt>` does to the question being read: "subsection" goes on with
 * its section, "content" is ordinary text, a question starts a new section and null ends it.
 */
const headingEffect = (
  el: Element,
  current: QuestionHeading | null
): "subsection" | "content" | QuestionHeading | null => {
  const heading = isHeading(el);
  const label = collapseWhitespace(visibleText(el));
  const question = isQuestion(label);
  const level = heading ? Number(el.name.slice(1)) : 0;

  if (!question) {
    // "Why choose us?" answered by one card per reason, each under its own subheading, is answered.
    if (heading && current && current.level > 0 && level > current.level) {
      return "subsection";
    }

    // A <summary> or <dt> ends a section only when it asks a question itself.
    return heading ? null : "content";
  }

  return {
    level,
    text: label.slice(0, 200),
    sectionWords: 0,
    firstBlockWords: null,
  };
};

/** Question headings in document order, with how much text follows each before the next one. */
const findQuestions = (body: Element): QuestionHeading[] => {
  const questions: QuestionHeading[] = [];
  let current: QuestionHeading | null = null;

  const walk = (nodes: AnyNode[]): void => {
    for (const node of nodes) {
      if (isText(node)) {
        if (current) {
          current.sectionWords += wordCount(node.data);
        }

        continue;
      }

      if (!isTag(node)) {
        if (hasChildren(node)) {
          walk(node.children);
        }

        continue;
      }

      if (HIDDEN_ELEMENTS.has(node.name)) {
        continue;
      }

      if (isHeading(node) || QUESTION_CONTAINERS.has(node.name)) {
        const effect = headingEffect(node, current);

        if (effect === "subsection") {
          continue;
        }

        if (effect !== "content") {
          current = effect;

          if (current && questions.length < MAX_QUESTIONS) {
            questions.push(current);
          }

          continue;
        }
      }

      if (
        current &&
        current.firstBlockWords === null &&
        ANSWER_BLOCKS.has(node.name)
      ) {
        current.firstBlockWords = wordCount(visibleText(node));
      }

      walk(node.children);
    }
  };

  walk(body.children);

  return questions;
};

/** A short selector for a `data-nosnippet` element: its tag plus its id or first class. */
const nosnippetSelector = (el: Element): string => {
  const id = attr(el, "id")?.trim();
  const firstClass = attr(el, "class")?.trim().split(/\s+/u)[0];

  let { name } = el;

  if (id) {
    name += `#${id}`;
  } else if (firstClass) {
    name += `.${firstClass}`;
  }

  return `${name.slice(0, 80)}[data-nosnippet]`;
};

const hasNosnippetAncestor = (el: Element): boolean => {
  for (let p = el.parent; p && isTag(p); p = p.parent) {
    if (Object.hasOwn(p.attribs, "data-nosnippet")) {
      return true;
    }
  }

  return false;
};

/** The first empty app root, and its selector. */
const emptyAppRoot = (
  body: Element
): { selector: string; el: Element } | null => {
  for (const selector of APP_ROOTS) {
    const el = queryOne(body, selector);

    if (el && wordCount(visibleText(el)) === 0) {
      return { selector, el };
    }
  }

  return null;
};

const emptySignals = (robotsMeta: AnswerSignals["robotsMeta"]) => ({
  robotsMeta,
  questions: [],
  lists: 0,
  tables: 0,
  nosnippetElements: 0,
  nosnippetWords: 0,
  nosnippetSelectors: [],
  nosnippetTags: [],
  emptyAppRoot: null,
  emptyAppRootTag: null,
  noscriptAsksForJavaScript: false,
  timeElements: 0,
  mentionsDate: false,
});

/**
 * Reads what the AEO rules need from a parsed document; `bodyText` is its visible body text. With
 * `html`, the source it was parsed from, the signals also quote the elements a fix rewrites.
 */
export const extractAnswerSignals = (
  doc: Document,
  bodyText: string,
  html?: string
): AnswerSignals => {
  // `index` counts every robots meta tag, empty ones too, the way `markup.metaRobots` lists them.
  const robotsMeta = queryAll(doc, "meta[name]")
    .filter((el) =>
      ROBOTS_META_NAMES.has((attr(el, "name") ?? "").trim().toLowerCase())
    )
    .flatMap((el, index) => {
      const name = (attr(el, "name") ?? "").trim().toLowerCase();

      const content = collapseWhitespace(
        attr(el, "content") ?? ""
      ).toLowerCase();

      return content ? [{ name, content, index }] : [];
    });

  const body = queryOne(doc, "body");

  if (!body) {
    return emptySignals(robotsMeta);
  }

  const nosnippet = queryAll(body, "[data-nosnippet]").filter(
    (el) => !hasNosnippetAncestor(el)
  );

  const appRoot = emptyAppRoot(body);

  return {
    robotsMeta,
    questions: findQuestions(body),
    lists: queryAll(body, "ul, ol").filter(
      (el) =>
        childElements(el).filter((c) => c.name === "li").length >= 2 &&
        !inChrome(el)
    ).length,
    tables: queryAll(body, "table").filter(
      (el) => queryAll(el, "tr").length >= 2 && !inChrome(el)
    ).length,
    nosnippetElements: nosnippet.length,
    nosnippetWords: nosnippet.reduce(
      (sum, el) => sum + wordCount(visibleText(el)),
      0
    ),
    nosnippetSelectors: nosnippet.slice(0, 10).map(nosnippetSelector),
    nosnippetTags:
      html === undefined
        ? []
        : nosnippet
            .slice(0, 10)
            .map((el) => sourceOf(el, html) ?? `<${el.name}>`),
    emptyAppRoot: appRoot?.selector ?? null,
    emptyAppRootTag:
      html !== undefined && appRoot
        ? sourceOf(appRoot.el, html, "outer")
        : null,
    noscriptAsksForJavaScript: queryAll(body, "noscript").some((el) =>
      /javascript/iu.test(text(el))
    ),
    timeElements: queryAll(body, "time").length,
    mentionsDate: DATE_PATTERNS.some((re) => re.test(bodyText)),
  };
};
