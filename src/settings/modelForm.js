export const MAX_SAVED_MODELS = 500;
export const MAX_MODEL_ID_LENGTH = 200;

// A model is only unique together with the configuration it belongs to: two
// saved keys can expose the same ID, and chat must route each one separately.
export function modelIdentity(config, modelId) {
  const scope = config?.configId || config?.providerId || config?.provider || "provider";
  return `${scope}:${modelId}`;
}

export function uniqueModelIds(entries) {
  const models = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const id = typeof entry === "string" ? entry.trim() : "";
    if (!id || id.length > MAX_MODEL_ID_LENGTH) continue;
    if (!models.includes(id)) models.push(id);
  }
  return models.slice(0, MAX_SAVED_MODELS);
}

// Older rows stored a single `model` before a catalogue existed. Treat it as a
// one-model catalogue so the settings UI never reports "no saved models" for a
// configuration that chat can still use.
export function savedModelIds(config) {
  const list = uniqueModelIds(config?.models);
  if (list.length > 0) return list;
  const single = String(config?.defaultModel || config?.model || "").trim();
  return single ? [single] : [];
}

// The key is only sent when the user typed a new one; an empty field means
// "keep what is stored", never "erase it". The same rule applies to the model
// list: an empty selection is omitted so discovery cannot be overwritten.
export function buildProviderSavePayload({ form, providerId, selectedModels = [], defaultModel = "" }) {
  const models = uniqueModelIds(selectedModels);
  const payload = {
    provider: String(form?.provider || "").trim(),
    providerId,
    baseUrl: String(form?.baseUrl || "").trim(),
    apiKey: String(form?.apiKey || "").trim(),
    model: String(form?.model || "").trim(),
    providerType: form?.providerType || "openai_compatible"
  };
  if (models.length > 0) {
    const wanted = String(defaultModel || "").trim();
    payload.models = models;
    payload.defaultModel = models.includes(wanted) ? wanted : models[0];
  }
  if (payload.providerType === "qoder_cloud_agents") {
    payload.authMode = form?.authMode || "pat";
    payload.openapiBaseUrl = String(form?.openapiBaseUrl || "").trim();
  }
  return payload;
}
