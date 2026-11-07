import test from "node:test";
import assert from "node:assert/strict";
import axios from "axios";
import { apiClient } from "../src/services/api.js";
import {
  answerTaskClarification,
  cancelTask,
  fetchTask,
  fetchTaskEvents,
  isAmbiguousSubmissionError,
  isOpenTaskState,
  isResumableTaskState,
  isTaskApiUnavailable,
  isTerminalTaskState,
  listTasks,
  MAX_CLARIFICATION_ANSWER_CHARS,
  resumeTask,
  submitTask,
  taskErrorCode,
  taskErrorKind
} from "../src/services/taskApi.js";

const originalBaseURL = apiClient.defaults.baseURL;
const originalAdapter = apiClient.defaults.adapter;

function httpError(status, body = {}) {
  return new axios.AxiosError(body.message || `HTTP ${status}`, "ERR_BAD_RESPONSE", null, null, {
    status,
    statusText: String(status),
    headers: {},
    config: { url: "/tasks" },
    data: body
  });
}

/** Records what the service layer actually put on the wire. */
function stubBackend(handler) {
  const requests = [];
  apiClient.defaults.baseURL = "https://api.example.test/api";
  apiClient.defaults.adapter = async config => {
    const request = {
      method: String(config.method || "get").toUpperCase(),
      url: config.url,
      params: config.params,
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

test("submitTask posts the durable task contract and returns the created record", async () => {
  const requests = stubBackend(() => ({ task: { taskId: "tsk_aaaaaaaaaaaaaaaaaaaaaaaa", state: "queued" } }));
  const task = await submitTask({
    prompt: "  summarise the release blockers\n  and list risks  ",
    conversationId: "654f00000000000000000001",
    model: "gpt-6",
    configId: "cfg_1",
    providerId: "openai",
    mode: "general",
    temperature: 0.4,
    workspacePath: "C:\\work"
  });

  assert.equal(task.taskId, "tsk_aaaaaaaaaaaaaaaaaaaaaaaa");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "POST");
  assert.equal(requests[0].url, "/tasks");
  // Outer whitespace only: the brief's line breaks are part of the instruction.
  assert.equal(requests[0].data.prompt, "summarise the release blockers\n  and list risks");
  assert.equal(requests[0].data.conversationId, "654f00000000000000000001");
  assert.equal(requests[0].data.model, "gpt-6");
  assert.equal(requests[0].data.temperature, 0.4);
  assert.equal(requests[0].data.workspacePath, "C:\\work");
});

test("submitTask refuses an empty brief without touching the network", async () => {
  const requests = stubBackend(() => ({ task: { taskId: "tsk_unwanted" } }));
  await assert.rejects(() => submitTask({ prompt: "   \n " }), error => error.code === "invalid_prompt");
  assert.equal(requests.length, 0);
});

test("submitTask never sends an abort signal, because the run is not the viewer's to end", async () => {
  const requests = stubBackend(() => ({ task: { taskId: "tsk_bbbbbbbbbbbbbbbbbbbbbbbb", state: "queued" } }));
  await submitTask({ prompt: "keep going" });
  assert.equal(requests[0].signal, undefined);
  assert.equal(requests[0].cancelToken, undefined);
});

test("listTasks sends the state filter as csv and reads every conversation's rows", async () => {
  const requests = stubBackend(() => ({
    tasks: [{ taskId: "tsk_1", state: "running" }, { taskId: "tsk_2", state: "completed" }]
  }));
  const tasks = await listTasks({ states: ["running", "completed"], limit: 25 });
  assert.deepEqual(requests[0].params, { state: "running,completed", limit: 25 });
  assert.equal(tasks.length, 2);
});

test("listTasks omits empty filters and tolerates a malformed body", async () => {
  const requests = stubBackend(() => ({ tasks: "not-an-array" }));
  assert.deepEqual(await listTasks({ limit: 5 }), []);
  assert.deepEqual(requests[0].params, { limit: 5 });

  stubBackend(() => ({}));
  assert.deepEqual(await listTasks({}), []);
});

test("fetchTask reads one record by id with the id escaped", async () => {
  const requests = stubBackend(() => ({ task: { taskId: "tsk_c", state: "running", events: [] } }));
  const task = await fetchTask("tsk_c");
  assert.equal(requests[0].url, "/tasks/tsk_c");
  assert.equal(task.state, "running");

  const encoded = stubBackend(() => ({ task: { taskId: "tsk/../x", state: "queued" } }));
  await fetchTask("tsk/../x");
  assert.equal(encoded[0].url, "/tasks/tsk%2F..%2Fx");
});

test("fetchTaskEvents passes the cursor and normalizes the replay page", async () => {
  const requests = stubBackend(request => {
    assert.equal(request.params.after, 7);
    return {
      taskId: "tsk_d",
      state: "running",
      stage: "running",
      conversationId: "654f00000000000000000009",
      done: false,
      lastSeq: 9,
      events: [{ seq: 8, message: "Reading the diff" }, { seq: 9, message: "Writing the patch" }]
    };
  });
  const page = await fetchTaskEvents("tsk_d", { after: 7 });
  assert.equal(requests[0].url, "/tasks/tsk_d/events");
  assert.equal(page.lastSeq, 9);
  assert.equal(page.events.length, 2);
  assert.equal(page.conversationId, "654f00000000000000000009");
  assert.equal(page.done, false);
});

test("fetchTaskEvents defaults to a full replay and never trusts a missing log", async () => {
  const requests = stubBackend(() => ({ taskId: "tsk_e", state: "queued", lastSeq: 4 }));
  const page = await fetchTaskEvents("tsk_e");
  assert.deepEqual(requests[0].params, { after: 0 });
  assert.deepEqual(page.events, []);
  assert.equal(page.lastSeq, 4);
});

test("cancel and resume target the task they name and return the backend record", async () => {
  const requests = stubBackend(request => ({
    task: { taskId: "tsk_f", state: request.url.endsWith("/cancel") ? "cancelled" : "running" }
  }));
  assert.equal((await cancelTask("tsk_f")).state, "cancelled");
  assert.equal((await resumeTask("tsk_f")).state, "running");
  assert.equal(requests[0].url, "/tasks/tsk_f/cancel");
  assert.equal(requests[1].url, "/tasks/tsk_f/resume");
});

test("cancellation refusals arrive as rejections the caller must show", async () => {
  stubBackend(() => httpError(409, { code: "task_terminal", message: "That task already finished." }));
  await assert.rejects(() => cancelTask("tsk_g"));
});

// ------------------------------------------------------------- clarification

test("answerTaskClarification posts the answer to the question it names", async () => {
  const requests = stubBackend(() => ({ task: { taskId: "tsk_a", state: "queued", pendingClarification: null } }));
  const task = await answerTaskClarification("tsk_a", "clr_9f2c", "  the second quarter\n  and include risks  ");
  assert.equal(task.state, "queued");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "POST");
  assert.equal(requests[0].url, "/tasks/tsk_a/clarifications/clr_9f2c/answer");
  // Outer whitespace only: a multi-paragraph answer keeps its line breaks.
  assert.deepEqual(requests[0].data, { answer: "the second quarter\n  and include risks" });
  // The run is the server's to end, so the answer call is not abortable either.
  assert.equal(requests[0].signal, undefined);
  assert.equal(requests[0].cancelToken, undefined);
});

test("both ids reach the wire escaped, so neither can address another route", async () => {
  const requests = stubBackend(() => ({ task: { taskId: "x", state: "queued" } }));
  await answerTaskClarification("tsk/../a", "clr/../b", "the second quarter");
  assert.equal(requests[0].url, "/tasks/tsk%2F..%2Fa/clarifications/clr%2F..%2Fb/answer");
});

test("an answer that cannot be accepted is refused before it leaves the device", async () => {
  const requests = stubBackend(() => ({ task: { taskId: "tsk_a", state: "queued" } }));

  await assert.rejects(() => answerTaskClarification("tsk_a", "", "yes"), error => error.code === "invalid_clarification_id");
  await assert.rejects(() => answerTaskClarification("tsk_a", undefined, "yes"), error => error.code === "invalid_clarification_id");
  await assert.rejects(() => answerTaskClarification("tsk_a", "clr_1", "   \n "), error => error.code === "answer_required");
  await assert.rejects(() => answerTaskClarification("tsk_a", "clr_1", 42), error => error.code === "answer_required");
  await assert.rejects(
    () => answerTaskClarification("tsk_a", "clr_1", "x".repeat(MAX_CLARIFICATION_ANSWER_CHARS + 1)),
    error => error.code === "answer_too_long"
  );
  assert.equal(requests.length, 0, "a locally impossible request must not reach the server");

  // Exactly at the cap still goes out.
  await answerTaskClarification("tsk_a", "clr_1", "x".repeat(MAX_CLARIFICATION_ANSWER_CHARS));
  assert.equal(requests.length, 1);
});

test("the answer cap mirrors the one the server's route enforces", () => {
  // server/src/task.js: MAX_CLARIFICATION_ANSWER_CHARS, answered with 413
  // `answer_too_long`. The two numbers are a contract; changing one without the
  // other lets the form accept text the backend then refuses.
  assert.equal(MAX_CLARIFICATION_ANSWER_CHARS, 4000);
});

test("a route refusal is a rejection carrying the backend's code", async () => {
  stubBackend(() => httpError(409, { code: "clarification_answered", message: "That question is already answered." }));
  await assert.rejects(
    () => answerTaskClarification("tsk_a", "clr_1", "yes"),
    error => taskErrorCode(error) === "clarification_answered"
  );

  stubBackend(() => httpError(404, { code: "task_not_found", message: "No such task." }));
  await assert.rejects(() => answerTaskClarification("tsk_a", "clr_1", "yes"), error => taskErrorCode(error) === "task_not_found");
});

test("Resume's own refusal code survives the transport", () => {
  // POST /resume answers 409 clarification_required while a question is pending,
  // which is a different fact from state_conflict and must not collapse into it.
  const asked = httpError(409, { code: "clarification_required", clarificationId: "clr_1" });
  assert.equal(taskErrorCode(asked), "clarification_required");
  assert.equal(taskErrorKind(asked), "rejected");
  assert.equal(isTaskApiUnavailable(asked), false);
});

test("the event page carries the pending question through, and keeps absent apart from null", async () => {
  stubBackend(() => ({
    taskId: "tsk_a",
    state: "waiting_for_user",
    stage: "awaiting_clarification",
    done: false,
    lastSeq: 4,
    events: [{ seq: 4, message: "Which quarter?" }],
    pendingClarification: {
      clarificationId: "clr_1",
      question: "Which quarter should the report cover?",
      options: ["Q1", "Q2"],
      askedAt: "2026-11-07T10:02:00.000Z",
      blockedSteps: ["Draft the summary"]
    }
  }));
  const page = await fetchTaskEvents("tsk_a", { after: 3 });
  assert.equal(page.pendingClarification.clarificationId, "clr_1");
  assert.deepEqual([...page.pendingClarification.options], ["Q1", "Q2"]);

  // A server that says the question is gone must be able to say so.
  stubBackend(() => ({ taskId: "tsk_a", state: "queued", done: false, lastSeq: 5, events: [], pendingClarification: null }));
  const cleared = await fetchTaskEvents("tsk_a", { after: 4 });
  assert.equal(cleared.pendingClarification, null);
  assert.equal("pendingClarification" in cleared, true);

  // A deployment without this feature sends no key at all, which is not "cleared".
  stubBackend(() => ({ taskId: "tsk_a", state: "running", done: false, lastSeq: 6, events: [] }));
  const legacy = await fetchTaskEvents("tsk_a", { after: 5 });
  assert.equal("pendingClarification" in legacy, false);
});

test("error kinds stay distinct so the UI never diagnoses the wrong problem", () => {
  assert.equal(taskErrorKind(httpError(401, { code: "unauthorized" })), "unauthorized");
  assert.equal(taskErrorKind(httpError(403, { code: "forbidden" })), "forbidden");
  assert.equal(taskErrorKind(httpError(404, { code: "task_not_found" })), "not_found");
  assert.equal(taskErrorKind(httpError(404, {})), "unsupported");
  assert.equal(taskErrorKind(httpError(405, {})), "unsupported");
  assert.equal(taskErrorKind(httpError(429, { code: "rate_limit" })), "rate_limited");
  assert.equal(taskErrorKind(httpError(500, {})), "server");
  assert.equal(taskErrorKind(httpError(400, { code: "invalid_prompt" })), "rejected");
  assert.equal(taskErrorKind(new Error("socket hang up")), "network");
  assert.equal(taskErrorKind(null), "unknown");
});

test("an expired session is never reported as an unavailable task API", () => {
  assert.equal(isTaskApiUnavailable(httpError(401, { code: "unauthorized" })), false);
  assert.equal(isTaskApiUnavailable(httpError(503, {})), false);
  assert.equal(isTaskApiUnavailable(httpError(404, { code: "task_not_found" })), false);
  assert.equal(isTaskApiUnavailable(httpError(404, {})), true);
  assert.equal(isTaskApiUnavailable(httpError(405, {})), true);
});

test("only outcomes that may have created a task are treated as ambiguous", () => {
  assert.equal(isAmbiguousSubmissionError(httpError(400, { code: "invalid_prompt" })), false);
  assert.equal(isAmbiguousSubmissionError(httpError(401, {})), false);
  assert.equal(isAmbiguousSubmissionError(httpError(400, { code: "invalid_conversation_id" })), false);
  assert.equal(isAmbiguousSubmissionError(new Error("socket hang up")), true);
  assert.equal(isAmbiguousSubmissionError(httpError(500, {})), true);
  assert.equal(isAmbiguousSubmissionError(httpError(429, {})), true);
});

test("taskErrorCode prefers the backend's code over the transport label", () => {
  assert.equal(taskErrorCode(httpError(404, { code: "task_not_found" })), "task_not_found");
  assert.equal(taskErrorCode({ response: { status: 409, data: { code: "task_terminal" } } }), "task_terminal");
  assert.equal(taskErrorCode(new Error("plain")), "");
});

test("state helpers agree with the server's lifecycle table", () => {
  assert.equal(isTerminalTaskState("completed"), true);
  assert.equal(isTerminalTaskState("failed"), true);
  assert.equal(isTerminalTaskState("cancelled"), true);
  assert.equal(isTerminalTaskState("recovering"), false);
  assert.equal(isOpenTaskState("queued"), true);
  assert.equal(isOpenTaskState("waiting_for_permission"), true);
  assert.equal(isOpenTaskState("cancelled"), false);
  assert.equal(isOpenTaskState("not_a_state"), false);
  assert.equal(isResumableTaskState("paused"), true);
  assert.equal(isResumableTaskState("waiting_for_user"), true);
  assert.equal(isResumableTaskState("completed"), false);
});
