import { isTauriRuntime } from "./shell.js";

// The Windows shell reverse-proxies /api to one backend and reports which one
// over /__desktop/runtime. These names mirror api_environment() in
// src-tauri/src/desktop_server.rs so the app and the shell never disagree.
export const PRODUCTION_API_ORIGIN = "https://vups-router-be.onrender.com";

export const DESKTOP_RUNTIME_PATH = "/__desktop/runtime";

export const BACKEND_ENVIRONMENTS = Object.freeze({
  production: "production",
  local: "local",
  external: "external",
  unknown: "unknown"
});

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function normalizeOrigin(value) {
  try {
    return new URL(String(value ?? "").trim()).origin;
  } catch {
    return "";
  }
}

export function isLoopbackOrigin(value) {
  try {
    const url = new URL(String(value ?? "").trim());
    return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

export function classifyBackendEnvironment(origin) {
  const normalized = normalizeOrigin(origin);
  if (!normalized) return BACKEND_ENVIRONMENTS.unknown;
  if (normalized === normalizeOrigin(PRODUCTION_API_ORIGIN)) return BACKEND_ENVIRONMENTS.production;
  if (isLoopbackOrigin(normalized)) return BACKEND_ENVIRONMENTS.local;
  return BACKEND_ENVIRONMENTS.external;
}

function unknownRuntime(probed) {
  return {
    environment: BACKEND_ENVIRONMENTS.unknown,
    apiOrigin: "",
    debugBuild: false,
    labelledBy: probed ? "unreachable" : "not-probed"
  };
}

// Best-effort by design: a missing or hostile runtime endpoint must leave the
// sign-in screen usable, so every failure path resolves to `unknown`.
export async function readBackendRuntime({
  fetchImpl = globalThis.fetch,
  pageOrigin = globalThis.window?.location?.origin ?? "",
  inShell = isTauriRuntime()
} = {}) {
  if (!inShell && !isLoopbackOrigin(pageOrigin)) return unknownRuntime(false);
  if (typeof fetchImpl !== "function") return unknownRuntime(true);
  let payload;
  try {
    const response = await fetchImpl(DESKTOP_RUNTIME_PATH, { cache: "no-store", credentials: "omit" });
    if (!response?.ok) return unknownRuntime(true);
    payload = await response.json();
  } catch {
    return unknownRuntime(true);
  }
  const apiOrigin = normalizeOrigin(payload?.apiOrigin);
  const labelled = Object.values(BACKEND_ENVIRONMENTS).includes(payload?.apiEnvironment)
    ? payload.apiEnvironment
    : "";
  const environment = labelled || (apiOrigin ? classifyBackendEnvironment(apiOrigin) : BACKEND_ENVIRONMENTS.unknown);
  return {
    environment,
    apiOrigin,
    debugBuild: payload?.debugBuild === true,
    labelledBy: labelled ? "shell" : apiOrigin ? "origin" : "unreachable"
  };
}

export function backendEnvironmentNotice(runtime) {
  const environment = runtime?.environment;
  if (environment !== BACKEND_ENVIRONMENTS.local && environment !== BACKEND_ENVIRONMENTS.external) {
    return null;
  }
  const target = runtime.apiOrigin || "an unknown backend";
  const source =
    environment === BACKEND_ENVIRONMENTS.local
      ? "a local QA backend started from this machine"
      : "a backend that is not the VupsRouter production server";
  return {
    severity: "warning",
    message:
      `Developer diagnostic: this app is talking to ${target}, which is ${source}. ` +
      "Accounts created on the VupsRouter website do not exist there, so a correct website password is " +
      "rejected and a forgot-password request never reaches your real mailbox. This app never falls back " +
      "to production on its own."
  };
}

export function logBackendEnvironment(runtime, sink = globalThis.console) {
  if (!runtime || typeof sink?.info !== "function") return;
  sink.info(
    `[vupsrouter] backend environment=${runtime.environment} origin=${runtime.apiOrigin || "-"} ` +
      `labelledBy=${runtime.labelledBy} debugBuild=${runtime.debugBuild}`
  );
}
