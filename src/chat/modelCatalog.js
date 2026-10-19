export const MODEL_SELECTION_STORAGE_KEY = "vupsrouter.chat.modelSelection";
export const PERSONAL_GROUP = "YOUR KEYS";
export const SHARED_GROUP = "FREE MODELS";

function cleanEntries(entries) {
  return (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry && typeof entry.id === "string" && entry.id.trim())
    .map((entry) => ({ ...entry, id: entry.id.trim() }));
}

function savedRow(entry) {
  const model = entry.id;
  const configId = entry.configId || "";
  const provider = entry.provider || entry.ownedBy || "Your provider";
  const masked = entry.apiKeyMasked || "";
  const vision = entry.vision === true ? true : entry.vision === false ? false : null;
  return {
    key: `saved:${configId || entry.providerId || provider}:${model}`,
    kind: "saved",
    group: PERSONAL_GROUP,
    name: entry.name || model,
    model,
    configId,
    providerId: entry.providerId || "",
    provider,
    ownedBy: entry.ownedBy || "",
    apiKeyMasked: masked,
    saved: true,
    shared: false,
    vision,
    tag: "Saved model",
    meta: [provider, masked].filter(Boolean).join(" · ")
  };
}

function sharedRow(entry) {
  const model = entry.id || entry.name;
  const vision = entry.vision === true;
  return {
    key: `shared:${model}`,
    kind: "shared",
    group: SHARED_GROUP,
    name: entry.name || model,
    model,
    configId: "",
    providerId: "",
    provider: entry.ownedBy || "Shared",
    ownedBy: entry.ownedBy || "",
    apiKeyMasked: "",
    saved: false,
    shared: true,
    vision,
    tag: "Free · No API key needed",
    meta: ""
  };
}

export function buildCatalog({ models = [], shared = null } = {}) {
  const entries = cleanEntries(models);
  const saved = new Map();
  for (const entry of entries) {
    if (entry.shared === true) continue;
    const row = savedRow(entry);
    if (!saved.has(row.key)) saved.set(row.key, row);
  }

  // Free models come from the shared status first so the full default
  // catalogue survives even when provider discovery fails, then from any
  // shared rows the models endpoint returned (which may add vision flags).
  const free = new Map();
  const sharedStatusModels = shared?.available && Array.isArray(shared.models) ? shared.models : [];
  for (const entry of sharedStatusModels) {
    if (!entry || entry.available === false) continue;
    const id = typeof entry.id === "string" ? entry.id.trim() : typeof entry.name === "string" ? entry.name.trim() : "";
    if (!id) continue;
    const row = sharedRow({ ...entry, id, name: entry.name || id });
    if (!free.has(row.key)) free.set(row.key, row);
  }
  for (const entry of entries) {
    if (entry.shared !== true) continue;
    const row = sharedRow(entry);
    if (!free.has(row.key)) free.set(row.key, row);
  }

  return [...saved.values(), ...free.values()];
}

export function selectionFromRow(row) {
  if (!row) return null;
  if (row.shared) return { kind: "shared", model: row.model };
  return { kind: "saved", configId: row.configId || "", model: row.model };
}

export function resolveSelection(catalog, selection) {
  const rows = Array.isArray(catalog) ? catalog : [];
  if (rows.length === 0 || !selection) return null;
  let wanted = selection;
  if (typeof wanted === "string") wanted = { kind: "auto", model: wanted };
  if (!wanted || typeof wanted !== "object" || typeof wanted.model !== "string") return null;
  const model = wanted.model.trim();
  if (!model) return null;
  if (wanted.kind === "shared") return rows.find((row) => row.shared && row.model === model) || null;
  if (wanted.kind === "saved") {
    if (wanted.configId) {
      return rows.find((row) => !row.shared && row.model === model && row.configId === wanted.configId) || null;
    }
    return rows.find((row) => !row.shared && row.model === model) || null;
  }
  return (
    rows.find((row) => row.key === model || (!row.shared && row.model === model)) ||
    rows.find((row) => row.model === model) ||
    null
  );
}

export function fallbackRow(catalog) {
  const rows = Array.isArray(catalog) ? catalog : [];
  return rows.find((row) => row.shared) || rows[0] || null;
}

export function chatReference(row) {
  if (!row) return {};
  if (row.shared) return { model: row.model };
  return { model: row.model, configId: row.configId || undefined };
}

function defaultStorage() {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function loadStoredSelection(storage = defaultStorage()) {
  try {
    const raw = storage?.getItem(MODEL_SELECTION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.kind === "shared" && typeof parsed.model === "string" && parsed.model) {
      return { kind: "shared", model: parsed.model };
    }
    if (parsed.kind === "saved" && typeof parsed.model === "string" && parsed.model) {
      return { kind: "saved", configId: typeof parsed.configId === "string" ? parsed.configId : "", model: parsed.model };
    }
    return null;
  } catch {
    return null;
  }
}

export function saveStoredSelection(selection, storage = defaultStorage()) {
  try {
    if (!storage) return;
    if (!selection || typeof selection.model !== "string" || !selection.model) {
      storage.removeItem(MODEL_SELECTION_STORAGE_KEY);
      return;
    }
    const payload =
      selection.kind === "saved"
        ? { kind: "saved", configId: selection.configId || "", model: selection.model }
        : { kind: "shared", model: selection.model };
    storage.setItem(MODEL_SELECTION_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    /* storage is best-effort: private mode or quota errors must not break chat */
  }
}
