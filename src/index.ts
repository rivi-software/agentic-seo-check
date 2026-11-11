export * from "./core/types.js";

export {
  auditHtml,
  auditUrl,
  auditFile,
  auditSite,
  auditDirectory,
  auditTarget,
  compactAudit,
  rollupIssues,
  DEFAULT_CRAWL,
} from "./core/audit.js";

export type {
  AuditOptions,
  CrawlOptions,
  HtmlAuditInput,
  ProgressEvent,
} from "./core/audit.js";

export {
  auditAeoHtml,
  auditAeoUrl,
  auditAeoSite,
  auditAeoDirectory,
  auditAeoTarget,
  compactAeoAudit,
} from "./core/aeo/audit.js";

export type { AeoOptions } from "./core/aeo/audit.js";

export { AI_BOTS } from "./core/aeo/bots.js";

export type { AiBot } from "./core/aeo/bots.js";

export { extractPage } from "./core/html/extract.js";

export {
  ALL_RULES,
  AEO_PAGE_RULES,
  PAGE_RULES,
  findRule,
  runPageRules,
} from "./core/rules/index.js";

export { baselineFromAudit, baselineFromIds } from "./core/recheck.js";

export type { Baseline, BaselineEntry } from "./core/recheck.js";

export { renderAeoMarkdown, renderMarkdown } from "./core/report/markdown.js";

export {
  runLighthouse,
  LighthouseUnavailableError,
} from "./core/lighthouse.js";

export { renderPage, RenderUnavailableError } from "./core/render.js";

export {
  fetchPage,
  probeUrl,
  DEFAULT_USER_AGENT,
  RequestRefusedError,
} from "./core/fetch.js";

export type {
  FetchOptions,
  FetchResult,
  Refusal,
  RequestGate,
} from "./core/fetch.js";

export { createMcpServer, startMcpServer } from "./mcp.js";

export type {
  HostedCall,
  HostedCallEnd,
  HostedCallInfo,
  HostedProfile,
  McpServerOptions,
  StartMcpServerOptions,
} from "./mcp.js";

export type {
  McpAnalytics,
  McpCaller,
  McpErrorType,
  McpToolCall,
} from "./telemetry/mcp.js";
