export const SAVED_MODELS_STORAGE_KEY = "vupsrouter.chat.savedModels";

export const MODEL_FILTERS = [
  { id: "all", label: "All models" },
  { id: "free", label: "Free" },
  { id: "saved", label: "Saved" }
];

const MAX_SAVED_MODELS = 200;

function defaultStorage() {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * Stable across catalogue refreshes: the provider configuration id (when the
 * model belongs to a user key) plus the exact model id the provider expects.
 * Display names and availability are deliberately not part of the identity.
 */
export function savedModelId(row) {
  if (!row || typeof row !== "object") return "";
  const model = typeof row.model === "string" ? row.model.trim() : "";
  if (!model) return "";
  if (row.vups) return `vups:${model}`;
  if (row.gateway) return `gateway:${row.source || "omniroute"}:${model}`;
  if (row.shared) return `shared:${model}`;
  const provider = String(row.configId || row.providerId || row.provider || "").trim();
  return `custom:${provider}:${model}`;
}

export function normalizeSavedModelIds(value) {
  const source = Array.isArray(value) ? value : Array.isArray(value?.models) ? value.models : [];
  const ids = [];
  for (const entry of source) {
    if (typeof entry !== "string") continue;
    const id = entry.trim();
    if (!id || ids.includes(id)) continue;
    ids.push(id);
    if (ids.length >= MAX_SAVED_MODELS) break;
  }
  return ids;
}

export function loadSavedModelIds(storage = defaultStorage()) {
  try {
    const raw = storage?.getItem(SAVED_MODELS_STORAGE_KEY);
    if (!raw) return [];
    return normalizeSavedModelIds(JSON.parse(raw));
  } catch {
    return [];
  }
}

export function saveSavedModelIds(ids, storage = defaultStorage()) {
  const normalized = normalizeSavedModelIds(ids);
  try {
    if (!storage) return normalized;
    if (normalized.length === 0) storage.removeItem(SAVED_MODELS_STORAGE_KEY);
    else storage.setItem(SAVED_MODELS_STORAGE_KEY, JSON.stringify({ version: 1, models: normalized }));
  } catch {
    /* storage is best-effort: private mode or quota errors must not break chat */
  }
  return normalized;
}

export function isModelSaved(row, savedIds) {
  const id = savedModelId(row);
  return Boolean(id && Array.isArray(savedIds) && savedIds.includes(id));
}

export function toggleSavedModel(row, savedIds) {
  const id = savedModelId(row);
  const current = normalizeSavedModelIds(savedIds);
  if (!id) return { ids: current, saved: false };
  if (current.includes(id)) return { ids: current.filter(entry => entry !== id), saved: false };
  return { ids: normalizeSavedModelIds([...current, id]), saved: true };
}

export function filterModelRows(rows, filter, savedIds) {
  const list = Array.isArray(rows) ? rows : [];
  if (filter === "free") return list.filter(row => row?.free === true && !row.disabled);
  if (filter === "saved") {
    const ids = new Set(normalizeSavedModelIds(savedIds));
    return list.filter(row => ids.has(savedModelId(row)));
  }
  return list;
}

export function missingSavedModelCount(rows, savedIds) {
  const available = new Set((Array.isArray(rows) ? rows : []).map(savedModelId));
  return normalizeSavedModelIds(savedIds).filter(id => !available.has(id)).length;
}

export function matchesModelQuery(row, needle) {
  const query = String(needle || "").trim().toLowerCase();
  if (!query) return true;
  return [row?.name, row?.model, row?.provider, row?.tag, row?.meta, ...(row?.capabilityLabels || [])]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .includes(query);
}

export function filterEmptyMessage(filter, { query = "", savedCount = 0 } = {}) {
  if (filter === "saved") {
    if (savedCount === 0) return "No saved models yet. Star a model to keep it here.";
    return query.trim()
      ? "No saved models match this search."
      : "Your saved models are not in the current catalogue.";
  }
  if (filter === "free") {
    return query.trim() ? "No free models match this search." : "No free models are available right now.";
  }
  return query.trim() ? "No models match this search." : "No models are available right now.";
}
