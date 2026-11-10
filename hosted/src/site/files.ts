/**
 * The website's files besides its pages: robots.txt, the sitemap, llms.txt and the script of the
 * audit form and the report's buttons.
 */
import { LOCAL_SERVER } from "../../../src/core/hosted.js";
import { ORIGIN as MCP_ORIGIN } from "../limits.js";
import { SITE_ORIGIN } from "./layout.js";

/** /audit answers a form, and its answer is a report nobody else should find. */
export const SITE_ROBOTS_TXT = `User-agent: *\nDisallow: /audit\n\nSitemap: ${SITE_ORIGIN}/sitemap.xml\n`;

export const SITEMAP_XML = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url><loc>${SITE_ORIGIN}/</loc></url>
<url><loc>${SITE_ORIGIN}/rules</loc></url>
</urlset>
`;

export const LLMS_TXT = `# agentic-seo-check

> An open source SEO and AEO audit for coding agents, by RIVI Software. It audits a URL, a crawl of a site, a directory of built HTML or an HTML string, and returns findings with a rule id, a severity, a recommendation and the exact edits that fix them.

The SEO audit is for search engines; the AEO audit is for AI answer engines such as ChatGPT search, Claude, Perplexity and Google AI Overviews. Each has its own rules and its own score. Neither uses an AI model.

## Use it

- [Audit a page in the browser](${SITE_ORIGIN}/): one public page per run, free
- [The hosted MCP server](${MCP_ORIGIN}/): \`${MCP_ORIGIN}/mcp\`, free, with no account and no key
- [The package on npm](https://www.npmjs.com/package/@rivi-software/agentic-seo-check): the command \`npx @rivi-software/agentic-seo-check audit <url>\` and the local MCP server \`${LOCAL_SERVER}\`

## Reference

- [The rules](${SITE_ORIGIN}/rules): every rule, its severity and what it recommends
- [The README](https://github.com/rivi-software/agentic-seo-check#readme): the commands, the MCP tools and their options
- [For site owners](${MCP_ORIGIN}/crawler): what the audit's requests are and how to block them
`;

/**
 * The page's script, served at /site.js so that the Content-Security-Policy needs no inline
 * script. It waits for Turnstile's token before the form is sent, shows that an audit is running,
 * and gives the report as a JSON file or as Markdown on the clipboard.
 */
export const SITE_JS = `(() => {
  const form = document.querySelector("#audit[data-check]");

  if (form) {
    const button = form.querySelector("button");
    const label = button.textContent;
    let waiting = false;

    const token = () => {
      const field = form.querySelector('[name="cf-turnstile-response"]');
      return field ? field.value : "";
    };

    // Turnstile calls this by name once it has a token.
    window.onAuditToken = () => {
      if (waiting) {
        waiting = false;
        form.submit();
      }
    };

    form.addEventListener("submit", (event) => {
      if (!token()) {
        event.preventDefault();
        waiting = true;
      }

      button.disabled = true;
      button.textContent = "Auditing…";
    });

    // A page restored from the back/forward cache still has the button as it was left.
    window.addEventListener("pageshow", () => {
      waiting = false;
      button.disabled = false;
      button.textContent = label;
    });
  }

  const source = document.querySelector("#report-data");

  if (source) {
    const data = JSON.parse(source.textContent);

    const say = (button, text) => {
      const label = button.textContent;
      button.textContent = text;
      setTimeout(() => {
        button.textContent = label;
      }, 2000);
    };

    for (const button of document.querySelectorAll("[data-report]")) {
      button.addEventListener("click", async () => {
        if (button.dataset.report === "download") {
          const file = new Blob([JSON.stringify(data.json, null, 2)], {
            type: "application/json",
          });
          const link = document.createElement("a");
          link.href = URL.createObjectURL(file);
          link.download = "agentic-seo-check-" + data.name + ".json";
          link.click();
          URL.revokeObjectURL(link.href);
          return;
        }

        try {
          await navigator.clipboard.writeText(data.markdown);
          say(button, "Copied");
        } catch {
          say(button, "Could not copy");
        }
      });
    }

    document.querySelector("#report").scrollIntoView();
  }
})();
`;
