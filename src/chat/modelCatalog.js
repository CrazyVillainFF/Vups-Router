export const MODEL_SELECTION_STORAGE_KEY = "vupsrouter.chat.modelSelection";
export const VUPS_MODELS_GROUP = "VUPS MODELS";
export const VUPS_MODEL_ID = "vups-v3-galax";
export const VUPS_MODEL_NAME = "Vups v3 Galax";
export const VUPS_CAPABILITIES = [
  "Full-stack developer",
  "Motion design",
  "CSS design",
  "Image reading",
  "Complex problem solving"
];
export const PERSONAL_GROUP = "YOUR KEYS";
export const SHARED_GROUP = "FREE MODELS";
export const SHARED_PAID_GROUP = "SHARED PAID MODELS";
export const GATEWAY_GROUP = "OMNIROUTE GATEWAY";
export const OMNIROUTE_SOURCE = "omniroute";

const CAPABILITY_LABELS = [
  ["vision", "Vision"],
  ["tools", "Tools"],
  ["reasoning", "Reasoning"],
  ["embeddings", "Embeddings"],
  ["imageGeneration", "Image gen"],
  ["audioInput", "Audio in"],
  ["audioOutput", "Audio out"],
  ["videoInput", "Video in"]
];

export function capabilityLabels(capabilities) {
  if (!capabilities || typeof capabilities !== "object") return [];
  return CAPABILITY_LABELS.filter(([key]) => capabilities[key] === true).map(([, label]) => label);
}

function capabilitiesFor(entry) {
  const source = entry?.capabilities;
  const capabilities = source && typeof source === "object" && !Array.isArray(source) ? { ...source } : {};
  if (entry?.vision === true || entry?.vision === false) {
    if (capabilities.vision !== true && capabilities.vision !== false) capabilities.vision = entry.vision;
  }
  return capabilities;
}

function visionFor(entry, capabilities) {
  if (entry?.vision === true) return true;
  if (entry?.vision === false) return false;
  if (capabilities.vision === true) return true;
  if (capabilities.vision === false) return false;
  return null;
}

function cleanEntries(entries) {
  return (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry && typeof entry.id === "string" && entry.id.trim())
    .map((entry) => ({ ...entry, id: entry.id.trim() }));
}

function isGatewayEntry(entry) {
  return entry?.gateway === true || entry?.source === OMNIROUTE_SOURCE;
}

function vupsRow() {
  return {
    key: `vups:${VUPS_MODEL_ID}`,
    kind: "vups",
    group: VUPS_MODELS_GROUP,
    name: VUPS_MODEL_NAME,
    model: VUPS_MODEL_ID,
    configId: "",
    providerId: "",
    provider: "Vups",
    ownedBy: "Vups",
    apiKeyMasked: "",
    saved: false,
    shared: false,
    vups: true,
    builtin: true,
    free: true,
    badge: "Default",
    vision: null,
    capabilities: {},
    capabilityLabels: [],
    capabilityChips: VUPS_CAPABILITIES,
    tag: "Free - no API key needed",
    meta: "First-party model"
  };
}

function savedRow(entry) {
  const model = entry.id;
  const configId = entry.configId || "";
  const provider = entry.provider || entry.ownedBy || "Your provider";
  const masked = entry.apiKeyMasked || "";
  const capabilities = capabilitiesFor(entry);
  const vision = visionFor(entry, capabilities);
  const restricted = entry.restrictedProvider === true;
  const free = entry.free === true;
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
    free,
    vision,
    capabilities,
    capabilityLabels: capabilityLabels(capabilities),
    disabled: restricted || undefined,
    tag: restricted ? "OpenCode client only - not usable from VupsRouter" : free ? "Free model - saved" : "Saved model",
    meta: [provider, masked].filter(Boolean).join(" - ")
  };
}

function sharedRow(entry) {
  const model = entry.id || entry.name;
  const capabilities = capabilitiesFor(entry);
  const vision = visionFor(entry, capabilities);
  const free = entry.free !== false;
  const context = entry.contextLength ? `${Math.round(entry.contextLength / 1000)}k context` : "";
  return {
    key: `shared:${model}`,
    kind: "shared",
    group: free ? SHARED_GROUP : SHARED_PAID_GROUP,
    name: entry.name || model,
    model,
    configId: "",
    providerId: "",
    provider: entry.ownedBy || "Shared",
    ownedBy: entry.ownedBy || "",
    apiKeyMasked: "",
    saved: false,
    shared: true,
    free,
    vision,
    capabilities,
    capabilityLabels: capabilityLabels(capabilities),
    tag: free ? "Free - no API key needed" : "Paid - shared server key",
    meta: [context, free ? "" : "Paid model on the shared key"].filter(Boolean).join(" - ")
  };
}

export function gatewayStatusLabel(status) {
  switch (status?.status) {
    case "disabled":
      return "Disabled on this server";
    case "not_configured":
    case "invalid_config":
      return "Not configured on this server";
    case "unauthorized":
      return "Server API key rejected";
    case "rate_limited":
      return "Rate-limited right now";
    case "timeout":
      return "Connection timed out";
    case "empty":
      return "No models configured";
    default:
      return "Unreachable right now";
  }
}

function gatewayStatusRow(status) {
  return {
    key: `gateway-status:${status.status}`,
    kind: "gateway-status",
    group: GATEWAY_GROUP,
    name: "OmniRoute",
    model: "",
    configId: "",
    providerId: "",
    provider: "OmniRoute",
    ownedBy: "",
    apiKeyMasked: "",
    saved: false,
    shared: false,
    gateway: true,
    source: OMNIROUTE_SOURCE,
    vision: null,
    disabled: true,
    tag: gatewayStatusLabel(status),
    meta: "Managed by the server"
  };
}

function gatewayRow(entry) {
  const model = entry.id || entry.name;
  const source = entry.source || OMNIROUTE_SOURCE;
  const provider = entry.provider || entry.ownedBy || "OmniRoute";
  const capabilities = capabilitiesFor(entry);
  const vision = visionFor(entry, capabilities);
  return {
    key: `gateway:${source}:${model}`,
    kind: "gateway",
    group: entry.group || GATEWAY_GROUP,
    name: entry.name || model,
    model,
    configId: "",
    providerId: "",
    provider,
    ownedBy: entry.ownedBy || "",
    apiKeyMasked: "",
    saved: false,
    shared: false,
    gateway: true,
    source,
    vision,
    capabilities,
    capabilityLabels: capabilityLabels(capabilities),
    tag: `${provider} gateway`,
    meta: "Managed by the server"
  };
}

export function buildCatalog({ models = [], shared = null, omniroute = null, vups = false } = {}) {
  const entries = cleanEntries(models);
  const saved = new Map();
  for (const entry of entries) {
    if (entry.shared === true || isGatewayEntry(entry)) continue;
    const row = savedRow(entry);
    if (!saved.has(row.key)) saved.set(row.key, row);
  }

  // Free models come from the shared status first so the full default
  // catalogue survives even when provider discovery fails, then from any
  // shared rows the models endpoint returned (which may add vision flags).
  const free = new Map();
  const freeIds = new Set();
  const sharedStatusModels = shared?.available && Array.isArray(shared.models) ? shared.models : [];
  for (const entry of sharedStatusModels) {
    if (!entry || entry.available === false) continue;
    const id = typeof entry.id === "string" ? entry.id.trim() : typeof entry.name === "string" ? entry.name.trim() : "";
    if (!id) continue;
    const row = sharedRow({ ...entry, id, name: entry.name || id });
    if (!free.has(row.key)) {
      free.set(row.key, row);
      freeIds.add(row.model);
    }
  }
  for (const entry of entries) {
    if (entry.shared !== true) continue;
    const row = sharedRow(entry);
    if (!free.has(row.key)) {
      free.set(row.key, row);
      freeIds.add(row.model);
    }
  }

  // Gateway rows are additive: they never replace saved or free models, and a
  // model already offered for free is not duplicated behind the gateway.
  const gateways = new Map();
  for (const entry of entries) {
    if (!isGatewayEntry(entry)) continue;
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    if (!id || freeIds.has(id)) continue;
    const row = gatewayRow({ ...entry, id, name: entry.name || id });
    if (!gateways.has(row.key)) gateways.set(row.key, row);
  }

  // An intended-but-unavailable gateway gets one informational row so the
  // picker can explain the state instead of silently showing nothing. The row
  // is not selectable and never becomes the active model.
  if (omniroute?.enabled && omniroute.configured && !omniroute.available && gateways.size === 0) {
    const row = gatewayStatusRow(omniroute);
    gateways.set(row.key, row);
  }

  return [
    ...(vups ? [vupsRow()] : []),
    ...saved.values(),
    ...free.values(),
    ...gateways.values()
  ];
}

export function selectionFromRow(row) {
  if (!row) return null;
  if (row.vups) return { kind: "vups", model: VUPS_MODEL_ID };
  if (row.gateway) return { kind: "gateway", source: row.source || OMNIROUTE_SOURCE, model: row.model };
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
  if (wanted.kind === "vups") return rows.find((row) => row.vups && row.model === model) || null;
  if (wanted.kind === "gateway") {
    const source = typeof wanted.source === "string" ? wanted.source : "";
    return (
      rows.find((row) => row.gateway && row.model === model && (!source || row.source === source)) || null
    );
  }
  if (wanted.kind === "shared") return rows.find((row) => row.shared && row.model === model) || null;
  if (wanted.kind === "saved") {
    if (wanted.configId) {
      return rows.find((row) => !row.shared && row.model === model && row.configId === wanted.configId) || null;
    }
    if (wanted.providerId) {
      return rows.find((row) => !row.shared && row.model === model && row.providerId === wanted.providerId) || null;
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
  return rows.find((row) => row.vups) || rows.find((row) => row.shared) || rows.find((row) => !row.disabled) || null;
}

export function chatReference(row) {
  if (!row || row.disabled) return {};
  if (row.vups) return { model: VUPS_MODEL_ID, vups: true };
  if (row.gateway) return { model: row.model, source: row.source || OMNIROUTE_SOURCE };
  if (row.shared) return { model: row.model };
  return { model: row.model, configId: row.configId || undefined, providerId: row.providerId || undefined };
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
    if (parsed.kind === "vups") return { kind: "vups", model: VUPS_MODEL_ID };
    if (parsed.kind === "gateway" && typeof parsed.model === "string" && parsed.model) {
      return {
        kind: "gateway",
        source: typeof parsed.source === "string" && parsed.source ? parsed.source : OMNIROUTE_SOURCE,
        model: parsed.model
      };
    }
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
      selection.kind === "vups"
        ? { kind: "vups", model: VUPS_MODEL_ID }
        : selection.kind === "gateway"
          ? { kind: "gateway", source: selection.source || OMNIROUTE_SOURCE, model: selection.model }
          : selection.kind === "saved"
            ? { kind: "saved", configId: selection.configId || "", model: selection.model }
            : { kind: "shared", model: selection.model };
    storage.setItem(MODEL_SELECTION_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    /* storage is best-effort: private mode or quota errors must not break chat */
  }
}
