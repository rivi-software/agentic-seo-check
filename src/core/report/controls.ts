/**
 * Whether a character may not reach a terminal: the C0 controls but tab and newline, DEL and the
 * C1 controls, which start escape sequences, and the bidirectional overrides and isolates, which
 * reorder what is shown.
 */
const unsafe = (code: number): boolean =>
  (code < 0x20 && code !== 0x09 && code !== 0x0a) ||
  (code >= 0x7f && code <= 0x9f) ||
  (code >= 0x20_2a && code <= 0x20_2e) ||
  (code >= 0x20_66 && code <= 0x20_69);

/**
 * `text` without the characters that would let a page move the cursor, retitle the window, hide
 * text or reorder it where a report is printed. A report quotes the page, and a person may print
 * it to a terminal, so every report that is text goes through this before it leaves.
 */
export const withoutControls = (text: string): string => {
  let out = "";

  for (const char of text) {
    if (!unsafe(char.codePointAt(0) ?? 0)) {
      out += char;
    }
  }

  return out;
};
