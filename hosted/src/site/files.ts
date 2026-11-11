/**
 * The website's files besides its pages: robots.txt, the sitemap, llms.txt and the pages' script,
 * which the hosted server's pages load too.
 */
import { PRODUCT_NAME } from "../../../src/brand.js";
import { HOSTED_LIMITS, LOCAL_SERVER } from "../../../src/core/hosted.js";
import { ORIGIN as MCP_ORIGIN } from "../limits.js";
import { icon } from "../ui/icons.js";
import { SITE_ORIGIN } from "./layout.js";

/**
 * /audit answers a form, and its answer is a report nobody else should find. /share/ stays open:
 * X, LinkedIn and Bluesky fetch a shared result's page and image to draw its card, and the page
 * keeps itself out of search with noindex.
 */
export const SITE_ROBOTS_TXT = `User-agent: *\nDisallow: /audit\n\nSitemap: ${SITE_ORIGIN}/sitemap.xml\n`;

export const SITEMAP_XML = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url><loc>${SITE_ORIGIN}/</loc></url>
<url><loc>${SITE_ORIGIN}/rules</loc></url>
</urlset>
`;

export const LLMS_TXT = `# ${PRODUCT_NAME}

> An open source SEO and AEO audit for coding agents, by RIVI Software. It audits a URL, a crawl of a site, a directory of built HTML or an HTML string, and returns findings with a rule id, a severity, a recommendation and the exact edits that fix them.

The SEO audit is for search engines; the AEO audit is for AI answer engines such as ChatGPT search, Claude, Perplexity and Google AI Overviews. Each has its own rules and its own score. Neither uses an AI model.

## Use it

- [Audit a page or a site in the browser](${SITE_ORIGIN}/): one public page, or a site's homepage for a crawl of up to ${HOSTED_LIMITS.maxPages} pages, free
- [The hosted MCP server](${MCP_ORIGIN}/): \`${MCP_ORIGIN}/mcp\`, free, with no account and no key
- [The package on npm](https://www.npmjs.com/package/@rivi-software/agentic-seo-check): the command \`npx @rivi-software/agentic-seo-check audit <url>\` and the local MCP server \`${LOCAL_SERVER}\`

## Reference

- [The rules](${SITE_ORIGIN}/rules): every rule, its severity and what it recommends
- [The README](https://github.com/rivi-software/agentic-seo-check#readme): the commands, the MCP tools and their options
- [For site owners](${MCP_ORIGIN}/crawler): what the audit's requests are and how to block them
`;

/**
 * The pages' script, served at /site.js on both hostnames so that the Content-Security-Policy
 * needs no inline script. It gives every command and snippet marked data-copy a button that copies
 * it, waits for Turnstile's token before the audit form is sent, shows that an audit or a crawl is
 * running, gives the report as a JSON file or as Markdown on the clipboard, and adds the system's
 * share sheet to the report's Share menu. Without it every page still reads and works, but the
 * form. It runs once the page is read to its end, so after a crawl's streamed answer.
 */
export const SITE_JS = `(() => {
  const COPY = ${JSON.stringify(`${icon("copy")}<span class="sr-only">Copy</span>`)};
  const COPIED = ${JSON.stringify(`${icon("check")}<span class="sr-only">Copied</span>`)};

  // Shows \`text\` on a button for two seconds, then what it said before.
  const say = (button, text) => {
    const label = button.querySelector(".btn-label") || button;
    const before = label.textContent;
    label.textContent = text;
    setTimeout(() => {
      label.textContent = before;
    }, 2000);
  };

  for (const block of document.querySelectorAll("[data-copy]")) {
    const code = block.querySelector("code") || block;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "copy";
    button.innerHTML = COPY;

    button.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(code.textContent);
        button.classList.add("is-copied");
        button.innerHTML = COPIED;
        setTimeout(() => {
          button.classList.remove("is-copied");
          button.innerHTML = COPY;
        }, 1600);
      } catch {
        button.title = "Could not copy";
      }
    });

    // A <pre> scrolls, which would take the button with it: it goes beside the <pre> instead.
    if (block.tagName === "PRE") {
      const holder = document.createElement("div");
      holder.className = "copyable";
      block.replaceWith(holder);
      holder.append(block, button);
    } else {
      block.append(button);
    }
  }

  const form = document.querySelector("#audit[data-check]");

  if (form) {
    const button = form.querySelector('button[type="submit"]');
    const label = button.querySelector(".btn-label");
    const text = label.dataset.idle || label.textContent;
    let waiting = false;

    // A homepage gets a crawl of its site when the form crawls: the address as the server reads it.
    const crawls = () => {
      const typed = form.querySelector('[name="url"]').value.trim();

      try {
        const url = new URL(typed.includes("://") ? typed : "https://" + typed);
        return form.dataset.crawls === "on" && url.pathname === "/" && !url.search;
      } catch {
        return false;
      }
    };

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
      button.classList.add("is-busy");
      label.textContent = crawls() ? "Crawling the site…" : "Auditing…";
    });

    // A page restored from the back/forward cache still has the button as it was left, and a
    // crawl's answer has it busy until the report is in.
    window.addEventListener("pageshow", () => {
      waiting = false;
      button.disabled = false;
      button.classList.remove("is-busy");
      label.textContent = text;
    });
  }

  // The report's Share menu: the system's share sheet where the browser has one, and the menu
  // closes on a click outside it or on Escape.
  const menus = document.querySelectorAll(".share-menu");

  for (const button of document.querySelectorAll("[data-share-url]")) {
    if (navigator.share) {
      button.hidden = false;
      button.addEventListener("click", async () => {
        try {
          await navigator.share({
            text: button.dataset.shareText,
            url: button.dataset.shareUrl,
          });
        } catch {
          // The person closed the sheet, or the browser refused it: nothing to show.
        }
      });
    }
  }

  document.addEventListener("click", (event) => {
    for (const menu of menus) {
      if (menu.open && !menu.contains(event.target)) {
        menu.open = false;
      }
    }
  });

  document.addEventListener("keydown", (event) => {
    for (const menu of menus) {
      if (event.key === "Escape" && menu.open) {
        menu.open = false;
        menu.querySelector("summary").focus();
      }
    }
  });

  const source = document.querySelector("#report-data");

  if (source) {
    const data = JSON.parse(source.textContent);

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
