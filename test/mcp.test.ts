import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { assert, describe, expect, it } from "vitest";
import { z } from "zod";

import { createMcpServer } from "../src/mcp.js";
import { VERSION } from "../src/version.js";

const connect = async () => {
  const server = createMcpServer();
  const client = new Client({ name: "test-client", version: "0.0.0" });

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  return { client, server };
};

/** The text of a tool result's first content block, which these tools always answer as text. */
const firstText = (result: Awaited<ReturnType<Client["callTool"]>>) => {
  const [first] = CallToolResultSchema.parse(result).content;
  assert(first?.type === "text", "the first content block is text");

  return first.text;
};

const PageAuditContent = z.object({
  kind: z.string(),
  findings: z.array(z.object({ rule: z.string(), severity: z.string() })),
  score: z.number(),
});

const RuleListContent = z.object({
  count: z.number(),
  rules: z.array(z.object({ id: z.string() })),
});

describe("MCP server", () => {
  it("names itself with its version, its maker and the RIVI mark", async () => {
    const { client } = await connect();
    const info = client.getServerVersion();

    expect(info).toMatchObject({
      name: "agentic-seo-check",
      title: "agentic-seo-check by RIVI Software",
      version: VERSION,
      websiteUrl: "https://github.com/rivi-software/agentic-seo-check",
    });
    expect(info?.icons?.map((icon) => icon.theme)).toStrictEqual([
      "light",
      "dark",
    ]);
  });

  it("lists the SEO tools with annotations", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).toSorted();
    expect(names).toStrictEqual([
      "seo_aeo_audit",
      "seo_audit_directory",
      "seo_audit_page",
      "seo_crawl_site",
      "seo_lighthouse",
      "seo_list_rules",
    ]);
    const page = tools.find((t) => t.name === "seo_audit_page");
    assert(page, "seo_audit_page is listed");
    expect(page.annotations?.readOnlyHint).toBeTruthy();
    expect(page.inputSchema).toMatchObject({ type: "object" });
    expect(JSON.stringify(page.inputSchema)).toContain('"render"');
  });

  it("audits inline HTML and returns structured content", async () => {
    const { client } = await connect();

    const result = await client.callTool({
      name: "seo_audit_page",
      arguments: {
        html: "<html><head><title>React App</title></head><body></body></html>",
        baseUrl: "https://a.test/",
        includeInfo: false,
      },
    });

    expect(result.isError).toBeFalsy();
    const structured = PageAuditContent.parse(result.structuredContent);
    expect(structured.kind).toBe("page");
    expect(structured.findings.map((f) => f.rule)).toContain("title.generic");
    expect(
      structured.findings.every((f) => f.severity !== "info")
    ).toBeTruthy();
    expect(JSON.parse(firstText(result)).score).toBe(structured.score);
  });

  it("returns markdown when asked", async () => {
    const { client } = await connect();

    const result = await client.callTool({
      name: "seo_audit_page",
      arguments: {
        html: "<html><head></head><body></body></html>",
        format: "markdown",
      },
    });

    expect(firstText(result)).toContain("# SEO audit");
  });

  it("lists and filters rules", async () => {
    const { client } = await connect();

    const result = await client.callTool({
      name: "seo_list_rules",
      arguments: { rule: "title.missing" },
    });

    const structured = RuleListContent.parse(result.structuredContent);
    expect(structured.count).toBe(1);
    expect(structured.rules[0]?.id).toBe("title.missing");
  });

  it("runs an AEO audit of inline HTML", async () => {
    const { client } = await connect();

    const result = await client.callTool({
      name: "seo_aeo_audit",
      arguments: {
        html: '<html><head><meta name="robots" content="nosnippet"></head><body><div id="root"></div></body></html>',
        baseUrl: "https://a.test/page",
      },
    });

    expect(result.isError).toBeFalsy();
    const structured = PageAuditContent.parse(result.structuredContent);
    expect(structured.kind).toBe("aeo");
    expect(structured.findings.map((f) => f.rule)).toStrictEqual([
      "aeo.nosnippet",
      "aeo.text-needs-javascript",
    ]);
  });

  it("asks for exactly one AEO target", async () => {
    const { client } = await connect();

    const none = await client.callTool({
      name: "seo_aeo_audit",
      arguments: {},
    });

    const both = await client.callTool({
      name: "seo_aeo_audit",
      arguments: { html: "<p>x</p>", dir: "." },
    });

    expect(none.isError).toBeTruthy();
    expect(both.isError).toBeTruthy();
  });

  it("reports errors as isError results", async () => {
    const { client } = await connect();

    const result = await client.callTool({
      name: "seo_audit_page",
      arguments: {},
    });

    expect(result.isError).toBeTruthy();
  });
});
