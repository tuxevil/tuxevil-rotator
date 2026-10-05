import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import {
  DASHBOARD_CSP,
  loadDashboardBundle,
  serveDashboardAsset,
  serveDashboardShell,
} from "../src/dashboard-app.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = join(__dirname, "..", "src", "web");

interface CapturedResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

function captureResponse(): { res: never; done: Promise<CapturedResponse> } {
  let resolve!: (value: CapturedResponse) => void;
  const done = new Promise<CapturedResponse>((r) => (resolve = r));
  const captured: CapturedResponse = { status: 0, headers: {}, body: Buffer.alloc(0) };
  const res = {
    writeHead(status: number, headers: Record<string, string> = {}) {
      captured.status = status;
      for (const [key, value] of Object.entries(headers)) captured.headers[key.toLowerCase()] = String(value);
    },
    end(chunk?: string | Buffer) {
      if (chunk) captured.body = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      resolve(captured);
    },
  };
  return { res: res as never, done };
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : [path];
  });
}

const webSources = () =>
  sourceFiles(WEB_ROOT)
    .filter((path) => /\.(tsx?|css)$/.test(path))
    .map((path) => ({ path, text: readFileSync(path, "utf-8") }));

describe("dashboard app", () => {
  it("bundles the Preact app into one hashed script and stylesheet", async () => {
    const bundle = await loadDashboardBundle();
    assert.match(bundle.js.path, /^\/dashboard\/assets\/app\.[0-9a-f]{12}\.js$/);
    assert.match(bundle.css.path, /^\/dashboard\/assets\/app\.[0-9a-f]{12}\.css$/);
    assert.ok(bundle.js.body.length > 10_000, "bundle contains the app");
    assert.ok(bundle.css.body.includes("--surface"), "stylesheet contains the design tokens");
  });

  it("serves a static shell with a strict CSP and no inline script or handlers", async () => {
    const { res, done } = captureResponse();
    await serveDashboardShell(res);
    const response = await done;
    const html = response.body.toString("utf-8");
    assert.equal(response.status, 200);
    assert.equal(response.headers["content-security-policy"], DASHBOARD_CSP);
    assert.match(DASHBOARD_CSP, /script-src 'self'/);
    assert.match(DASHBOARD_CSP, /frame-ancestors 'none'/);
    assert.doesNotMatch(DASHBOARD_CSP, /unsafe-inline|unsafe-eval/);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.match(html, /<meta charset="utf-8">/);
    assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
    assert.match(html, /<script type="module" src="\/dashboard\/assets\/app\.[0-9a-f]{12}\.js"><\/script>/);
    assert.doesNotMatch(html, /<script>|<script\s+(?!type="module" src=)/i, "no inline scripts");
    assert.doesNotMatch(html, /\son[a-z]+=/i, "no inline event handlers");
    assert.doesNotMatch(html, /\sstyle=/i, "no inline styles");
    assert.doesNotMatch(html, /token/i, "the shell never carries the admin token");
  });

  it("serves assets with immutable caching, gzip and ETag revalidation", async () => {
    const bundle = await loadDashboardBundle();
    const request = (headers: Record<string, string>) => ({ headers }) as never;

    const plain = captureResponse();
    assert.equal(await serveDashboardAsset(request({}), plain.res, bundle.js.path), true);
    const js = await plain.done;
    assert.equal(js.status, 200);
    assert.match(js.headers["content-type"], /text\/javascript/);
    assert.match(js.headers["cache-control"], /immutable/);
    assert.equal(js.body.length, bundle.js.body.length);

    const zipped = captureResponse();
    await serveDashboardAsset(request({ "accept-encoding": "gzip, br" }), zipped.res, bundle.css.path);
    const css = await zipped.done;
    assert.equal(css.headers["content-encoding"], "gzip");
    assert.equal(gunzipSync(css.body).toString("utf-8"), bundle.css.body.toString("utf-8"));

    const cached = captureResponse();
    await serveDashboardAsset(request({ "if-none-match": bundle.js.etag }), cached.res, bundle.js.path);
    assert.equal((await cached.done).status, 304);

    const stale = captureResponse();
    await serveDashboardAsset(request({}), stale.res, "/dashboard/assets/app.000000000000.js");
    assert.equal((await stale.done).status, 404);

    assert.equal(await serveDashboardAsset(request({}), captureResponse().res, "/dashboard/accounts"), false);
  });
});

describe("dashboard client source", () => {
  it("never writes raw HTML", () => {
    for (const { path, text } of webSources()) {
      assert.doesNotMatch(text, /dangerouslySetInnerHTML|\.innerHTML\s*=|insertAdjacentHTML|document\.write/, path);
    }
  });

  it("does not keep the admin token in the browser", () => {
    for (const { path, text } of webSources()) {
      if (path.endsWith("store.ts")) continue; // one-time migration of the legacy key
      assert.doesNotMatch(text, /rotatorAdminToken|X-Rotator-Admin-Token/i, path);
    }
    const store = readFileSync(join(WEB_ROOT, "state", "store.ts"), "utf-8");
    assert.match(store, /writePref\("rotatorAdminToken", null\)/, "the legacy token is deleted after migration");
  });

  it("does not embed OAuth credentials or secrets", () => {
    for (const { path, text } of webSources()) {
      assert.doesNotMatch(text, /GOCSPX-|apps\.googleusercontent\.com|client_secret/i, path);
      assert.doesNotMatch(text, /1\/\/0[0-9A-Za-z_-]{20,}/, `${path} contains a refresh token`);
    }
  });

  it("keeps dashboard copy in English", () => {
    for (const { path, text } of webSources()) {
      assert.doesNotMatch(text, /\b(Cuenta|cuentas|Guardar|Cancelar|Exportar|Importar|Rojo|Azul|Verde|más|configuración)\b/, path);
    }
  });

  it("defines every CSS custom property it uses, in both themes", () => {
    const css = readFileSync(join(WEB_ROOT, "styles", "app.css"), "utf-8");
    const defined = new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
    const used = new Set([...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]));
    for (const name of used) assert.ok(defined.has(name), `${name} is used but never defined`);

    const block = (selector: string) => {
      const start = css.indexOf(`${selector} {`);
      assert.ok(start >= 0, `${selector} block exists`);
      return css.slice(start, css.indexOf("\n}", start));
    };
    const tokens = (text: string) => new Set([...text.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((m) => m[1]));
    const light = tokens(block(":root"));
    const dark = tokens(block(':root[data-theme="dark"]'));
    const lightOnly = ["--radius", "--radius-sm", "--font", "--mono", "--sidebar"];
    for (const name of light) {
      if (lightOnly.includes(name)) continue;
      assert.ok(dark.has(name), `${name} has no dark-theme value`);
    }
  });

  it("uses only same-origin requests", () => {
    for (const { path, text } of webSources()) {
      for (const match of text.matchAll(/fetch\(\s*["'`]([^"'`]+)/g)) {
        assert.match(match[1], /^\//, `${path} fetches ${match[1]}`);
      }
      assert.doesNotMatch(text, /@import\s+url\(|fonts\.googleapis/, path);
    }
  });
});
