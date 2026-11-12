/**
 * The answer for a file that keeps its address when a deploy changes it: the pages, `/site.js`,
 * `/ph.js`, robots.txt (issue #160). `no-cache` lets a browser keep the file but makes it ask on
 * every visit, so a deploy shows on the next one, and a page never pairs with the script of another
 * deploy. The ETag lets the browser keep its copy, with a 304, while the bytes are unchanged: the
 * rules page alone is some 350 KB.
 *
 * The tag is weak, since Cloudflare compresses the answer on its way out and drops a strong ETag
 * when it does. It is a SHA-256 of the body, under a millisecond for the rules page, so it changes
 * with anything a page is built from: the code, a variable, the address's query.
 */

/** The opaque tag, quoted, of `body`: the first 128 bits of its SHA-256. */
const tagOf = async (body: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(body)
  );

  const hex = Array.from(new Uint8Array(digest, 0, 16), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");

  return `"${hex}"`;
};

/** Whether If-None-Match is `*` or names `tag`, weak or not: it compares weakly (RFC 9110, 13.1.2). */
const unchanged = (request: Request, tag: string): boolean =>
  (request.headers.get("if-none-match") ?? "")
    .split(",")
    .map((sent) => sent.trim())
    .some((sent) => sent === "*" || sent === tag || sent === `W/${tag}`);

/**
 * `body` with `headers`, `cache-control: no-cache` and, for a 200, its ETag. A GET or HEAD whose
 * If-None-Match names the ETag gets a 304 without a body or a content type: the browser shows
 * the copy it kept, with the headers it kept. Any other status has no ETag, so never a 304.
 */
export const freshResponse = async (
  request: Request,
  body: string,
  headers: Record<string, string>,
  status = 200
): Promise<Response> => {
  const sent = new Headers({ ...headers, "cache-control": "no-cache" });

  if (status === 200) {
    const tag = await tagOf(body);
    sent.set("etag", `W/${tag}`);

    if (unchanged(request, tag)) {
      sent.delete("content-type");

      return new Response(null, { status: 304, headers: sent });
    }
  }

  return new Response(request.method === "HEAD" ? null : body, {
    status,
    headers: sent,
  });
};
