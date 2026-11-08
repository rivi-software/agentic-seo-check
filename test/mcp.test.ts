import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { createMcpServer } from '../src/mcp.js';

async function connect() {
  const server = createMcpServer();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

describe('MCP server', () => {
  it('lists the SEO tools with annotations', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(['seo_audit_directory', 'seo_audit_page', 'seo_crawl_site', 'seo_lighthouse', 'seo_list_rules']);
    const page = tools.find((t) => t.name === 'seo_audit_page')!;
    expect(page.annotations?.readOnlyHint).toBe(true);
    expect(page.inputSchema).toMatchObject({ type: 'object' });
    expect(JSON.stringify(page.inputSchema)).toContain('"render"');
  });

  it('audits inline HTML and returns structured content', async () => {
    const { client } = await connect();
    const result = await client.callTool({ name: 'seo_audit_page', arguments: { html: '<html><head><title>React App</title></head><body></body></html>', baseUrl: 'https://a.test/', includeInfo: false } });
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as { kind: string; findings: { rule: string; severity: string }[]; score: number };
    expect(structured.kind).toBe('page');
    expect(structured.findings.map((f) => f.rule)).toContain('title.generic');
    expect(structured.findings.every((f) => f.severity !== 'info')).toBe(true);
    const text = (result.content as { type: string; text: string }[])[0]!.text;
    expect(JSON.parse(text).score).toBe(structured.score);
  });

  it('returns markdown when asked', async () => {
    const { client } = await connect();
    const result = await client.callTool({ name: 'seo_audit_page', arguments: { html: '<html><head></head><body></body></html>', format: 'markdown' } });
    const text = (result.content as { type: string; text: string }[])[0]!.text;
    expect(text).toContain('# SEO audit');
  });

  it('lists and filters rules', async () => {
    const { client } = await connect();
    const result = await client.callTool({ name: 'seo_list_rules', arguments: { rule: 'title.missing' } });
    const structured = result.structuredContent as { count: number; rules: { id: string }[] };
    expect(structured.count).toBe(1);
    expect(structured.rules[0]!.id).toBe('title.missing');
  });

  it('reports errors as isError results', async () => {
    const { client } = await connect();
    const result = await client.callTool({ name: 'seo_audit_page', arguments: {} });
    expect(result.isError).toBe(true);
  });
});
