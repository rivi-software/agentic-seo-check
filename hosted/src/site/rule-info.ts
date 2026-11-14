/**
 * What the rules index (rules-page.ts) and each rule's page (rule-page.ts) say about a rule beside
 * its metadata, and its address, which the reports link to (issue #171). All of it is built from
 * `ALL_RULES`: nothing is written for one rule by hand.
 */
import { findRule } from "../../../src/core/rules/index.js";
import type { Requirement, RuleMeta } from "../../../src/core/types.js";

/** The audit a rule belongs to: the AEO rules are one category, every other rule is SEO. */
type AuditKind = "seo" | "aeo";

export const auditOf = (rule: RuleMeta): AuditKind =>
  rule.category === "aeo" ? "aeo" : "seo";

export const AUDIT_LABEL: Record<AuditKind, string> = {
  seo: "SEO audit",
  aeo: "AEO audit",
};

/** The arguments of the MCP call that runs only one rule, with the option it needs. */
interface RuleCall {
  url: string;
  crawl?: boolean;
  render?: boolean;
  lighthouse?: boolean;
  fieldData?: boolean;
  keyword?: string;
  aiBots?: boolean;
  rules: string[];
}

/**
 * What a rule that does not run on every audit needs: its short name on a rule's label, when it
 * runs, whether it needs this machine (a browser, or requests from here), and the flag and the
 * argument that switch it on. A crawl has neither: the SEO audit crawls with a command of its own.
 */
export const REQUIREMENTS: Record<
  Requirement,
  {
    tag: string;
    when: string;
    local: boolean;
    option?: [flag: string, arg: Partial<RuleCall>];
  }
> = {
  render: {
    tag: "--render",
    when: "Runs with --render, on the command or the local server.",
    local: true,
    option: ["--render", { render: true }],
  },
  lighthouse: {
    tag: "--lighthouse",
    when: "Runs with --lighthouse, on the command or the local server.",
    local: true,
    option: ["--lighthouse", { lighthouse: true }],
  },
  "field-data": {
    tag: "--field-data",
    when: "Runs with --field-data (fieldData), on the command and both MCP servers, and in this site's audits: it reads the Chrome UX Report's real-user data.",
    local: false,
    option: ["--field-data", { fieldData: true }],
  },
  crawl: {
    tag: "crawl",
    when: "Runs on a crawl or a build directory.",
    local: false,
  },
  keyword: {
    tag: "keyword",
    when: "Runs when the audit is given a keyword.",
    local: false,
    option: ['--keyword "running shoes"', { keyword: "running shoes" }],
  },
  "ai-bots": {
    tag: "--ai-bots",
    when: "Runs with --ai-bots, on the command or the local server.",
    local: true,
    option: ["--ai-bots", { aiBots: true }],
  },
};

/** Where a rule can run: everywhere, or only where a browser or this machine is at hand. */
export const runsWhere = (rule: RuleMeta): string =>
  rule.requires && REQUIREMENTS[rule.requires].local
    ? "The command and the local MCP server"
    : "The command, both MCP servers and this site";

/** Where the rules' own pages are. Rule ids are lowercase letters, digits, dots and hyphens. */
export const RULES_PREFIX = "/rules/";

export const rulePath = (id: string): string => `${RULES_PREFIX}${id}`;

/** The page of a rule a finding names, when the rule has one: the audit's own findings have none. */
export const rulePathOf = (id: string): string | null =>
  findRule(id) ? rulePath(id) : null;

const PACKAGE = "npx @rivi-software/agentic-seo-check";
const EXAMPLE_URL = "https://example.com";

type Option = [flag: string, arg: Partial<RuleCall>];

const NO_OPTION: Option = ["", {}];

/** The CLI's command and the MCP tool that run `rule`, and the flag and argument it needs. */
const runnerOf = (
  rule: RuleMeta
): [verb: string, tool: string, ...option: Option] => {
  const aeo = auditOf(rule) === "aeo";

  if (rule.requires === "crawl") {
    // The AEO audit crawls with a flag, the SEO audit with a command of its own.
    return aeo
      ? ["aeo", "seo_aeo_audit", "--crawl", { crawl: true }]
      : ["crawl", "seo_crawl_site", ...NO_OPTION];
  }

  const option = rule.requires
    ? (REQUIREMENTS[rule.requires].option ?? NO_OPTION)
    : NO_OPTION;

  return aeo
    ? ["aeo", "seo_aeo_audit", ...option]
    : ["audit", "seo_audit_page", ...option];
};

/** The command line and the MCP call that run only a rule. */
interface RuleUsage {
  command: string;
  tool: string;
  args: RuleCall;
}

export const ruleUsage = (rule: RuleMeta): RuleUsage => {
  const [verb, tool, flag, arg] = runnerOf(rule);

  return {
    command: [PACKAGE, verb, EXAMPLE_URL, flag, `--rule ${rule.id}`]
      .filter(Boolean)
      .join(" "),
    tool,
    args: { url: EXAMPLE_URL, ...arg, rules: [rule.id] },
  };
};
