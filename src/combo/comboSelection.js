export const COMBO_MAX_SELECTED = 32;

const KINDS = ["saved", "shared", "vups"];
const STATUS_LABELS = {
  working: "Working",
  not_working: "Not Working",
  unknown: "Not checked"
};

export function comboModelKey(model) {
  const kind = KINDS.includes(model?.kind) ? model.kind : "saved";
  const modelId = String(model?.model || "").trim();
  if (!modelId) return "";
  if (kind === "saved") return `saved:${String(model?.configId || "").trim()}:${modelId}`;
  if (kind === "shared") return `shared:${modelId}`;
  return `vups:${modelId}`;
}

export function normalizeSelectedModel(model) {
  if (!model || typeof model !== "object") return null;
  const kind = KINDS.includes(model.kind) ? model.kind : "saved";
  const modelId = String(model.model || "").trim();
  if (!modelId) return null;
  const configId = kind === "saved" ? String(model.configId || "").trim() : "";
  if (kind === "saved" && !configId) return null;
  return {
    key: comboModelKey({ kind, configId, model: modelId }),
    kind,
    configId,
    providerId: kind === "saved" ? String(model.providerId || "").trim() : "",
    provider: String(model.provider || "").trim() || (kind === "shared" ? "Shared" : kind === "vups" ? "Vups" : "Provider"),
    providerType: String(model.providerType || "").trim(),
    model: modelId,
    label: String(model.label || "").trim() || modelId
  };
}

export function toggleSelectedModel(selected, model) {
  const normalized = normalizeSelectedModel(model);
  if (!normalized) return Array.isArray(selected) ? selected : [];
  const current = Array.isArray(selected) ? selected : [];
  if (current.some(entry => entry.key === normalized.key)) {
    return current.filter(entry => entry.key !== normalized.key);
  }
  if (current.length >= COMBO_MAX_SELECTED) return current;
  return [...current, normalized];
}

export function removeSelectedModel(selected, key) {
  return (Array.isArray(selected) ? selected : []).filter(entry => entry.key !== key);
}

export function moveSelectedModel(selected, key, offset) {
  const list = Array.isArray(selected) ? [...selected] : [];
  const index = list.findIndex(entry => entry.key === key);
  if (index < 0) return list;
  const target = index + offset;
  if (target < 0 || target >= list.length) return list;
  const [entry] = list.splice(index, 1);
  list.splice(target, 0, entry);
  return list;
}

export function filterModels(models, { query = "", provider = "", workingOnly = false, availability = null } = {}) {
  const list = Array.isArray(models) ? models : [];
  const term = String(query || "").trim().toLowerCase();
  const providerName = String(provider || "").trim();
  return list.filter(model => {
    if (providerName && model.provider !== providerName) return false;
    // Only a real check can put a model in the Working view, so an entry with no
    // availability record at all is excluded rather than assumed healthy.
    if (workingOnly && statusFor(availability, model.key) !== "working") return false;
    if (!term) return true;
    return [model.label, model.model, model.provider]
      .some(value => String(value || "").toLowerCase().includes(term));
  });
}

// The provider select carries one extra view alongside the real providers, so it
// needs a value that can never collide with a provider label.
export const WORKING_MODELS_FILTER = "__working";

export function isWorkingModelsFilter(value) {
  return String(value || "") === WORKING_MODELS_FILTER;
}

export function libraryEmptyMessage({ query = "", workingOnly = false } = {}) {
  const term = String(query || "").trim();
  if (workingOnly) {
    return term
      ? "No Working models match this search."
      : "No model has a verified Working result yet. Run Test on a model to check one.";
  }
  return term ? "No models match this search or filter." : "No models match this filter.";
}

export function providerOptions(models) {
  const counts = new Map();
  for (const model of Array.isArray(models) ? models : []) {
    const provider = String(model?.provider || "").trim();
    if (!provider) continue;
    counts.set(provider, (counts.get(provider) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([provider, count]) => ({ provider, count }));
}

export function hasVisionModels(models) {
  return (Array.isArray(models) ? models : []).some(model => model?.vision === true);
}

export function availabilityMap(entries) {
  const map = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry?.key) map.set(entry.key, entry);
  }
  return map;
}

export function statusFor(map, key) {
  const status = map instanceof Map ? map.get(key)?.status : null;
  if (status === "working" || status === "not_working") return status;
  return "unknown";
}

export function statusLabel(status) {
  return STATUS_LABELS[status] || STATUS_LABELS.unknown;
}

export function summaryFor(selected, map) {
  const list = Array.isArray(selected) ? selected : [];
  const summary = { selected: list.length, working: 0, notWorking: 0, unknown: 0 };
  for (const entry of list) {
    const status = statusFor(map, entry.key);
    if (status === "working") summary.working += 1;
    else if (status === "not_working") summary.notWorking += 1;
    else summary.unknown += 1;
  }
  return summary;
}

// The chat picker row only reports what a real health check proved: a set that
// has never been checked shows a count, never "0 working", which would read as
// a failed check the app never ran.
export function comboCatalogState(config) {
  const selected = Array.isArray(config?.selected) ? config.selected : [];
  const summary = summaryFor(selected, availabilityMap(config?.availability));
  const checked = summary.working + summary.notWorking;
  return {
    enabled: config?.enabled !== false,
    selectedCount: summary.selected,
    workingCount: checked === 0 ? null : summary.working
  };
}

export function mergeSelectedModels(selected, catalogModels) {
  const byKey = new Map((Array.isArray(catalogModels) ? catalogModels : []).map(model => [model.key, model]));
  return (Array.isArray(selected) ? selected : []).map(entry => {
    const catalog = byKey.get(entry.key) || null;
    return { ...entry, catalog };
  });
}

export function withStaleSelected(mergedSelected, map) {
  const next = map instanceof Map ? new Map(map) : new Map();
  for (const entry of Array.isArray(mergedSelected) ? mergedSelected : []) {
    if (!entry.catalog && !next.has(entry.key)) {
      next.set(entry.key, { key: entry.key, status: "not_working", checkedAt: null, stale: true });
    }
  }
  return next;
}

export function selectionForSave(selected, catalogModels) {
  const availableKeys = new Set((Array.isArray(catalogModels) ? catalogModels : []).map(model => model.key));
  return (Array.isArray(selected) ? selected : [])
    .filter(entry => availableKeys.has(entry.key))
    .map(entry => normalizeSelectedModel(entry))
    .filter(Boolean);
}

export function formatCheckedAt(value) {
  if (!value) return "";
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "";
  const seconds = Math.max(0, Math.round((Date.now() - time) / 1000));
  if (seconds < 20) return "Checked just now";
  if (seconds < 90) return "Checked a minute ago";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `Checked ${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Checked ${hours} hour${hours === 1 ? "" : "s"} ago`;
  return `Checked ${new Date(time).toLocaleDateString()}`;
}

export function runPoolSummary(pool) {
  if (!pool) return null;
  const active = Array.isArray(pool.active) ? pool.active : [];
  const excluded = Array.isArray(pool.excluded) ? pool.excluded : [];
  return {
    active: active.length,
    excluded: excluded.length,
    deferred: Number(pool.deferredCount) || 0,
    selected: Number(pool.selectedCount) || active.length + excluded.length
  };
}
