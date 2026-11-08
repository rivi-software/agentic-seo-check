import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { MCP_ICONS } from "../src/brand.js";

const asset = (name: string) =>
  readFileSync(new URL(`../assets/${name}`, import.meta.url), "utf-8").trim();

const decoded = (src: string) =>
  Buffer.from(src.replace("data:image/svg+xml;base64,", ""), "base64").toString(
    "utf-8"
  );

describe("brand", () => {
  it("inlines the light-theme mark exactly as assets/rivi-mark.svg draws it", () => {
    const light = MCP_ICONS.find((icon) => icon.theme === "light");

    expect(light && decoded(light.src)).toBe(asset("rivi-mark.svg"));
  });

  it("inlines the dark-theme mark exactly as assets/rivi-mark-on-dark.svg draws it", () => {
    const dark = MCP_ICONS.find((icon) => icon.theme === "dark");

    expect(dark && decoded(dark.src)).toBe(asset("rivi-mark-on-dark.svg"));
  });

  it("keeps assets/icon.svg a copy of the light-theme mark", () => {
    expect(asset("icon.svg")).toBe(asset("rivi-mark.svg"));
  });
});
