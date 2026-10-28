import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const vercel = JSON.parse(fs.readFileSync(new URL("vercel.json", root), "utf8"));
const pkg = JSON.parse(fs.readFileSync(new URL("package.json", root), "utf8"));
const checkScript = fileURLToPath(new URL("scripts/check-api-config.mjs", root));
const RENDER_API = "https://vups-router-be.onrender.com/api";

function runConfigCheck(apiBaseUrl) {
  const env = { ...process.env };
  if (apiBaseUrl === undefined) delete env.VITE_API_BASE_URL;
  else env.VITE_API_BASE_URL = apiBaseUrl;
  return spawnSync(process.execPath, [checkScript], { env, encoding: "utf8" });
}

test("production build runs API configuration validation first", () => {
  assert.equal(pkg.scripts.prebuild, "node scripts/check-api-config.mjs");
});

test("Vercel proxies both /api and /api/* to the Render backend", () => {
  const apiRewrites = vercel.rewrites.filter(rewrite =>
    ["/api", "/api/(.*)", "/api/:path*"].includes(rewrite.source)
  );
  assert.ok(
    apiRewrites.some(rewrite => rewrite.source === "/api/:path*" && rewrite.destination === `${RENDER_API}/:path*`),
    "missing /api/:path* proxy"
  );
  assert.ok(
    apiRewrites.some(rewrite => rewrite.source === "/api/(.*)" && rewrite.destination === `${RENDER_API}/$1`),
    "missing /api/(.*) proxy for the trailing-slash route"
  );
  const catchAll = vercel.rewrites.findIndex(rewrite => rewrite.source === "/(.*)");
  assert.ok(catchAll > 0, "SPA catch-all must exist");
  for (const rewrite of apiRewrites) {
    assert.ok(vercel.rewrites.indexOf(rewrite) < catchAll, `${rewrite.source} must run before the SPA catch-all`);
  }
});

test("production hosting configuration contains no localhost origin", () => {
  assert.doesNotMatch(JSON.stringify(vercel), /localhost|127\.0\.0\.1|\[::1\]/i);
});

test("Vite dev and preview proxy /api to the verified backend", async () => {
  const { apiProxy, RENDER_API_ORIGIN, default: config } = await import("../vite.config.js");
  assert.equal(apiProxy["/api"].target, RENDER_API_ORIGIN);
  assert.equal(apiProxy["/api"].changeOrigin, true);
  assert.equal(config.server.proxy, apiProxy, "dev server must proxy /api");
  assert.equal(config.preview.proxy, apiProxy, "preview server must proxy /api");
  if (!process.env.VITE_API_PROXY_TARGET) {
    assert.equal(RENDER_API_ORIGIN, new URL(RENDER_API).origin);
  }
});

test("the production CSP allows only the verified backend and the release lookup", async () => {
  const csp = vercel.headers
    .flatMap(entry => entry.headers)
    .find(header => header.key === "Content-Security-Policy");
  assert.ok(csp, "missing Content-Security-Policy header");
  assert.match(csp.value, /connect-src 'self' https:\/\/vups-router-be\.onrender\.com/);
  assert.doesNotMatch(csp.value, /localhost|127\.0\.0\.1|\[::1\]/i);

  const { LATEST_RELEASE_API_URL } = await import("../src/download/releases.js");
  const connectSrc = /connect-src([^;]*)/.exec(csp.value)?.[1] ?? "";
  assert.ok(
    connectSrc.includes(new URL(LATEST_RELEASE_API_URL).origin),
    "/download reads the GitHub Releases API; dev serves no CSP, so production alone would hide the block"
  );
  assert.doesNotMatch(connectSrc, /\*/, "connect-src must stay an explicit origin allow-list");
});

test("API responses stay uncached through the proxy", () => {
  const apiHeaderEntry = vercel.headers.find(entry => entry.source === "/api/:path*");
  assert.ok(apiHeaderEntry, "missing /api/:path* cache headers");
  const cacheControl = apiHeaderEntry.headers.find(header => header.key === "Cache-Control");
  assert.equal(cacheControl?.value, "no-store");
});

test("the build guard accepts missing configuration", () => {
  const result = runConfigCheck(undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Production API base URL: \/api/);
});

test("the build guard accepts the verified proxy configuration", () => {
  const result = runConfigCheck("/api");
  assert.equal(result.status, 0, result.stderr);
});

test("the build guard accepts an absolute public URL but warns it is ignored", () => {
  const result = runConfigCheck(RENDER_API);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /ignored in production/i);
});

test("the build guard fails when production configuration points at localhost", () => {
  for (const value of ["http://localhost:4000/api", "http://127.0.0.1:4000/api", "http://[::1]:4000/api"]) {
    const result = runConfigCheck(value);
    assert.equal(result.status, 1, `${value} should be rejected`);
    assert.match(result.stderr, /localhost/i);
  }
});
