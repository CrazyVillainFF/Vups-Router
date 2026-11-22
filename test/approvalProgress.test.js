import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import axios from "axios";

import { apiClient } from "../src/services/api.js";
import {
  APPROVAL_ROWS,
  APPROVAL_STATES,
  approvalProgressRow,
  approvalRowKey,
  reportApprovalEvent,
  trackApprovalTransition
} from "../src/chat/approvalEvents.js";
import { normalizeDesktopToolPrompt } from "../src/native/desktopTools.js";

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const originalBaseURL = apiClient.defaults.baseURL;
const originalAdapter = apiClient.defaults.adapter;

function stubBackend(handler) {
  const requests = [];
  apiClient.defaults.baseURL = "https://api.example.test/api";
  apiClient.defaults.adapter = async config => {
    const request = {
      method: String(config.method || "get").toUpperCase(),
      url: config.url,
      data: config.data ? JSON.parse(config.data) : undefined
    };
    requests.push(request);
    const reply = handler(request);
    if (reply instanceof Error) throw reply;
    return { data: reply ?? {}, status: 200, statusText: "OK", headers: {}, config };
  };
  return requests;
}

test.afterEach(() => {
  apiClient.defaults.baseURL = originalBaseURL;
  apiClient.defaults.adapter = originalAdapter;
});

// The id the native layer really issues for a permission request: a uuid v4.
const REQUEST_ID = "9b1de4a2-4f77-4a1e-9d2b-0c5e6f7a8b91";
const RUN_ID = "654f00000000000000000001";

function prompt(overrides = {}) {
  return normalizeDesktopToolPrompt({
    requestId: REQUEST_ID,
    operationId: RUN_ID,
    tool: "write_file",
    access: "write",
    action: "write",
    scopePath: "C:\\work\\a.txt",
    expiresAt: Date.now() + 120000,
    ...overrides
  });
}

test("the app's permission sentences match the ones the backend stores", () => {
  const states = Object.keys(APPROVAL_ROWS);
  assert.deepEqual(APPROVAL_STATES, states);
  for (const state of ["requested", "waiting", "granted", "denied", "expired", "cancelled", "resumed", "stopped"]) {
    assert.ok(states.includes(state), `${state} is a transition the app can report`);
  }

  // The durable row is the backend's wording; the painted row has to be the same
  // words, or a line the reader watched move becomes a different line on reload.
  // CI checks the backend out beside the client for exactly this comparison.
  const server = read("../server/src/taskEvents.js");
  const table = server.slice(server.indexOf("const APPROVAL_ROWS = Object.freeze({"));
  for (const [state, row] of Object.entries(APPROVAL_ROWS)) {
    assert.ok(
      table.includes(`${state}: { status: "${row.status}", message: "${row.message}" }`),
      `${state} reads differently in the backend's table`
    );
  }
  assert.match(read("src/chat/activity.js"), /export const UNREPORTED_APPROVAL_LABEL = "The approval wait ended without a reported decision"/);
  assert.ok(table.includes('message: "The approval wait ended without a reported decision"'));
});

test("one request keeps one line, and what became of the operation keeps another", () => {
  for (const state of ["requested", "waiting", "granted", "denied", "expired", "cancelled"]) {
    assert.equal(approvalRowKey(REQUEST_ID, state), `approval:${REQUEST_ID}`);
  }
  for (const state of ["resumed", "stopped"]) {
    assert.equal(approvalRowKey(REQUEST_ID, state), `approvalex:${REQUEST_ID}`);
  }
  // A key is the row's identity, so an id this app cannot hold whole is refused
  // rather than cut down to size, where two cards could collapse onto one line.
  assert.equal(approvalRowKey("x".repeat(41), "granted"), "");
  assert.equal(approvalRowKey("short", "granted"), "");
  assert.equal(approvalRowKey("has spaces", "granted"), "");
  assert.equal(approvalRowKey(REQUEST_ID.toUpperCase(), "granted"), `approval:${REQUEST_ID.toUpperCase()}`);

  const row = approvalProgressRow({ requestId: REQUEST_ID, state: "waiting", path: "C:\\work\\a.txt" });
  assert.deepEqual(
    { key: row.key, phase: row.phase, status: row.status, code: row.code, message: row.message, path: row.path },
    {
      key: `approval:${REQUEST_ID}`,
      phase: "approval",
      status: "running",
      code: "approval:waiting",
      message: "Waiting for approval.",
      path: "C:\\work\\a.txt"
    }
  );
  assert.equal(approvalProgressRow({ requestId: REQUEST_ID, state: "approved_and_run" }), null);
  assert.equal(approvalProgressRow({ requestId: "", state: "granted" }), null);
  assert.equal(approvalProgressRow({ requestId: REQUEST_ID, state: "granted" }).path, "");
  assert.equal(approvalProgressRow({ requestId: REQUEST_ID, state: " granted " }), null, "the states are spelled as they are spelled");
  assert.ok(
    approvalProgressRow({ requestId: REQUEST_ID, state: "granted", path: "y".repeat(900) }).path.length <= 200,
    "a row's chip is bounded the way the stored row's is"
  );
});

test("a transition is stored against the run that raised it, with nothing the caller typed", async () => {
  const stored = { key: `approval:${REQUEST_ID}`, phase: "approval", status: "completed", seq: 6, message: "Approval granted." };
  const requests = stubBackend(() => ({ runId: RUN_ID, events: [stored] }));

  const events = await reportApprovalEvent({
    runId: RUN_ID,
    requestId: REQUEST_ID,
    state: "granted",
    tool: "write_file",
    path: "C:\\work\\a.txt"
  });

  assert.deepEqual(events, [stored], "the server's own row comes back for the merge");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "POST");
  assert.equal(requests[0].url, "/chat/desktop-tools/approvals");
  assert.deepEqual(requests[0].data, {
    runId: RUN_ID,
    requestId: REQUEST_ID,
    state: "granted",
    tool: "write_file",
    path: "C:\\work\\a.txt"
  });

  // A draft conversation has no id yet, and the backend rejects a row filed
  // against a conversation the run does not belong to, so it is left off.
  const withConversation = stubBackend(() => ({ events: [] }));
  await reportApprovalEvent({ runId: RUN_ID, requestId: REQUEST_ID, state: "waiting", conversationId: "654f00000000000000000009" });
  assert.equal(withConversation[0].data.conversationId, "654f00000000000000000009");

  const omitted = stubBackend(() => ({ events: [] }));
  await reportApprovalEvent({ runId: RUN_ID, requestId: REQUEST_ID, state: "cancelled" });
  assert.deepEqual(Object.keys(omitted[0].data).sort(), ["requestId", "runId", "state"]);
});

test("a report the backend will not take is dropped, not retried and not invented", async () => {
  for (const [label, send] of [
    ["no run", { runId: "", requestId: REQUEST_ID, state: "granted" }],
    ["an id the native layer never issues", { runId: RUN_ID, requestId: "1", state: "granted" }],
    ["a state off the list", { runId: RUN_ID, requestId: REQUEST_ID, state: "approved_and_run" }]
  ]) {
    const requests = stubBackend(() => ({ events: [] }));
    assert.deepEqual(await reportApprovalEvent(send), [], label);
    assert.equal(requests.length, 0, `${label} never reaches the network`);
  }

  const refusing = stubBackend(() => {
    throw new axios.AxiosError("HTTP 404", "ERR_BAD_RESPONSE", null, null, {
      status: 404,
      statusText: "Not Found",
      headers: {},
      config: { url: "/chat/desktop-tools/approvals" },
      data: { code: "run_not_found" }
    });
  });
  assert.deepEqual(
    await reportApprovalEvent({ runId: RUN_ID, requestId: REQUEST_ID, state: "granted" }),
    [],
    "a lost turn's permission line must not change how the answer itself responds"
  );
  assert.equal(refusing.length, 1);

  const shapeless = stubBackend(() => ({ runId: RUN_ID }));
  assert.deepEqual(await reportApprovalEvent({ runId: RUN_ID, requestId: REQUEST_ID, state: "granted" }), []);
  assert.equal(shapeless.length, 1);
});

test("the line moves the moment the app sees it and again when the backend confirms", async () => {
  const stored = { key: `approval:${REQUEST_ID}`, phase: "approval", status: "running", seq: 4, message: "Waiting for approval." };
  const requests = stubBackend(() => ({ events: [stored] }));
  const painted = [];
  const card = prompt();

  const events = await trackApprovalTransition(card, "waiting", {
    runId: card.operationId,
    paint: rows => painted.push(rows)
  });

  assert.equal(painted.length, 2, "painted now, then confirmed by the server");
  assert.deepEqual(
    painted[0].map(row => [row.key, row.code, row.status, row.message]),
    [[`approval:${REQUEST_ID}`, "approval:waiting", "running", "Waiting for approval."]]
  );
  assert.equal(painted[0][0].path, "C:\\work\\a.txt", "the row carries the request's own target");
  assert.deepEqual(painted[1], [stored], "the stored row is what the backend returned");
  assert.deepEqual(events, [stored]);
  assert.equal(requests[0].data.runId, RUN_ID, "the operation id is the run the turn is stored under");
  assert.equal(requests[0].data.tool, "write_file");
  assert.equal(requests[0].data.path, "C:\\work\\a.txt");

  // A row the backend refused still shows the user what they just did; only the
  // durable half is missing, and that is a record, not a decision.
  const paintedAlone = [];
  const offline = stubBackend(() => {
    throw new axios.AxiosError("Network down", "ERR_NETWORK", null, null, {
      status: 0,
      statusText: "",
      headers: {},
      config: { url: "/chat/desktop-tools/approvals" },
      data: {}
    });
  });
  const quiet = await trackApprovalTransition(card, "denied", { runId: RUN_ID, paint: rows => paintedAlone.push(rows) });
  assert.deepEqual(quiet, []);
  assert.equal(paintedAlone.length, 1);
  assert.deepEqual(
    paintedAlone[0].map(row => [row.code, row.status]),
    [["approval:denied", "cancelled"]]
  );
  assert.equal(offline.length, 1);

  const nothingPainted = [];
  assert.deepEqual(
    await trackApprovalTransition(card, "approved_and_run", { runId: RUN_ID, paint: rows => nothingPainted.push(rows) }),
    [],
    "a state the table does not know paints no line, because nothing was observed"
  );
  assert.equal(nothingPainted.length, 0);
});

test("both surfaces that answer a permission card report the same lifecycle", () => {
  const surfaces = {
    chat: read("src/ChatPage.jsx"),
    "side task": read("src/desktop/panel/SideTaskPane.jsx")
  };
  for (const [name, source] of Object.entries(surfaces)) {
    assert.match(source, /trackApprovalTransition/, `${name} has to report its own permission lines`);
    assert.match(source, /runId: prompt\?\.operationId/, `${name} files each row under the run that raised it`);
    assert.match(source, /noteApproval\(prompt, "waiting"\)/, `${name} records the wait when the native card arrives`);
    assert.match(source, /"denied" : "granted"/, `${name} records how the user voted`);
    assert.match(source, /"stopped" : "resumed"/, `${name} records what became of the paused operation`);
    assert.match(source, /noteApproval\((prompt|request), "cancelled"/, `${name} closes a card the native layer withdrew`);
    assert.match(source, /noteApproval\((prompt|request), "expired"\)/, `${name} can say a request went unanswered`);
  }

  // A grant is one fact and the resumed call another, reported in that order so
  // the log numbers them the way the reader watched them happen.
  for (const source of Object.values(surfaces)) {
    assert.ok(
      source.indexOf(`"denied" : "granted"`) < source.indexOf(`"stopped" : "resumed"`),
      "the vote is recorded before the outcome it produced"
    );
  }

  // The vote never travels as an instruction: the native layer is what decides,
  // and neither surface sends a state that could be read as one.
  for (const forbidden of ["approve_desktop", "grant", "execute", "bypass"]) {
    for (const source of Object.values(surfaces)) {
      assert.ok(
        !new RegExp(`reportApprovalEvent\\([^)]*${forbidden}`).test(source),
        `${forbidden} is not a permission transition this app can claim`
      );
    }
  }
});
