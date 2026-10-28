import { isTauriRuntime } from "./shell.js";

export const PRODUCTION_SITE_URL = "https://vups-router-three.vercel.app";

// Mirrors the opener:allow-open-url scope in src-tauri/capabilities/desktop-local.json.
// A URL outside this set is rejected in JS before Tauri's ACL rejects it natively.
export const APPROVED_AUTH_ORIGINS = Object.freeze([new URL(PRODUCTION_SITE_URL).origin]);

export const AUTH_ROUTE_PATHS = Object.freeze({
  signin: "/signin",
  signup: "/signup"
});

export function assertApprovedAuthUrl(url) {
  const target = url instanceof URL ? url : new URL(url);
  if (target.protocol !== "https:") {
    throw new Error("Authentication links must use HTTPS.");
  }
  if (!APPROVED_AUTH_ORIGINS.includes(target.origin)) {
    throw new Error("Authentication links may only open the VupsRouter website.");
  }
  return target.toString();
}

export function authUrl(kind) {
  const path = AUTH_ROUTE_PATHS[kind];
  if (!path) throw new Error("Unknown authentication page.");
  return assertApprovedAuthUrl(new URL(path, PRODUCTION_SITE_URL));
}

export async function openAuthPage(kind, options = {}) {
  const url = authUrl(kind);
  const runtime = options.runtime ?? isTauriRuntime();

  if (runtime) {
    const opener = options.openUrl ?? (await import("@tauri-apps/plugin-opener")).openUrl;
    await opener(url);
    return url;
  }

  const openWindow =
    options.openWindow ??
    ((target, name, features) => window.open(target, name, features));
  const popup = openWindow(url, "_blank", "noopener,noreferrer");
  if (popup === null) {
    throw new Error("The browser blocked the VupsRouter page. Allow pop-ups and try again.");
  }
  return url;
}
