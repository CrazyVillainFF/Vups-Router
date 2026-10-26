import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { assertProductionApiUrl, normalizeApiBaseUrl } from "../src/config/apiBaseUrl.js";

const RENDER_API = "https://vups-router-be.onrender.com/api";
const configured = normalizeApiBaseUrl(process.env.VITE_API_BASE_URL);

try {
  assertProductionApiUrl(configured);
} catch (error) {
  console.error(`[api-config] ${error.message}`);
  process.exit(1);
}

if (configured && !configured.startsWith("/")) {
  console.warn(
    "[api-config] VITE_API_BASE_URL is an absolute URL and is ignored in production. " +
      "Requests use the same-origin /api proxy. Set it to /api (or unset it) in Vercel."
  );
}

const vercelPath = fileURLToPath(new URL("../vercel.json", import.meta.url));
const vercel = JSON.parse(fs.readFileSync(vercelPath, "utf8"));
const rewrites = Array.isArray(vercel.rewrites) ? vercel.rewrites : [];
const proxy = rewrites.find(
  rewrite =>
    (rewrite.source === "/api" || String(rewrite.source || "").startsWith("/api/")) &&
    String(rewrite.destination || "").startsWith(`${RENDER_API}/`)
);
if (!proxy) {
  console.error(`[api-config] vercel.json must proxy /api/* to ${RENDER_API}/*.`);
  process.exit(1);
}

console.log("[api-config] Production API base URL: /api (Vercel proxy configured).");
