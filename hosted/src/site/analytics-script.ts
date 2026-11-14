/**
 * The part of the pages' script (files.ts) that cleans an event before posthog-js sends it: an
 * address of this site loses what belongs to the audited site, at any depth of the event (a Web
 * Vitals event nests its address), and an error's message loses what could be a page's or a
 * person's, by the very patterns `cleanMessage` uses for the tool's own errors. It is a string of
 * browser code with no access to the page, so the tests run it in Node (hosted/test/analytics-script.test.ts).
 */
import {
  IDENTIFIER,
  MAX_MESSAGE,
  MAX_READ,
  MESSAGE_PATTERNS,
  SINGLE_QUOTED,
} from "../../../src/telemetry/exceptions.js";

/** The patterns as the browser builds them again: source, flags, replacement, and whether it is the quote. */
const PATTERNS = MESSAGE_PATTERNS.map(([pattern, replacement]) => [
  pattern.source,
  pattern.flags,
  replacement,
  pattern === SINGLE_QUOTED,
]);

/**
 * Defines `cleanEvent(event)`, posthog-js's `before_send`, and the `clean` and `cleanMessage` it
 * uses, in the scope it is put in. `location` is the page's.
 */
export const ANALYTICS_HELPERS_JS = String.raw`
  // An address of this site as an event records it, less what belongs to the audited site: a
  // share link's result (its address and scores) and the address a link put in the form. The
  // hostnames before issue #168 too, which a referrer may still name.
  const OWN = /^(agentic-seo\.org|(mcp\.)?agentic-seo(-check)?\.rivi\.software)$/;

  const clean = (value) => {
    if (typeof value !== "string" || !/^(\/|https?:\/\/)/.test(value)) {
      return value;
    }

    let url;

    try {
      url = new URL(value, location.href);
    } catch {
      return value;
    }

    if (!OWN.test(url.hostname) && url.hostname !== location.hostname) {
      return value;
    }

    if (url.pathname.startsWith("/share/")) {
      url.pathname = "/share/:result";
    }

    url.searchParams.delete("url");
    url.hash = "";

    return value.startsWith("/") ? url.pathname + url.search : url.href;
  };

  // The tool's own patterns for an error's message (src/telemetry/exceptions.ts). A browser that
  // cannot build one of them sends no message at all.
  const MESSAGE_PATTERNS = (() => {
    try {
      return ${JSON.stringify(PATTERNS)}.map(([source, flags, to, quote]) => [
        new RegExp(source, flags),
        to,
        quote,
      ]);
    } catch {
      return null;
    }
  })();

  const IDENTIFIER = new RegExp(${JSON.stringify(IDENTIFIER.source)}, ${JSON.stringify(IDENTIFIER.flags)});

  const cleanMessage = (message) => {
    if (typeof message !== "string") {
      return message;
    }

    if (!MESSAGE_PATTERNS) {
      return "<message>";
    }

    let text = message.slice(0, ${MAX_READ});

    for (const [pattern, to, quote] of MESSAGE_PATTERNS) {
      text = text.replace(pattern, (match) =>
        quote && IDENTIFIER.test(match.slice(1, -1)) ? match : to
      );
    }

    return text.length > ${MAX_MESSAGE} ? text.slice(0, ${MAX_MESSAGE - 1}) + "…" : text;
  };

  // Every string of an event's properties through clean. An object or array nested deeper than
  // any event posthog-js builds is dropped, not sent unread.
  const scrub = (value, depth) => {
    if (typeof value === "string") {
      return clean(value);
    }

    if (value === null || typeof value !== "object") {
      return value;
    }

    if (depth > 6) {
      return null;
    }

    if (Array.isArray(value)) {
      return value.map((item) => scrub(item, depth + 1));
    }

    for (const key of Object.keys(value)) {
      value[key] = scrub(value[key], depth + 1);
    }

    return value;
  };

  // An error from a script of this site: one only from a browser extension, or from a script some
  // other software put in the page, is not ours to fix, and its address is not ours to send.
  const ours = (list) =>
    list.every((entry) => {
      const frames = (entry.stacktrace && entry.stacktrace.frames) || [];

      return (
        frames.length === 0 ||
        frames.some((frame) => {
          // An absolute address: code without one was evaluated or injected, which the site's
          // Content-Security-Policy keeps its own scripts from doing.
          try {
            return new URL(frame.filename).origin === location.origin;
          } catch {
            return false;
          }
        })
      );
    });

  const cleanEvent = (event) => {
    if (!event) {
      return event;
    }

    const properties = event.properties;

    if (event.event === "$exception" && properties) {
      const list = Array.isArray(properties.$exception_list) ? properties.$exception_list : [];

      if (!ours(list)) {
        return null;
      }

      for (const entry of list) {
        entry.value = cleanMessage(entry.value);
      }

      properties.$exception_message = cleanMessage(properties.$exception_message);

      if (Array.isArray(properties.$exception_values)) {
        properties.$exception_values = properties.$exception_values.map(cleanMessage);
      }

      delete properties.$exception_steps;
    }

    for (const part of [properties, event.$set, event.$set_once]) {
      if (part) {
        // A share page's title names the address and its scores.
        delete part.title;
        delete part.$title;
        scrub(part, 0);
      }
    }

    return event;
  };
`;
