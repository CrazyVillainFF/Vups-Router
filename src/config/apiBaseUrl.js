const LOCALHOST_API_RE =
  /^https?:\/\/(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\])(?::\d+)?(?:\/|$)/i;

export function normalizeApiBaseUrl(value) {
  const trimmed = String(value ?? "").trim();
  return trimmed ? trimmed.replace(/\/+$/, "") : "";
}

export function isLocalhostApiUrl(value) {
  return LOCALHOST_API_RE.test(String(value ?? "").trim());
}

export function assertProductionApiUrl(value) {
  if (isLocalhostApiUrl(value)) {
    throw new Error(
      "Refusing to build for production with VITE_API_BASE_URL pointing at localhost. " +
        "Unset it or set it to /api so requests use the same-origin Vercel proxy."
    );
  }
}

export function resolveApiBaseURL(env = {}) {
  const configured = normalizeApiBaseUrl(env.VITE_API_BASE_URL);
  if (env.DEV) {
    // Vite proxies /api to the backend declared in vite.config.js. Set
    // VITE_API_BASE_URL to call a different backend directly from the browser.
    return configured || "/api";
  }
  if (configured.startsWith("/")) return configured;
  // Production requests must stay on the Vercel origin so the HttpOnly
  // session cookie is first-party. An absolute backend URL (including a
  // stale localhost value) would make the cookie third-party or unreachable.
  return "/api";
}
