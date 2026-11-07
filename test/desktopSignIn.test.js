import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { apiClient } from "../src/services/api.js";
import {
  DESKTOP_SIGNIN_STORAGE_KEY,
  DesktopSignInError,
  abortPendingPoll,
  approvalBaseUrl,
  approvalUrl,
  beginDesktopSignIn,
  challengeForVerifier,
  clearPendingSignIn,
  createVerifier,
  hasActivePoll,
  pollDesktopSignIn,
  readPendingSignIn,
  reopenDesktopSignIn,
  savePendingSignIn,
  siteBaseUrl,
  waitForDesktopSignIn
} from "../src/native/desktopSignIn.js";
import { PRODUCTION_SITE_URL } from "../src/native/authLinks.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = file => readFileSync(path.join(root, file), "utf8");

const TICKET = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const VERIFIER = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: key => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: key => data.delete(key)
  };
}

function transaction(overrides = {}) {
  return {
    ticket: TICKET,
    verifier: VERIFIER,
    mode: "signin",
    client: "windows",
    expiresAt: Date.now() + 600_000,
    ...overrides
  };
}

// The helpers read `window` and `localStorage` at call time, so each scenario
// installs its own globals and restores whatever was there before. The restore
// has to wait for the scenario's own awaits, or the stub disappears mid-flight.
async function withGlobals(values, run) {
  const entries = Object.entries(values);
  const previous = entries.map(([name]) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  for (const [name, value] of entries) {
    Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
  }
  try {
    return await run();
  } finally {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
}

async function withApiStub(handler, run) {
  const original = apiClient.post;
  const calls = [];
  apiClient.post = async (url, body, config) => {
    calls.push({ url, body, config });
    return handler(url, body, config, calls.length);
  };
  try {
    return await run(calls);
  } finally {
    apiClient.post = original;
  }
}

function response(status, data) {
  return { status, data };
}

async function rejection(run) {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to fail");
}

// axios rejects with a response object; a transport failure has none at all.
// The polling loop has to tell those two apart, so the fixtures say so too.
function httpError(status, message = "Request failed") {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    isAxiosError: true,
    response: { status, data: { message } }
  });
}

function offlineError() {
  return Object.assign(new Error("Network Error"), { isAxiosError: true });
}

// Lets the loop under test get its request out before the scenario acts on it.
async function until(predicate, tries = 100) {
  for (let i = 0; i < tries; i += 1) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  throw new Error("the condition never became true");
}

// A promise that rejects while nobody is watching it is a test bug, not a
// result: capture the outcome instead of attaching a handler after the fact.
function settled(promise) {
  return promise.then(value => ({ ok: true, value }), error => ({ ok: false, error }));
}

test("the sign-in page always lives on the deployed HTTPS site", () => {
  assert.equal(siteBaseUrl({}), new URL(PRODUCTION_SITE_URL).origin);
  assert.equal(siteBaseUrl({ VITE_SITE_URL: "https://preview.example/" }), "https://preview.example");
  assert.equal(siteBaseUrl({ VITE_SITE_URL: "http://localhost:5173" }), "http://localhost:5173");
  assert.equal(siteBaseUrl({ VITE_SITE_URL: "http://evil.example" }), new URL(PRODUCTION_SITE_URL).origin);
  assert.equal(siteBaseUrl({ VITE_SITE_URL: "javascript:alert(1)" }), new URL(PRODUCTION_SITE_URL).origin);
});

test("the approval page stays on the app origin when the API is loopback", () => {
  assert.equal(
    approvalBaseUrl(
      { VITE_SITE_URL: "https://site.test" },
      { apiOrigin: "http://127.0.0.1:4190", pageOrigin: "http://127.0.0.1:52123" }
    ),
    "http://127.0.0.1:52123"
  );
  assert.equal(
    approvalBaseUrl(
      { VITE_SITE_URL: "https://site.test" },
      { apiOrigin: "https://vups-router-be.onrender.com", pageOrigin: "http://127.0.0.1:52123" }
    ),
    "https://site.test"
  );
  assert.equal(
    approvalBaseUrl(
      {},
      { apiOrigin: "http://127.0.0.1:4190", pageOrigin: "https://vups-router-three.vercel.app" }
    ),
    new URL(PRODUCTION_SITE_URL).origin,
    "a non-loopback page origin never becomes the approval origin"
  );
  assert.equal(
    new URL(approvalUrl(transaction(), {}, "http://127.0.0.1:52123")).origin,
    "http://127.0.0.1:52123"
  );
});

test("the challenge is the SHA-256 of a local verifier", async () => {
  const verifier = await createVerifier();
  assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(await challengeForVerifier(verifier), createHash("sha256").update(verifier).digest("base64url"));
  assert.notEqual(await createVerifier(), verifier, "each attempt gets its own verifier");
});

test("starting a sign-in sends only the challenge, saves the verifier, opens the browser once", async () => {
  const store = memoryStorage();
  const opened = [];
  const fakeWindow = { open: value => { opened.push(String(value)); return { close() {} }; } };

  const outcome = await withGlobals({ localStorage: store, window: fakeWindow }, () =>
    withApiStub(async (url, body) => {
      assert.equal(url, "/auth/desktop/start");
      assert.deepEqual(Object.keys(body).sort(), ["challenge", "client"]);
      assert.match(body.challenge, /^[A-Za-z0-9_-]{43}$/);
      assert.equal(body.client, "windows");
      return response(201, { ticket: TICKET, expiresIn: 600, expiresAt: new Date(Date.now() + 600_000).toISOString() });
    }, () => beginDesktopSignIn({ client: "windows", mode: "signin" }))
  );

  assert.equal(opened.length, 1, "the browser is opened exactly once");
  const approval = new URL(opened[0]);
  assert.equal(approval.origin, new URL(PRODUCTION_SITE_URL).origin);
  assert.equal(approval.pathname, "/desktop-auth");
  assert.equal(approval.searchParams.get("ticket"), outcome.transaction.ticket);
  assert.doesNotMatch(opened[0], /(token|jwt|secret|session)=/i, "no credential is ever carried in the URL");
  assert.ok(!opened[0].includes(outcome.transaction.verifier), "the verifier never travels in the URL");
  const saved = JSON.parse(store.getItem(DESKTOP_SIGNIN_STORAGE_KEY));
  assert.equal(saved.verifier, outcome.transaction.verifier, "the verifier stays on the device");
  assert.equal(saved.ticket, TICKET);
});

test("a malformed start response is refused and nothing is stored or opened", async () => {
  const store = memoryStorage();
  const opened = [];
  await withGlobals({ localStorage: store, window: { open: value => { opened.push(String(value)); return { close() {} }; } } }, () =>
    withApiStub(async () => response(201, { ticket: "short" }), async () => {
      await assert.rejects(() => beginDesktopSignIn({ client: "windows" }), DesktopSignInError);
      assert.equal(store.getItem(DESKTOP_SIGNIN_STORAGE_KEY), null);
      assert.deepEqual(opened, []);
    })
  );
});

test("a backend without the sign-in route fails with a readable reason", async () => {
  const store = memoryStorage();
  const opened = [];
  const axiosLike = Object.assign(new Error("Request failed with status code 404"), {
    isAxiosError: true,
    response: { status: 404, data: { message: "That API route does not exist." } }
  });
  await withGlobals({ localStorage: store, window: { open: value => { opened.push(String(value)); return { close() {} }; } } }, () =>
    withApiStub(async () => { throw axiosLike; }, async () => {
      const error = await rejection(() => beginDesktopSignIn({ client: "windows" }));
      assert.ok(error instanceof DesktopSignInError, "a refused start reports a sign-in error");
      assert.equal(error.reason, "start_failed");
      assert.match(error.message, /does not offer app sign-in yet/);
      assert.doesNotMatch(error.message, /status code 404/, "the raw HTTP status is never shown to the user");
      assert.equal(store.getItem(DESKTOP_SIGNIN_STORAGE_KEY), null);
      assert.deepEqual(opened, [], "a refused start never opens the browser");
    })
  );

  await withGlobals({ localStorage: store, window: { open: () => ({ close() {} }) } }, () =>
    withApiStub(async () => { throw Object.assign(new Error("Request failed with status code 500"), { isAxiosError: true, response: { status: 500 } }); }, async () => {
      const error = await rejection(() => beginDesktopSignIn({ client: "windows" }));
      assert.match(error.message, /HTTP 500/);
    })
  );
});

test("the pending transaction survives a restart and drops once it is stale", () => {
  const store = memoryStorage();
  savePendingSignIn(transaction(), store);
  assert.equal(readPendingSignIn(store)?.ticket, TICKET);
  assert.equal(readPendingSignIn(store, Date.now() + 700_000), null);
  assert.equal(store.getItem(DESKTOP_SIGNIN_STORAGE_KEY), null, "expired entries are cleared on read");

  assert.equal(readPendingSignIn(memoryStorage({ [DESKTOP_SIGNIN_STORAGE_KEY]: "{not json" })), null);
  assert.equal(
    readPendingSignIn(memoryStorage({ [DESKTOP_SIGNIN_STORAGE_KEY]: JSON.stringify({ ticket: TICKET, verifier: "x", expiresAt: Date.now() + 1000 }) })),
    null,
    "a truncated verifier is not a transaction"
  );

  const store2 = memoryStorage();
  savePendingSignIn(transaction(), store2);
  clearPendingSignIn(store2);
  assert.equal(store2.getItem(DESKTOP_SIGNIN_STORAGE_KEY), null);
});

test("the approval page keeps the client and signup mode in its URL", () => {
  const env = { VITE_SITE_URL: "https://site.test" };
  const url = new URL(approvalUrl(transaction({ client: "android", mode: "signup" }), env));
  assert.equal(url.origin, "https://site.test");
  assert.equal(url.pathname, "/desktop-auth");
  assert.equal(url.searchParams.get("ticket"), TICKET);
  assert.equal(url.searchParams.get("client"), "android");
  assert.equal(url.searchParams.get("mode"), "signup");
  assert.equal(new URL(approvalUrl(transaction(), env)).searchParams.get("mode"), null);
});

test("poll responses map onto waiting, approved, rejected and expired", async () => {
  const cases = [
    { status: 202, data: { status: "pending" }, expect: "pending" },
    { status: 200, data: { status: "approved", user: { email: "a@b.c" }, token: "session-jwt" }, expect: "approved" },
    { status: 400, data: { message: "This sign-in request is not valid." }, expect: "invalid" },
    { status: 410, data: { message: "This sign-in request expired." }, expect: "expired" },
    { status: 410, data: { message: "This sign-in request was already used." }, expect: "consumed" }
  ];
  let index = 0;
  await withApiStub(async (url, body) => {
    assert.equal(url, "/auth/desktop/poll");
    assert.deepEqual(body, { ticket: TICKET, verifier: VERIFIER });
    const fixture = cases[index];
    return response(fixture.status, { ...fixture.data, status: fixture.expect });
  }, async () => {
    for (const fixture of cases) {
      const result = await pollDesktopSignIn(transaction());
      assert.equal(result.status, fixture.expect);
      if (fixture.expect === "approved") {
        assert.deepEqual(result.user, fixture.data.user);
        assert.ok(!("token" in result), "the session token is never handed to the UI layer");
      }
      index += 1;
    }
  });
});

test("waiting polls until the browser approves, then clears local state", async () => {
  const store = memoryStorage();
  savePendingSignIn(transaction(), store);
  return withGlobals({ localStorage: store }, () =>
    withApiStub(async (url, body, config, call) =>
      call < 3 ? response(202, { status: "pending" }) : response(200, { status: "approved", user: { email: "a@b.c" }, token: "x" }),
    async () => {
      const result = await waitForDesktopSignIn(readPendingSignIn(store), { intervalMs: 1 });
      assert.equal(result.status, "approved");
      assert.equal(store.getItem(DESKTOP_SIGNIN_STORAGE_KEY), null, "a used transaction is not kept");
    })
  );
});

test("an expired or reused ticket ends the wait with the server's reason", async () => {
  const store = memoryStorage();
  savePendingSignIn(transaction(), store);
  return withGlobals({ localStorage: store }, () =>
    withApiStub(async () => response(410, { message: "This sign-in request expired. Start again." }), async () => {
      await assert.rejects(
        () => waitForDesktopSignIn(readPendingSignIn(store), { intervalMs: 1 }),
        error => error instanceof DesktopSignInError && error.reason === "expired" && /expired/.test(error.message)
      );
      assert.equal(store.getItem(DESKTOP_SIGNIN_STORAGE_KEY), null);
    })
  );
});

test("a wrong verifier is reported as a failure, not as an endless wait", async () => {
  const store = memoryStorage();
  savePendingSignIn(transaction(), store);
  return withGlobals({ localStorage: store }, () =>
    withApiStub(async () => response(400, { message: "This sign-in request is not valid." }), async () => {
      await assert.rejects(
        () => waitForDesktopSignIn(readPendingSignIn(store), { intervalMs: 1 }),
        error => error instanceof DesktopSignInError && /not valid/.test(error.message)
      );
    })
  );
});

test("cancelling the wait stops polling and leaves the transaction resumable", async () => {
  const store = memoryStorage();
  savePendingSignIn(transaction(), store);
  const controller = new AbortController();
  let polls = 0;
  return withGlobals({ localStorage: store }, () =>
    withApiStub(async () => {
      polls += 1;
      if (polls === 1) controller.abort();
      return response(202, { status: "pending" });
    }, async () => {
      await assert.rejects(
        () => waitForDesktopSignIn(readPendingSignIn(store), { signal: controller.signal, intervalMs: 5 }),
        error => error.name === "AbortError"
      );
      assert.equal(polls, 1, "polling stops with the wait");
      assert.ok(readPendingSignIn(store), "a later mount can resume the same ticket");
    })
  );
});

test("reopen sends the browser back to the same pending ticket", async () => {
  const opened = [];
  return withGlobals({ window: { open: value => { opened.push(String(value)); return { close() {} }; } } }, async () => {
    const url = await reopenDesktopSignIn(transaction({ client: "android" }), { VITE_SITE_URL: "https://site.test" });
    assert.deepEqual(opened, [url]);
    assert.equal(new URL(url).searchParams.get("client"), "android");
    assert.equal(new URL(url).searchParams.get("ticket"), TICKET);
  });
});

test("an abort during an in-flight poll cancels the request, not only the timer", async () => {
  const store = memoryStorage();
  savePendingSignIn(transaction(), store);
  const controller = new AbortController();
  let polls = 0;
  let heldSignal = null;
  let releaseHold;
  const hold = new Promise(resolve => {
    releaseHold = resolve;
  });

  return withGlobals({ localStorage: store }, () =>
    withApiStub(
      async (url, body, config) => {
        polls += 1;
        if (polls === 1) {
          heldSignal = config.signal;
          await hold;
          // A backend still thinking when the app walked away answers the way
          // axios does: a cancellation, not a response.
          if (heldSignal?.aborted) {
            throw Object.assign(new Error("canceled"), { code: "ERR_CANCELED", name: "CanceledError" });
          }
        }
        return response(202, { status: "pending" });
      },
      async () => {
        const wait = settled(
          waitForDesktopSignIn(readPendingSignIn(store), { signal: controller.signal, intervalMs: 1 })
        );
        await until(() => polls === 1);
        assert.ok(heldSignal instanceof AbortSignal, "the poll is issued with a cancellable signal");
        controller.abort();
        releaseHold();
        const outcome = await wait;
        assert.equal(outcome.ok, false, "a cancelled wait does not resolve");
        assert.equal(outcome.error.name, "AbortError");
        assert.equal(heldSignal.aborted, true, "the request in flight is aborted, not abandoned");
        assert.equal(polls, 1, "an aborted loop issues no further polls");
        assert.ok(readPendingSignIn(store), "a cancelled wait leaves the ticket resumable");
      }
    )
  );
});

test("one ticket has one polling owner and a replacement stops the loop it supersedes", async () => {
  const store = memoryStorage();
  savePendingSignIn(transaction(), store);
  const tx = readPendingSignIn(store);
  let polls = 0;

  return withGlobals({ localStorage: store }, () =>
    withApiStub(async () => {
      polls += 1;
      return response(202, { status: "pending" });
    }, async () => {
      const first = settled(waitForDesktopSignIn(tx, { intervalMs: 1 }));
      await until(() => hasActivePoll(tx.ticket));
      assert.equal(hasActivePoll(tx.ticket), true, "the wait owns its ticket while it runs");

      const second = settled(waitForDesktopSignIn(tx, { intervalMs: 1 }));
      const beaten = await first;
      assert.equal(beaten.ok, false, "the superseded loop ends");
      assert.equal(beaten.error.name, "AbortError", "it is cancelled, not allowed to race on");
      assert.equal(hasActivePoll(tx.ticket), true, "the replacement owns the ticket");

      abortPendingPoll(tx.ticket);
      const stopped = await second;
      assert.equal(stopped.ok, false, "the owner releases when the wait is cancelled");
      assert.equal(stopped.error.name, "AbortError");
      assert.equal(hasActivePoll(tx.ticket), false, "no owner survives a cancelled wait");
      assert.ok(readPendingSignIn(store), "a ticket nobody finished is still resumable");
      assert.ok(polls >= 2, "both loops got as far as asking");
    })
  );
});

test("a backend that briefly returns 5xx is retried and can still complete the sign-in", async () => {
  const store = memoryStorage();
  savePendingSignIn(transaction(), store);
  let polls = 0;
  return withGlobals({ localStorage: store }, () =>
    withApiStub(async () => {
      polls += 1;
      if (polls <= 2) throw httpError(503, "Service Unavailable");
      return response(200, { status: "approved", user: { email: "a@b.c" }, token: "session-jwt" });
    }, async () => {
      const result = await waitForDesktopSignIn(readPendingSignIn(store), { intervalMs: 1 });
      assert.equal(result.status, "approved", "an outage mid-wait is not a failed sign-in");
      assert.equal(polls, 3);
      assert.equal(store.getItem(DESKTOP_SIGNIN_STORAGE_KEY), null);
    })
  );
});

test("a backend that stays unreachable stops retrying and reports a connection failure, not an expiry", async () => {
  const store = memoryStorage();
  savePendingSignIn(transaction(), store);
  let polls = 0;
  return withGlobals({ localStorage: store }, () =>
    withApiStub(
      async () => {
        polls += 1;
        throw offlineError();
      },
      async () => {
        const error = await rejection(() => waitForDesktopSignIn(readPendingSignIn(store), { intervalMs: 1 }));
        assert.ok(error instanceof DesktopSignInError);
        assert.equal(error.reason, "network", "a transport failure is not an authentication outcome");
        assert.match(error.message, /reach the VupsRouter sign-in service/);
        assert.doesNotMatch(error.message, /expired/, "the app must not blame the ticket for an outage");
        assert.equal(polls, 4, "retries are bounded: one attempt plus three retries");
        assert.ok(readPendingSignIn(store), "the ticket survives an outage and can be resumed");
      }
    )
  );
});

test("a rejected transaction is asked about once and never retried", async () => {
  const rejections = [
    { status: 400, data: { status: "invalid", message: "The sign-in request could not be verified. Start again from the app." } },
    { status: 410, data: { status: "expired", message: "This sign-in request expired. Start again from the app." } }
  ];
  for (const fixture of rejections) {
    const store = memoryStorage();
    savePendingSignIn(transaction(), store);
    let polls = 0;
    await withGlobals({ localStorage: store }, () =>
      withApiStub(
        async () => {
          polls += 1;
          return response(fixture.status, fixture.data);
        },
        async () => {
          const error = await rejection(() => waitForDesktopSignIn(readPendingSignIn(store), { intervalMs: 1 }));
          assert.ok(error instanceof DesktopSignInError);
          assert.equal(polls, 1, `a ${fixture.status} rejection ends the wait at once`);
          assert.equal(error.message, fixture.data.message, "the server's reason is what the user reads");
          assert.equal(store.getItem(DESKTOP_SIGNIN_STORAGE_KEY), null, "a rejected ticket is not kept to retry");
        }
      )
    );
  }
});

test("a duplicate poll that answers completed is a finished sign-in, not a failure", async () => {
  const store = memoryStorage();
  savePendingSignIn(transaction(), store);
  return withGlobals({ localStorage: store }, () =>
    withApiStub(async () => response(200, { status: "completed" }), async () => {
      const result = await waitForDesktopSignIn(readPendingSignIn(store), { intervalMs: 1 });
      assert.equal(result.status, "completed");
      assert.equal(store.getItem(DESKTOP_SIGNIN_STORAGE_KEY), null, "a redeemed ticket is never left to resume");
    })
  );
});

test("a transaction already past its local deadline is dropped without asking the server", async () => {
  const store = memoryStorage();
  savePendingSignIn(transaction(), store);
  let polls = 0;
  return withGlobals({ localStorage: store }, () =>
    withApiStub(
      async () => {
        polls += 1;
        return response(202, { status: "pending" });
      },
      async () => {
        const error = await rejection(() =>
          waitForDesktopSignIn(transaction({ expiresAt: Date.now() - 1000 }), { intervalMs: 1 })
        );
        assert.ok(error instanceof DesktopSignInError && error.reason === "expired");
        assert.equal(polls, 0, "a locally dead ticket never reaches the network");
        assert.equal(store.getItem(DESKTOP_SIGNIN_STORAGE_KEY), null, "the stale local copy goes with it");
      }
    )
  );
});

test("polling cannot leave an orphan owner behind after the wait ends", async () => {
  const store = memoryStorage();
  savePendingSignIn(transaction(), store);
  await withGlobals({ localStorage: store }, () =>
    withApiStub(async () => response(200, { status: "approved", user: { email: "a@b.c" } }), async () => {
      await waitForDesktopSignIn(readPendingSignIn(store), { intervalMs: 1 });
      assert.equal(hasActivePoll(TICKET), false, "a finished wait releases its ticket");
    })
  );
});

test("the desktop shell serves the window from an origin that survives a restart", () => {
  const server = read("src-tauri/src/desktop_server.rs");
  assert.match(server, /fn bind_listener\(\)/, "the listener picks its own port instead of asking the OS");
  assert.match(server, /page_origin = format!\("http:\/\/127\.0\.0\.1:\{port\}"\)/);
  assert.match(server, /Ok\(format!\("\{page_origin\}\/chat\?native=windows"\)\)/, "the window is opened on the origin the guard expects");
  const startBody = server.slice(server.indexOf("pub fn start"), server.indexOf("async fn handle_request"));
  assert.match(startBody, /let listener = bind_listener\(\)\?;/, "start() delegates the port choice to bind_listener()");
  assert.doesNotMatch(
    startBody,
    /TcpListener::bind/,
    "start() never asks the OS for a port directly, so the origin is stable unless the whole range is busy"
  );
  const bindBody = server.slice(server.indexOf("fn bind_listener()"), server.indexOf("pub(crate) fn guard_headers"));
  assert.ok(
    bindBody.indexOf("for port in preferred_ports()") < bindBody.indexOf('bind(("127.0.0.1", 0))'),
    "an OS-allocated port is the last resort, not the first try"
  );
  assert.match(server, /if let Some\(status\) = guard_headers\(/, "every request is checked before any route serves it");

  const capability = JSON.parse(read("src-tauri/capabilities/desktop-local.json"));
  assert.deepEqual(
    capability.remote.urls,
    ["http://127.0.0.1:*"],
    "the wildcard port is what keeps the loopback scope working when the range is busy"
  );
});

test("the app drives one polling loop and never restarts one by recursion", () => {
  const app = read("src/App.jsx");
  assert.match(app, /hasActivePoll\(pending\.ticket\)/, "a mount that is already polling does not start a second loop");
  assert.match(app, /if \(hasActivePoll\(stale\.ticket\)\) abortPendingPoll\(stale\.ticket\);/, "a fresh sign-in cancels the loop it replaces");
  assert.match(
    app,
    /handoffRef\.current\?\.abort\(\);\s*\n\s*const controller = new AbortController\(\);/,
    "the previous owner is dropped before a ticket is adopted"
  );
  assert.match(app, /if \(handoffRef\.current !== controller\) return;/, "a superseded loop cannot write an error over the winner");
  assert.equal(
    (app.match(/waitForDesktopSignIn\(/g) || []).length,
    1,
    "exactly one place polls, so no failure path can re-enter the wait and loop forever"
  );
  assert.equal(
    (app.match(/beginDesktopSignIn\(/g) || []).length,
    1,
    "exactly one place starts a transaction: one click, one attempt"
  );
  assert.match(app, /That sign-in was already completed in another window/, "a completed-elsewhere ticket reads as completed");
  assert.match(app, /That sign-in request is no longer available\. Start again\./, "reopen refuses a ticket that is gone");
});

test("the app resumes a pending sign-in and lands on the authenticated chat page", () => {
  const app = read("src/App.jsx");
  assert.match(app, /from "\.\/native\/desktopSignIn\.js"/);
  assert.match(app, /readPendingSignIn\(\)/);
  assert.match(app, /await waitForDesktopSignIn\(transaction, \{ signal: controller\.signal \}\)/);
  assert.match(app, /await refreshSession\(\)/);
  assert.match(app, /if \(status === "authenticated"\) return <Navigate to=\{redirectTo\} replace \/>;/);
  assert.match(app, /const browserAuth = usesBrowserAuthHandoff\(nativeShell\)/);
  assert.match(app, /\{!browserAuth \? <>/, "the credential form is the screen every shell without a browser handoff gets");
  assert.match(app, /if \(!browserAuth\) return undefined;/, "only a shell with a browser handoff resumes a pending ticket");
  assert.doesNotMatch(
    app,
    /NATIVE_SHELLS\.android \? "android"/,
    "the Android app must never start a browser handoff: its WebView is already on the site origin"
  );
  assert.match(app, /clearPendingSignIn\(\)/, "Cancel abandons the stored transaction");
  assert.doesNotMatch(app, /does not yet receive a browser session/, "the dead-end copy is gone");
  assert.match(app, /path="\/desktop-auth" element=\{<DesktopAuthPage \/>\}/);

  const context = read("src/context/AuthContext.jsx");
  assert.match(context, /return current;/, "refreshSession hands the caller the session user");

  const page = read("src/pages/DesktopAuthPage.jsx");
  assert.match(page, /\.post\("\/auth\/desktop\/approve", \{ ticket \}\)/);
  assert.match(page, /started\.current/, "a duplicate callback approves only once");
  assert.match(page, /state=\{\{ from: redirectTarget \}\}/, "signing in returns to the approval page");
});
