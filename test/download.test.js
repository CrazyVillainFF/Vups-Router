import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { DOWNLOADS, PREVIEWS, RELEASE_STATUS, statusFor } from "../src/download/releases.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = file => readFileSync(path.join(root, file), "utf8");

function pngSize(file) {
  const buffer = readFileSync(path.join(root, "public", file));
  assert.equal(buffer.toString("ascii", 1, 4), "PNG", `${file} must be a PNG`);
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

test("download routes and navigation are wired", () => {
  const app = read("src/App.jsx");
  assert.ok(app.includes('path="/download"'), "App.jsx must register /download");

  const header = read("src/components/SiteHeader.jsx");
  assert.ok(header.includes('to="/download"'), "navbar must link to /download");

  const landingFooter = read("src/components/LandingFooter.jsx");
  assert.ok(landingFooter.includes('"/download"'), "landing footer must link to /download");

  const siteFooter = read("src/components/SiteFooter.jsx");
  assert.ok(siteFooter.includes('to="/download"'), "site footer must link to /download");

  const sitemap = read("public/sitemap.xml");
  assert.ok(sitemap.includes("https://vups-router-three.vercel.app/download"), "sitemap must list /download");
});

test("release states never invent installers", () => {
  assert.equal(DOWNLOADS.windows.status, "coming-soon");
  assert.equal(DOWNLOADS.android.status, "coming-soon");
  assert.equal(DOWNLOADS.windows.downloadUrl, null);
  assert.equal(DOWNLOADS.android.downloadUrl, null);
  assert.equal(DOWNLOADS.windows.version, null);
  assert.equal(DOWNLOADS.android.version, null);

  assert.equal(DOWNLOADS.web.status, "available");
  assert.equal(DOWNLOADS.web.downloadUrl, "https://vups-router-three.vercel.app/");
  assert.equal(statusFor(DOWNLOADS.web).label, "Available");
  assert.equal(statusFor(DOWNLOADS.windows).label, RELEASE_STATUS["coming-soon"].label);

  for (const release of Object.values(DOWNLOADS)) {
    if (release.downloadUrl) assert.match(release.downloadUrl, /^https:\/\//);
  }
});

test("preview cards use truthful source labels and shipped images", () => {
  assert.equal(PREVIEWS.length, 6);
  assert.deepEqual(PREVIEWS.map(preview => preview.id), ["home", "chat", "routing", "threads", "desktop", "android"]);
  assert.ok(PREVIEWS.every(preview => preview.alt.length > 20));
  assert.equal(PREVIEWS.find(preview => preview.id === "home").source, "Live product screenshot");
  assert.match(PREVIEWS.find(preview => preview.id === "chat").source, /Conceptual/);
  assert.match(PREVIEWS.find(preview => preview.id === "desktop").source, /real website content/);

  assert.deepEqual(pngSize("previews/home-desktop.png"), { width: 1440, height: 1000 });
  assert.deepEqual(pngSize("previews/home-mobile.png"), { width: 390, height: 844 });
});

test("PWA manifest exposes real screenshots and keeps install metadata", () => {
  const manifest = JSON.parse(read("public/manifest.webmanifest"));
  assert.equal(manifest.display, "standalone");
  assert.ok(manifest.display_override.includes("standalone"));
  assert.equal(manifest.start_url, "/");
  assert.equal(manifest.theme_color, "#070b14");
  assert.ok(Array.isArray(manifest.screenshots));
  assert.equal(manifest.screenshots.length, 2);

  for (const screenshot of manifest.screenshots) {
    const file = screenshot.src.replace(/^\//, "");
    assert.ok(existsSync(path.join(root, "public", file)), `${file} is missing`);
    const [width, height] = screenshot.sizes.split("x").map(Number);
    assert.deepEqual(pngSize(file), { width, height });
  }
});

test("service worker skips API responses and registers only in production", () => {
  const sw = read("public/sw.js");
  assert.ok(sw.includes('url.pathname.startsWith("/api/")'), "API responses must not be cached");
  assert.ok(sw.includes("request.mode === \"navigate\""), "navigations need an offline fallback");
  assert.ok(sw.includes("SKIP_WAITING"), "updates must be able to activate");
  assert.ok(existsSync(path.join(root, "public/offline.html")), "offline fallback is missing");

  const main = read("src/main.jsx");
  assert.ok(main.includes('import.meta.env.PROD && !isTauriRuntime() && "serviceWorker" in navigator'));
  assert.ok(main.includes('register("/sw.js")'));
});
