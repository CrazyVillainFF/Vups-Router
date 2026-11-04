import { providerArtwork, providerArtworkById } from "./comboArtwork.js";
import { statusFor } from "./comboSelection.js";

// Registry provider IDs are canonical. Aggregators and direct providers are
// deduplicated by this identity, while custom endpoints stay scoped to their
// configuration so unrelated accounts are never merged into one node.
const PROVIDER_ID_ALIASES = {
  openrouter: "openrouter",
  "kilo-gateway": "kilo",
  litellm: "litellm",
  omniroute: "omniroute",
  portkey: "portkey",
  "vercel-ai-gateway": "vercel",
  requesty: "requesty",
  agentrouter: "agentrouter",
  "opencode-zen": "opencode",
  qoder: "qoder",
  openai: "openai",
  deepseek: "deepseek",
  groq: "groq",
  "google-gemini": "googlegemini",
  anthropic: "anthropic",
  mistral: "mistralai",
  cohere: "cohere",
  together: "together",
  fireworks: "fireworks",
  cerebras: "cerebras",
  "nvidia-nim": "nvidia",
  xai: "xai",
  sambanova: "sambanova",
  novita: "novita",
  huggingface: "huggingface",
  "cloudflare-workers-ai": "cloudflare",
  "amazon-bedrock": "amazon",
  "azure-ai-foundry": "microsoft",
  "ibm-watsonx": "ibm",
  ai21: "ai21",
  flagshiprouter: "flagshiprouter",
  ollama: "ollama",
  vllm: "vllm",
  localai: "localai",
  lmstudio: "lmstudio"
};

const CUSTOM_PROVIDER_ID = /^custom-/;

// These providers host models from many vendors. The network shows the model's
// vendor identity so the orbit reflects the real AI providers, while direct
// provider connections keep their own brand.
const VENDOR_INFERENCE_PROVIDERS = new Set([
  "openrouter",
  "kilo",
  "litellm",
  "omniroute",
  "portkey",
  "vercel",
  "requesty",
  "agentrouter",
  "opencode",
  "flagshiprouter",
  "cloudflare",
  "novita",
  "huggingface",
  "ollama"
]);

function slugify(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function vendorArtworkFor(model) {
  if (!model?.model) return null;
  const art = providerArtwork({ model: model.model });
  if (!art || art.id === "fallback" || art.id === "vups") return null;
  return art;
}

function vendorIdentity(model) {
  const art = vendorArtworkFor(model);
  if (!art) return null;
  return { id: `provider:${art.id}`, canonicalId: art.id, name: art.name, artwork: art };
}

export function resolveProviderIdentity(model) {
  if (!model || typeof model !== "object") return null;
  const providerId = String(model.providerId || "").trim().toLowerCase();
  const configId = String(model.configId || "").trim();

  if (model.kind === "vups") {
    const art = providerArtworkById("vups") || providerArtwork(model);
    return { id: "provider:vups", canonicalId: "vups", name: art.name, artwork: art };
  }

  const alias = PROVIDER_ID_ALIASES[providerId];
  if (alias) {
    if (VENDOR_INFERENCE_PROVIDERS.has(alias)) {
      const vendor = vendorIdentity(model);
      if (vendor) return vendor;
    }
    const art = providerArtworkById(alias) || providerArtwork(model);
    return { id: `provider:${alias}`, canonicalId: alias, name: art.name, artwork: art };
  }

  if (providerId) {
    const art = CUSTOM_PROVIDER_ID.test(providerId)
      ? providerArtwork(model)
      : providerArtwork({ provider: model.provider });
    return {
      id: `config:${configId || providerId}`,
      canonicalId: null,
      name: art.name,
      artwork: art
    };
  }

  const byName = providerArtwork({ provider: model.provider });
  if (byName.id !== "fallback") {
    if (VENDOR_INFERENCE_PROVIDERS.has(byName.id)) {
      const vendor = vendorIdentity(model);
      if (vendor) return vendor;
    }
    return { id: `provider:${byName.id}`, canonicalId: byName.id, name: byName.name, artwork: byName };
  }
  return {
    id: `shared:${slugify(model.provider) || "provider"}`,
    canonicalId: null,
    name: byName.name,
    artwork: byName
  };
}

export function buildProviderNetwork(models) {
  const list = Array.isArray(models) ? models : [];
  const network = new Map();
  for (const model of list) {
    const identity = resolveProviderIdentity(model);
    if (!identity) continue;
    let provider = network.get(identity.id);
    if (!provider) {
      provider = {
        id: identity.id,
        canonicalId: identity.canonicalId,
        name: identity.name,
        artwork: identity.artwork,
        models: [],
        keys: []
      };
      network.set(identity.id, provider);
    }
    provider.models.push(model);
    if (model.key) provider.keys.push(model.key);
  }
  return [...network.values()];
}

export function providerStatusFor(provider, availability) {
  const keys = Array.isArray(provider?.keys) ? provider.keys : [];
  if (keys.length === 0) return "unknown";
  let working = false;
  let unknown = false;
  for (const key of keys) {
    const status = statusFor(availability, key);
    if (status === "working") working = true;
    else if (status === "unknown") unknown = true;
  }
  if (working) return "working";
  return unknown ? "unknown" : "not_working";
}

export function providerActivityFor(provider, activity) {
  if (!(activity instanceof Map) || activity.size === 0) return null;
  const keys = Array.isArray(provider?.keys) ? provider.keys : [];
  let queued = false;
  let done = false;
  let failed = false;
  for (const key of keys) {
    const state = activity.get(key);
    if (state === "working") return "working";
    if (state === "queued") queued = true;
    else if (state === "done") done = true;
    else if (state === "failed") failed = true;
  }
  if (queued) return "queued";
  if (done) return "done";
  if (failed) return "failed";
  return null;
}

export function providerSummaryFor(providers, availability) {
  const list = Array.isArray(providers) ? providers : [];
  const summary = { total: list.length, working: 0, notWorking: 0, unknown: 0 };
  for (const provider of list) {
    const status = providerStatusFor(provider, availability);
    if (status === "working") summary.working += 1;
    else if (status === "not_working") summary.notWorking += 1;
    else summary.unknown += 1;
  }
  return summary;
}
