import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { FetchOptions, RequestGate } from "../src/core/fetch.js";
import { trackRefusals } from "../src/core/refusals.js";
import { answerRoute, fetchThroughOptions } from "../src/core/render-fetch.js";
import type {
  BrowserAnswer,
  BrowserRequest,
  RouteLike,
} from "../src/core/render-fetch.js";
import { startFixtureServer } from "./helpers/fixture-server.js";
import type { FixtureServer, Routes } from "./helpers/fixture-server.js";

const USER_AGENT =
  "Mozilla/5.0 (compatible; agentic-seo-check/1.0.0; +https://agentic-seo.org/crawler)";

const SECRET = "Basic c3RhZ2luZzpzZWNyZXQ=";

const sign = () => ({
  signature: "sig1=:test:",
  "signature-input": 'sig1=("@authority");tag="web-bot-auth"',
});

/** A gate that refuses the paths in `refused` and records every URL it was asked about. */
const gateStub = (refused: string[] = []) => {
  const asked: string[] = [];

  const gate: RequestGate = {
    beforeRequest: (url) => {
      asked.push(url.pathname);

      return refused.includes(url.pathname)
        ? { scope: "url", reason: "robots_txt", message: "Disallowed." }
        : undefined;
    },
  };

  return { gate, asked };
};

const request = (
  url: string,
  extra: Partial<BrowserRequest> = {}
): BrowserRequest => ({
  url,
  method: "GET",
  headers: { accept: "*/*", "user-agent": "HeadlessChrome" },
  resourceType: "script",
  ...extra,
});

/** What a test reads in place of an answer it expected and did not get. */
const NO_ANSWER: BrowserAnswer = { kind: "fail", reason: "Failed" };

const text = (answer: BrowserAnswer): string =>
  answer.kind === "fulfil" ? new TextDecoder().decode(answer.body) : "";

const header = (answer: BrowserAnswer, name: string): string | undefined =>
  answer.kind === "fulfil"
    ? answer.headers.find((h) => h.name.toLowerCase() === name)?.value
    : undefined;

const optionsWith = (gate: RequestGate, extra: FetchOptions = {}) => ({
  userAgent: USER_AGENT,
  sign,
  gate,
  ...extra,
});

/** A Playwright route that records what it was answered with. */
const fakeRoute = () => {
  const calls: unknown[] = [];

  const route: RouteLike = {
    fulfill: (options) => {
      calls.push(["fulfill", options]);

      return Promise.resolve();
    },
    abort: (code) => {
      calls.push(["abort", code]);

      return Promise.resolve();
    },
  };

  return { route, calls };
};

describe(fetchThroughOptions, () => {
  let site: FixtureServer;
  let other: FixtureServer;

  const siteRoutes: Routes = {
    "/app.js": {
      headers: { "content-type": "text/javascript" },
      body: "console.log('app');",
    },
    "/private.js": { body: "secret" },
    "/redirect": { status: 302, headers: { location: "/target" } },
    "/hop1": { status: 302, headers: { location: "/hop2" } },
    "/hop2": { status: 302, headers: { location: "/hop3" } },
    "/hop3": { body: "end" },
    "/loop": { status: 302, headers: { location: "/loop" } },
    "/target": { body: "<p>target</p>" },
    "/big.js": { body: "x".repeat(2000) },
    "/exact.js": { body: "x".repeat(1000) },
    // 1,000 bytes in ten chunks, 30 ms apart, with no Content-Length.
    "/stream.js": {
      chunked: { chunk: "s".repeat(100), count: 10, everyMs: 30 },
    },
    // Promises 1,000 bytes and sends ten: the connection ends short.
    "/short.js": {
      headers: { "content-length": "1000", connection: "close" },
      body: "x".repeat(10),
    },
    "/form": { body: "ok" },
    "/limited.js": { status: 429, body: "slow down" },
    "/after.js": { body: "after" },
    "/forbidden.js": { status: 403, body: "no" },
    "/challenge": {
      status: 503,
      body: "<html><head><title>Just a moment...</title></head></html>",
    },
  };

  const otherRoutes: Routes = { "/lib.js": { body: "lib" } };

  beforeAll(async () => {
    site = await startFixtureServer(siteRoutes);
    other = await startFixtureServer(otherRoutes);
    siteRoutes["/away"] = {
      status: 302,
      headers: {
        location: `${other.origin.replace("localhost", "127.0.0.1")}/lib.js`,
      },
    };
  });

  afterAll(async () => {
    await site.close();
    await other.close();
  });

  it("fulfils a script with its status and bytes, sent with the hosted User-Agent and the signature", async () => {
    const { gate } = gateStub();
    const through = fetchThroughOptions(optionsWith(gate), `${site.origin}/`);

    const answer = await through(request(`${site.origin}/app.js`));

    expect({
      status: answer.kind === "fulfil" && answer.status,
      body: text(answer),
      type: header(answer, "content-type"),
    }).toStrictEqual({
      status: 200,
      body: "console.log('app');",
      type: "text/javascript",
    });

    const index = site.requests.lastIndexOf("/app.js");
    const sent = site.requestHeaders[index];

    // The browser's own headers go along, but not its User-Agent.
    expect({
      ua: sent?.["user-agent"],
      signature: sent?.["signature"],
      input: sent?.["signature-input"],
      accept: sent?.["accept"],
    }).toStrictEqual({
      ua: USER_AGENT,
      signature: "sig1=:test:",
      input: 'sig1=("@authority");tag="web-bot-auth"',
      accept: "*/*",
    });
  });

  it("fails a request the gate refuses as blocked by the client, and sends nothing", async () => {
    const { gate, asked } = gateStub(["/private.js"]);
    const through = fetchThroughOptions(optionsWith(gate), `${site.origin}/`);

    const answer = await through(request(`${site.origin}/private.js`));

    expect(answer).toStrictEqual({ kind: "fail", reason: "BlockedByClient" });
    expect(asked).toContain("/private.js");
    expect(site.requests).not.toContain("/private.js");
  });

  it("walks a redirect itself, asking the gate and signing each hop, and fulfils the last answer", async () => {
    const { gate, asked } = gateStub();
    const through = fetchThroughOptions(optionsWith(gate), `${site.origin}/`);

    const answer = await through(
      request(`${site.origin}/redirect`, { resourceType: "image" })
    );

    expect({
      status: answer.kind === "fulfil" && answer.status,
      body: text(answer),
      location: header(answer, "location"),
    }).toStrictEqual({
      status: 200,
      body: "<p>target</p>",
      location: undefined,
    });
    expect(asked).toStrictEqual(["/redirect", "/target"]);

    const hop = site.requestHeaders[site.requests.lastIndexOf("/target")];

    expect({
      ua: hop?.["user-agent"],
      signature: hop?.["signature"],
    }).toStrictEqual({ ua: USER_AGENT, signature: "sig1=:test:" });
  });

  it("fails a redirect whose next hop the gate refuses, and sends that hop nothing", async () => {
    const { gate } = gateStub(["/target"]);
    const through = fetchThroughOptions(optionsWith(gate), `${site.origin}/`);
    const before = site.requests.filter((p) => p === "/target").length;

    await expect(
      through(request(`${site.origin}/redirect`))
    ).resolves.toStrictEqual({ kind: "fail", reason: "BlockedByClient" });
    expect(site.requests.filter((p) => p === "/target")).toHaveLength(before);
  });

  it("fails a redirect walk past maxRedirects, and a loop", async () => {
    const { gate } = gateStub();

    const through = fetchThroughOptions(
      optionsWith(gate, { maxRedirects: 1 }),
      `${site.origin}/`
    );

    const before = site.requests.filter((p) => p === "/hop3").length;

    await expect(
      through(request(`${site.origin}/hop1`))
    ).resolves.toStrictEqual({ kind: "fail", reason: "Failed" });
    expect(site.requests.filter((p) => p === "/hop3")).toHaveLength(before);
    await expect(
      through(request(`${site.origin}/loop`))
    ).resolves.toStrictEqual({ kind: "fail", reason: "Failed" });
  });

  it("carries neither the user's headers nor the browser's cookie along a redirect to another origin", async () => {
    const { gate } = gateStub();

    const through = fetchThroughOptions(
      optionsWith(gate, { headers: { Authorization: SECRET } }),
      `${site.origin}/`
    );

    const answer = await through(
      request(`${site.origin}/away`, {
        headers: { accept: "*/*", cookie: "session=1" },
      })
    );

    expect(text(answer)).toBe("lib");

    const first = site.requestHeaders[site.requests.lastIndexOf("/away")];
    const hop = other.requestHeaders[other.requests.lastIndexOf("/lib.js")];

    expect({
      auth: first?.["authorization"],
      cookie: first?.["cookie"],
    }).toStrictEqual({ auth: SECRET, cookie: "session=1" });
    expect({
      auth: hop?.["authorization"],
      cookie: hop?.["cookie"],
      signature: hop?.["signature"],
    }).toStrictEqual({
      auth: undefined,
      cookie: undefined,
      signature: "sig1=:test:",
    });
  });

  it("asks the navigation's gate for the page's own navigation, and the subresources' gate for the rest", async () => {
    const own = gateStub();
    const sub = gateStub();

    const through = fetchThroughOptions(
      optionsWith(own.gate, { subresourceGate: sub.gate }),
      `${site.origin}/`
    );

    await through(
      request(`${site.origin}/target`, {
        resourceType: "document",
        navigation: true,
      })
    );
    await through(request(`${site.origin}/app.js`));
    // A frame's document is no navigation of the page.
    await through(request(`${site.origin}/hop3`, { resourceType: "document" }));

    expect({ own: own.asked, sub: sub.asked }).toStrictEqual({
      own: ["/target"],
      sub: ["/app.js", "/hop3"],
    });
  });

  it("fails a body over maxBodyBytes, and fulfils one at the cap", async () => {
    const { gate } = gateStub();

    const through = fetchThroughOptions(
      optionsWith(gate, { maxBodyBytes: 1000 }),
      `${site.origin}/`
    );

    await expect(
      through(request(`${site.origin}/big.js`))
    ).resolves.toStrictEqual({
      kind: "fail",
      reason: "Failed",
    });
    expect(
      text(await through(request(`${site.origin}/exact.js`)))
    ).toHaveLength(1000);
  });

  it("times out at timeoutMs", async () => {
    siteRoutes["/slow.js"] = { body: "slow", delaysMs: [500] };
    const { gate } = gateStub();

    const through = fetchThroughOptions(
      optionsWith(gate, { timeoutMs: 50 }),
      `${site.origin}/`
    );

    await expect(
      through(request(`${site.origin}/slow.js`))
    ).resolves.toStrictEqual({
      kind: "fail",
      reason: "TimedOut",
    });
  });

  it("fails a request the network cannot send", async () => {
    const { gate } = gateStub();
    const through = fetchThroughOptions(optionsWith(gate), `${site.origin}/`);

    await expect(
      through(request("http://127.0.0.1:1/nothing.js"))
    ).resolves.toStrictEqual({
      kind: "fail",
      reason: "Failed",
    });
  });

  it("sends the user's headers to the page's origin and not to another", async () => {
    const { gate } = gateStub();

    const through = fetchThroughOptions(
      optionsWith(gate, { headers: { Authorization: SECRET } }),
      `${site.origin}/`
    );

    await through(request(`${site.origin}/app.js`));
    await through(
      request(`${other.origin.replace("localhost", "127.0.0.1")}/lib.js`)
    );

    const own = site.requests.lastIndexOf("/app.js");
    const third = other.requests.lastIndexOf("/lib.js");

    expect(site.requestHeaders[own]?.["authorization"]).toBe(SECRET);
    expect(other.requestHeaders[third]?.["authorization"]).toBeUndefined();
  });

  it("fails a request whose answer the gate refuses as blocked by the client", async () => {
    const { gate } = gateStub();

    const through = fetchThroughOptions(
      optionsWith({
        ...gate,
        afterResponse: (url, response) =>
          response.status === 403
            ? { scope: "url", reason: "http_403", message: `${url.href} 403.` }
            : undefined,
      }),
      `${site.origin}/`
    );

    await expect(
      through(request(`${site.origin}/forbidden.js`))
    ).resolves.toStrictEqual({ kind: "fail", reason: "BlockedByClient" });
  });

  it("fails a document the gate refuses once it reads the page, and not a script", async () => {
    const { gate } = gateStub();

    const through = fetchThroughOptions(
      optionsWith({
        ...gate,
        afterBody: (url, page) =>
          page.status === 503 && page.body?.includes("Just a moment")
            ? { scope: "host", reason: "challenge", message: "Challenge." }
            : undefined,
      }),
      `${site.origin}/`
    );

    // The script first: the challenge refuses the whole host once a document shows it.
    const script = await through(request(`${site.origin}/challenge`));

    expect(script.kind).toBe("fulfil");
    await expect(
      through(request(`${site.origin}/challenge`, { resourceType: "document" }))
    ).resolves.toStrictEqual({ kind: "fail", reason: "BlockedByClient" });
  });

  it("records a refusal, so a host that answered 429 is sent nothing more", async () => {
    const { gate } = gateStub();
    const refusals = trackRefusals();

    const through = fetchThroughOptions(
      optionsWith({
        ...gate,
        afterResponse: (url, response) =>
          response.status === 429
            ? { scope: "host", reason: "http_429", message: `${url.host} 429.` }
            : undefined,
      }),
      `${site.origin}/`,
      { refusals }
    );

    await expect(
      through(request(`${site.origin}/limited.js`))
    ).resolves.toStrictEqual({ kind: "fail", reason: "BlockedByClient" });
    await expect(
      through(request(`${site.origin}/after.js`))
    ).resolves.toStrictEqual({
      kind: "fail",
      reason: "BlockedByClient",
    });
    expect(site.requests).not.toContain("/after.js");
    expect(refusals.of(`${site.origin}/after.js`)?.reason).toBe("http_429");
  });

  it("sends GET and HEAD only: any other method is blocked and sends nothing", async () => {
    const { gate, asked } = gateStub();
    const through = fetchThroughOptions(optionsWith(gate), `${site.origin}/`);
    const before = site.requests.filter((p) => p === "/form").length;

    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- one method at a time
      await expect(
        through(
          request(`${site.origin}/form`, { method, resourceType: "fetch" })
        )
      ).resolves.toStrictEqual({ kind: "fail", reason: "BlockedByClient" });
    }

    expect(asked).toStrictEqual([]);
    expect(site.requests.filter((p) => p === "/form")).toHaveLength(before);

    const head = await through(
      request(`${site.origin}/form`, { method: "HEAD", resourceType: "fetch" })
    );

    expect(head.kind === "fulfil" && head.status).toBe(200);
  });

  it("blocks a render's requests past maxRequests, a redirect's hops counted, and sends them nothing", async () => {
    const { gate } = gateStub();

    const through = fetchThroughOptions(optionsWith(gate), `${site.origin}/`, {
      maxRequests: 3,
    });

    // Two requests: /redirect and its hop to /target.
    const walked = await through(request(`${site.origin}/redirect`));
    const script = await through(request(`${site.origin}/app.js`));

    expect([walked.kind, script.kind]).toStrictEqual(["fulfil", "fulfil"]);

    const before = site.requests.length;

    await expect(
      through(request(`${site.origin}/after.js`))
    ).resolves.toStrictEqual({ kind: "fail", reason: "BlockedByClient" });
    expect(site.requests).toHaveLength(before);
  });

  it("blocks an answer past the bytes in flight, until the browser has the ones before it", async () => {
    const { gate } = gateStub();

    const through = fetchThroughOptions(optionsWith(gate), `${site.origin}/`, {
      maxBytesInFlight: 1500,
    });

    const first = await through(request(`${site.origin}/exact.js`));

    expect(first.kind).toBe("fulfil");
    await expect(
      through(request(`${site.origin}/exact.js`))
    ).resolves.toStrictEqual({ kind: "fail", reason: "BlockedByClient" });

    through.delivered(first);
    // Told twice, it lets go once.
    through.delivered(first);

    const third = await through(request(`${site.origin}/exact.js`));

    expect(third.kind).toBe("fulfil");
    await expect(
      through(request(`${site.origin}/exact.js`))
    ).resolves.toStrictEqual({ kind: "fail", reason: "BlockedByClient" });
  });

  it("counts a body's bytes as they arrive, so reads side by side stop at the cap while they stream", async () => {
    const { gate } = gateStub();

    const through = fetchThroughOptions(optionsWith(gate), `${site.origin}/`, {
      maxBytesInFlight: 1500,
    });

    let most = 0;

    const sample = setInterval(() => {
      most = Math.max(most, through.held());
    }, 1);

    const started = Date.now();

    const answers = await Promise.all(
      [1, 2, 3].map(async () => {
        const answer = await through(request(`${site.origin}/stream.js`));

        return { answer, ms: Date.now() - started };
      })
    );

    clearInterval(sample);

    const fulfilled = answers.filter(({ answer }) => answer.kind === "fulfil");

    const blocked = answers.filter(
      ({ answer }) =>
        answer.kind === "fail" && answer.reason === "BlockedByClient"
    );

    const [answered] = fulfilled;
    const heldBeforeDelivery = through.held();

    through.delivered(answered?.answer ?? NO_ANSWER);

    expect({
      fulfilled: fulfilled.length,
      blocked: blocked.length,
      body: text(answered?.answer ?? NO_ANSWER),
      // The two over the cap stopped while their bodies were still streaming, well before the
      // last chunk of the one that was answered.
      stoppedEarly: blocked.every(({ ms }) => ms < (answered?.ms ?? 0) - 50),
      withinCap: most <= 1500,
      heldBeforeDelivery,
    }).toStrictEqual({
      fulfilled: 1,
      blocked: 2,
      body: "s".repeat(1000),
      stoppedEarly: true,
      withinCap: true,
      heldBeforeDelivery: 1000,
    });
    expect(through.held()).toBe(0);
  });

  it("lets go of what a request held once it fails, over maxBodyBytes, cut short or timed out", async () => {
    const { gate } = gateStub();

    const through = fetchThroughOptions(
      optionsWith(gate, { maxBodyBytes: 1000, timeoutMs: 100 }),
      `${site.origin}/`,
      { maxBytesInFlight: 1500 }
    );

    const after: [BrowserAnswer, number][] = [];

    for (const path of ["/big.js", "/short.js", "/stream.js"]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- one after another, so each lets go before the next
      const answer = await through(request(`${site.origin}${path}`));
      after.push([answer, through.held()]);
    }

    expect(after).toStrictEqual([
      [{ kind: "fail", reason: "Failed" }, 0],
      [{ kind: "fail", reason: "Failed" }, 0],
      [{ kind: "fail", reason: "TimedOut" }, 0],
    ]);

    // A body whose Content-Length does not fit beside what is held is blocked before it is read.
    const first = await through(request(`${site.origin}/exact.js`));

    expect([first.kind, through.held()]).toStrictEqual(["fulfil", 1000]);
    await expect(
      through(request(`${site.origin}/exact.js`))
    ).resolves.toStrictEqual({ kind: "fail", reason: "BlockedByClient" });
    expect(through.held()).toBe(1000);
  });

  it("counts the robots.txt a gate that reads it requests for each new host as one more request", async () => {
    const { gate } = gateStub();

    const reading: RequestGate = {
      ...gate,
      robotsTxt: () => Promise.reject(new Error("not read here")),
    };

    const through = fetchThroughOptions(
      optionsWith(reading),
      `${site.origin}/`,
      { maxRequests: 4 }
    );

    // The site's first request is two (its robots.txt and the script), the next one.
    const app = await through(request(`${site.origin}/app.js`));
    const after = await through(request(`${site.origin}/after.js`));

    expect([app.kind, after.kind]).toStrictEqual(["fulfil", "fulfil"]);

    const before = other.requests.length;

    // Another host's first request would be the fifth and sixth.
    await expect(
      through(request(`${other.origin}/lib.js`))
    ).resolves.toStrictEqual({ kind: "fail", reason: "BlockedByClient" });
    expect(other.requests).toHaveLength(before);
  });
});

describe(answerRoute, () => {
  it("fulfils with the status, the headers and the body, each set-cookie on its own line", async () => {
    const { route, calls } = fakeRoute();
    const body = new TextEncoder().encode("hi");

    await answerRoute(route, {
      kind: "fulfil",
      status: 302,
      headers: [
        { name: "location", value: "/target" },
        { name: "set-cookie", value: "a=1" },
        { name: "set-cookie", value: "b=2" },
      ],
      body,
    });

    expect(calls).toStrictEqual([
      [
        "fulfill",
        {
          status: 302,
          headers: { location: "/target", "set-cookie": "a=1\nb=2" },
          body: Buffer.from(body),
        },
      ],
    ]);
  });

  it("aborts with Playwright's error code for each failure", async () => {
    const { route, calls } = fakeRoute();

    await answerRoute(route, { kind: "fail", reason: "BlockedByClient" });
    await answerRoute(route, { kind: "fail", reason: "Failed" });
    await answerRoute(route, { kind: "fail", reason: "TimedOut" });

    expect(calls).toStrictEqual([
      ["abort", "blockedbyclient"],
      ["abort", "failed"],
      ["abort", "timedout"],
    ]);
  });
});
