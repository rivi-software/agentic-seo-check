import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { MCP_ICONS } from "../src/brand.js";

const asset = (name: string) =>
  readFileSync(new URL(`../assets/${name}`, import.meta.url), "utf-8").trim();

const decoded = (src: string) =>
  Buffer.from(src.replace("data:image/svg+xml;base64,", ""), "base64").toString(
    "utf-8"
  );

const inner = (svg: string) =>
  svg.replace(/^<svg[^>]*>/u, "").replace(/<\/svg>$/u, "");

describe("brand", () => {
  it("inlines the light-theme icon exactly as assets/icon.svg draws it", () => {
    const light = MCP_ICONS.find((icon) => icon.theme === "light");

    expect(light && decoded(light.src)).toBe(asset("icon.svg"));
  });

  it("inlines the dark-theme icon exactly as assets/icon-on-dark.svg draws it", () => {
    const dark = MCP_ICONS.find((icon) => icon.theme === "dark");

    expect(dark && decoded(dark.src)).toBe(asset("icon-on-dark.svg"));
  });

  it("embeds the same icon geometry in both README lockups", () => {
    expect(asset("rivi-agentic-seo-check.svg")).toContain(
      inner(asset("icon.svg"))
    );
    expect(asset("rivi-agentic-seo-check-on-dark.svg")).toContain(
      inner(asset("icon-on-dark.svg"))
    );
  });
});
