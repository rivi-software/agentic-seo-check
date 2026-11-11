/**
 * Checks the package as a user gets it from npm. It packs it the way `pnpm publish` does;
 * arethetypeswrong then reads the entry point's types under Node's ESM and bundler resolution, and
 * plain npm installs the tarball in an empty project, without the optional dependency (Playwright)
 * and the optional peers (Lighthouse, chrome-launcher), so nothing may need them to load. In that
 * project it imports the entry point, audits a page through the CLI with both the SEO and the AEO
 * audit, checks that `install-browser` says Playwright is missing, and opens an MCP session with
 * the server, whose stdout must carry JSON-RPC and nothing else. Run it after `pnpm run build`.
 *   node scripts/check-package.ts
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// The commands it runs send no telemetry (issue #57): every child inherits this.
process.env.AGENTIC_SEO_CHECK_TELEMETRY = "0";

const root = path.join(import.meta.dirname, "..");
const work = mkdtempSync(path.join(tmpdir(), "check-package-"));

const run = (command: string, args: string[], cwd: string, input?: string) =>
  execFileSync(command, args, {
    cwd,
    encoding: "utf-8",
    input,
    stdio: ["pipe", "pipe", "inherit"],
  });

const fail = (message: string): never => {
  throw new Error(message);
};

/** Starts the MCP server, sends `initialize`, and answers the server's first line on stdout. */
const firstMcpLine = (bin: string, cwd: string) => {
  const server = spawn(bin, [], { cwd, stdio: ["pipe", "pipe", "inherit"] });

  const request = {
    id: 1,
    jsonrpc: "2.0",
    method: "initialize",
    params: {
      capabilities: {},
      clientInfo: { name: "check-package", version: "0.0.0" },
      protocolVersion: "2025-06-18",
    },
  };

  // oxlint-disable-next-line promise/avoid-new -- a child process reports through events, not a promise
  return new Promise<string>((resolve, reject) => {
    let output = "";

    const timer = setTimeout(() => {
      server.kill();
      reject(
        new Error("The MCP server did not answer initialize within 10 seconds.")
      );
    }, 10_000);

    server.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf-8");
      const end = output.indexOf("\n");

      if (end !== -1) {
        clearTimeout(timer);
        server.kill();
        resolve(output.slice(0, end));
      }
    });
    server.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    server.stdin.write(`${JSON.stringify(request)}\n`);
  });
};

try {
  const tarballs = path.join(work, "tarballs");
  mkdirSync(tarballs);
  run("pnpm", ["pack", "--pack-destination", tarballs], root);

  const tarball = path.join(
    tarballs,
    readdirSync(tarballs)[0] ?? fail("pnpm pack wrote nothing.")
  );

  execFileSync(
    path.join(root, "node_modules", ".bin", "attw"),
    [tarball, "--profile", "esm-only"],
    { cwd: root, stdio: "inherit" }
  );

  const project = path.join(work, "project");
  mkdirSync(project);
  writeFileSync(
    path.join(project, "package.json"),
    JSON.stringify({ name: "check-package", private: true, type: "module" })
  );
  run(
    "npm",
    [
      "install",
      "--omit=optional",
      "--no-audit",
      "--no-fund",
      "--loglevel=error",
      tarball,
    ],
    project
  );
  console.log("ok  installed without Playwright and the optional peers");

  const exports = run(
    "node",
    [
      "--input-type=module",
      "--eval",
      `const m = await import("@rivi-software/agentic-seo-check");
       for (const name of ["auditUrl", "auditSite", "auditDirectory", "auditHtml", "renderMarkdown", "auditAeoTarget", "renderAeoMarkdown", "renderText", "renderAeoText"])
         if (typeof m[name] !== "function") throw new Error(name + " is not exported");
       console.log(Object.keys(m).length);`,
    ],
    project
  );

  console.log(
    `ok  import @rivi-software/agentic-seo-check (${exports.trim()} exports)`
  );

  const bin = (name: string) =>
    path.join(project, "node_modules", ".bin", name);

  const version = run(bin("agentic-seo-check"), ["--version"], project).trim();
  console.log(`ok  agentic-seo-check --version: ${version}`);

  // SAFETY: every field is typed unknown and checked just below before it is trusted.
  const audit = JSON.parse(
    run(
      bin("agentic-seo-check"),
      ["audit", "-", "--format", "json", "--base-url", "https://example.com/"],
      project,
      "<!doctype html><html lang=en><head><title>A page</title></head><body><h1>A page</h1></body></html>"
    )
  ) as { kind?: unknown; findings?: unknown };

  if (audit.kind !== "page" || !Array.isArray(audit.findings)) {
    fail("agentic-seo-check audit - did not print a page audit.");
  }

  console.log("ok  agentic-seo-check audit - prints a page audit");

  // SAFETY: every field is typed unknown and checked just below before it is trusted.
  const aeo = JSON.parse(
    run(
      bin("agentic-seo-check"),
      ["aeo", "-", "--format", "json", "--base-url", "https://example.com/"],
      project,
      "<!doctype html><html lang=en><head><title>A page</title></head><body><h1>A page</h1></body></html>"
    )
  ) as { kind?: unknown; findings?: unknown };

  if (aeo.kind !== "aeo" || !Array.isArray(aeo.findings)) {
    fail("agentic-seo-check aeo - did not print an AEO audit.");
  }

  console.log("ok  agentic-seo-check aeo - prints an AEO audit");

  const install = spawnSync(bin("agentic-seo-check"), ["install-browser"], {
    cwd: project,
    encoding: "utf-8",
  });

  if (
    install.status !== 2 ||
    !install.stderr.includes("Playwright is not installed")
  ) {
    fail(
      `agentic-seo-check install-browser without Playwright exited with ${install.status}: ${install.stderr}`
    );
  }

  console.log(
    "ok  agentic-seo-check install-browser says Playwright is missing"
  );

  const line = await firstMcpLine(bin("agentic-seo-check-mcp"), project);

  // SAFETY: the fields are optional and compared just below before they are trusted.
  const answer = JSON.parse(line) as {
    id?: unknown;
    result?: { serverInfo?: { version?: unknown } };
  };

  if (answer.id !== 1 || answer.result?.serverInfo?.version !== version) {
    fail(`agentic-seo-check-mcp answered initialize with: ${line}`);
  }

  console.log("ok  agentic-seo-check-mcp answers initialize on stdout");
} finally {
  rmSync(work, { force: true, recursive: true });
}
