import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as wait } from "node:timers/promises";

export interface Route {
  status?: number;
  headers?: Record<string, string>;
  /** Text, in which __ORIGIN__ and __PATH__ are filled in, or bytes sent as they are (a gzip file). */
  body?: string | Buffer;
  /** Answer 403 to a request whose User-Agent contains one of these, as a CDN that blocks bots does. */
  blockUserAgents?: string[];
  /** Milliseconds to wait before answering the first, second, ... request to this path, to order races. */
  delaysMs?: number[];
}

/** The site a fixture server serves, by path; a test may add a route once the server listens. */
export type Routes = Record<string, Route>;

export interface FixtureServer {
  origin: string;
  close: () => Promise<void>;
  requests: string[];
  /** The User-Agent of each request, in the order of `requests`. */
  userAgents: string[];
}

const page = (title: string, body: string, extraHead = "") =>
  `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><meta name="description" content="Description for ${title} that is long enough to pass the minimum length check easily."><link rel="canonical" href="__ORIGIN__/__PATH__">${extraHead}</head><body><h1>${title}</h1>${body}</body></html>`;

export const siteRoutes = () => {
  const text = Array.from(
    { length: 40 },
    () => "Useful words about widgets and workshops appear here in sentences."
  ).join(" ");

  return {
    "/": {
      body: page(
        "Home page title for fixture",
        `<p>${text}</p><nav><a href="/about/">About</a> <a href="/missing">Missing</a> <a href="/redirect">Redirect</a> <a href="/blog/post-1">Post</a> <a href="/chain">Chain</a> <a href="https://external.invalid/dead">Ext</a> <a href="/file.pdf">PDF</a></nav>`
      ),
    },
    "/about/": {
      body: page(
        "Home page title for fixture",
        `<p>${text}</p><a href="/">Home</a> <a href="/private/secret">Secret</a> <a href="/about/">Self</a>`
      ),
    },
    "/blog/post-1": {
      body: page(
        "Post one",
        `<p>${text}</p><a href="/">Home</a>`,
        '<meta name="robots" content="noindex">'
      ),
    },
    "/orphan": {
      body: page(
        "Orphan page title here",
        `<p>${text}</p><a href="/">Home</a>`
      ),
    },
    "/private/secret": { body: page("Secret", "<p>hidden</p>") },
    "/redirect": { status: 301, headers: { location: "/about/" } },
    "/chain": { status: 302, headers: { location: "/chain2" } },
    "/chain2": { status: 301, headers: { location: "/about/" } },
    "/file.pdf": {
      headers: { "content-type": "application/pdf" },
      body: "%PDF-1.4",
    },
    "/robots.txt": {
      headers: { "content-type": "text/plain" },
      body: "User-agent: *\nDisallow: /private/\nSitemap: __ORIGIN__/sitemap.xml\n",
    },
    "/sitemap.xml": {
      headers: { "content-type": "application/xml" },
      body: '<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>__ORIGIN__/</loc></url><url><loc>__ORIGIN__/about/</loc></url><url><loc>__ORIGIN__/blog/post-1</loc></url><url><loc>__ORIGIN__/orphan</loc></url><url><loc>__ORIGIN__/gone</loc></url></urlset>',
    },
  } satisfies Record<string, Route>;
};

const originOf = (server: http.Server) => {
  // SAFETY: the server listens on a TCP port, never a pipe, so its address is an AddressInfo; it
  // is read only once the server is listening.
  const { port } = server.address() as AddressInfo;

  return `http://localhost:${port}`;
};

export const startFixtureServer = async (
  routes: Routes
): Promise<FixtureServer> => {
  const requests: string[] = [];
  const userAgents: string[] = [];

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const userAgent = req.headers["user-agent"] ?? "";
    const earlier = requests.filter((p) => p === url.pathname).length;
    requests.push(url.pathname);
    userAgents.push(userAgent);
    const route = routes[url.pathname];
    const origin = originOf(server);
    const delay = route?.delaysMs?.[earlier] ?? 0;

    if (delay > 0) {
      await wait(delay);
    }

    if (route?.blockUserAgents?.some((bot) => userAgent.includes(bot))) {
      res.writeHead(403, { "content-type": "text/html" });
      res.end("<html><head><title>Access denied</title></head></html>");

      return;
    }

    if (!route) {
      res.writeHead(404, { "content-type": "text/html" });
      res.end(
        "<html><head><title>Not found</title></head><body>404</body></html>"
      );

      return;
    }

    res.setHeader("content-type", "text/html; charset=utf-8");

    for (const [name, value] of Object.entries(route.headers ?? {})) {
      res.setHeader(name, value.replace("__ORIGIN__", origin));
    }

    res.writeHead(route.status ?? 200);

    if (Buffer.isBuffer(route.body)) {
      res.end(route.body);

      return;
    }

    res.end(
      (route.body ?? "")
        .replaceAll("__ORIGIN__", origin)
        .replaceAll("__PATH__", url.pathname.replace(/^\//u, ""))
    );
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  return {
    origin: originOf(server),
    requests,
    userAgents,
    close: () => server[Symbol.asyncDispose](),
  };
};
