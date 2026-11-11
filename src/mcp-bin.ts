#!/usr/bin/env node
import { PRODUCT_NAME } from "./brand.js";
import { startMcpServer } from "./mcp.js";

try {
  await startMcpServer();
} catch (error) {
  process.stderr.write(
    `The ${PRODUCT_NAME} MCP server failed to start: ${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exit(1);
}
