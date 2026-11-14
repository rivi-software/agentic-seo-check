/**
 * The website's files besides its pages: robots.txt, the sitemap, llms.txt and the pages' script,
 * which the hosted server's pages, on the same hostname (issue #168), load too.
 */
import { PRODUCT_NAME } from "../../../src/brand.js";
import { HOSTED_LIMITS, LOCAL_SERVER } from "../../../src/core/hosted.js";
import { MCP_URL } from "../limits.js";
import { CLAUDE_DIRECTORY_URL } from "../ui/frame.js";
import { icon } from "../ui/icons.js";
import { SITE_ORIGIN } from "./layout.js";

/**
 * /audit answers a form, and its answer is a report nobody else should find. /share/ stays open:
 * X, LinkedIn and Bluesky fetch a shared result's page and image to draw its card, and the page
 * keeps itself out of search with noindex.
 *
 * Cloudflare's Bot Preference Sync, on for every host of rivi.software, where the site lived before
 * issue #168, puts a section before this file that disallows Google-Extended with the other AI
 * training crawlers. The group for Google-Extended here lets Gemini's app answers cite the site
 * (and Gemini train on it) wherever a zone puts such a section before it: a crawler's groups
 * combine, and an Allow wins over a Disallow as long (RFC 9309, sections 2.2.1 and 2.2.2), as
 * Google reads them too. It repeats Disallow: /audit, since a crawler with a group of its
 * own ignores the `*` group.
 */
export const SITE_ROBOTS_TXT = `User-agent: *\nDisallow: /audit\n\n# Gemini may cite this site: this group combines with the Disallow for Google-Extended above, and Allow wins (RFC 9309).\nUser-agent: Google-Extended\nAllow: /\nDisallow: /audit\n\nSitemap: ${SITE_ORIGIN}/sitemap.xml\n`;

export const SITEMAP_XML = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url><loc>${SITE_ORIGIN}/</loc></url>
<url><loc>${SITE_ORIGIN}/rules</loc></url>
<url><loc>${MCP_URL}</loc></url>
<url><loc>${SITE_ORIGIN}/crawler</loc></url>
</urlset>
`;

export const LLMS_TXT = `# ${PRODUCT_NAME}

> An open source SEO and AEO audit for coding agents, by RIVI Software. It audits a URL, a crawl of a site, a directory of built HTML or an HTML string, and returns findings with a rule id, a severity, a recommendation and the exact edits that fix them.

The SEO audit is for search engines; the AEO audit is for AI answer engines such as ChatGPT search, Claude, Perplexity and Google AI Overviews. Each has its own rules and its own score. Neither uses an AI model.

## Use it

- [Audit a page or a site in the browser](${SITE_ORIGIN}/): one public page, or a site's homepage for a crawl of up to ${HOSTED_LIMITS.maxPages} pages, free
- [The hosted MCP server](${MCP_URL}): \`${MCP_URL}\`, free, with no account and no key
- [The hosted MCP server in the Claude Directory](${CLAUDE_DIRECTORY_URL}): its listing, from which claude.ai connects it
- [The package on npm](https://www.npmjs.com/package/@rivi-software/agentic-seo-check): the command \`npx @rivi-software/agentic-seo-check audit <url>\` and the local MCP server \`${LOCAL_SERVER}\`

## Reference

- [The rules](${SITE_ORIGIN}/rules): every rule, its severity and what it recommends
- [The README](https://github.com/rivi-software/agentic-seo-check#readme): the commands, the MCP tools and their options
- [For site owners](${SITE_ORIGIN}/crawler): what the audit's requests are and how to block them
`;

/**
 * Where the website serves pdfmake with the code that draws a report's PDF (pdf-assets.ts), which
 * that code names `drawReportPdf`.
 */
export const PDFMAKE_PATH = "/pdfmake.js";

/**
 * The pages' script, served at /site.js so that the Content-Security-Policy
 * needs no inline script. It gives every command and snippet marked data-copy a button that copies
 * it, waits for Turnstile's token before the audit form is sent, shows that an audit or a crawl is
 * running, shows the report one section at a time behind its tabs, gives the report as a JSON
 * file, as Markdown on the clipboard or as a PDF that pdfmake draws in the page (issue #157), opens
 * every section and finding while the page prints, adds the system's share sheet to the report's
 * Share menu, and
 * filters the rules page. In production it also loads PostHog from /ph.js for the
 * usage analytics (issue #57), with the cookie banner, and sends the closed list of events below:
 * never an address the visitor audited, nothing they typed and nothing from a report but its
 * scores. Without it every page still reads and works, but the form. It runs once the page is read
 * to its end, so after a crawl's streamed answer.
 */
export const SITE_JS = `(() => {
  const COPY = ${JSON.stringify(`${icon("copy")}<span class="sr-only">Copy</span>`)};
  const COPIED = ${JSON.stringify(`${icon("check")}<span class="sr-only">Copied</span>`)};

  // The analytics: PostHog, once /ph.js has loaded. Events from before then wait in \`queue\`.
  let analytics = null;
  const queue = [];

  const track = (event, properties, options) => {
    if (!analytics) {
      queue.push([event, properties, options]);
      return;
    }

    try {
      analytics.capture(event, properties, options);
    } catch {
      // Analytics never break the page.
    }
  };

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

        if (block.classList.contains("share-url")) {
          track("report_shared", { network: "copy_link" });
        } else {
          track("snippet_copied", { snippet: block.dataset.copy || "code" });
        }

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
      // Sent at once: the form's answer is the next page.
      track(
        "audit_requested",
        { mode: crawls() ? "site" : "page" },
        { send_instantly: true, transport: "sendBeacon" }
      );

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

  // The rules page: a filter over the rules, a link to a rule opens it, and the list of categories
  // marks the one in view. Without the script every rule is still there, closed.
  const filter = document.querySelector(".rules-filter");

  if (filter) {
    const input = filter.querySelector("input");
    const count = filter.querySelector(".rules-count");
    const strip = document.querySelector(".rules-toc ul");
    const groups = [...document.querySelectorAll(".rule-group")];
    const rules = [...document.querySelectorAll(".rule")];

    // What a filter matches: a rule's id and all of its text, what to change included.
    const text = new Map(
      rules.map((rule) => [rule, (rule.id + " " + rule.textContent).toLowerCase()])
    );

    const links = new Map(
      [...document.querySelectorAll(".rules-toc a[data-group]")].map((link) => [
        link.dataset.group,
        link,
      ])
    );

    filter.hidden = false;

    input.addEventListener("input", () => {
      const words = input.value.toLowerCase().split(/\\s+/).filter(Boolean);
      let shown = 0;

      for (const rule of rules) {
        const match = words.every((word) => text.get(rule).includes(word));
        rule.hidden = !match;
        shown += match ? 1 : 0;
      }

      for (const group of groups) {
        const left = group.querySelectorAll(".rule:not([hidden])").length;
        const chip = group.querySelector(".rule-group-head .chip");
        group.hidden = left === 0;

        // The category's count says how many of its rules the filter left.
        chip.dataset.all ||= chip.textContent;
        chip.textContent =
          words.length === 0 ? chip.dataset.all : left === 1 ? "1 rule" : left + " rules";

        if (links.has(group.id)) {
          links.get(group.id).parentElement.hidden = left === 0;
        }
      }

      count.textContent =
        words.length === 0 ? "" : shown === 1 ? "1 rule" : shown + " rules";
    });

    const open = () => {
      const target = document.getElementById(
        decodeURIComponent(location.hash.slice(1))
      );

      if (target && target.tagName === "DETAILS") {
        target.open = true;
      }
    };

    open();
    window.addEventListener("hashchange", open);

    const motion = matchMedia("(prefers-reduced-motion: reduce)").matches
      ? "auto"
      : "smooth";

    // The category whose rules cross a band near the top of the window is the one in view.
    const seen = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const link = links.get(entry.target.id);

          if (!entry.isIntersecting || !link) {
            continue;
          }

          for (const other of links.values()) {
            other.removeAttribute("aria-current");
          }

          link.setAttribute("aria-current", "location");

          // On a phone the categories scroll sideways: keep the current one on screen.
          const left = link.offsetLeft - strip.offsetLeft;

          if (
            left < strip.scrollLeft ||
            left + link.offsetWidth > strip.scrollLeft + strip.clientWidth
          ) {
            strip.scrollTo({ left: left - 16, behavior: motion });
          }
        }
      },
      { rootMargin: "-25% 0px -65% 0px" }
    );

    for (const group of groups) {
      seen.observe(group);
    }
  }

  // The report's sections as tabs: the strip above them shows one at a time. A hidden section
  // stays findable: the browser's find in page opens its tab, where it can (hidden=until-found).
  // Without the script every section is there, one under the other, and the strip links to each.
  const tabStrip = document.querySelector(".report-tabs");

  if (tabStrip) {
    const tabs = [...tabStrip.querySelectorAll("a")];
    const panels = tabs.map((tab) => document.getElementById(tab.hash.slice(1)));
    const holder = panels[0].parentElement;
    let current = 0;

    const show = (index) => {
      current = index;
      tabs.forEach((tab, i) => {
        tab.setAttribute("aria-selected", String(i === index));
        tab.tabIndex = i === index ? 0 : -1;
        panels[i].hidden = i === index ? false : "until-found";
      });

      // On a phone the tabs scroll sideways: keep the open one on screen.
      const tab = tabs[index];

      if (
        tab.offsetLeft < tabStrip.scrollLeft ||
        tab.offsetLeft + tab.offsetWidth > tabStrip.scrollLeft + tabStrip.clientWidth
      ) {
        tabStrip.scrollTo({ left: tab.offsetLeft - 16 });
      }
    };

    tabs.forEach((tab, i) => {
      tab.id = "tab-" + panels[i].id;
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-controls", panels[i].id);
      panels[i].setAttribute("role", "tabpanel");
      panels[i].setAttribute("aria-labelledby", tab.id);
      panels[i].addEventListener("beforematch", () => {
        show(i);
      });
    });

    tabStrip.setAttribute("role", "tablist");
    tabStrip.closest(".report").classList.add("has-tabs");
    show(0);

    // Printed, or saved as a PDF, the report has every section, one after the other; afterwards the
    // tab that was open is again the only one.
    window.addEventListener("beforeprint", () => {
      for (const panel of panels) {
        panel.hidden = false;
      }
    });

    window.addEventListener("afterprint", () => {
      show(current);
    });

    // Opens the tab \`index\`. When the strip is stuck to the top of the window, the section that was
    // open is scrolled out of view above it, and the new one is shown from its start.
    const open = (index) => {
      show(index);

      if (holder.getBoundingClientRect().top < tabStrip.getBoundingClientRect().bottom) {
        holder.scrollIntoView({ behavior: "instant" });
      }
    };

    // A link to a section, or to a part of one (a score, the overview's index or a finding to fix
    // first), opens its tab, and the finding it names.
    document.addEventListener("click", (event) => {
      const link = event.target.closest && event.target.closest('a[href^="#"]');
      const target =
        link && document.getElementById(decodeURIComponent(link.hash.slice(1)));
      const index = target ? panels.findIndex((panel) => panel.contains(target)) : -1;

      if (index === -1) {
        return;
      }

      event.preventDefault();

      // A tab opens its section where it is; a link to a part of one scrolls to it.
      if (link.parentElement === tabStrip) {
        open(index);
      } else {
        show(index);

        if (target.tagName === "DETAILS") {
          target.open = true;
        }

        target.scrollIntoView();
      }
    });

    // The arrow keys, Home and End move between the tabs; Space opens one, as Enter does.
    tabStrip.addEventListener("keydown", (event) => {
      const index = tabs.indexOf(document.activeElement);

      if (index === -1) {
        return;
      }

      if (event.key === " ") {
        event.preventDefault();
        tabs[index].click();
        return;
      }

      const next = {
        ArrowRight: (index + 1) % tabs.length,
        ArrowLeft: (index - 1 + tabs.length) % tabs.length,
        Home: 0,
        End: tabs.length - 1,
      }[event.key];

      if (next !== undefined) {
        event.preventDefault();
        open(next);
        tabs[next].focus();
      }
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
          track("report_shared", { network: "system" });
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

  // Saves \`file\` as \`name\` in the browser's downloads.
  const save = (file, name) => {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(file);
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 10000);
  };

  // pdfmake and the code that draws a report's PDF with it, from this site, loaded on the first
  // "Download PDF" only. A load that failed is tried again on the next click.
  let drawing = null;

  const loadPdf = () => {
    drawing ||= new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = ${JSON.stringify(PDFMAKE_PATH)};
      script.onload = () =>
        window.drawReportPdf ? resolve(window.drawReportPdf) : reject(new Error("pdfmake"));
      script.onerror = reject;
      document.head.append(script);
    }).catch((error) => {
      drawing = null;
      throw error;
    });

    return drawing;
  };

  if (source) {
    const data = JSON.parse(source.textContent);

    for (const button of document.querySelectorAll("[data-report]")) {
      button.addEventListener("click", async () => {
        if (button.dataset.report === "download") {
          track("report_downloaded", { format: "json" });
          save(
            new Blob([JSON.stringify(data.json, null, 2)], {
              type: "application/json",
            }),
            "agentic-seo-check-" + data.name + ".json"
          );
          return;
        }

        // The PDF, drawn in the page from the report's data with the site's own fonts. Where it
        // cannot be drawn, the print dialog saves one.
        if (button.dataset.report === "pdf") {
          if (button.disabled) {
            return;
          }

          track("report_downloaded", { format: "pdf" });
          const label = button.querySelector(".btn-label");
          const idle = label.textContent;
          button.disabled = true;
          button.classList.add("is-busy");
          label.textContent = "Making the PDF…";

          try {
            const draw = await loadPdf();
            const file = await draw(data.pdf).getBlob();
            save(file, "agentic-seo-check-" + data.name + ".pdf");
          } catch {
            window.print();
          } finally {
            button.disabled = false;
            button.classList.remove("is-busy");
            label.textContent = idle;
          }

          return;
        }

        try {
          await navigator.clipboard.writeText(data.markdown);
          track("report_downloaded", { format: "markdown" });
          say(button, "Copied");
        } catch {
          say(button, "Could not copy");
        }
      });
    }

    // Printed, every finding is open with its fix, and the file a PDF is saved to is named after
    // the site, as the JSON download is. Afterwards the page is as the visitor left it. A browser
    // may say "beforeprint" twice before one "afterprint" (Chrome's PDF does): the second changes
    // nothing, so what the first kept is what comes back.
    let printing = false;
    let closed = [];
    let title = document.title;

    window.addEventListener("beforeprint", () => {
      if (printing) {
        return;
      }

      printing = true;
      closed = [...document.querySelectorAll(".report details.finding:not([open])")];

      for (const finding of closed) {
        finding.open = true;
      }

      title = document.title;
      document.title = "agentic-seo-check-" + data.name;
    });

    window.addEventListener("afterprint", () => {
      if (!printing) {
        return;
      }

      printing = false;

      for (const finding of closed) {
        finding.open = false;
      }

      closed = [];
      document.title = title;
    });

    if (data.summary) {
      track("audit_shown", data.summary);
    }

    document.querySelector("#report").scrollIntoView();
  }

  const failed = document.querySelector("[data-failure]");

  if (failed) {
    track("audit_failed", { reason: failed.dataset.failure });
  }

  // A click on a link to one of these places, by name: never the address itself.
  const TARGETS = {
    "github.com": "github",
    "www.npmjs.com": "npm",
    "claude.ai": "claude_directory",
  };

  // The networks of the report's Share menu.
  const NETWORKS = {
    "x.com": "x",
    "www.linkedin.com": "linkedin",
    "bsky.app": "bluesky",
  };

  document.addEventListener("click", (event) => {
    const link = event.target.closest && event.target.closest("a[href]");

    if (!link || link.hostname === location.hostname) {
      return;
    }

    if (link.closest(".share-panel") && NETWORKS[link.hostname]) {
      track("report_shared", { network: NETWORKS[link.hostname] });
    } else if (TARGETS[link.hostname]) {
      track(
        "link_clicked",
        { target: TARGETS[link.hostname] },
        { transport: "sendBeacon" }
      );
    }
  });

  // An address of this site as an event records it, less what belongs to the audited site: a
  // share link's result (its address and scores) and the address a link put in the form. The
  // hostnames before issue #168 too, which a referrer may still name.
  const OWN = /^(agentic-seo\\.org|(mcp\\.)?agentic-seo(-check)?\\.rivi\\.software)$/;

  const clean = (value) => {
    if (typeof value !== "string" || !/^(\\/|https?:\\/\\/)/.test(value)) {
      return value;
    }

    let url;

    try {
      url = new URL(value, location.href);
    } catch {
      return value;
    }

    if (!OWN.test(url.hostname) && url.hostname !== location.hostname) {
      return value;
    }

    if (url.pathname.startsWith("/share/")) {
      url.pathname = "/share/:result";
    }

    url.searchParams.delete("url");
    url.hash = "";

    return value.startsWith("/") ? url.pathname + url.search : url.href;
  };

  const cleanAll = (properties) => {
    if (!properties) {
      return;
    }

    // A share page's title names the address and its scores.
    delete properties.title;
    delete properties.$title;

    for (const key of Object.keys(properties)) {
      properties[key] = clean(properties[key]);
    }
  };

  const banner = document.querySelector("#consent");
  const settings = document.querySelector("[data-consent-settings]");

  // Do Not Track and Global Privacy Control read as a decline: no banner, no cookie.
  const declined =
    navigator.doNotTrack === "1" || navigator.globalPrivacyControl === true;

  const start = (module) => {
    const posthog = module.default;

    posthog.init(module.TOKEN, {
      api_host: module.API_HOST,
      ui_host: "https://eu.posthog.com",
      defaults: "2026-08-30",
      // Counted without a cookie until the visitor accepts one; one choice for every page.
      cookieless_mode: "on_reject",
      opt_out_capturing_by_default: true,
      opt_out_capturing_persistence_type: "cookie",
      respect_dnt: true,
      persistence: "localStorage+cookie",
      cross_subdomain_cookie: true,
      person_profiles: "identified_only",
      capture_pageview: true,
      capture_pageleave: true,
      // The closed list of events above, and nothing from the page: a report quotes other sites.
      autocapture: false,
      rageclick: false,
      capture_dead_clicks: false,
      capture_heatmaps: false,
      capture_exceptions: false,
      capture_performance: false,
      disable_session_recording: true,
      disable_surveys: true,
      disable_product_tours: true,
      disable_web_experiments: true,
      disable_conversations: true,
      // No flags and no remote config: the project's settings turn nothing on here.
      advanced_disable_flags: true,
      before_send: (event) => {
        if (event) {
          cleanAll(event.properties);
          cleanAll(event.$set);
          cleanAll(event.$set_once);
        }

        return event;
      },
    });

    analytics = posthog;

    for (const [event, properties, options] of queue.splice(0)) {
      track(event, properties, options);
    }

    if (!banner || !settings || declined) {
      return;
    }

    const choose = (accept) => {
      if (accept) {
        posthog.opt_in_capturing();
      } else {
        posthog.opt_out_capturing();
      }

      banner.hidden = true;
    };

    for (const button of banner.querySelectorAll("[data-consent]")) {
      button.addEventListener("click", () => {
        choose(button.dataset.consent === "accept");
      });
    }

    settings.hidden = false;
    settings.addEventListener("click", () => {
      banner.hidden = false;
      banner.querySelector("[data-consent]").focus();
    });

    if (posthog.get_explicit_consent_status() === "pending") {
      banner.hidden = false;
    }
  };

  if (OWN.test(location.hostname)) {
    import("/ph.js").then(start, () => {
      // Off (no /ph.js), or blocked: the page works without it.
    });
  }
})();
`;
