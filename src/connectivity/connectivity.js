import { useSyncExternalStore } from "react";
import { resolveApiBaseURL } from "../config/apiBaseUrl.js";

/**
 * One connectivity state for the whole app.
 *
 * The browser's `onLine` flag only says a network interface exists; it does not
 * say the VupsRouter backend can be reached. Offline-first behaviour needs the
 * stricter answer because a local model must not be blocked by a cloud that is
 * down, and a cloud call must not be attempted repeatedly while there is no
 * route to it. A bounded health probe supplies that answer without delaying
 * startup.
 */

export const OFFLINE_ERROR_CODE = "OFFLINE";
export const OFFLINE_MESSAGE =
  "You are offline. Cloud features are unavailable until the connection returns; installed local models keep working.";
export const PROBE_TIMEOUT_MS = 4000;
export const PROBE_MIN_INTERVAL_MS = 30000;

const NON_ROUTE_ERROR_CODES = new Set([
  "ERR_CANCELED",
  "ABORT_ERR",
  "ECONNABORTED",
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
  "ERR_INVALID_URL"
]);

export function offlineError() {
  const error = new Error(OFFLINE_MESSAGE);
  error.code = OFFLINE_ERROR_CODE;
  error.isOffline = true;
  return error;
}

export function isOfflineError(error) {
  return error?.code === OFFLINE_ERROR_CODE || error?.isOffline === true;
}

function initialState(nav) {
  const browserOnline = !nav || nav.onLine !== false;
  return Object.freeze({
    online: browserOnline,
    checking: false,
    backendReachable: browserOnline ? null : false,
    lastCheckedAt: 0,
    reason: browserOnline ? "initial" : "navigator"
  });
}

export function createConnectivityManager({
  nav = typeof navigator === "undefined" ? null : navigator,
  fetchImpl = typeof fetch === "function" ? (...args) => fetch(...args) : null,
  getApiBase = () =>
    resolveApiBaseURL(typeof import.meta !== "undefined" ? import.meta.env || {} : {}),
  now = () => Date.now(),
  setTimeoutImpl = typeof setTimeout === "function" ? setTimeout : null,
  clearTimeoutImpl = typeof clearTimeout === "function" ? clearTimeout : null,
  probeTimeoutMs = PROBE_TIMEOUT_MS,
  minProbeIntervalMs = PROBE_MIN_INTERVAL_MS
} = {}) {
  let state = initialState(nav);
  const listeners = new Set();
  let probeInFlight = null;
  let activeController = null;

  function emit(patch) {
    state = Object.freeze({ ...state, ...patch });
    for (const listener of [...listeners]) listener();
  }

  function markOffline(reason) {
    activeController?.abort();
    emit({ online: false, checking: false, backendReachable: false, reason });
  }

  function markOnline(reason) {
    emit({ online: true, checking: false, backendReachable: true, reason });
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function responseIsReachable(status) {
    // A 4xx still proves the route and the backend answered; only a 5xx means
    // the cloud work this client wants cannot be served right now.
    return status < 500;
  }

  async function probe({ force = false } = {}) {
    if (nav && nav.onLine === false) {
      markOffline("navigator");
      return state;
    }
    if (probeInFlight) return probeInFlight;
    if (!force && state.lastCheckedAt && now() - state.lastCheckedAt < minProbeIntervalMs) {
      return state;
    }
    if (!fetchImpl) {
      emit({ online: true, backendReachable: null, reason: "no-fetch" });
      return state;
    }

    emit({ checking: true });
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    activeController = controller;
    let timer = null;
    probeInFlight = (async () => {
      try {
        if (timer === null && setTimeoutImpl && controller) {
          timer = setTimeoutImpl(() => controller.abort(), probeTimeoutMs);
        }
        const base = String(getApiBase() || "/api").replace(/\/+$/, "");
        const response = await fetchImpl(`${base}/health`, {
          method: "GET",
          headers: { Accept: "application/json" },
          cache: "no-store",
          signal: controller?.signal
        });
        if (responseIsReachable(response.status)) markOnline("probe");
        else markOffline(`HTTP ${response.status}`);
      } catch (error) {
        markOffline(error?.name === "AbortError" ? "timeout" : "network");
      } finally {
        if (timer !== null) clearTimeoutImpl?.(timer);
        activeController = null;
        emit({ checking: false, lastCheckedAt: now() });
        probeInFlight = null;
      }
      return state;
    })();
    return probeInFlight;
  }

  /**
   * A request with no HTTP response is evidence of a broken route, not a
   * backend decision. Marking it here stops every screen from firing its own
   * retries at the same dead endpoint.
   */
  function reportRequestFailure(error) {
    if (nav && nav.onLine === false) {
      markOffline("navigator");
      return;
    }
    // A user stop, a client-side timeout or a malformed request URL says
    // nothing about the route; only a request that ended without any HTTP
    // response is evidence of it. The health probe stays the authority on
    // whether the backend can actually be reached.
    if (error?.name === "AbortError" || NON_ROUTE_ERROR_CODES.has(error?.code)) return;
    if (!error?.response) markOffline("request");
  }

  function reportRequestSuccess() {
    if (!state.online && (!nav || nav.onLine !== false)) markOnline("request");
  }

  function handleBrowserOnline() {
    if (!state.online) emit({ checking: true, reason: "browser-online" });
    probe({ force: true });
  }

  function handleBrowserOffline() {
    markOffline("navigator");
  }

  return {
    getState: () => state,
    isOnline: () => state.online,
    subscribe,
    probe,
    refresh: () => probe({ force: true }),
    reportRequestFailure,
    reportRequestSuccess,
    handleBrowserOnline,
    handleBrowserOffline
  };
}

const manager = createConnectivityManager();
let started = false;
let stopBrowserEvents = null;

export function startConnectivity(target = typeof window === "undefined" ? null : window) {
  if (started) return;
  started = true;
  if (target?.addEventListener) {
    target.addEventListener("online", manager.handleBrowserOnline);
    target.addEventListener("offline", manager.handleBrowserOffline);
    stopBrowserEvents = () => {
      target.removeEventListener("online", manager.handleBrowserOnline);
      target.removeEventListener("offline", manager.handleBrowserOffline);
    };
  }
  // Deliberately not awaited: assets and local data must render whether or not
  // this probe ever answers.
  manager.probe();
}

export function stopConnectivity() {
  stopBrowserEvents?.();
  stopBrowserEvents = null;
  started = false;
}

export function getConnectivityState() {
  return manager.getState();
}

export function subscribeConnectivity(listener) {
  return manager.subscribe(listener);
}

export function isCloudOnline() {
  return manager.isOnline();
}

export function refreshConnectivity() {
  return manager.refresh();
}

export function reportNetworkFailure(error) {
  manager.reportRequestFailure(error);
}

export function reportNetworkSuccess() {
  manager.reportRequestSuccess();
}

export function useConnectivity() {
  const snapshot = useSyncExternalStore(subscribeConnectivity, getConnectivityState, getConnectivityState);
  return {
    ...snapshot,
    offline: !snapshot.online,
    localOnly: !snapshot.online,
    refresh: refreshConnectivity
  };
}
