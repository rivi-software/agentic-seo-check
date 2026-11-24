import { afterEach, describe, expect, it, vi } from "vitest";

import { LabUnavailableError } from "../../src/core/psi.ts";
import lhr from "../../test/fixtures/psi-lhr.json";
import { labRunner } from "../src/psi.ts";

const ORIGIN = "https://agentic-seo.org";
const PAGE = "https://shop.example.com/";

/** The Cache API in memory: the caches opened, by name, and the addresses each keeps. */
const fakeCaches = () => {
  const opened: string[] = [];
  const kept = new Map<string, Map<string, string>>();
  const cacheControl: (string | null)[] = [];

  vi.stubGlobal("caches", {
    // oxlint-disable-next-line eslint/require-await -- the Cache API answers with a promise
    open: async (name: string) => {
      opened.push(name);

      const entries = kept.get(name) ?? new Map<string, string>();
      kept.set(name, entries);

      return {
        match: (key: string) => {
          const text = entries.get(key);

          return Promise.resolve(
            text === undefined ? undefined : new Response(text)
          );
        },
        put: async (key: string, res: Response) => {
          cacheControl.push(res.headers.get("cache-control"));
          entries.set(key, await res.text());
        },
      };
    },
  });

  return { opened, kept, cacheControl };
};

/** A PageSpeed Insights that answers with the fixture's result, and the runner that asks it. */
const stubbed = () => {
  const fetcher = vi.fn<typeof fetch>(() =>
    Promise.resolve(Response.json({ lighthouseResult: lhr }))
  );

  vi.stubGlobal("fetch", fetcher);

  return { fetcher, lab: labRunner({ PSI_API_KEY: "test-key" }, ORIGIN) };
};

describe("the hosted server's lab (issue #222)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("asks PageSpeed Insights once for the same URL and strategy, from the psi cache", async () => {
    const { opened } = fakeCaches();
    const { fetcher, lab } = stubbed();

    const first = await lab(PAGE, "mobile");
    const second = await lab(PAGE, "mobile");

    expect(fetcher).toHaveBeenCalledOnce();
    expect(second).toStrictEqual(first);
    expect(new Set(opened)).toStrictEqual(new Set(["psi"]));

    // Another strategy is another run.
    await lab(PAGE, "desktop");

    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("keeps each answer for ten minutes, not the day a CrUX answer is kept", async () => {
    const { cacheControl } = fakeCaches();
    const { lab } = stubbed();

    await lab(PAGE, "mobile");

    expect(cacheControl).toStrictEqual(["public, max-age=600"]);
  });

  it("keeps each answer at an address of its own origin that names neither the page nor the key", async () => {
    const { kept } = fakeCaches();
    const { lab } = stubbed();

    await lab(PAGE, "mobile");

    const keys = [...(kept.get("psi")?.keys() ?? [])];

    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(
      /^https:\/\/agentic-seo\.org\/\.psi-cache\/[\da-f]{64}$/u
    );
    expect(keys.join(" ")).not.toMatch(/shop\.example\.com|test-key/u);
  });

  it("says lab performance is not set up, and asks nothing, without a key", async () => {
    const fetcher = vi.fn<typeof fetch>();

    vi.stubGlobal("fetch", fetcher);

    const run = labRunner({}, ORIGIN)(PAGE, "mobile");

    await expect(run).rejects.toBeInstanceOf(LabUnavailableError);
    await expect(run).rejects.toThrow(
      "Lab performance is not set up on this server."
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
});
