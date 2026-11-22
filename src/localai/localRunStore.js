/**
 * The local execution service.
 *
 * A local run is not a server task: its loop runs in this JavaScript context, so
 * the module that owns the loop is the only thing that can outlive a ChatPage.
 * The registry below is that owner. It is keyed by conversation, it emits the
 * same way the task tracker emits, and it carries the draft text the run has
 * produced, so a chat that is reopened while the run is still going paints the
 * work that really exists instead of an empty assistant row.
 *
 * This is not a second task manager. Cloud work still belongs to the server and
 * to the task tracker; this only answers "what is this device's runtime doing
 * for this conversation". It disappears with the document — the conversation on
 * the account is what survives a restart, and the draft written here is the
 * bridge for a run the document did not outlive.
 */

export const LOCAL_RUN_DRAFT_KEY = "vupsrouter.localrun.v1";
export const LOCAL_RUN_STATES = Object.freeze({
  RUNNING: "running",
  DONE: "done",
  STOPPED: "stopped",
  FAILED: "failed"
});

const PUBLISH_MS = 250;
const DRAFT_WRITE_MS = 1000;
const DRAFT_CHARS = 12000;
const DRAFT_LIMIT = 8;
const FINISHED_RETENTION_MS = 30 * 60 * 1000;
const MAX_RECORDS = 24;

let owner = "";
/** @type {Map<string, object>} conversationId -> record */
const runs = new Map();
const listeners = new Set();
let snapshotCache = null;
let version = 0;
let publishTimer = null;

function storage() {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function readDrafts() {
  const store = storage();
  try {
    const parsed = JSON.parse(store?.getItem(LOCAL_RUN_DRAFT_KEY) || "null");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeDrafts(drafts) {
  try {
    storage()?.setItem(LOCAL_RUN_DRAFT_KEY, JSON.stringify(drafts));
  } catch {
    // The conversation itself is already saved; the draft is best-effort.
  }
}

function persistDraft(record) {
  if (!record.owner) return;
  const drafts = readDrafts();
  drafts[record.conversationId] = {
    owner: record.owner,
    conversationId: record.conversationId,
    assistantId: record.assistantId,
    kind: record.kind,
    label: record.label,
    stage: record.stage.slice(-DRAFT_CHARS),
    plan: record.plan || null,
    startedAt: record.startedAt,
    updatedAt: Date.now()
  };
  const kept = Object.entries(drafts)
    .sort((left, right) => Number(right[1]?.updatedAt) - Number(left[1]?.updatedAt))
    .slice(0, DRAFT_LIMIT);
  writeDrafts(Object.fromEntries(kept));
}

/**
 * The draft an earlier document left for this conversation, if any. Ownership is
 * checked here rather than at write time, so another account on the same machine
 * never reads a draft that is not its own.
 */
export function readLocalRunDraft(conversationId, forOwner = owner) {
  const id = String(conversationId || "");
  const who = String(forOwner || "");
  if (!id || !who) return null;
  const draft = readDrafts()[id] || null;
  if (!draft || String(draft.owner || "") !== who) return null;
  return {
    conversationId: id,
    assistantId: String(draft.assistantId || ""),
    kind: String(draft.kind || "combo"),
    label: String(draft.label || ""),
    stage: typeof draft.stage === "string" ? draft.stage : "",
    plan: draft.plan && typeof draft.plan === "object" ? draft.plan : null,
    startedAt: Number(draft.startedAt) || 0,
    updatedAt: Number(draft.updatedAt) || 0
  };
}

export function clearLocalRunDraft(conversationId) {
  const id = String(conversationId || "");
  if (!id) return;
  const drafts = readDrafts();
  if (!drafts[id]) return;
  delete drafts[id];
  writeDrafts(drafts);
}

function publicRun(record) {
  return Object.freeze({
    conversationId: record.conversationId,
    assistantId: record.assistantId,
    kind: record.kind,
    label: record.label,
    stage: record.stage,
    plan: record.plan || null,
    status: record.status,
    content: record.content,
    error: record.error,
    saved: record.saved,
    stopRequested: record.stopRequested,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt
  });
}

export function getLocalRunSnapshot() {
  if (!snapshotCache) {
    const rows = [...runs.values()].map(publicRun);
    rows.sort((left, right) => right.startedAt - left.startedAt);
    snapshotCache = Object.freeze({ version, owner, runs: Object.freeze(rows) });
  }
  return snapshotCache;
}

export function subscribeLocalRuns(listener) {
  if (typeof listener !== "function") return () => {};
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit() {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // A broken subscriber must not stop the run from recording its progress.
    }
  }
}

function publish({ immediate = false } = {}) {
  version += 1;
  snapshotCache = null;
  if (immediate) {
    if (publishTimer) {
      clearTimeout(publishTimer);
      publishTimer = null;
    }
    emit();
    return;
  }
  if (publishTimer) return;
  publishTimer = setTimeout(() => {
    publishTimer = null;
    emit();
  }, PUBLISH_MS);
}

function trim() {
  if (runs.size <= MAX_RECORDS) return;
  const finished = [...runs.values()]
    .filter(record => record.status !== LOCAL_RUN_STATES.RUNNING)
    .sort((left, right) => left.finishedAt - right.finishedAt);
  for (const record of finished) {
    if (runs.size <= MAX_RECORDS) break;
    runs.delete(record.conversationId);
  }
}

/** A different account is a different set of runs; nothing survives the change. */
export function setLocalRunOwner(nextOwner) {
  const id = String(nextOwner || "");
  if (id === owner) return false;
  owner = id;
  runs.clear();
  publish({ immediate: true });
  return true;
}

export function getLocalRunOwner() {
  return owner;
}

export function beginLocalRun({
  conversationId,
  assistantId,
  kind = "combo",
  label = "",
  plan = null,
  controller = null,
  ownerId = ""
} = {}) {
  const id = String(conversationId || "");
  const assistant = String(assistantId || "");
  if (!id || !assistant) return null;
  if (ownerId) owner = String(ownerId);
  const record = {
    conversationId: id,
    assistantId: assistant,
    kind,
    label: String(label || ""),
    stage: "",
    plan: plan && typeof plan === "object" ? plan : null,
    status: LOCAL_RUN_STATES.RUNNING,
    content: "",
    error: "",
    saved: null,
    owner,
    controller,
    stopRequested: false,
    startedAt: Date.now(),
    finishedAt: 0,
    lastDraftAt: 0
  };
  runs.set(id, record);
  trim();
  publish({ immediate: true });
  return record;
}

export function noteLocalRunStage(conversationId, stage) {
  const record = runs.get(String(conversationId || ""));
  if (!record || record.status !== LOCAL_RUN_STATES.RUNNING) return false;
  const next = typeof stage === "string" ? stage : "";
  if (next === record.stage) return false;
  record.stage = next;
  const now = Date.now();
  if (now - record.lastDraftAt >= DRAFT_WRITE_MS) {
    record.lastDraftAt = now;
    persistDraft(record);
  }
  publish();
  return true;
}

/**
 * The run has settled. The record is kept briefly so a screen that returns just
 * after the end can still paint what the run produced, then it is dropped; the
 * saved conversation is the durable copy.
 */
export function finishLocalRun(conversationId, {
  status = LOCAL_RUN_STATES.DONE,
  content = "",
  error = "",
  saved = null,
  label = ""
} = {}) {
  const record = runs.get(String(conversationId || ""));
  if (!record) return null;
  record.status =
    status === LOCAL_RUN_STATES.FAILED
      ? LOCAL_RUN_STATES.FAILED
      : status === LOCAL_RUN_STATES.STOPPED
        ? LOCAL_RUN_STATES.STOPPED
        : LOCAL_RUN_STATES.DONE;
  record.content = typeof content === "string" ? content : "";
  record.error = String(error || "");
  record.saved = saved;
  if (label) record.label = String(label);
  record.finishedAt = Date.now();
  record.controller = null;
  if (record.stage.trim()) {
    // Keep the last draft until the final assistant message is known to exist.
    if (saved !== false) clearLocalRunDraft(record.conversationId);
  } else {
    clearLocalRunDraft(record.conversationId);
  }
  publish({ immediate: true });
  const timer = setTimeout(() => {
    const current = runs.get(record.conversationId);
    if (current && current.assistantId === record.assistantId && current.status !== LOCAL_RUN_STATES.RUNNING) {
      runs.delete(record.conversationId);
      publish({ immediate: true });
    }
  }, FINISHED_RETENTION_MS);
  timer?.unref?.();
  return record;
}

/**
 * Stop names the run's own controller, not whatever request this screen happens
 * to hold. The loop then settles as "stopped" and saves the drafts it completed.
 */
export function stopLocalRun(conversationId) {
  const record = runs.get(String(conversationId || ""));
  if (!record || record.status !== LOCAL_RUN_STATES.RUNNING) return false;
  record.stopRequested = true;
  const controller = record.controller;
  record.controller = null;
  try {
    controller?.abort();
  } catch {
    // An already-aborted controller is the same request to this caller.
  }
  publish({ immediate: true });
  return true;
}

export function getLocalRun(conversationId) {
  return runs.get(String(conversationId || "")) || null;
}

export function isLocalRunActive(conversationId) {
  const record = getLocalRun(conversationId);
  return Boolean(record && record.status === LOCAL_RUN_STATES.RUNNING);
}

export function listLocalRuns() {
  return [...runs.values()].map(publicRun);
}

export function clearLocalRun(conversationId, assistantId = "") {
  const id = String(conversationId || "");
  const record = runs.get(id);
  if (!record) return false;
  if (assistantId && record.assistantId !== String(assistantId)) return false;
  runs.delete(id);
  publish({ immediate: true });
  return true;
}

/** Signing out or switching accounts: the next user must not inherit these runs. */
export function resetLocalRuns() {
  owner = "";
  runs.clear();
  if (publishTimer) {
    clearTimeout(publishTimer);
    publishTimer = null;
  }
  publish({ immediate: true });
}

/** Test seam: a snapshot that is rebuilt from scratch after every change. */
export function localRunVersion() {
  return version;
}
