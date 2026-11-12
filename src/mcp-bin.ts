#!/usr/bin/env node
import { PRODUCT_NAME } from "./brand.js";
import { errorText } from "./help.js";
import { startMcpServer } from "./mcp.js";
import { announceMcpServer } from "./screens.js";
import { localMcpTelemetry } from "./telemetry/local.js";
import { colorFor } from "./terminal.js";

const analytics = await localMcpTelemetry();

try {
  await startMcpServer({ analytics });
} catch (error) {
  process.stderr.write(
    errorText(
      `The ${PRODUCT_NAME} MCP server failed to start: ${error instanceof Error ? error.message : String(error)}`,
      colorFor(process.stderr)
    )
  );
  await analytics?.crashed(error);
  process.exit(1);
}

announceMcpServer();
