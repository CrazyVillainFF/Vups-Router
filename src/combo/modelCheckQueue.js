/**
 * The model-checking queue.
 *
 * Checking a library means asking a provider about every model in it, and a
 * provider is a shared, rate-limited thing: ten probes at once is a lot, a
 * thousand at once is an outage. So the checks run through one queue with a
 * hard ceiling on how many are in flight, and a slot is freed the moment a
 * check finishes, whether it succeeded or not.
 *
 * The queue is the only thing that talks to a provider about a model's
 * availability. The page's single-model Test control joins the same queue, so
 * one model checked by hand can never push the library over the ceiling.
 *
 * Nothing here knows what a model is. A job is a key, a label and whatever
 * the caller wants back, and the caller is told what happened to each one.
 */

/** How many availability checks may be in flight at once. */
export const MODEL_CHECK_CONCURRENCY = 10;

/** How many times a retryable failure is tried again before it is given up on. */
export const MODEL_CHECK_MAX_RETRIES = 3;

const DEFAULT_BACKOFF_MS = attempt => Math.min(8000, 400 * 2 ** attempt);

export function createModelCheckQueue({
  concurrency = MODEL_CHECK_CONCURRENCY,
  maxRetries = MODEL_CHECK_MAX_RETRIES,
  run,
  isRetryable = () => false,
  backoffMs = DEFAULT_BACKOFF_MS,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  onStart = () => {},
  onResult = () => {},
  onFailure = () => {},
  onProgress = () => {}
} = {}) {
  if (typeof run !== "function") throw new Error("A model check queue needs something to run.");

  const limit = Math.max(1, Number(concurrency) || 1);
  const pending = [];
  const queued = new Set();
  const active = new Map();
  let running = false;
  let cancelled = false;
  let controller = null;
  let completed = 0;
  let failed = 0;

  function snapshot() {
    return {
      active: active.size,
      pending: pending.length,
      completed,
      failed,
      total: completed + failed + active.size + pending.length
    };
  }

  function report() {
    onProgress(snapshot());
  }

  function drain() {
    while (!cancelled && active.size < limit && pending.length > 0) {
      const job = pending.shift();
      const jobController = typeof AbortController === "function" ? new AbortController() : null;
      job.controller = jobController;
      active.set(job.key, job);
      onStart(job);
      report();
      void start(job);
    }
  }

  async function start(job) {
    let attempt = 0;
    for (;;) {
      try {
        const result = await run(job, { signal: job.controller?.signal, attempt });
        if (cancelled) return;
        active.delete(job.key);
        completed += 1;
        onResult(job, result);
        report();
        drain();
        return;
      } catch (error) {
        if (cancelled || job.cancelled) {
          // A check that was stopped is not a failure. The model keeps whatever
          // status it had, and it may be checked again later.
          active.delete(job.key);
          report();
          drain();
          return;
        }
        if (attempt < maxRetries && isRetryable(error, attempt)) {
          attempt += 1;
          await sleep(backoffMs(attempt));
          if (cancelled) return;
          continue;
        }
        active.delete(job.key);
        failed += 1;
        onFailure(job, error);
        report();
        drain();
        return;
      }
    }
  }

  return {
    /**
     * Add models to the queue.
     *
     * A model already queued or being checked is not added twice, so a second
     * Test All over the same library does not ask the provider twice. A queue
     * that is already running takes the new models rather than starting a
     * second one.
     */
    enqueue(items) {
      const list = Array.isArray(items) ? items : [];
      let added = 0;
      for (const item of list) {
        const key = String(item?.key ?? "");
        if (!key || queued.has(key)) continue;
        queued.add(key);
        pending.push(item);
        added += 1;
      }
      if (added > 0) {
        cancelled = false;
        if (!running) {
          running = true;
          controller = typeof AbortController === "function" ? new AbortController() : null;
        }
        report();
        drain();
      }
      return added;
    },

    /** Stop the queue. Models that were never checked keep whatever they had. */
    cancel() {
      cancelled = true;
      pending.length = 0;
      for (const job of active.values()) {
        job.cancelled = true;
        job.controller?.abort();
      }
      active.clear();
      queued.clear();
      controller?.abort();
      report();
    },

    /**
     * Stop one model.
     *
     * A model that is waiting is simply dropped; one that is already running
     * is told to stop. Neither counts as a failure: a model nobody managed to
     * check keeps the status it had.
     */
    cancelKey(key) {
      const id = String(key ?? "");
      const index = pending.findIndex(job => String(job.key) === id);
      if (index >= 0) {
        pending.splice(index, 1);
        queued.delete(id);
        report();
        return true;
      }
      const job = active.get(id);
      if (!job) return false;
      job.cancelled = true;
      job.controller?.abort();
      active.delete(id);
      queued.delete(id);
      report();
      drain();
      return true;
    },

    /** Whether a model is waiting or being checked right now. */
    has(key) {
      const id = String(key ?? "");
      return queued.has(id) || active.has(id);
    },

    /** Forget every key, so the same model may be checked again later. */
    reset() {
      queued.clear();
    },

    isRunning() {
      return running;
    },

    snapshot
  };
}
