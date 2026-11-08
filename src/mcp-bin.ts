#!/usr/bin/env node
import { startMcpServer } from "./mcp.js";

try {
  await startMcpServer();
} catch (error) {
  process.stderr.write(
    `agentic-seo-check MCP server failed to start: ${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exit(1);
}
