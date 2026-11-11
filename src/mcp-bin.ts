#!/usr/bin/env node
import { PRODUCT_NAME } from "./brand.js";
import { startMcpServer } from "./mcp.js";
import { localMcpTelemetry } from "./telemetry/local.js";

const analytics = await localMcpTelemetry();

try {
  await startMcpServer({ analytics });
} catch (error) {
  process.stderr.write(
    `The ${PRODUCT_NAME} MCP server failed to start: ${error instanceof Error ? error.message : String(error)}\n`
  );
  await analytics?.crashed(error);
  process.exit(1);
}
