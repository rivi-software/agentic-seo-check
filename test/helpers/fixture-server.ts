import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Route {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
}

export interface FixtureServer {
  origin: string;
  close(): Promise<void>;
  requests: string[];
}

const page = (title: string, body: string, extraHead = '') =>
  `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><meta name="description" content="Description for ${title} that is long enough to pass the minimum length check easily."><link rel="canonical" href="__ORIGIN__/__PATH__">${extraHead}</head><body><h1>${title}</h1>${body}</body></html>`;

export function siteRoutes(): Record<string, Route> {
  const text = Array(40).fill('Useful words about widgets and workshops appear here in sentences.').join(' ');
  return {
    '/': { body: page('Home page title for fixture', `<p>${text}</p><nav><a href="/about/">About</a> <a href="/missing">Missing</a> <a href="/redirect">Redirect</a> <a href="/blog/post-1">Post</a> <a href="/chain">Chain</a> <a href="https://external.invalid/dead">Ext</a> <a href="/file.pdf">PDF</a></nav>`) },
    '/about/': { body: page('Home page title for fixture', `<p>${text}</p><a href="/">Home</a> <a href="/private/secret">Secret</a> <a href="/about/">Self</a>`) },
    '/blog/post-1': { body: page('Post one', `<p>${text}</p><a href="/">Home</a>`, '<meta name="robots" content="noindex">') },
    '/orphan': { body: page('Orphan page title here', `<p>${text}</p><a href="/">Home</a>`) },
    '/private/secret': { body: page('Secret', '<p>hidden</p>') },
    '/redirect': { status: 301, headers: { location: '/about/' } },
    '/chain': { status: 302, headers: { location: '/chain2' } },
    '/chain2': { status: 301, headers: { location: '/about/' } },
    '/file.pdf': { headers: { 'content-type': 'application/pdf' }, body: '%PDF-1.4' },
    '/robots.txt': { headers: { 'content-type': 'text/plain' }, body: 'User-agent: *\nDisallow: /private/\nSitemap: __ORIGIN__/sitemap.xml\n' },
    '/sitemap.xml': {
      headers: { 'content-type': 'application/xml' },
      body: '<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>__ORIGIN__/</loc></url><url><loc>__ORIGIN__/about/</loc></url><url><loc>__ORIGIN__/blog/post-1</loc></url><url><loc>__ORIGIN__/orphan</loc></url><url><loc>__ORIGIN__/gone</loc></url></urlset>',
    },
  };
}

export async function startFixtureServer(routes: Record<string, Route>): Promise<FixtureServer> {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    requests.push(url.pathname);
    const route = routes[url.pathname];
    const origin = `http://localhost:${(server.address() as AddressInfo).port}`;
    if (!route) {
      res.writeHead(404, { 'content-type': 'text/html' });
      res.end('<html><head><title>Not found</title></head><body>404</body></html>');
      return;
    }
    const headers: Record<string, string> = { 'content-type': 'text/html; charset=utf-8', ...(route.headers ?? {}) };
    if (headers['location']) headers['location'] = headers['location'].replace('__ORIGIN__', origin);
    res.writeHead(route.status ?? 200, headers);
    res.end((route.body ?? '').replaceAll('__ORIGIN__', origin).replaceAll('__PATH__', url.pathname.replace(/^\//, '')));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://localhost:${(server.address() as AddressInfo).port}`;
  return { origin, requests, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}
