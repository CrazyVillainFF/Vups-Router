/**
 * How many working models may join one run. This is the execution depth, not
 * the selection size: the two were the same number only while the selection
 * was small, and raising the selection must not let a single run fan out
 * across the whole library.
 */
export const COMBO_MAX_WORKING_MODELS = 32;

const KINDS = ["saved", "shared", "vups"];
const STATUS_LABELS = {
  working: "Working",
  not_working: "Not Working",
  unknown: "Not Checked",
  checking: "Checking"
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
    label: String(model.label || "").trim() || modelId,
    // What the model can do with a picture. `null` means the capability is
    // not known, and an unknown model is never asked to read one.
    vision: model.vision === true ? true : model.vision === false ? false : null
  };
}

export function toggleSelectedModel(selected, model) {
  const normalized = normalizeSelectedModel(model);
  if (!normalized) return Array.isArray(selected) ? selected : [];
  const current = Array.isArray(selected) ? selected : [];
  if (current.some(entry => entry.key === normalized.key)) {
    return current.filter(entry => entry.key !== normalized.key);
  }
  return [...current, normalized];
}

export function removeSelectedModel(selected, key) {
  return (Array.isArray(selected) ? selected : []).filter(entry => entry.key !== key);
}

/**
 * Every model in the library, selected.
 *
 * Availability is not a condition: a model that is currently unavailable is
 * still part of the library and stays selected, exactly as it would if the
 * user had picked it by hand. The selection is capped at the limit, and a
 * model that is already selected keeps its place and its stored identity.
 */
export function selectAllModels(selected, catalogModels) {
  const current = Array.isArray(selected) ? selected : [];
  const known = new Set(current.map(entry => entry.key));
  const next = [...current];
  for (const model of Array.isArray(catalogModels) ? catalogModels : []) {
    const normalized = normalizeSelectedModel(model);
    if (!normalized || known.has(normalized.key)) continue;
    known.add(normalized.key);
    next.push(normalized);
  }
  return next;
}

// How many models one availability request carries. A sweep over a thousand
// models is split into batches of this size so each request can finish, and
// each finished batch is already saved when the next one starts.
export const COMBO_AVAILABILITY_BATCH = 20;

/**
 * The batches a sweep is split into.
 *
 * One request for a thousand models cannot finish, and a request that is cut
 * short leaves the page with nothing. Splitting the work keeps every finished
 * batch on the server and in the page as it lands, so the counters move while
 * the sweep runs instead of jumping at the end.
 */
export function availabilityBatches(targets, size = COMBO_AVAILABILITY_BATCH) {
  const list = Array.isArray(targets) ? targets : [];
  const width = Math.max(1, Number(size) || 1);
  const batches = [];
  for (let index = 0; index < list.length; index += width) {
    batches.push(list.slice(index, index + width));
  }
  return batches;
}

/**
 * Every model the account holds.
 *
 * A sweep works from this list, so a search, a provider filter, or a page of
 * the library can never decide which models are checked. Selected or not, on
 * screen or not, every configured model is in here.
 */
export function libraryModelKeys(catalogModels) {
  const list = Array.isArray(catalogModels) ? catalogModels : [];
  const keys = [];
  const seen = new Set();
  for (const model of list) {
    const key = String(model?.key || "");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

/**
 * Keep only the models a real check proved are working.
 *
 * A model with no availability record is not working as far as this app can
 * tell, so it goes too: an unchecked model is not evidence of a working one,
 * and keeping it would put a model that never answered into the run.
 */
export function unselectNotWorkingModels(selected, availability) {
  const map = availability instanceof Map ? availability : availabilityMap(availability);
  return (Array.isArray(selected) ? selected : []).filter(
    entry => statusFor(map, entry.key) === "working"
  );
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
  // How many of the selected models are known to read pictures. A model whose
  // capability is unknown is not counted: an unknown model is never asked to
  // read one.
  const visionCapableCount = selected.filter(entry => entry?.vision === true).length;
  return {
    enabled: config?.enabled !== false,
    selectedCount: summary.selected,
    workingCount: checked === 0 ? null : summary.working,
    visionCapableCount
  };
}

export function mergeSelectedModels(selected, catalogModels) {
  const byKey = new Map((Array.isArray(catalogModels) ? catalogModels : []).map(model => [model.key, model]));
  return (Array.isArray(selected) ? selected : []).map(entry => {
    const catalog = byKey.get(entry.key) || null;
    // The catalogue knows what a model can do with a picture; the saved
    // selection keeps that fact with the model.
    const vision = entry?.vision === true ? true : entry?.vision === false ? false : catalog?.vision === true ? true : catalog?.vision === false ? false : null;
    return { ...entry, vision, catalog };
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
