# What the Browser Run spike showed (issue #230, PR A, Task 1)

Verdict: **PASS**. With CDP `Fetch.enable` on `*` and every `Fetch.requestPaused` answered by the Worker through `Fetch.fulfillRequest`, the browser on real Browser Run sent nothing to the network itself. Every request was paused, answered with headers the Worker built (our User-Agent, our signature headers, no `cf-brapi-*` or `cf-biso-*`), the redirect was fulfilled as the 302 and the browser asked again for `/target`, `/sw.js` was never requested, and a WebSocket was closed by `page.routeWebSocket` before it reached the network.

## What ran

- Package: `@cloudflare/playwright@1.4.0` from npm. Its `package.json` already names `git+https://github.com/cloudflare/browser-run.git` (`packages/playwright-cloudflare`), the fork the docs point to, so npm's 1.4.0 is that fork's build. It drives Chromium 152 (from `sec-ch-ua`).
- Spike Worker in `hosted/spike/render-spike/` (its own `package.json`, `wrangler.jsonc` and `index.ts`; deleted after the run), `compatibility_date: "2025-09-15"`, `nodejs_compat`, `browser: { binding: "BROWSER" }`.
- `wrangler dev --remote` (Wrangler 4.162.0) on the RIVI account (`11cac7608b348e25e8e8bd377ff3e2fa`). Nothing was deployed. `limits()` answered `maxConcurrentSessions: 200, allowedBrowserAcquisitions: 10`.
- `/render?mode=plain|routed` launched `launch(env.BROWSER)`, opened a context with `userAgent: "agentic-seo-check-spike"` and `serviceWorkers: "block"`, rendered `/page` (a stylesheet, a script, an image, a link to `/redirect` that answers 302 to `/target`, `navigator.serviceWorker.register('/sw.js')`, and a `new WebSocket` to `/ws`), clicked the link, and returned what a second CDP session saw on the `Network` domain.
- `routed`: a CDP session on the page, `Fetch.enable({ patterns: [{ urlPattern: "*", requestStage: "Request" }] })`. Each paused request became a new `Request` with `user-agent: agentic-seo-check-spike`, the browser's `Accept`, and stand-in `signature`, `signature-input` and `signature-agent` values, `redirect: "manual"`. That request was recorded and answered by the spike's own site handler in process, and its status, headers and base64 body went back through `Fetch.fulfillRequest` (a 302 as the 302 with its `Location`). `page.routeWebSocket(/.*/, ws => ws.close({ code: 1008 }))` closed WebSockets.

## What the run could not show, and why that does not weaken the result

A remote dev preview is reachable only with the preview token Wrangler adds on `localhost`; the Worker does not see that token, and `render-spike.rivi-software.workers.dev` has no deployed Worker, so a browser that fetches it gets Cloudflare's 404. So in `plain` mode the Worker received nothing over the network, and the `cf-brapi-*` headers Browser Run adds could not be read at an origin (a public echo was out of scope). They are added outside Chromium, so CDP's `requestWillBeSentExtraInfo` does not show them either.

What `plain` does prove is the contrast: without interception the browser fetched the page itself and got the 404, then followed the 404 page's favicon to `workers.cloudflare.com` and `www.cloudflare.com` (CDP reports the headers it sent for each). In `routed` mode, against the same unreachable host, the page rendered with its own title, its script ran, and the click reached `/target`. That is possible only if every response came from the Worker's fulfilment, and CDP reported no `requestWillBeSentExtraInfo` (headers sent on the wire) and no `webSocketCreated` at all. In the real implementation the in-process handler is replaced by `fetchThrough`, whose requests the Worker builds and signs, so Browser Run's headers and signature never ride on them.

## Plain log

Requests the Worker received over the network: none (`{"log":[],"paused":[]}`). What the browser itself did, from CDP (a `__cf_bm` cookie in one request's headers is redacted, and no other secret appears):

```
request   https://render-spike.rivi-software.workers.dev/page            Document
sent      Host=render-spike.rivi-software.workers.dev  UA=agentic-seo-check-spike
response  https://render-spike.rivi-software.workers.dev/page  404
request   https://workers.cloudflare.com/favicon.ico                     Other
sent      Host=workers.cloudflare.com  UA=agentic-seo-check-spike
request   https://www.cloudflare.com/favicon.ico  (after a 301)           Other
sent      Host=www.cloudflare.com  UA=agentic-seo-check-spike
response  https://www.cloudflare.com/favicon.ico  200
(the same again after Playwright's retry; one request carried Cookie: __cf_bm=[redacted])
result: title "Page not found", appRan false, page.click('#go') timed out after 30 s
```

## Routed log

Final run (`sessionId b3ba3578-…`, 4.3 s):

```json
{
  "wsRouted": ["wss://render-spike.rivi-software.workers.dev/ws"],
  "pageTitleAfterSw": "sw-registered",
  "appRan": true,
  "swRegisterSource": "async () => { console.warn('Service Worker registration blocked by Playwright'); }",
  "swRegistrations": 0,
  "wsEvents": ["close:1008"],
  "finalUrl": "https://render-spike.rivi-software.workers.dev/target",
  "finalTitle": "target"
}
```

Paused, in order (every request CDP's `Network` domain saw, and nothing else):

```
GET /page (Document)
GET /style.css (Stylesheet)
GET /app.js (Script)
GET /img.png (Image)
GET /favicon.ico (Other)
GET /redirect (Document)
GET /target (Document)      Network: requestWillBeSent with redirectResponse 302
```

What the routed handler sent and the site received, for each of the seven (identical apart from `path`; the signature values are the spike's stand-ins, not a real key):

```json
{
  "via": "in-process",
  "path": "/page",
  "ua": "agentic-seo-check-spike",
  "headers": {
    "signature": "sig1=:SPIKE-OUR-OWN-SIGNATURE:",
    "signature-agent": "\"https://spike.example\"",
    "signature-input": "sig1=(\"@authority\");tag=\"web-bot-auth\""
  }
}
```

No `cf-brapi-*` or `cf-biso-*` header on any of them. CDP: no `requestWillBeSentExtraInfo`, no `webSocketCreated`, no `loadingFailed`.

## Facts the plan asked for

- **`serviceWorkers: "block"` exists** (`"allow" | "block"` on `newContext`). Playwright implements it by replacing `navigator.serviceWorker.register` with a stub that resolves to `undefined` (source above), so a page's `register()` *resolves* (the title went to `sw-registered`) but nothing is fetched or registered (`getRegistrations()` is empty, `/sw.js` never paused). A page script that treats the promise's value as a registration may throw; that is the page's problem, not a leak.
- **`page.routeWebSocket` and `context.routeWebSocket` exist and work** on Browser Run: the WebSocket was handed to the handler and closed with 1008 without any network handshake. `Fetch` interception does not cover WebSockets, so the route is needed.
- **The error when no browser is free**: a burst of 12 concurrent `launch()` calls gave 10 browsers and two of `Error: Unable to create new browser: code: 429: message: Rate limit exceeded`. That is the acquisition rate (`allowedBrowserAcquisitions: 10`), not the 200 concurrent sessions, which the spike did not reach. The concurrency error was not seen.
- **Bundles with Wrangler 4.162.0**: yes. `wrangler deploy --dry-run` and the remote preview built it, 4,604 KiB, 924 KiB gzip, for the spike alone. That is the whole Playwright client, so the premium Worker's bundle grows by about that much; it is under the 10 MB (paid) limit but worth watching.
- **`nodejs_compat` is needed**: without it the bundle warns that `node:async_hooks` and `node:events` (imported by the package's `webSocketTransport.js`, `apiCallZone.js`, `zones.js`, `eventEmitter.js` and others) are missing and will throw at run time.
- **Launch options worth knowing**: `launch()` takes `guardrails` (`SessionGuardrails`: "an empty `allowedDomains` denies all outbound traffic, and an invalid policy fails closed") and `outboundByHost`. Guardrails with no allowed domains would be a second wall behind `Fetch` interception, if a fulfilled request is not counted as outbound traffic; the spike did not try it.

## Concerns for Tasks 2 to 5

- The `Fetch` domain was enabled on the page's CDP session. A dedicated Web Worker or an out-of-process iframe is its own target; the spike's page had neither. The implementation should enable `Fetch` on every attached target (or `Target.setAutoAttach` with `waitForDebuggerOnStart`), or fail the render when a target it cannot intercept appears.
- `routeWebSocket` replaces `window.WebSocket` in the page; a WebSocket opened from a Worker would not see it. Same answer as above.
- `/favicon.ico` is requested by the browser on every page and goes through `Fetch`, so it passes the gate and counts as a request.
- The spike used one CDP session for `Fetch` and a second for `Network`; Playwright's own `page.route` was not used, and need not be.

## After the final review: redirects walked by `fetchThrough` (finding 2)

The spike answered `Fetch.requestPaused` on its own CDP session, where a fulfilled 302 made the browser pause the next hop again. The implementation routes through Playwright's `context.route` instead, and `@cloudflare/playwright` (`crNetworkManager.js`, the `redirectedFrom` branch) continues a redirect's next request with `Fetch.continueRequest` without handing it to the route: every hop after a fulfilled 3xx would have gone to Browser Run's own network, where the guardrails deny it. So `fetchThrough` now walks each redirect itself, asks the gate and signs each hop, and fulfils the browser with the last answer. The browser keeps the URL it asked for, which is fine for a subresource; the audit renders the page's final URL already.

Checked on 2026-11-24 with `wrangler dev --remote` (Wrangler 4.162.0, RIVI account, nothing deployed; the throwaway Worker and its files were deleted after the run). The Worker ran the branch's own `renderPage` and `fetchThroughOptions` with `launch(env.BROWSER, { guardrails: { allowedDomains: [] } })`, and answered the test site in process, as the spike did, since a remote preview has no public address. The page linked a stylesheet behind a 307, a script behind a 302 and an image behind a 301, and its script sent `fetch('/post', { method: 'POST' })`. Result (4.1 s):

```json
{
  "appRan": true,
  "img": "loaded",
  "post": "blocked",
  "consoleErrors": [],
  "blockedRequests": 1,
  "gateAsked": [
    "gate /page",
    "subresources /r/style.css", "subresources /style.css",
    "subresources /r/app.js", "subresources /app.js",
    "subresources /r/img.png", "subresources /img.png"
  ]
}
```

Every one of the seven requests the site received was a GET with the check's User-Agent and signature (`sig1=:RENDER-CHECK:`); the POST reached neither the gate nor the site. The script behind its redirect ran and the image behind its redirect loaded, which, with the guardrails denying the browser any traffic of its own, is possible only if each hop was fetched by `fetchThrough`. The page's navigation went through the call's gate and everything else through `subresourceGate`. Chromium's console error for the blocked POST was left out of `consoleErrors`, and counted in `blockedRequests`.
