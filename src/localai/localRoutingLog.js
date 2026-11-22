/**
 * The routing receipt for a finished local run.
 *
 * The plan belongs to the assistant message, not to the screen that ran it, so
 * it is stored by message id and read back when the conversation is opened
 * later. It is scoped to the account, bounded, and never contains model output.
 */

export const LOCAL_ROUTING_STORAGE_KEY = "vupsrouter.localrouting.v1";

const LIMIT = 120;

function storage() {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function readLog() {
  try {
    const parsed = JSON.parse(storage()?.getItem(LOCAL_ROUTING_STORAGE_KEY) || "null");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeLog(entries) {
  try {
    storage()?.setItem(LOCAL_ROUTING_STORAGE_KEY, JSON.stringify(entries));
    return true;
  } catch {
    return false;
  }
}

function publicEntry(entry) {
  return {
    messageId: String(entry.messageId || ""),
    intent: String(entry.intent || ""),
    objective: String(entry.objective || ""),
    taskPreview: String(entry.taskPreview || ""),
    label: String(entry.label || ""),
    execution: Number(entry.execution) || 0,
    reason: String(entry.reason || ""),
    notes: Array.isArray(entry.notes) ? entry.notes.map(String) : [],
    stages: Array.isArray(entry.stages)
      ? entry.stages
          .filter(stage => stage && stage.model)
          .map(stage => ({
            role: String(stage.role || "chat"),
            model: String(stage.model || ""),
            final: Boolean(stage.final),
            detail: String(stage.detail || "")
          }))
      : [],
    at: Number(entry.at) || 0
  };
}

/** Save the plan for one assistant message. */
export function saveLocalRouting(messageId, plan, { owner = "" } = {}) {
  const id = String(messageId || "").trim();
  if (!id || !plan || typeof plan !== "object") return false;
  const entries = readLog();
  entries[id] = { ...publicEntry({ ...plan, messageId: id }), owner: String(owner || ""), at: Date.now() };
  const kept = Object.entries(entries)
    .sort((left, right) => Number(right[1]?.at) - Number(left[1]?.at))
    .slice(0, LIMIT);
  return writeLog(Object.fromEntries(kept));
}

/** The plan saved for one message, or null when it is not this account's. */
export function readLocalRouting(messageId, owner = "") {
  const id = String(messageId || "").trim();
  if (!id) return null;
  const entry = readLog()[id];
  if (!entry || String(entry.owner || "") !== String(owner || "")) return null;
  return publicEntry(entry);
}

/** Every plan this account owns, keyed by message id, for one conversation load. */
export function readLocalRoutingMap(owner = "") {
  const who = String(owner || "");
  const map = new Map();
  for (const entry of Object.values(readLog())) {
    if (!entry || String(entry.owner || "") !== who) continue;
    const id = String(entry.messageId || "");
    if (id) map.set(id, publicEntry(entry));
  }
  return map;
}

export function resetLocalRouting() {
  try {
    storage()?.removeItem(LOCAL_ROUTING_STORAGE_KEY);
  } catch {
    // A rejected storage write is the same as no receipt; the answer still exists.
  }
}
