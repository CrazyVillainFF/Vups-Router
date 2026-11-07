import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { AxiosError, AxiosHeaders } from "axios";
import {
  apiClient,
  getApiErrorMessage,
  requestPasswordReset,
  resetPassword,
  verifyResetCode
} from "../src/services/api.js";

// The recovery screen must be able to tell "the provider accepted the message"
// from "the request was refused". These tests pin that contract from the
// client side: the state the backend reports survives the API layer, and a
// refusal reaches the UI as an error rather than as a success message.

const DELIVERY_FAILED_MESSAGE =
  "We could not send the reset email just now, so no code was sent. Please try again in a few minutes.";
const SENT_MESSAGE = "If that email exists, we sent a 6-digit code.";

function respondWith(data, status = 200) {
  const original = { baseURL: apiClient.defaults.baseURL, adapter: apiClient.defaults.adapter };
  apiClient.defaults.baseURL = "https://api.example.test/api";
  apiClient.defaults.adapter = async config => ({ data, status, statusText: "OK", headers: {}, config });
  return {
    restore() {
      apiClient.defaults.baseURL = original.baseURL;
      apiClient.defaults.adapter = original.adapter;
    }
  };
}

function rejectWith(response) {
  const original = { baseURL: apiClient.defaults.baseURL, adapter: apiClient.defaults.adapter };
  apiClient.defaults.baseURL = "https://api.example.test/api";
  apiClient.defaults.adapter = async config => {
    throw new AxiosError(
      response.status === 429 ? "Request failed with status code 429" : "Request failed with status code 503",
      AxiosError.ERR_BAD_RESPONSE,
      config,
      {},
      { ...response, statusText: "", headers: {}, config }
    );
  };
  return {
    restore() {
      apiClient.defaults.baseURL = original.baseURL;
      apiClient.defaults.adapter = original.adapter;
    }
  };
}

test("a refused send reaches the caller as an error carrying the honest message", async () => {
  const mock = rejectWith({
    data: { message: DELIVERY_FAILED_MESSAGE, state: "delivery_failed", code: "reset_email_delivery_failed" },
    status: 503,
    headers: new AxiosHeaders()
  });
  let error;
  try {
    await requestPasswordReset("someone@example.com");
  } catch (err) {
    error = err;
  } finally {
    mock.restore();
  }

  assert.ok(error, "a 503 must not resolve as a success");
  assert.equal(getApiErrorMessage(error), DELIVERY_FAILED_MESSAGE);
  assert.ok(
    !/^\s*If that email exists/i.test(getApiErrorMessage(error)),
    "the failure answer must not be the acceptance answer"
  );
});

test("a spent send quota reaches the caller as the rate-limit message", async () => {
  const mock = rejectWith({
    data: {
      message: "Too many reset codes were requested for this email. For security, we send at most 4 codes per 24 hours — try again in about 12 minutes.",
      state: "rate_limited",
      code: "reset_send_limit"
    },
    status: 429,
    headers: new AxiosHeaders()
  });
  let error;
  try {
    await requestPasswordReset("someone@example.com");
  } catch (err) {
    error = err;
  } finally {
    mock.restore();
  }

  assert.ok(error);
  assert.match(getApiErrorMessage(error), /at most 4 codes per 24 hours/);
});

test("the delivery state survives the API layer for every recovery response", async () => {
  const cases = [
    ["delivery_pending", () => requestPasswordReset("someone@example.com")],
    ["code_verified", () => verifyResetCode({ email: "someone@example.com", code: "123456" })],
    ["reset_completed", () => resetPassword({ email: "someone@example.com", code: "123456", newPassword: "new-one-1234" })]
  ];

  for (const [state, call] of cases) {
    const mock = respondWith({ message: "ok", state });
    try {
      const data = await call();
      assert.equal(data.state, state, `${state} must survive to the screen`);
    } finally {
      mock.restore();
    }
  }
});

test("client and backend agree on the recovery state vocabulary", () => {
  const routeSource = readFileSync(
    new URL("../../server/src/routes/passwordReset.js", import.meta.url),
    "utf8"
  );
  const backendStates = new Set(
    [...routeSource.matchAll(/const STATE_[A-Z_]+ = "([a-z_]+)";/g)].map(match => match[1])
  );

  assert.deepEqual(
    [...backendStates].sort(),
    [
      "code_verified",
      "delivery_failed",
      "delivery_pending",
      "invalid_or_expired_code",
      "invalid_request",
      "rate_limited",
      "reset_completed"
    ],
    "the backend state names are a fixed contract with the screens"
  );
});

test("the recovery screen shows the server answer and never claims an inbox delivery", () => {
  const source = readFileSync(new URL("../src/auth/PasswordRecovery.jsx", import.meta.url), "utf8");

  assert.ok(source.includes("getApiErrorMessage(err)"), "refusals are shown as errors");
  assert.ok(source.includes("data?.message"), "the accepted answer comes from the server, not hard-coded hope");
  assert.ok(!/delivered to your inbox|email was delivered|successfully sent to your inbox/i.test(source));
  assert.ok(
    source.includes("we respond the same way whether or not an account exists"),
    "the screen tells the user the answer is deliberately non-committal"
  );
});

test("the acceptance copy matches the backend string so neither over-claims", () => {
  const source = readFileSync(new URL("../src/auth/PasswordRecovery.jsx", import.meta.url), "utf8");
  const quoted = source.match(/const SENT_MESSAGE = "([^"]+)";/)?.[1];

  assert.equal(quoted, SENT_MESSAGE);
  assert.match(quoted, /^If that email exists, we sent a 6-digit code\.$/);
});
