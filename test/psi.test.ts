import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { ExpectedError } from "../src/core/errors.js";
import type { FieldDataCache } from "../src/core/field-data.js";
import type { LhrLike } from "../src/core/lighthouse.js";
import { LabUnavailableError, pageSpeedInsights } from "../src/core/psi.js";
import lhrJson from "./fixtures/psi-lhr.json" with { type: "json" };

const lhr: LhrLike = lhrJson;

const PAGE = "https://www.example.com/widgets/";

type Fetcher = typeof fetch;

const answering = (
  body: { lighthouseResult?: LhrLike; error?: { message?: string } },
  status = 200
) => vi.fn<Fetcher>(() => Promise.resolve(Response.json(body, { status })));

const ok = () => answering({ lighthouseResult: lhr });

/** The URL of the request a stubbed fetch got first. */
const askedUrl = (fetcher: ReturnType<typeof ok>): URL =>
  new URL(String(fetcher.mock.calls[0]?.[0]));

/** What a promise rejects with. */
const failure = async (run: Promise<unknown>): Promise<Error> => {
  try {
    await run;
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
  }

  throw new Error("It did not fail.");
};

const memory = () => {
  const store = new Map<string, string>();

  const cache: FieldDataCache = {
    get: (key) => Promise.resolve(store.get(key)),
    put: (key, value) => {
      store.set(key, value);

      return Promise.resolve();
    },
  };

  return { cache, store };
};

describe(pageSpeedInsights, () => {
  it("asks for the strategy, both categories and the key", async () => {
    const fetcher = ok();

    const result = await pageSpeedInsights(PAGE, "mobile", {
      apiKey: "k3y",
      fetch: fetcher,
    });

    const asked = askedUrl(fetcher);

    expect(result.lighthouseVersion).toBe("13.0.1");
    expect(asked.origin + asked.pathname).toBe(
      "https://www.googleapis.com/pagespeedonline/v5/runPagespeed"
    );
    expect(asked.searchParams.get("url")).toBe(PAGE);
    expect(asked.searchParams.get("strategy")).toBe("MOBILE");
    expect([
      ...asked.searchParams.getAll("category"),
      asked.searchParams.get("key"),
    ]).toStrictEqual(["PERFORMANCE", "SEO", "k3y"]);
  });

  it("asks for DESKTOP on a desktop audit", async () => {
    const fetcher = ok();

    await pageSpeedInsights(PAGE, "desktop", { apiKey: "k", fetch: fetcher });

    expect(askedUrl(fetcher).searchParams.get("strategy")).toBe("DESKTOP");
  });

  it("says a 429 is unavailable", async () => {
    const error = await failure(
      pageSpeedInsights(PAGE, "mobile", {
        apiKey: "k",
        fetch: answering({ error: {} }, 429),
      })
    );

    expect(error).toBeInstanceOf(LabUnavailableError);
  });

  it("says any other failed answer is unavailable, without the URL", async () => {
    const error = await failure(
      pageSpeedInsights(PAGE, "mobile", {
        apiKey: "k",
        fetch: answering({ error: {} }, 500),
      })
    );

    expect(error).toBeInstanceOf(LabUnavailableError);
    expect(error.message).not.toContain("example.com");
  });

  it("says a network failure is unavailable", async () => {
    const error = await failure(
      pageSpeedInsights(PAGE, "mobile", {
        apiKey: "k",
        fetch: () => Promise.reject(new TypeError("fetch failed")),
      })
    );

    expect(error).toBeInstanceOf(LabUnavailableError);
  });

  it("throws PSI's runtime error with the URL cleaned out", async () => {
    const runtimeError = {
      code: "FAILED_DOCUMENT_REQUEST",
      message: `Lighthouse was unable to reliably load the page you requested (${PAGE}). Status code: 500`,
    };

    const error = await failure(
      pageSpeedInsights(PAGE, "mobile", {
        apiKey: "k",
        fetch: answering({ lighthouseResult: { ...lhr, runtimeError } }),
      })
    );

    expect(error).toBeInstanceOf(ExpectedError);
    expect(error).not.toBeInstanceOf(LabUnavailableError);
    expect(error.message).toContain("FAILED_DOCUMENT_REQUEST");
    expect(error.message).not.toContain("example.com");
  });

  it("sends no request on a cache hit", async () => {
    const { cache, store } = memory();
    const fetcher = ok();

    await pageSpeedInsights(PAGE, "mobile", {
      apiKey: "k",
      cache,
      fetch: fetcher,
    });

    const again = await pageSpeedInsights(PAGE, "mobile", {
      apiKey: "k",
      cache,
      fetch: fetcher,
    });

    expect(fetcher).toHaveBeenCalledOnce();
    expect(store.size).toBe(1);
    expect(again.lighthouseVersion).toBe("13.0.1");
  });

  it("keeps an answer under a key with no URL and no API key", async () => {
    const { cache, store } = memory();

    await pageSpeedInsights(PAGE, "desktop", {
      apiKey: "secret-key",
      cache,
      fetch: ok(),
    });

    const [key = ""] = [...store.keys()];
    const hash = createHash("sha256").update(PAGE).digest("hex");

    expect(key).toContain(hash);
    expect(key).toContain("desktop");
    expect(key).not.toContain("example.com");
    expect(key).not.toContain("secret-key");
  });

  it("does not keep a failed answer", async () => {
    const { cache, store } = memory();

    await failure(
      pageSpeedInsights(PAGE, "mobile", {
        apiKey: "k",
        cache,
        fetch: answering({}, 429),
      })
    );

    expect(store.size).toBe(0);
  });

  it("asks again when the cache fails", async () => {
    const broken: FieldDataCache = {
      get: () => Promise.reject(new Error("down")),
      put: () => Promise.reject(new Error("down")),
    };

    const result = await pageSpeedInsights(PAGE, "mobile", {
      apiKey: "k",
      cache: broken,
      fetch: ok(),
    });

    expect(result.lighthouseVersion).toBe("13.0.1");
  });
});
