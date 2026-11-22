import test from "node:test";
import assert from "node:assert/strict";
import {
  apiClient,
  fetchCurrentUser,
  getApiErrorMessage,
  listConversations
} from "../src/services/api.js";
import {
  isCloudOnline,
  isOfflineError,
  reportNetworkFailure,
  reportNetworkSuccess
} from "../src/connectivity/connectivity.js";
import { cachedFetchProviderConfig } from "../src/services/settingsCache.js";

function trackingAdapter() {
  const requests = [];
  const originalBaseURL = apiClient.defaults.baseURL;
  const originalAdapter = apiClient.defaults.adapter;
  apiClient.defaults.baseURL = "https://api.example.test/api";
  apiClient.defaults.adapter = async config => {
    requests.push(config.url);
    return {
      data: { user: { id: "user-1" } },
      status: 200,
      statusText: "OK",
      headers: {},
      config
    };
  };
  return {
    requests,
    restore() {
      apiClient.defaults.baseURL = originalBaseURL;
      apiClient.defaults.adapter = originalAdapter;
    }
  };
}

function forceOffline() {
  // A request that ended without any HTTP response is the connectivity
  // manager's evidence of a broken route.
  reportNetworkFailure({});
}

test("a cloud request made offline is refused before it reaches the network", async () => {
  const adapter = trackingAdapter();
  try {
    forceOffline();
    assert.equal(isCloudOnline(), false);

    await assert.rejects(listConversations(), error => {
      assert.equal(error.code, "OFFLINE");
      assert.equal(isOfflineError(error), true);
      return true;
    });

    assert.deepEqual(adapter.requests, []);
  } finally {
    adapter.restore();
    reportNetworkSuccess();
  }
});

test("the offline refusal reads as a plain explanation to the user", () => {
  const error = new Error("You are offline. Cloud features are unavailable until the connection returns; installed local models keep working.");
  error.code = "OFFLINE";
  error.isOffline = true;
  assert.match(getApiErrorMessage(error), /^You are offline\./);
});

test("the settings cache does not start a request while offline", async () => {
  const adapter = trackingAdapter();
  try {
    forceOffline();
    await assert.rejects(cachedFetchProviderConfig(), error => error.code === "OFFLINE");
    assert.deepEqual(adapter.requests, []);
  } finally {
    adapter.restore();
    reportNetworkSuccess();
  }
});

test("reconnecting lets the same call through again", async () => {
  const adapter = trackingAdapter();
  try {
    forceOffline();
    await assert.rejects(fetchCurrentUser(), error => error.code === "OFFLINE");

    reportNetworkSuccess();
    assert.equal(isCloudOnline(), true);

    const user = await fetchCurrentUser();
    assert.deepEqual(user, { id: "user-1" });
    assert.deepEqual(adapter.requests, ["/auth/me"]);
  } finally {
    adapter.restore();
    reportNetworkSuccess();
  }
});

test("a user stop or an HTTP error is not evidence the route is down", () => {
  reportNetworkSuccess();
  assert.equal(isCloudOnline(), true);

  const aborted = new Error("canceled");
  aborted.name = "AbortError";
  reportNetworkFailure(aborted);
  assert.equal(isCloudOnline(), true);

  reportNetworkFailure({ code: "ERR_CANCELED" });
  assert.equal(isCloudOnline(), true);

  // A client-side timeout leaves the route unproven, not disproven; the health
  // probe decides. The same goes for a request that never had a valid URL.
  reportNetworkFailure({ code: "ECONNABORTED", message: "timeout" });
  assert.equal(isCloudOnline(), true);
  reportNetworkFailure({ code: "ERR_INVALID_URL", message: "Invalid URL" });
  assert.equal(isCloudOnline(), true);

  reportNetworkFailure({ response: { status: 500 } });
  assert.equal(isCloudOnline(), true);

  reportNetworkFailure({});
  assert.equal(isCloudOnline(), false);

  reportNetworkSuccess();
  assert.equal(isCloudOnline(), true);
});
