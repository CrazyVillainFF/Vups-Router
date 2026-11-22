import test from "node:test";
import assert from "node:assert/strict";
import {
  OFFLINE_ERROR_CODE,
  OFFLINE_MESSAGE,
  createConnectivityManager,
  isOfflineError,
  offlineError
} from "../src/connectivity/connectivity.js";

function jsonResponse(status) {
  return { status, ok: status < 400 };
}

function managerWith(fetchImpl, overrides = {}) {
  const nav = { onLine: true };
  return createConnectivityManager({
    nav,
    fetchImpl,
    getApiBase: () => "/api",
    now: () => Date.now(),
    probeTimeoutMs: 50,
    minProbeIntervalMs: 30000,
    ...overrides
  });
}

test("offline error is identifiable without reading its wording", () => {
  const error = offlineError();
  assert.equal(error.code, OFFLINE_ERROR_CODE);
  assert.equal(error.message, OFFLINE_MESSAGE);
  assert.equal(isOfflineError(error), true);
  assert.equal(isOfflineError({ code: OFFLINE_ERROR_CODE }), true);
  assert.equal(isOfflineError({ code: "OTHER" }), false);
});

test("a browser with no network interface starts offline without probing", async () => {
  let calls = 0;
  const manager = createConnectivityManager({
    nav: { onLine: false },
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse(200);
    },
    getApiBase: () => "/api"
  });
  assert.equal(manager.getState().online, false);
  await manager.probe();
  assert.equal(calls, 0);
  assert.equal(manager.getState().online, false);
  assert.equal(manager.getState().reason, "navigator");
});

test("a reachable health endpoint marks the cloud online", async () => {
  const manager = managerWith(async url => {
    assert.equal(url, "/api/health");
    return jsonResponse(200);
  });
  const state = await manager.probe();
  assert.equal(state.online, true);
  assert.equal(state.backendReachable, true);
  assert.equal(state.reason, "probe");
  assert.equal(state.checking, false);
});

test("a 4xx answer still proves the route while a 5xx does not", async () => {
  const unauthorized = managerWith(async () => jsonResponse(401));
  await unauthorized.probe();
  assert.equal(unauthorized.getState().online, true);

  const broken = managerWith(async () => jsonResponse(503));
  await broken.probe();
  assert.equal(broken.getState().online, false);
  assert.equal(broken.getState().backendReachable, false);
  assert.equal(broken.getState().reason, "HTTP 503");
});

test("network and timeout failures mark the cloud offline", async () => {
  const failed = managerWith(async () => {
    throw new Error("getaddrinfo ENOTFOUND");
  });
  await failed.probe();
  assert.equal(failed.getState().online, false);
  assert.equal(failed.getState().reason, "network");

  const hanging = managerWith(
    (url, options) =>
      new Promise((resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      }),
    { probeTimeoutMs: 10 }
  );
  await hanging.probe();
  assert.equal(hanging.getState().online, false);
  assert.equal(hanging.getState().reason, "timeout");
  assert.ok(hanging.getState().lastCheckedAt > 0);
});

test("concurrent probes share one request and the minimum interval suppresses repeats", async () => {
  let calls = 0;
  let release;
  const gate = new Promise(resolve => {
    release = resolve;
  });
  let clock = 1000;
  const manager = managerWith(
    async () => {
      calls += 1;
      await gate;
      return jsonResponse(200);
    },
    { now: () => clock, minProbeIntervalMs: 1000 }
  );

  const first = manager.probe();
  const second = manager.probe();
  assert.equal(calls, 1);
  release();
  await Promise.all([first, second]);
  assert.equal(calls, 1);

  await manager.probe();
  assert.equal(calls, 1, "a fresh answer is reused inside the interval");

  clock += 1001;
  await manager.probe();
  assert.equal(calls, 2);
});

test("a request without a response marks offline, but a cancel does not", () => {
  let calls = 0;
  const manager = managerWith(async () => {
    calls += 1;
    return jsonResponse(200);
  });

  manager.reportRequestFailure({ message: "Network Error" });
  assert.equal(manager.getState().online, false);
  assert.equal(manager.getState().reason, "request");

  manager.reportRequestSuccess();
  assert.equal(manager.getState().online, true);

  manager.reportRequestFailure({ name: "AbortError" });
  assert.equal(manager.getState().online, true);

  manager.reportRequestFailure({ code: "ERR_CANCELED" });
  assert.equal(manager.getState().online, true);

  manager.reportRequestFailure({ response: { status: 500 } });
  assert.equal(manager.getState().online, true, "an HTTP answer is not a broken route");
  assert.equal(calls, 0);
});

test("browser online and offline events drive the same gate", async () => {
  let calls = 0;
  const manager = managerWith(async () => {
    calls += 1;
    return jsonResponse(200);
  });

  manager.handleBrowserOffline();
  assert.equal(manager.getState().online, false);

  manager.handleBrowserOnline();
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(calls, 1);
  assert.equal(manager.getState().online, true);

  manager.handleBrowserOffline();
  assert.equal(manager.getState().online, false);
  assert.equal(manager.getState().reason, "navigator");
});

test("subscribers are told about every transition and can detach", async () => {
  const manager = managerWith(async () => jsonResponse(200));
  let seen = 0;
  const unsubscribe = manager.subscribe(() => {
    seen += 1;
  });
  await manager.probe();
  assert.ok(seen >= 2, "checking and the final state both notify");
  const after = seen;
  unsubscribe();
  manager.handleBrowserOffline();
  assert.equal(seen, after);
});
