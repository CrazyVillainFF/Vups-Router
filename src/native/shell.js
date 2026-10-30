export const NATIVE_SHELLS = Object.freeze({
  windows: "windows",
  android: "android"
});

export const NATIVE_SHELL_STORAGE_KEY = "vupsrouter.native-shell";

export function isTauriRuntime() {
  return typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);
}

export function normalizeNativeShell(value) {
  const candidate = typeof value === "string" ? value.trim().toLowerCase() : "";
  return candidate === NATIVE_SHELLS.windows || candidate === NATIVE_SHELLS.android
    ? candidate
    : null;
}

function defaultStorage() {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function detectNativeShell(search, storage = defaultStorage()) {
  let query = "";
  try {
    if (typeof search === "string") {
      query = new URLSearchParams(search).get("native") || "";
    } else if (typeof window !== "undefined") {
      query = new URLSearchParams(window.location.search).get("native") || "";
    }
  } catch {
    query = "";
  }

  const fromQuery = normalizeNativeShell(query);
  if (fromQuery) {
    try {
      storage?.setItem(NATIVE_SHELL_STORAGE_KEY, fromQuery);
    } catch {
      /* session storage is best-effort */
    }
    return fromQuery;
  }

  try {
    return normalizeNativeShell(storage?.getItem(NATIVE_SHELL_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function nativeChatPath(shell) {
  const normalized = normalizeNativeShell(shell);
  return normalized ? `/chat?native=${normalized}` : "/chat";
}

export function isNativeShell(shell, expected) {
  const normalized = normalizeNativeShell(shell);
  return Boolean(normalized && (!expected || normalized === expected));
}

// Only the Windows shell needs account access to happen in a real browser: it
// serves its own UI from a loopback origin, so a cookie set by the production
// site would never reach the app. The Android WebView is already on that site's
// origin, so it signs in in place and the session cookie stays first-party.
export function usesBrowserAuthHandoff(shell) {
  return normalizeNativeShell(shell) === NATIVE_SHELLS.windows;
}
