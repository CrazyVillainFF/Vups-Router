import * as defaultApi from "../services/taskApi.js";
import {
  isAmbiguousSubmissionError,
  isOpenTaskState,
  isTerminalTaskState,
  taskErrorKind
} from "../services/taskApi.js";

/**
 * The client-side task tracker.
 *
 * It lives at module scope on purpose. A durable task belongs to the backend
 * worker and the browser is only ever a viewer of it, so the viewer's state —
 * which tasks exist, how far each has got, where its event cursor is — has to
 * outlive any component that looks at it. Mounting, unmounting, switching a
 * conversation or navigating to another page changes what is displayed and
 * nothing else. There is no AbortController in this file for exactly that
 * reason: aborting work because a view moved on is the defect this phase
 * removes. What a view ending *does* end is its own read, which is a different
 * thing from ending the run.
 *
 * Three properties hold the design up:
 *
 * — Ownership. Everything here belongs to one authenticated account. The
 *   registry is cleared the moment that identity changes, so a second user on
 *   the same machine never inherits the first one's rows, cursors or watchers.
 *
 * — Per-task isolation. Every entry owns its own id, event log and cursor, and
 *   a page of events is applied only to the entry it names, so two tasks
 *   running at once cannot overwrite or consume each other's rows.
 *
 * — The server decides. Reads reconcile; they do not speculate. A cursor only
 *   ever moves forward, a duplicate row changes nothing, and a finished record
 *   stays finished unless an action the backend accepts says otherwise.
 */

const DEFAULT_POLL_MS = 2500;
// The list is where a task started in another view shows up. Reading it every
// few ticks is one cheap request and keeps the Task Center honest without a
// socket to maintain.
const LIST_REFRESH_EVERY = 8;
// Matches the window the server itself keeps, so the client never holds more
// than the backend could replay anyway.
const MAX_EVENTS_KEPT = 80;
// How long a remembered submission keeps protecting against a duplicate. A
// remount, a double click or a re-render inside this window re-uses the task
// the server already accepted instead of asking for another one.
const SUBMISSION_MEMO_MS = 15 * 60 * 1000;
// Two clocks are compared when deciding whether the server already took a
// submission; see findAdoptableTask.
const CLOCK_SKEW_ALLOWANCE_MS = 2000;

let api = defaultApi;

/** The account this registry belongs to, or null while nobody is signed in. */
let owner = "";
/** @type {Map<string, object>} taskId -> entry */
const entries = new Map();
const listeners = new Set();

/** key -> in-flight POST promise, so the same intent cannot be sent twice. */
const inFlightSubmissions = new Map();
/** key -> {taskId} | {uncertain, prompt} — what the last attempt on a key did. */
const submissionMemo = new Map();

let timer = null;
let intervalMs = DEFAULT_POLL_MS;
let tickCount = 0;
let ticking = null;
let version = 0;
let snapshotCache = null;
let status = "idle";
let errorKind = "";
let syncError = "";
let lastSyncAt = 0;
let hydration = { state: "idle", error: "", errorKind: "", at: 0 };

function touch() {
  version += 1;
  snapshotCache = null;
}

function emit(taskId = null) {
  for (const listener of [...listeners]) {
    try {
      listener(taskId);
    } catch {
      // A broken subscriber must not stop the loop that keeps every task fresh.
    }
  }
}

/** Turn a transport error into the status the UI is allowed to show. */
function recordSyncFailure(error, fallback) {
  const kind = taskErrorKind(error);
  errorKind = kind;
  syncError = error?.message || fallback;
  // An expired session says "sign in", an unregistered route says "this server
  // has no task API", and only the rest say "could not read". Collapsing them
  // sends the user to fix the wrong thing.
  if (kind === "unauthorized") return "unauthorized";
  if (kind === "unsupported") return "unsupported";
  if (kind === "network" || kind === "server" || kind === "rate_limited") return "offline";
  return "error";
}

/**
 * The highest sequence actually held. A summary carries only `lastEvent`, so it
 * deliberately yields 0: a cursor must never pass a row this client has not
 * seen, or the replay would skip it.
 */
function cursorOf(task) {
  const events = Array.isArray(task?.events) ? task.events : [];
  if (events.length === 0) return 0;
  return Number(events[events.length - 1]?.seq) || 0;
}

function storedEvents(task) {
  return Array.isArray(task?.events) ? task.events.slice(-MAX_EVENTS_KEPT) : [];
}

function newEntry(task, { watchers = 0 } = {}) {
  const record = { ...task, events: storedEvents(task) };
  return {
    taskId: record.taskId,
    task: record,
    state: record.state,
    stage: record.stage || "",
    conversationId: record.conversationId || null,
    lastSeq: cursorOf(record),
    offline: false,
    // A row learned from the list has not had its log read yet; that read is
    // what turns `lastEvent` into the whole retained window.
    needsLog: !Array.isArray(task?.events) || task.events.length === 0,
    // A task that finished between two reads still has rows the client has not
    // seen; one more authoritative read closes the gap, then this goes false.
    needsFinalRead: false,
    watchers,
    // Only an explicit, supported recovery action may move a finished record
    // back into an open state, and it is cleared as soon as that action lands.
    allowRevival: false
  };
}

function entryView(entry) {
  return {
    taskId: entry.taskId,
    state: entry.state,
    stage: entry.stage,
    conversationId: entry.conversationId,
    lastSeq: entry.lastSeq,
    offline: entry.offline,
    watchers: entry.watchers,
    task: entry.task
  };
}

/** A stable value between changes, which is what useSyncExternalStore needs. */
export function getTaskTrackerSnapshot() {
  if (snapshotCache) return snapshotCache;
  const tasks = [...entries.values()].map(entryView);
  tasks.sort((left, right) => {
    const a = Number(new Date(left.task?.lastActivityAt ?? left.task?.createdAt ?? 0)) || 0;
    const b = Number(new Date(right.task?.lastActivityAt ?? right.task?.createdAt ?? 0)) || 0;
    return b - a;
  });
  snapshotCache = Object.freeze({
    version,
    owner,
    status,
    error: syncError,
    errorKind,
    hydration: Object.freeze({ ...hydration }),
    lastSyncAt,
    running: timer !== null,
    tasks: Object.freeze(tasks)
  });
  return snapshotCache;
}

export function getTrackedTask(taskId) {
  const entry = entries.get(String(taskId || ""));
  return entry ? entryView(entry) : null;
}

export function subscribeToTaskTracker(listener) {
  if (typeof listener !== "function") return () => {};
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function mergeEvents(entry, incoming) {
  const known = new Set((entry.task.events || []).map(event => Number(event?.seq)));
  const fresh = incoming.filter(event => !known.has(Number(event?.seq)));
  if (fresh.length === 0) return false;
  entry.task.events = [...(entry.task.events || []), ...fresh].slice(-MAX_EVENTS_KEPT);
  // Forward only. A late or replayed batch that starts lower cannot pull the
  // cursor back, which would make the next read ask for rows already applied.
  entry.lastSeq = Math.max(entry.lastSeq, ...fresh.map(event => Number(event?.seq) || 0));
  entry.needsLog = false;
  return true;
}

/**
 * The state on the record only moves forward unless this entry is inside an
 * action that is allowed to restart it. A task that a stray read reports as
 * running again after finishing is a contradiction somewhere else, and
 * believing it silently is how a finished turn starts showing live work.
 */
function applyState(entry, nextState, { stage } = {}) {
  let changed = false;
  if (nextState && nextState !== entry.state) {
    if (isTerminalTaskState(entry.state) && !isTerminalTaskState(nextState) && !entry.allowRevival) {
      // The entry does not move, so the record must not either: a task object
      // claiming "queued" beside an entry that says "cancelled" would draw the
      // controls for a state this client has just refused to believe.
      entry.task = { ...entry.task, state: entry.state, stage: entry.stage };
      return false;
    }
    entry.state = nextState;
    changed = true;
  }
  if (stage !== undefined && stage !== entry.stage) {
    entry.stage = stage;
    changed = true;
  }
  if (changed) entry.task = { ...entry.task, state: entry.state, stage: entry.stage };
  return changed;
}

/** Insert or update from any server record. Returns the entry, newly created or not. */
function upsertEntry(task) {
  const taskId = String(task?.taskId || "");
  if (!taskId) return { entry: null, created: false };
  const existing = entries.get(taskId);
  if (!existing) {
    const entry = newEntry(task);
    entries.set(taskId, entry);
    return { entry, created: true };
  }
  const merged = { ...existing.task, ...task };
  // The detail carries the log; a summary must not throw it away.
  merged.events = storedEvents(task).length > 0 ? storedEvents(task) : (existing.task.events || []);
  // A list row is the weaker read of the question, so it cannot shorten one this
  // client already holds in full. An absent key says nothing at all.
  if ("pendingClarification" in task) {
    merged.pendingClarification = reconcileClarification(
      existing.task.pendingClarification ?? null,
      task.pendingClarification
    );
  }
  existing.task = merged;
  if (Array.isArray(task.events) && task.events.length > 0) existing.needsLog = false;
  existing.conversationId = task.conversationId ?? existing.conversationId;
  const stateChanged = applyState(existing, task.state, { stage: task.stage });
  if (Array.isArray(task.events) && task.events.length > 0) {
    const seq = cursorOf(merged);
    if (seq > existing.lastSeq) mergeEvents(existing, task.events);
  } else if (isTerminalTaskState(existing.state)) {
    // A list row can announce a finish that happened between two reads. Its
    // state is believed, but it carries no log, so the rows leading up to the
    // finish still need one read before this entry can be left alone.
    existing.needsFinalRead = true;
  }
  return { entry: existing, created: false, changed: stateChanged };
}

/**
 * One page of replayed events. The cursor is the dedupe: a row at or below it
 * has already been applied, so the same delivery twice changes nothing rather
 * than adding a step that already happened.
 */
function applyEventPage(entry, page) {
  if (!entry || !page) return false;
  if (page.taskId && String(page.taskId) !== entry.taskId) return false;
  const incoming = (Array.isArray(page.events) ? page.events : []).filter(
    event => Number(event?.seq) > entry.lastSeq
  );
  let changed = false;
  if (incoming.length > 0) changed = mergeEvents(entry, incoming) || changed;
  const serverLastSeq = Number(page.lastSeq) || 0;
  // Nothing new above the cursor but the server is further along: the rows in
  // between left its own window. Only the record can settle what happened.
  if (incoming.length === 0 && serverLastSeq > entry.lastSeq) return "resync";
  if (applyState(entry, page.state, { stage: page.stage })) changed = true;
  if (applyClarification(entry, page.pendingClarification)) changed = true;
  entry.offline = false;
  return changed;
}

/**
 * Which of two readings of the question survives.
 *
 * The same question arrives at two lengths: a list row carries the first 160
 * characters and the detail or event read carries all 2,000, because the server
 * truncates the list on purpose. A question row is never edited once written, so
 * a second question always has a different id — which means a shorter payload for
 * an id this client already holds is a weaker read, not a changed question. Taking
 * it literally would cut the text in the middle of the sentence the reader is
 * answering, every time the list refreshed.
 */
function reconcileClarification(held, incoming) {
  const next = incoming ?? null;
  if (next === null) return null;
  if (held && held.clarificationId === next.clarificationId && held.question.length > next.question.length) {
    return held;
  }
  return next;
}

/**
 * The question a parked task is waiting on, carried by the replay itself.
 *
 * A progress row is capped far below a question's length, which is why the
 * server sends the whole text as its own field instead of inside a row — and
 * why an event window that trimmed the park announcement cannot lose the
 * question. An absent field is a backend that does not know clarifications and
 * must leave what this client holds untouched; `null` is the server saying the
 * question has been answered.
 */
function applyClarification(entry, incoming) {
  if (incoming === undefined) return false;
  const held = entry.task?.pendingClarification ?? null;
  const next = reconcileClarification(held, incoming);
  if (next === held) return false;
  entry.task = { ...entry.task, pendingClarification: next };
  return true;
}

async function resyncTask(entry) {
  const detail = await api.fetchTask(entry.taskId);
  const before = `${entry.state}|${entry.lastSeq}`;
  const record = { ...detail, events: storedEvents(detail) };
  const heldCursor = entry.lastSeq;
  entry.task = record;
  // The single-record read is the backend speaking plainly about this one task,
  // so it is the one thing allowed to state the terminal answer — and the
  // running answer — over what this client holds. The guard in applyState
  // protects against the weaker evidence (a capped list row, a replayed event
  // page) resurrecting a finished task on its own.
  entry.state = record.state;
  entry.stage = record.stage || "";
  entry.conversationId = record.conversationId || null;
  // The retained window can start above or below what this client holds; the
  // cursor never goes backwards either way.
  entry.lastSeq = Math.max(heldCursor, cursorOf(record));
  entry.needsLog = false;
  entry.needsFinalRead = false;
  entry.offline = false;
  return `${entry.state}|${entry.lastSeq}` !== before;
}

async function pollEntry(entry) {
  try {
    const page = await api.fetchTaskEvents(entry.taskId, { after: entry.needsLog ? 0 : entry.lastSeq });
    if (page?.taskId && String(page.taskId) !== entry.taskId) return false;
    const result = applyEventPage(entry, page);
    if (result === "resync") return await resyncTask(entry);
    // The gap that made this read necessary is closed only once the rows are
    // in hand; a failed resync throws into the catch below and leaves the flag
    // set, so the next pass asks again rather than dropping the missed rows.
    entry.needsFinalRead = false;
    return result === true;
  } catch (error) {
    const kind = taskErrorKind(error);
    if (kind === "not_found") {
      // The record is gone — collected after retention, or never this account's.
      entries.delete(entry.taskId);
      return true;
    }
    if (kind === "unauthorized") {
      // Session, not task. Nothing here is disproved and the cursor must not
      // move, or re-signing in would silently skip what was missed.
      status = "unauthorized";
      errorKind = kind;
      syncError = error?.message || "Your session expired.";
      return false;
    }
    // A temporary failure costs patience, not memory: the entry and its cursor
    // stay, so the next read is a replay of exactly what was missed.
    entry.offline = true;
    return false;
  }
}

/** One pass, awaited, so two ticks can never overlap and read a task twice. */
export async function pollTaskTrackerOnce() {
  if (ticking) return ticking;
  const run = (async () => {
    let changed = false;
    let labelled = false;
    if (tickCount % LIST_REFRESH_EVERY === 0) {
      try {
        changed = (await hydrateTaskTracker()) > 0 || changed;
      } catch {
        changed = true;
      }
    }
    for (const entry of [...entries.values()]) {
      if (!entries.has(entry.taskId)) continue;
      if (entry.needsLog || entry.needsFinalRead || isOpenTaskState(entry.state)) {
        const wasOffline = entry.offline;
        changed = (await pollEntry(entry)) || changed;
        // "last read failed" and its clearing are the row's own news. A pass
        // that changes nothing else still has to invalidate the cached snapshot,
        // or React compares the same object and the view keeps showing progress
        // that was read before the network went away.
        if (entry.offline !== wasOffline) labelled = true;
      }
    }
    tickCount += 1;
    if (changed) {
      lastSyncAt = Date.now();
      touch();
      emit();
    } else if (labelled) {
      touch();
      emit();
    }
    return changed;
  })();
  ticking = run;
  try {
    return await run;
  } finally {
    if (ticking === run) ticking = null;
  }
}

/**
 * Every task this account has, across all of its conversations.
 *
 * This is also what makes a reload survive: the registry is module scope, but
 * module scope does not outlive the document, so on start the tracker asks the
 * backend what exists and replays each open task's log from a cursor of zero.
 * Startup therefore needs no saved client state to be correct — the server has
 * it — and a client that guessed would be worse.
 *
 * A task the list no longer mentions is left alone: the list is capped, so
 * absence here is not evidence that the record went away. Only the task's own
 * read answering not-found removes it.
 */
export async function hydrateTaskTracker() {
  hydration = { state: "pending", error: hydration.error, errorKind, at: Date.now() };
  touch();
  try {
    const tasks = await api.listTasks({ limit: 50 });
    let changed = false;
    for (const task of tasks) {
      const { entry, created } = upsertEntry(task);
      if (!entry) continue;
      changed = true;
      // A reload has to recover the progress a still-open task made while this
      // page was gone, so a freshly learned row reads its log straight away.
      if (created && (entry.needsLog || isOpenTaskState(entry.state))) {
        await pollEntry(entry);
      }
    }
    status = "online";
    errorKind = "";
    syncError = "";
    lastSyncAt = Date.now();
    hydration = { state: "ready", error: "", errorKind: "", at: Date.now() };
    touch();
    emit();
    return tasks.length;
  } catch (error) {
    status = recordSyncFailure(error, "The task list could not be read.");
    hydration = {
      state: "failed",
      error: error?.message || "The task list could not be read.",
      errorKind: taskErrorKind(error),
      at: Date.now()
    };
    touch();
    emit();
    throw error;
  }
}

/**
 * A viewer's interest, refcounted. Releasing it stops nothing that is running:
 * the task keeps its row and keeps being read, because closing a panel or
 * leaving a chat is not a cancellation.
 */
export function watchTrackedTask(taskId) {
  const id = String(taskId || "");
  if (!id) return () => {};
  const existing = entries.get(id);
  if (existing) {
    existing.watchers += 1;
    emit(id);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = entries.get(id);
      if (!current) return;
      current.watchers = Math.max(0, current.watchers - 1);
      emit(id);
    };
  }
  const entry = newEntry({ taskId: id, state: "queued", stage: "queued", conversationId: null, events: [] }, {
    watchers: 1
  });
  entries.set(id, entry);
  touch();
  emit(id);
  api.fetchTask(id)
    .then(detail => {
      if (entries.get(id) !== entry) return;
      entry.task = { ...detail, events: storedEvents(detail) };
      entry.state = detail.state;
      entry.stage = detail.stage || "";
      entry.conversationId = detail.conversationId || null;
      entry.lastSeq = Math.max(entry.lastSeq, cursorOf(entry.task));
      entry.needsLog = false;
      touch();
      emit(id);
    })
    .catch(error => {
      const kind = taskErrorKind(error);
      if (kind === "not_found") {
        entries.delete(id);
        touch();
        emit(id);
        return;
      }
      entry.offline = true;
      if (kind === "unauthorized") status = "unauthorized";
      syncError = error?.message || "The task could not be read.";
      touch();
      emit(id);
    });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = entries.get(id);
    if (!current) return;
    current.watchers = Math.max(0, current.watchers - 1);
    emit(id);
  };
}

function memoValue(key) {
  const hit = submissionMemo.get(key);
  if (!hit) return null;
  if (Date.now() - Number(hit.at || 0) > SUBMISSION_MEMO_MS) {
    submissionMemo.delete(key);
    return null;
  }
  return hit;
}

/**
 * A task that is already on the server for this intent.
 *
 * The list is the cheapest authority available, and matching is deliberately
 * narrow: same prompt text, created at or after the uncertain attempt, and not
 * a record this client already knows. Anything looser would adopt a task the
 * user never asked for.
 *
 * The creation time comes from the backend's clock and `sinceMs` from this
 * machine's, so a small skew allowance is required — without it a genuinely
 * accepted task could be re-sent because the two clocks disagree. Two seconds
 * is enough to absorb skew and still far shorter than any real queue delay, and
 * the same-prompt-plus-unknown-id condition carries the actual weight.
 */
function findAdoptableTask(tasks, { prompt, sinceMs }) {
  return (
    tasks.find(
      task =>
        task?.taskId &&
        !entries.has(String(task.taskId)) &&
        String(task.description || "").trim() === prompt &&
        Number(new Date(task.createdAt || 0)) >= sinceMs - CLOCK_SKEW_ALLOWANCE_MS
    ) || null
  );
}

/**
 * Submitting registers the row so the Task Center and the badge see it at once.
 * No request is tied to a component, and no watcher count is claimed here: the
 * screen that shows the task watches it and releases that when it goes away.
 *
 * `key` is the caller's identity for one user intent — one press of the send
 * button. Two calls with the same key are one task, never two, which is what
 * makes a remount, a re-render or a double click harmless. The server has no
 * idempotency field on this route, so the guarantee lives here.
 *
 * When a POST fails in a way that does not prove the server refused — dropped
 * connection, 5xx, 429 — the outcome is uncertain, and re-sending would risk a
 * second task. So an uncertain key never re-sends blindly: the retry reads the
 * list first and adopts the task if the first attempt did land.
 */
export function submitTrackedTask(input = {}, { key } = {}) {
  const submissionKey = String(key || "").trim();
  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";

  if (submissionKey) {
    const inFlight = inFlightSubmissions.get(submissionKey);
    if (inFlight) return inFlight;
    const remembered = memoValue(submissionKey);
    if (remembered?.taskId) {
      const known = entries.get(remembered.taskId);
      if (known) return Promise.resolve(entryView(known).task);
    }
  }

  const attempt = (async () => {
    if (submissionKey) {
      const remembered = memoValue(submissionKey);
      if (remembered?.uncertain) {
        let tasks;
        try {
          tasks = await api.listTasks({ limit: 50 });
        } catch (error) {
          // Cannot check, so cannot risk a duplicate either. Saying so is the
          // only honest option left, and it keeps the key uncertain.
          throw Object.assign(
            error instanceof Error ? error : new Error(String(error)),
            {
              code: "submission_unverified",
              taskSubmissionUncertain: true,
              message:
                error?.message ||
                "The earlier task request could not be confirmed, and the task list is unreachable."
            }
          );
        }
        const adopted = findAdoptableTask(tasks, { prompt, sinceMs: remembered.at });
        if (adopted) {
          const { entry } = upsertEntry(adopted);
          submissionMemo.set(submissionKey, { taskId: adopted.taskId, at: remembered.at });
          touch();
          emit(entry?.taskId);
          return adopted;
        }
        submissionMemo.delete(submissionKey);
      }
    }

    let task;
    const startedAt = Date.now();
    try {
      task = await api.submitTask(input);
    } catch (error) {
      const wrapped = error instanceof Error ? error : new Error(String(error));
      if (submissionKey && isAmbiguousSubmissionError(error)) {
        submissionMemo.set(submissionKey, { uncertain: true, at: startedAt });
        Object.assign(wrapped, {
          code: wrapped.code || "submission_uncertain",
          taskSubmissionUncertain: true
        });
      }
      throw wrapped;
    }
    if (!task?.taskId) {
      throw Object.assign(new Error("The server accepted the task but did not identify it."), {
        code: "invalid_task_response"
      });
    }
    if (submissionKey) submissionMemo.set(submissionKey, { taskId: task.taskId, at: startedAt });
    const { entry } = upsertEntry(task);
    touch();
    emit(entry?.taskId || task.taskId);
    return task;
  })().finally(() => {
    if (submissionKey && inFlightSubmissions.get(submissionKey) === attempt) {
      inFlightSubmissions.delete(submissionKey);
    }
  });

  if (submissionKey) inFlightSubmissions.set(submissionKey, attempt);
  return attempt;
}

/**
 * Cancellation is the backend's decision, not the client's hope. Whatever the
 * record says when the request lands is what this applies, and a refusal — a
 * task that had already finished — reaches the caller as an error it can show.
 */
async function actOnTask(taskId, action, read) {
  const id = String(taskId || "");
  if (!id) throw Object.assign(new Error("No task to act on."), { code: "invalid_task_id" });
  const existing = entries.get(id);
  let task;
  // Only a resume may turn a finished record back into an open one, and the
  // allowance has to stay open until the answer is applied: clearing it when the
  // request returned would make the backend's own "running" look like a
  // resurrection and get refused.
  if (existing && action === "resume") existing.allowRevival = true;
  try {
    task = await read(id);
    if (!task?.taskId || String(task.taskId) !== id) {
      // A response naming another task is never applied here: one row's action
      // must not rewrite a different task's state.
      throw Object.assign(new Error("The task action returned a different task."), {
        code: "task_id_mismatch"
      });
    }
    upsertEntry(task);
    touch();
    emit(id);
  } finally {
    if (existing && action === "resume") existing.allowRevival = false;
  }
  return task;
}

export function cancelTrackedTask(taskId) {
  return actOnTask(taskId, "cancel", api.cancelTask);
}

/** The one supported way a finished-looking record becomes open again: resuming a paused or waiting task. */
export function resumeTrackedTask(taskId) {
  return actOnTask(taskId, "resume", api.resumeTask);
}

/**
 * Answering a parked task's question, which is what puts it back in the queue.
 *
 * This is a read-like apply of the backend's own record, with no optimistic
 * mutation: the answer text is not written into the row here, and the question
 * does not vanish until the server's response says it has. A duplicate press
 * therefore lands on the backend's single-use CAS — which refuses the second
 * one — and the row this client holds is the record either way.
 */
export function answerTrackedClarification(taskId, clarificationId, answer) {
  return actOnTask(taskId, "answer", id => api.answerTaskClarification(id, clarificationId, answer));
}

/** An explicit re-read of one record — the only thing that may rewrite what this client believes. */
export async function refreshTrackedTask(taskId) {
  const id = String(taskId || "");
  if (!id) throw Object.assign(new Error("No task to refresh."), { code: "invalid_task_id" });
  let entry = entries.get(id);
  const fresh = !entry;
  if (fresh) {
    entry = newEntry({ taskId: id, state: "queued", stage: "queued", conversationId: null, events: [] });
    entries.set(id, entry);
  }
  try {
    await resyncTask(entry);
  } catch (error) {
    if (taskErrorKind(error) === "not_found") {
      entries.delete(id);
      touch();
      emit(id);
      throw error;
    }
    entry.offline = true;
    if (fresh) entries.delete(id);
    touch();
    emit(id);
    throw error;
  }
  touch();
  emit(id);
  return entry.task;
}

export function listTrackedTasks() {
  return getTaskTrackerSnapshot().tasks;
}

export function startTaskTracker({ intervalMs: nextInterval, api: injectedApi } = {}) {
  if (injectedApi !== undefined) configureTaskTrackerApi(injectedApi);
  if (Number.isFinite(nextInterval) && nextInterval > 0) intervalMs = nextInterval;
  if (timer) return false;
  timer = setInterval(() => {
    pollTaskTrackerOnce().catch(() => {});
  }, intervalMs);
  // Opening the app has to read the server's task list before it shows
  // anything, so a reload finds the tasks that were started before it.
  pollTaskTrackerOnce().catch(() => {});
  touch();
  return true;
}

export function stopTaskTracker() {
  if (!timer) return false;
  clearInterval(timer);
  timer = null;
  // The registry survives on purpose. Stopping the loop is what signing out
  // needs; a component unmount is not a reason to stop knowing about a task.
  touch();
  return true;
}

export function isTaskTrackerRunning() {
  return timer !== null;
}

export function getTaskTrackerOwner() {
  return owner;
}

/**
 * Bind this registry to an authenticated account.
 *
 * A different id — signing out, or signing in as somebody else without the
 * document reloading — is a new set of tasks, so everything learned about the
 * previous one goes: rows, cursors, watchers, and the submission keys that were
 * protecting its duplicate sends. Nothing from one account survives into
 * another's view.
 */
export function setTaskTrackerOwner(nextOwner) {
  const id = String(nextOwner || "");
  if (id === owner) return false;
  owner = id;
  entries.clear();
  inFlightSubmissions.clear();
  submissionMemo.clear();
  tickCount = 0;
  status = "idle";
  errorKind = "";
  syncError = "";
  lastSyncAt = 0;
  hydration = { state: "idle", error: "", errorKind: "", at: 0 };
  touch();
  emit();
  return true;
}

/** Signing out or switching accounts: the next user must not inherit these rows. */
export function resetTaskTracker() {
  owner = "";
  entries.clear();
  inFlightSubmissions.clear();
  submissionMemo.clear();
  tickCount = 0;
  status = "idle";
  errorKind = "";
  syncError = "";
  lastSyncAt = 0;
  ticking = null;
  hydration = { state: "idle", error: "", errorKind: "", at: 0 };
  touch();
}

export function taskTrackerStatus() {
  return { status, owner, error: syncError, errorKind, hydration, lastSyncAt, running: timer !== null };
}

/**
 * Test seam: substitute the HTTP layer so the loop's behaviour can be driven
 * deterministically. Production code never calls this.
 */
export function configureTaskTrackerApi(nextApi) {
  api = nextApi || defaultApi;
}
