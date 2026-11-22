/**
 * The local model library.
 *
 * Every entry is a model the local runtime can actually install, named exactly
 * as the runtime names it, and every name in this file resolves on the public
 * Ollama registry. Capability flags describe what the publisher's model can do;
 * they are re-checked against the runtime once the model is installed, because
 * the runtime is the only authority on what a model on this machine supports.
 *
 * Download sizes are not written down here: they are read from the runtime's
 * own registry, so a size shown in the UI is a real size and a model whose size
 * cannot be read simply shows none.
 */

import { formatModelSize } from "./localRuntime.js";

export const LOCAL_MODELS_GROUP = "LOCAL MODELS";
const REGISTRY_ORIGIN = "https://registry.ollama.ai";
const GIGABYTE = 1024 * 1024 * 1024;

/** The capabilities a recommendation category can be built on. */
export const MODEL_CAPABILITIES = Object.freeze(["chat", "coding", "vision", "thinking", "reasoning"]);

// [name, family, parameters in billions, capability flags]
// Names and tags were verified against registry.ollama.ai; a tag that did not
// resolve is not in this list.
const LIBRARY_TUPLES = [
  ["llama3.2:1b", "llama", 1.2, ["chat"]],
  ["llama3.2:3b", "llama", 3.2, ["chat"]],
  ["llama3.1:8b", "llama", 8, ["chat"]],
  ["llama3.3:70b", "llama", 70, ["chat"]],
  ["gemma2:2b", "gemma2", 2.6, ["chat"]],
  ["gemma2:9b", "gemma2", 9.2, ["chat"]],
  ["gemma2:27b", "gemma2", 27, ["chat"]],
  ["gemma3:1b", "gemma3", 1, ["chat"]],
  ["gemma3:4b", "gemma3", 4.3, ["chat", "vision"]],
  ["gemma3:12b", "gemma3", 12.2, ["chat", "vision"]],
  ["gemma3:27b", "gemma3", 27.4, ["chat", "vision"]],
  ["mistral:7b", "llama", 7.2, ["chat"]],
  ["phi3.5:3.8b", "phi3", 3.8, ["chat"]],
  ["phi4:14b", "phi4", 14.7, ["chat", "reasoning"]],
  ["phi4-mini:3.8b", "phi4", 3.8, ["chat"]],
  ["qwen2.5:0.5b", "qwen2", 0.5, ["chat"]],
  ["qwen2.5:1.5b", "qwen2", 1.5, ["chat"]],
  ["qwen2.5:3b", "qwen2", 3.1, ["chat"]],
  ["qwen2.5:7b", "qwen2", 7.6, ["chat"]],
  ["qwen2.5:14b", "qwen2", 14.7, ["chat"]],
  ["qwen2.5:32b", "qwen2", 32.8, ["chat"]],
  ["qwen2.5:72b", "qwen2", 72.7, ["chat"]],
  ["qwen3:0.6b", "qwen3", 0.6, ["chat", "thinking"]],
  ["qwen3:1.7b", "qwen3", 2, ["chat", "thinking"]],
  ["qwen3:4b", "qwen3", 4, ["chat", "thinking"]],
  ["qwen3:8b", "qwen3", 8.2, ["chat", "thinking"]],
  ["qwen3:14b", "qwen3", 14.8, ["chat", "thinking"]],
  ["qwen3:32b", "qwen3", 32.8, ["chat", "thinking"]],
  ["qwen2.5-coder:0.5b", "qwen2", 0.5, ["chat", "coding"]],
  ["qwen2.5-coder:1.5b", "qwen2", 1.5, ["chat", "coding"]],
  ["qwen2.5-coder:3b", "qwen2", 3.1, ["chat", "coding"]],
  ["qwen2.5-coder:7b", "qwen2", 7.6, ["chat", "coding"]],
  ["qwen2.5-coder:14b", "qwen2", 14.7, ["chat", "coding"]],
  ["qwen2.5-coder:32b", "qwen2", 32.8, ["chat", "coding"]],
  ["qwen3-coder:30b", "qwen3moe", 30.5, ["chat", "coding"]],
  ["codellama:7b", "llama", 7, ["chat", "coding"]],
  ["codellama:13b", "llama", 13, ["chat", "coding"]],
  ["codellama:34b", "llama", 34, ["chat", "coding"]],
  ["starcoder2:3b", "starcoder2", 3, ["chat", "coding"]],
  ["starcoder2:7b", "starcoder2", 7, ["chat", "coding"]],
  ["starcoder2:15b", "starcoder2", 15, ["chat", "coding"]],
  ["deepseek-coder-v2:16b", "deepseek2", 15.7, ["chat", "coding"]],
  ["qwen2.5vl:3b", "qwen2vl", 3.8, ["chat", "vision"]],
  ["qwen2.5vl:7b", "qwen2vl", 8.3, ["chat", "vision"]],
  ["qwen2.5vl:32b", "qwen2vl", 33, ["chat", "vision"]],
  ["qwen2.5vl:72b", "qwen2vl", 73, ["chat", "vision"]],
  ["llava:7b", "llama", 7, ["chat", "vision"]],
  ["llava:13b", "llama", 13, ["chat", "vision"]],
  ["llava:34b", "llama", 34, ["chat", "vision"]],
  ["llava-llama3:8b", "llama", 8, ["chat", "vision"]],
  ["moondream:1.8b", "phi2", 1.8, ["chat", "vision"]],
  ["llama3.2-vision:11b", "mllama", 10.7, ["chat", "vision"]],
  ["llama3.2-vision:90b", "mllama", 90, ["chat", "vision"]],
  ["deepseek-r1:1.5b", "qwen2", 1.5, ["chat", "reasoning"]],
  ["deepseek-r1:7b", "qwen2", 7.6, ["chat", "reasoning"]],
  ["deepseek-r1:8b", "llama", 8, ["chat", "reasoning"]],
  ["deepseek-r1:14b", "qwen2", 14.8, ["chat", "reasoning"]],
  ["deepseek-r1:32b", "qwen2", 32.8, ["chat", "reasoning"]],
  ["qwq:32b", "qwq", 32.8, ["chat", "reasoning"]]
];

export const LOCAL_MODEL_LIBRARY = Object.freeze(
  LIBRARY_TUPLES.map(([name, family, params, capabilities]) =>
    Object.freeze({ name, family, params, capabilities: Object.freeze(capabilities) })
  )
);

/**
 * The legacy one-word capability, derived from verified facts only. The page
 * uses the full capability list; this label stays for the compact picker rows.
 */
export function libraryCapability(entry) {
  const capabilities = Array.isArray(entry?.capabilities) ? entry.capabilities : [];
  const name = String(entry?.name || "").toLowerCase();
  const family = String(entry?.family || "").toLowerCase();
  if (capabilities.includes("vision") || /vl|vision/.test(name)) return "Vision";
  if (capabilities.includes("thinking") || /r1|think/.test(name)) return "Reasoning";
  if (capabilities.includes("coding") || /coder|code/.test(name) || /coder|code/.test(family)) return "Code";
  const billions = Number(entry?.params);
  if (Number.isFinite(billions) && billions > 0 && billions <= 1) return "Fast";
  return "Chat";
}

function parseModel(name) {
  const text = String(name || "").trim();
  if (!text) return null;
  const [library, tag = "latest"] = text.split(":");
  if (!library) return null;
  return { library, tag };
}

/**
 * The download size of a model, read from the runtime's registry.
 *
 * All manifest layers are counted — weights and, for vision models, the
 * projector — so the number matches what a pull has to transfer. Without a
 * network there is no size to show, and the entry simply carries none.
 */
export async function fetchRegistrySizeBytes(name, { fetchImpl = fetch, signal } = {}) {
  const parsed = parseModel(name);
  if (!parsed) return 0;
  const response = await fetchImpl(
    `${REGISTRY_ORIGIN}/v2/library/${encodeURIComponent(parsed.library)}/manifests/${encodeURIComponent(parsed.tag)}`,
    { headers: { Accept: "application/vnd.docker.distribution.manifest.v2+json" }, signal }
  );
  if (!response.ok) return 0;
  const manifest = await response.json();
  const layers = Array.isArray(manifest?.layers) ? manifest.layers : [];
  return layers.reduce((total, layer) => total + (Number(layer?.size) || 0), 0);
}

export async function fetchRegistrySize(name, { fetchImpl = fetch, signal } = {}) {
  try {
    const bytes = await fetchRegistrySizeBytes(name, { fetchImpl, signal });
    return bytes > 0 ? formatModelSize(bytes) : "";
  } catch {
    return "";
  }
}

/** An estimate used only until the registry reports the real weights size. */
export function estimatedWeightsBytes(entry) {
  const params = Number(entry?.params);
  if (!Number.isFinite(params) || params <= 0) return 0;
  // Q4_K_M weights land near 0.65 GB per billion parameters.
  return Math.round(params * 0.65 * GIGABYTE);
}

export function libraryEntry(name) {
  const key = String(name || "").trim().toLowerCase();
  return LOCAL_MODEL_LIBRARY.find(entry => entry.name.toLowerCase() === key) || null;
}

/**
 * The library and the installed models as one list.
 *
 * A model that is already installed appears once, with the runtime's own size,
 * and no entry is offered twice. `sizes` carries registry download sizes in
 * bytes, keyed by lower-case model name.
 */
export function buildLibraryRows({ library = LOCAL_MODEL_LIBRARY, installed = [], sizes = {}, installedSizes = {} } = {}) {
  const installedByName = new Map(installed.map(model => [String(model.name || "").toLowerCase(), model]));
  const rows = [];
  const seen = new Set();
  for (const entry of library) {
    const name = String(entry.name || "").trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const model = installedByName.get(key);
    const downloadBytes = Number(sizes[key]) || 0;
    const installedBytes = Number(model?.bytes) || Number(installedSizes[key]) || 0;
    rows.push({
      name,
      family: entry.family || "",
      params: Number(entry.params) || 0,
      capabilities: Array.isArray(entry.capabilities) ? [...entry.capabilities] : ["chat"],
      capabilitySource: model ? "runtime" : "catalogue",
      capability: model?.capability || libraryCapability(entry),
      downloadBytes,
      downloadSize: downloadBytes > 0 ? formatModelSize(downloadBytes) : "",
      installedBytes,
      installedSize: model?.size || (installedBytes > 0 ? formatModelSize(installedBytes) : ""),
      installed: Boolean(model),
      runtimeName: model?.name || name
    });
  }
  // A model the runtime has that the library does not offer is still the user's
  // model: it is listed as installed rather than hidden.
  for (const model of installed) {
    const key = String(model?.name || "").toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const entry = libraryEntry(model.name);
    rows.push({
      name: model.name,
      family: model.family || entry?.family || "",
      params: Number(entry?.params) || 0,
      capabilities: Array.isArray(model.capabilities) && model.capabilities.length
        ? [...model.capabilities]
        : entry?.capabilities
          ? [...entry.capabilities]
          : ["chat"],
      capabilitySource: "runtime",
      capability: model.capability || "Chat",
      downloadBytes: Number(sizes[key]) || 0,
      downloadSize: sizes[key] ? formatModelSize(Number(sizes[key])) : "",
      installedBytes: Number(model.bytes) || 0,
      installedSize: model.size || "",
      installed: true,
      runtimeName: model.name
    });
  }
  return rows;
}
