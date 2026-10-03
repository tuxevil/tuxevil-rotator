// Serves the dashboard single-page app from src/web.
//
// The client is TypeScript + Preact, bundled in memory with esbuild the first
// time it is needed (tsx already ships esbuild, so there is no separate build
// step and `npm install && npm start` keeps working). Set
// TUXEVIL_ROTATOR_DASHBOARD_DEV=1 to rebuild on every page load while editing.

import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { rotatorEnv } from "./env.js";
import { logger } from "./logger.js";

const appLogger = logger.child("dashboard");
const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_ENTRY = join(__dirname, "web", "main.tsx");
const ASSET_PREFIX = "/dashboard/assets/";

interface DashboardAsset {
  path: string;
  type: string;
  body: Buffer;
  gzip: Buffer;
  etag: string;
}

interface DashboardBundle {
  js: DashboardAsset;
  css: DashboardAsset;
  html: string;
}

let bundlePromise: Promise<DashboardBundle> | null = null;

function isDevMode(): boolean {
  return rotatorEnv("DASHBOARD_DEV") === "1";
}

/**
 * Locked down to same-origin resources. Preact sets inline styles through
 * the CSSOM, which `style-src 'self'` allows; style attributes in markup and
 * inline scripts are refused.
 */
export const DASHBOARD_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const FAVICON =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#5b4bdb"/><path d="M9 11h14M9 16h10M9 21h6" stroke="#fff" stroke-width="3" stroke-linecap="round"/></svg>',
  );

function makeAsset(name: string, ext: string, body: Buffer, type: string): DashboardAsset {
  const hash = createHash("sha256").update(body).digest("hex").slice(0, 12);
  return {
    path: `${ASSET_PREFIX}${name}.${hash}.${ext}`,
    type,
    body,
    gzip: gzipSync(body),
    etag: `"${hash}"`,
  };
}

function renderShell(js: DashboardAsset, css: DashboardAsset): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="no-referrer">
<title>Tuxevil Rotator</title>
<link rel="icon" href="${FAVICON}">
<link rel="stylesheet" href="${css.path}">
<script type="module" src="${js.path}"></script>
</head>
<body>
<div id="app"></div>
<noscript>The Tuxevil Rotator dashboard needs JavaScript.</noscript>
</body>
</html>
`;
}

async function buildBundle(): Promise<DashboardBundle> {
  const { build } = await import("esbuild");
  const dev = isDevMode();
  const result = await build({
    entryPoints: [WEB_ENTRY],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: ["es2020"],
    outdir: "/dashboard-out",
    entryNames: "app",
    jsx: "automatic",
    jsxImportSource: "preact",
    minify: !dev,
    sourcemap: dev ? "inline" : false,
    legalComments: "none",
    logLevel: "silent",
    define: { "process.env.NODE_ENV": dev ? '"development"' : '"production"' },
  });
  const jsFile = result.outputFiles.find((f) => f.path.endsWith(".js"));
  const cssFile = result.outputFiles.find((f) => f.path.endsWith(".css"));
  if (!jsFile || !cssFile) throw new Error("dashboard bundle is missing app.js or app.css");
  const js = makeAsset("app", "js", Buffer.from(jsFile.contents), "text/javascript; charset=utf-8");
  const css = makeAsset("app", "css", Buffer.from(cssFile.contents), "text/css; charset=utf-8");
  return { js, css, html: renderShell(js, css) };
}

/** `fresh` rebuilds in dev mode; asset requests reuse the bundle the page was rendered with. */
export function loadDashboardBundle(fresh = false): Promise<DashboardBundle> {
  if (!bundlePromise || (fresh && isDevMode())) {
    const started = Date.now();
    const pending = buildBundle();
    bundlePromise = pending;
    pending.then(
      (bundle) =>
        appLogger.info(
          `Dashboard bundle ready in ${Date.now() - started}ms (${Math.round(bundle.js.body.length / 1024)} KB js, ${Math.round(bundle.css.body.length / 1024)} KB css)`,
        ),
      (err) => {
        appLogger.error(`Dashboard bundle failed: ${err instanceof Error ? err.message : String(err)}`);
        if (bundlePromise === pending) bundlePromise = null;
      },
    );
  }
  return bundlePromise!;
}

/** Start building at server start so the first page load is fast and errors surface early. */
export function prewarmDashboard(): void {
  loadDashboardBundle().catch(() => {
    // logged in loadDashboardBundle; retried on the next request
  });
}

function acceptsGzip(req: IncomingMessage): boolean {
  const header = req.headers["accept-encoding"];
  const value = Array.isArray(header) ? header.join(",") : header || "";
  return /\bgzip\b/.test(value);
}

export function securityHeaders(): Record<string, string> {
  return {
    "Content-Security-Policy": DASHBOARD_CSP,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
  };
}

function sendBuildError(res: ServerResponse, err: unknown): void {
  res.writeHead(500, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(
    isDevMode()
      ? `Dashboard failed to build:\n\n${err instanceof Error ? err.message : String(err)}`
      : "Dashboard failed to build. Check the server logs.",
  );
}

export async function serveDashboardShell(res: ServerResponse): Promise<void> {
  let bundle: DashboardBundle;
  try {
    bundle = await loadDashboardBundle(true);
  } catch (err) {
    sendBuildError(res, err);
    return;
  }
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    ...securityHeaders(),
  });
  res.end(bundle.html);
}

/** Returns false when the path is not a dashboard asset. */
export async function serveDashboardAsset(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (!pathname.startsWith(ASSET_PREFIX)) return false;
  let bundle: DashboardBundle;
  try {
    bundle = await loadDashboardBundle();
  } catch (err) {
    sendBuildError(res, err);
    return true;
  }
  const asset = [bundle.js, bundle.css].find((a) => a.path === pathname);
  if (!asset) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
    res.end("Not found");
    return true;
  }
  const headers: Record<string, string> = {
    "Content-Type": asset.type,
    "Cache-Control": "public, max-age=31536000, immutable",
    ETag: asset.etag,
    Vary: "Accept-Encoding",
    "X-Content-Type-Options": "nosniff",
  };
  if (req.headers["if-none-match"] === asset.etag) {
    res.writeHead(304, headers);
    res.end();
    return true;
  }
  if (acceptsGzip(req)) {
    res.writeHead(200, { ...headers, "Content-Encoding": "gzip" });
    res.end(asset.gzip);
  } else {
    res.writeHead(200, headers);
    res.end(asset.body);
  }
  return true;
}

/** JSON response, gzipped when large and the client accepts it. */
export function sendDashboardJson(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  body: unknown,
): void {
  const json = Buffer.from(JSON.stringify(body));
  const headers: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    Vary: "Accept-Encoding",
  };
  if (json.length > 2048 && acceptsGzip(req)) {
    res.writeHead(status, { ...headers, "Content-Encoding": "gzip" });
    res.end(gzipSync(json));
    return;
  }
  res.writeHead(status, headers);
  res.end(json);
}
