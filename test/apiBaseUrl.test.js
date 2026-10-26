import test from "node:test";
import assert from "node:assert/strict";
import {
  assertProductionApiUrl,
  isLocalhostApiUrl,
  normalizeApiBaseUrl,
  resolveApiBaseURL
} from "../src/config/apiBaseUrl.js";

test("development defaults to the local backend when unset", () => {
  assert.equal(resolveApiBaseURL({ DEV: true }), "http://localhost:4000/api");
  assert.equal(resolveApiBaseURL({ DEV: true, VITE_API_BASE_URL: "   " }), "http://localhost:4000/api");
});

test("development honors a configured backend and trims trailing slashes", () => {
  assert.equal(
    resolveApiBaseURL({ DEV: true, VITE_API_BASE_URL: " https://api.example.test/api/// " }),
    "https://api.example.test/api"
  );
});

test("production uses the same-origin proxy when configuration is missing", () => {
  assert.equal(resolveApiBaseURL({}), "/api");
  assert.equal(resolveApiBaseURL({ DEV: false }), "/api");
  assert.equal(resolveApiBaseURL({ DEV: false, PROD: true, VITE_API_BASE_URL: "" }), "/api");
});

test("production ignores absolute backend URLs", () => {
  for (const configured of [
    "https://vups-router-be.onrender.com/api",
    "http://localhost:4000/api",
    "http://127.0.0.1:4000/api",
    "http://[::1]:4000/api"
  ]) {
    assert.equal(resolveApiBaseURL({ DEV: false, PROD: true, VITE_API_BASE_URL: configured }), "/api");
  }
});

test("production honors relative proxy paths", () => {
  assert.equal(resolveApiBaseURL({ DEV: false, VITE_API_BASE_URL: "/api/" }), "/api");
  assert.equal(resolveApiBaseURL({ DEV: false, VITE_API_BASE_URL: " /backend/// " }), "/backend");
});

test("base URL normalization handles empty and padded values", () => {
  assert.equal(normalizeApiBaseUrl(undefined), "");
  assert.equal(normalizeApiBaseUrl(null), "");
  assert.equal(normalizeApiBaseUrl("   "), "");
  assert.equal(normalizeApiBaseUrl(" https://api.example.test/api/ "), "https://api.example.test/api");
});

test("localhost detection covers loopback hosts", () => {
  for (const value of [
    "http://localhost:4000/api",
    "https://localhost",
    "http://127.0.0.1:4000/api",
    "http://127.10.20.30/api",
    "http://0.0.0.0:4000",
    "http://[::1]:4000/api"
  ]) {
    assert.equal(isLocalhostApiUrl(value), true, value);
  }
});

test("localhost detection ignores lookalike and relative values", () => {
  for (const value of ["/api", "", "https://localhost.example.com/api", "https://example.com/localhost"]) {
    assert.equal(isLocalhostApiUrl(value), false, value);
  }
});

test("production configuration validation rejects localhost", () => {
  assert.throws(() => assertProductionApiUrl("http://localhost:4000/api"), /localhost/i);
  assert.throws(() => assertProductionApiUrl("http://127.0.0.1:4000/api"), /localhost/i);
});

test("production configuration validation accepts the proxy and public backends", () => {
  assert.doesNotThrow(() => assertProductionApiUrl("/api"));
  assert.doesNotThrow(() => assertProductionApiUrl(""));
  assert.doesNotThrow(() => assertProductionApiUrl("https://vups-router-be.onrender.com/api"));
});
