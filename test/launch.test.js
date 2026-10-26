import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { LEGAL, LEGAL_PLACEHOLDER_MARKER } from "../src/legal/config.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = file => readFileSync(path.join(root, file), "utf8");

test("legal configuration exposes product identity and clearly marked placeholders", () => {
  assert.equal(LEGAL.operatorName, "VupsRouter");
  assert.match(LEGAL.effectiveDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(LEGAL.minimumAge, /^\d{1,2}$/);
  assert.ok(LEGAL.siteUrl.startsWith("https://"));

  assert.ok(
    LEGAL.legalEntity.includes(LEGAL_PLACEHOLDER_MARKER),
    "the legal entity must default to an explicit placeholder, never an invented company"
  );
  assert.ok(
    LEGAL.jurisdiction.includes(LEGAL_PLACEHOLDER_MARKER),
    "jurisdiction must default to an explicit placeholder"
  );
  assert.ok(
    LEGAL.retention.includes(LEGAL_PLACEHOLDER_MARKER),
    "an explicit retention period must not be invented"
  );
  assert.ok(
    LEGAL.contactEmail.endsWith(".example"),
    "the default contact address must be a reserved, clearly non-real example domain"
  );
});

test("legal pages exist, are routed, and are linked from the footer", () => {
  const app = read("src/App.jsx");
  for (const route of ["/privacy-policy", "/terms", "/cookie-policy"]) {
    assert.ok(app.includes(`path="${route}"`), `App.jsx must register ${route}`);
  }

  const pages = read("src/legal/LegalPages.jsx");
  assert.ok(pages.includes("export function PrivacyPolicy"));
  assert.ok(pages.includes("export function TermsOfService"));
  assert.ok(pages.includes("export function CookiePolicy"));
  assert.ok(pages.includes("vr_session"), "the cookie policy must document the real session cookie name");

  const footer = read("src/components/SiteFooter.jsx");
  for (const route of ["/privacy-policy", "/terms", "/cookie-policy"]) {
    assert.ok(footer.includes(`to="${route}"`), `footer must link to ${route}`);
  }
});

test("privacy and terms pages cover the real data flows and third parties", () => {
  const pages = read("src/legal/LegalPages.jsx");
  for (const subject of [
    "bcrypt",
    "AES-256-GCM",
    "OpenRouter",
    "Vercel",
    "Render",
    "MongoDB Atlas",
    "Google Fonts",
    "Google AI Studio",
    "unpaid quota",
    "legitimate interests",
    "children"
  ]) {
    assert.ok(pages.toLowerCase().includes(subject.toLowerCase()), `legal pages must mention ${subject}`);
  }
  assert.ok(!/GDPR-compliant|fully compliant|certified/i.test(pages), "must not claim blanket compliance certifications");
});

test("robots.txt and sitemap.xml exist for the public pages", () => {
  const robots = read("public/robots.txt");
  assert.match(robots, /User-agent: \*/);
  assert.match(robots, /Disallow: \/settings/);
  assert.match(robots, /Sitemap: https:\/\/vups-router-three\.vercel\.app\/sitemap\.xml/);

  const sitemap = read("public/sitemap.xml");
  for (const route of ["/", "/chat", "/privacy-policy", "/terms", "/cookie-policy"]) {
    assert.ok(
      sitemap.includes(`https://vups-router-three.vercel.app${route}<`),
      `sitemap must include ${route}`
    );
  }
  assert.match(sitemap, /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
});

test("index.html ships production metadata", () => {
  const html = read("index.html");
  assert.match(html, /<meta name="description" content="[^"]{40,}"/);
  assert.match(html, /<link rel="canonical" href="https:\/\/vups-router-three\.vercel\.app\/"/);
  assert.match(html, /<meta property="og:title"/);
  assert.match(html, /<meta name="twitter:card"/);
  assert.match(html, /<meta name="robots" content="index, follow"/);
  assert.ok(html.includes("lang=\"en\""));
});

test("vercel.json keeps SPA routing, proxies the API on the same origin, and adds security headers", () => {
  const config = JSON.parse(read("vercel.json"));
  assert.deepEqual(config.rewrites, [
    { source: "/api/(.*)", destination: "https://vups-router-be.onrender.com/api/$1" },
    { source: "/api/:path*", destination: "https://vups-router-be.onrender.com/api/:path*" },
    { source: "/(.*)", destination: "/index.html" }
  ]);
  assert.equal(config.outputDirectory, "dist");

  const apiHeaders = Object.fromEntries(
    config.headers.find(group => group.source === "/api/:path*").headers.map(h => [h.key, h.value])
  );
  assert.equal(apiHeaders["Cache-Control"], "no-store");
  assert.equal(apiHeaders["x-vercel-enable-rewrite-caching"], "0");

  const headers = Object.fromEntries(
    config.headers.find(group => group.source === "/(.*)").headers.map(h => [h.key, h.value])
  );
  assert.match(headers["Content-Security-Policy"], /default-src 'self'/);
  assert.match(headers["Content-Security-Policy"], /frame-ancestors 'none'/);
  assert.match(headers["Content-Security-Policy"], /connect-src 'self' https:\/\/vups-router-be\.onrender\.com/);
  assert.doesNotMatch(headers["Content-Security-Policy"], /localhost|127\.0\.0\.1|\[::1\]/i);
  assert.equal(headers["X-Content-Type-Options"], "nosniff");
  assert.equal(headers["X-Frame-Options"], "DENY");
  assert.equal(headers["Referrer-Policy"], "strict-origin-when-cross-origin");
  assert.match(headers["Permissions-Policy"], /camera=\(\)/);
  assert.match(headers["Strict-Transport-Security"], /max-age=\d{7,}/);
});

test("per-route metadata component supports titles and noindex", () => {
  const meta = read("src/components/PageMeta.jsx");
  assert.ok(meta.includes("document.title"));
  assert.ok(meta.includes("noindex, nofollow"));
  const app = read("src/App.jsx");
  assert.ok(app.includes("<PageMeta"), "routes must set per-page metadata");
});
