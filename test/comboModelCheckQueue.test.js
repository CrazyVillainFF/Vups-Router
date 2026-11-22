/**
 * The model-checking queue.
 *
 * The library can hold a thousand models, and every one of them is a question
 * for a provider that is shared with everyone else. These tests pin the
 * behaviour that keeps that fair: a hard ceiling on how many checks are in
 * flight, a slot freed the moment a check ends, a failure that never stops the
 * queue, and no model asked about twice.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  MODEL_CHECK_CONCURRENCY,
  createModelCheckQueue
} from "../src/combo/modelCheckQueue.js";

/** A queue whose checks are finished by the test, one at a time. */
function harness({ concurrency = MODEL_CHECK_CONCURRENCY, fail = () => false, isRetryable = () => false, maxRetries = 0 } = {}) {
  const state = {
    active: 0,
    peak: 0,
    started: [],
    finished: [],
    failed: [],
    results: [],
    attempts: new Map()
  };
  const queue = createModelCheckQueue({
    concurrency,
    maxRetries,
    isRetryable,
    run: async job => {
      state.attempts.set(job.key, (state.attempts.get(job.key) || 0) + 1);
      state.active += 1;
      state.peak = Math.max(state.peak, state.active);
      state.started.push(job.key);
      await new Promise(resolve => setTimeout(resolve, 0));
      state.active -= 1;
      if (fail(job)) throw new Error("provider refused");
      state.finished.push(job.key);
      state.results.push(job.key);
      return { key: job.key, status: "working" };
    },
    sleep: async () => {},
    onResult: (job, result) => state.results.push(`result:${result.key}`),
    onFailure: (job, error) => state.failed.push(`${job.key}:${error.message}`)
  });
  return { queue, state };
}

const flush = () => new Promise(resolve => setTimeout(resolve, 30));

/** Waits until the queue has nothing left to do. */
async function waitForIdle(queue) {
  for (let i = 0; i < 200 && queue.snapshot().active + queue.snapshot().pending > 0; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  await new Promise(resolve => setTimeout(resolve, 20));
}

test("no more than ten checks run at the same time", async () => {
  const { queue, state } = harness();
  queue.enqueue(Array.from({ length: 60 }, (_, index) => ({ key: `m${index}` })));
  await flush();
  assert.ok(state.peak <= 10, `never more than ten at once (peak ${state.peak})`);
  assert.equal(MODEL_CHECK_CONCURRENCY, 10);
});

test("a new check starts as soon as one finishes", async () => {
  const { queue, state } = harness({ concurrency: 3 });
  queue.enqueue(Array.from({ length: 9 }, (_, index) => ({ key: `m${index}` })));
  // A fixed sleep races the machine under load; wait for the queue itself.
  await waitForIdle(queue);
  assert.equal(state.finished.length, 9, "every model was checked");
  assert.equal(state.peak, 3, "the queue ran full");
});

test("every eligible model is eventually checked", async () => {
  const { queue, state } = harness();
  const keys = Array.from({ length: 250 }, (_, index) => `m${index}`);
  queue.enqueue(keys.map(key => ({ key })));
  await waitForIdle(queue);
  assert.equal(state.finished.length, 250);
  assert.equal(new Set(state.finished).size, 250);
});

test("a failed check does not stop the queue", async () => {
  const { queue, state } = harness({ fail: job => job.key === "m2" });
  queue.enqueue(Array.from({ length: 12 }, (_, index) => ({ key: `m${index}` })));
  await flush();
  assert.equal(state.finished.length, 11, "the other eleven still ran");
  assert.equal(state.failed.length, 1);
  assert.match(state.failed[0], /m2:provider refused/);
});

test("a retryable failure is tried again with a bounded backoff", async () => {
  const backoffs = [];
  const tries = new Map();
  const queue = createModelCheckQueue({
    concurrency: 2,
    maxRetries: 3,
    isRetryable: error => error?.status === 429,
    backoffMs: attempt => attempt,
    sleep: async ms => { backoffs.push(ms); },
    run: async job => {
      const count = (tries.get(job.key) || 0) + 1;
      tries.set(job.key, count);
      if (job.key === "busy" && count < 3) {
        const error = new Error("too many requests");
        error.status = 429;
        throw error;
      }
      return { key: job.key };
    }
  });
  queue.enqueue([{ key: "busy" }, { key: "calm" }]);
  await flush();
  assert.deepEqual(backoffs, [1, 2], "the backoff grew and stopped");
  assert.equal(tries.get("busy"), 3, "a 429 is retried, but only a bounded number of times");
  assert.equal(tries.get("calm"), 1, "the other model was asked once");
});

test("a permanent failure is not retried", async () => {
  let calls = 0;
  const queue = createModelCheckQueue({
    concurrency: 2,
    maxRetries: 5,
    isRetryable: () => false,
    sleep: async () => {},
    run: async () => {
      calls += 1;
      throw new Error("401 unauthorized");
    }
  });
  queue.enqueue([{ key: "denied" }]);
  await flush();
  assert.equal(calls, 1, "an invalid credential is asked about once");
});

test("the same model is never checked twice", async () => {
  const { queue, state } = harness();
  queue.enqueue([{ key: "same" }, { key: "same" }, { key: "other" }]);
  await flush();
  assert.equal(state.started.filter(key => key === "same").length, 1);
  assert.equal(state.finished.length, 2);
});

test("a second run joins the queue that is already running", async () => {
  const { queue, state } = harness({ concurrency: 2 });
  queue.enqueue([{ key: "a" }, { key: "b" }]);
  queue.enqueue([{ key: "c" }]);
  await flush();
  assert.equal(state.peak, 2, "the second batch did not start a second queue");
  assert.deepEqual(state.finished.sort(), ["a", "b", "c"]);
});

test("a model checked by hand joins the same queue", async () => {
  const { queue, state } = harness({ concurrency: 2 });
  queue.enqueue([{ key: "library-1" }, { key: "library-2" }]);
  queue.enqueue([{ key: "by-hand" }]);
  await flush();
  assert.equal(state.peak, 2, "a hand-picked model respects the ceiling");
  assert.ok(state.finished.includes("by-hand"));
});

test("cancelling stops the queued checks and leaves the rest alone", async () => {
  const { queue, state } = harness({ concurrency: 1 });
  queue.enqueue(Array.from({ length: 20 }, (_, index) => ({ key: `m${index}` })));
  queue.cancel();
  await flush();
  assert.ok(state.finished.length < 20, "the queue stopped early");
  assert.equal(state.failed.length, 0, "a cancelled check is not a failure");
});

test("progress reports what has been checked", async () => {
  const progress = [];
  const queue = createModelCheckQueue({
    concurrency: 2,
    sleep: async () => {},
    run: async job => ({ key: job.key }),
    onProgress: snapshot => progress.push({ ...snapshot })
  });
  queue.enqueue(Array.from({ length: 5 }, (_, index) => ({ key: `m${index}` })));
  await flush();
  const last = progress[progress.length - 1];
  assert.equal(last.completed, 5);
  assert.equal(last.failed, 0);
  assert.equal(last.active, 0);
  assert.equal(last.pending, 0);
});
