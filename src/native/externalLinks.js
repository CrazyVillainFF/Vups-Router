import { isTauriRuntime } from "./shell.js";

export const LINK_ERROR_EVENT = "vupsrouter:link-error";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function isLoopbackUrl(url) {
  return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
}

export function detectLinkRuntime() {
  if (isTauriRuntime()) return "tauri";
  const capacitor = typeof window !== "undefined" ? window.Capacitor : null;
  if (capacitor?.isNativePlatform?.()) return "capacitor";
  return "web";
}

// Only secure web links and email links leave the app. Anything else
// (javascript:, data:, file:, smb:) is rejected before it reaches the
// native opener, which has its own scheme allowlist as a second layer.
// Plain http is accepted for loopback only, so a QA build can hand off to a
// locally served site; remote http stays blocked.
export function parseExternalUrl(value, { allowMailto = true } = {}) {
  let url;
  try {
    url = value instanceof URL ? value : new URL(String(value ?? "").trim());
  } catch {
    throw new Error("This link is not a valid address.");
  }
  const allowed =
    url.protocol === "https:" ||
    (url.protocol === "mailto:" && allowMailto) ||
    isLoopbackUrl(url);
  if (!allowed) {
    throw new Error("Only secure https links can be opened.");
  }
  if (url.protocol === "https:" && (url.username || url.password)) {
    throw new Error("Links with embedded credentials are not allowed.");
  }
  if (url.protocol === "https:" && !url.hostname) {
    throw new Error("This link is missing a website address.");
  }
  return url;
}

export function reportLinkError(message, url = "") {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(LINK_ERROR_EVENT, { detail: { message, url: String(url) } }));
}

export async function openExternalUrl(value, options = {}) {
  const url = parseExternalUrl(value, options);
  const runtime = options.runtime ?? detectLinkRuntime();
  const target = url.toString();

  if (runtime === "tauri") {
    const opener = options.openUrl ?? (await import("@tauri-apps/plugin-opener")).openUrl;
    await opener(target);
    return target;
  }

  if (runtime === "capacitor") {
    const browser = options.browser ?? window.Capacitor?.Plugins?.Browser;
    if (browser?.open) {
      await browser.open({ url: target });
      return target;
    }
    // Capacitor's WebView client routes any navigation away from the app
    // origin to the system browser, so this hands off without a plugin.
    window.location.assign(target);
    return target;
  }

  const openWindow = options.openWindow ?? ((href) => window.open(href, "_blank"));
  const popup = openWindow(target);
  if (!popup) {
    throw new Error("Your browser blocked the link. Allow pop-ups for VupsRouter and try again.");
  }
  try {
    popup.opener = null;
  } catch {
    /* cross-origin windows can reject this; the link still opened */
  }
  return target;
}
