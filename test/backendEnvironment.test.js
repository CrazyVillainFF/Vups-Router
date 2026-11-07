import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  BACKEND_ENVIRONMENTS,
  DESKTOP_RUNTIME_PATH,
  PRODUCTION_API_ORIGIN,
  backendEnvironmentNotice,
  classifyBackendEnvironment,
  isLoopbackOrigin,
  logBackendEnvironment,
  normalizeOrigin,
  readBackendRuntime
} from "../src/native/backendEnvironment.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = file => readFileSync(path.join(root, file), "utf8");

const LOCAL_QA = "http://127.0.0.1:4190";

function shellRuntime(payload, calls = []) {
  return {
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return { ok: true, json: async () => payload };
    },
    calls
  };
}

test("the active backend is named by environment, not guessed by the user", () => {
  assert.equal(classifyBackendEnvironment(PRODUCTION_API_ORIGIN), BACKEND_ENVIRONMENTS.production);
  assert.equal(classifyBackendEnvironment(`${PRODUCTION_API_ORIGIN}/`), BACKEND_ENVIRONMENTS.production);
  assert.equal(classifyBackendEnvironment(LOCAL_QA), BACKEND_ENVIRONMENTS.local);
  assert.equal(classifyBackendEnvironment("http://localhost:4000"), BACKEND_ENVIRONMENTS.local);
  assert.equal(classifyBackendEnvironment("https://staging.example.com"), BACKEND_ENVIRONMENTS.external);
  assert.equal(classifyBackendEnvironment("not a url"), BACKEND_ENVIRONMENTS.unknown);
  assert.equal(classifyBackendEnvironment(""), BACKEND_ENVIRONMENTS.unknown);
});

test("a loopback https origin is never treated as the local QA backend", () => {
  assert.equal(isLoopbackOrigin("https://127.0.0.1:4190"), false);
  assert.equal(isLoopbackOrigin("http://169.254.169.254"), false);
  assert.equal(isLoopbackOrigin("http://10.0.0.5:4190"), false);
  assert.equal(isLoopbackOrigin("http://[::1]:4190"), true);
  assert.equal(classifyBackendEnvironment("https://127.0.0.1:4190"), BACKEND_ENVIRONMENTS.external);
});

test("the client production origin is the same literal the Rust shell proxies to", () => {
  const rust = read("src-tauri/src/desktop_server.rs");
  const rustOrigin = rust.match(/const API_ORIGIN: &str = "([^"]+)"/)?.[1];
  assert.ok(rustOrigin, "the shell still declares a single API_ORIGIN literal");
  assert.equal(PRODUCTION_API_ORIGIN, rustOrigin);
  assert.equal(normalizeOrigin(PRODUCTION_API_ORIGIN), PRODUCTION_API_ORIGIN);
});

test("the shell's own label wins over anything the page guesses", async () => {
  const { fetchImpl, calls } = shellRuntime({
    apiOrigin: LOCAL_QA,
    apiEnvironment: BACKEND_ENVIRONMENTS.local,
    debugBuild: true,
    pageOrigin: "http://127.0.0.1:47821"
  });
  const runtime = await readBackendRuntime({ fetchImpl, pageOrigin: "http://127.0.0.1:47821", inShell: true });
  assert.equal(runtime.environment, "local");
  assert.equal(runtime.apiOrigin, LOCAL_QA);
  assert.equal(runtime.debugBuild, true);
  assert.equal(runtime.labelledBy, "shell");
  assert.equal(calls[0].url, DESKTOP_RUNTIME_PATH);
  assert.equal(calls[0].init.credentials, "omit", "the runtime probe must never send the session cookie");
});

test("an older shell without a label is still classified from its origin", async () => {
  const { fetchImpl } = shellRuntime({ apiOrigin: "https://preview.example" });
  const runtime = await readBackendRuntime({ fetchImpl, pageOrigin: "http://127.0.0.1:47821", inShell: true });
  assert.equal(runtime.environment, "external");
  assert.equal(runtime.labelledBy, "origin");
  assert.equal(runtime.debugBuild, false);
});

test("a browser tab left on the loopback shell is diagnosed without the Tauri runtime", async () => {
  const { fetchImpl, calls } = shellRuntime({ apiOrigin: LOCAL_QA, apiEnvironment: "local" });
  const runtime = await readBackendRuntime({ fetchImpl, pageOrigin: "http://127.0.0.1:47821", inShell: false });
  assert.equal(runtime.environment, "local");
  assert.equal(calls.length, 1);
});

test("the public website never probes for a desktop runtime", async () => {
  let probed = 0;
  const runtime = await readBackendRuntime({
    fetchImpl: async () => {
      probed += 1;
      throw new Error("must not be called");
    },
    pageOrigin: "https://vups-router-three.vercel.app",
    inShell: false
  });
  assert.equal(probed, 0);
  assert.equal(runtime.environment, BACKEND_ENVIRONMENTS.unknown);
  assert.equal(runtime.labelledBy, "not-probed");
});

test("an unreachable or hostile runtime endpoint degrades to unknown", async () => {
  const throwing = await readBackendRuntime({
    fetchImpl: async () => {
      throw new Error("shell not listening");
    },
    pageOrigin: "http://127.0.0.1:47821",
    inShell: true
  });
  assert.equal(throwing.environment, BACKEND_ENVIRONMENTS.unknown);

  const notFound = await readBackendRuntime({
    // The web host serves the SPA shell for an unknown path: HTML, not JSON.
    fetchImpl: async () => ({ ok: true, json: async () => JSON.parse("<html>not json</html>") }),
    pageOrigin: "http://127.0.0.1:47821",
    inShell: true
  });
  assert.equal(notFound.environment, BACKEND_ENVIRONMENTS.unknown);

  const refused = await readBackendRuntime({
    fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }),
    pageOrigin: "http://127.0.0.1:47821",
    inShell: true
  });
  assert.equal(refused.environment, BACKEND_ENVIRONMENTS.unknown);
  assert.equal(refused.labelledBy, "unreachable");
});

test("only a non-production backend gets a warning, and it says what breaks", () => {
  assert.equal(backendEnvironmentNotice({ environment: "production", apiOrigin: PRODUCTION_API_ORIGIN }), null);
  assert.equal(backendEnvironmentNotice({ environment: "unknown", apiOrigin: "" }), null);
  assert.equal(backendEnvironmentNotice(null), null);

  const notice = backendEnvironmentNotice({ environment: "local", apiOrigin: LOCAL_QA });
  assert.equal(notice.severity, "warning");
  assert.match(notice.message, /127\.0\.0\.1:4190/);
  assert.match(notice.message, /local QA backend/);
  assert.match(notice.message, /correct website password is rejected/);
  assert.match(notice.message, /never reaches your real mailbox/);
  assert.match(notice.message, /never falls back to production/, "silently switching is the bug being fixed");
});

test("the diagnostic log names the environment and nothing secret", () => {
  const lines = [];
  logBackendEnvironment(
    { environment: "local", apiOrigin: LOCAL_QA, debugBuild: true, labelledBy: "shell" },
    { info: line => lines.push(line) }
  );
  assert.equal(lines.length, 1);
  assert.match(lines[0], /environment=local/);
  assert.doesNotMatch(lines[0], /vr_session|ticket|verifier|cookie|Bearer/i);
  logBackendEnvironment({ environment: "production" }, null);
  assert.equal(lines.length, 1, "a missing console must not throw in the app window");
});

test("the sign-in screen renders the active backend environment", () => {
  const app = read("src/App.jsx");
  assert.match(app, /from "\.\/native\/backendEnvironment\.js"/);
  assert.match(app, /readBackendRuntime\(\)/);
  assert.match(app, /backendEnvironmentNotice\(backendRuntime\)/);
  assert.match(app, /\{backendNotice \? <Alert/);
});

test("the password recovery screen names the active backend too", () => {
  const recovery = read("src/auth/PasswordRecovery.jsx");
  assert.match(recovery, /from "\.\.\/native\/backendEnvironment\.js"/);
  assert.match(recovery, /readBackendRuntime\(\)/);
  assert.match(recovery, /backendEnvironmentNotice\(backendRuntime\)/);
  assert.match(recovery, /\{backendNotice \? <Alert/, "a code sent to a QA backend must not look like a real reset");
});
