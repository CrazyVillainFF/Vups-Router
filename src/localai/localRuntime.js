import { NATIVE_SHELLS, normalizeNativeShell } from "../native/shell.js";

/**
 * Local AI runtime access.
 *
 * The Windows app talks to the local runtime that is actually installed on the
 * machine: Ollama's own HTTP API, on its own port. Nothing here pretends a
 * model is installed — every installed model in this file came back from the
 * runtime itself, and a runtime that cannot be reached is reported as such.
 */

export const LOCAL_AI_BASE_URL = "http://127.0.0.1:11434";
export const LOCAL_AI_STATES = Object.freeze({
  ready: "ready",
  unavailable: "unavailable",
  unsupported: "unsupported"
});

const TAGS_TIMEOUT_MS = 4000;
const PULL_TIMEOUT_MS = 30 * 60 * 1000;

function runtimeBaseUrl() {
  const configured = (import.meta.env?.VITE_LOCAL_AI_URL || "").trim();
  return (configured || LOCAL_AI_BASE_URL).replace(/\/+$/, "");
}

async function readJson(url, options = {}) {
  const { request, ...rest } = options;
  const response = await (request || fetch)(url, rest);
  if (!response.ok) throw new Error(`The local runtime answered ${response.status}.`);
  return response.json();
}

/**
 * Which local runtime, if any, this shell can use.
 *
 * Android has no local inference runtime in the app yet, and the browser build
 * has no native side at all, so both are reported as unsupported instead of
 * pretending that every model is missing.
 */
export function localRuntimeKind(shell) {
  const normalized = normalizeNativeShell(shell);
  if (normalized === NATIVE_SHELLS.windows) return "ollama";
  if (normalized === NATIVE_SHELLS.android) return null;
  return null;
}

export function localAiSupported(shell) {
  return normalizeNativeShell(shell) === NATIVE_SHELLS.windows;
}

function capabilityFor(model) {
  const capabilities = Array.isArray(model?.capabilities) ? model.capabilities.map(String) : [];
  const family = String(model?.details?.family || model?.family || "").toLowerCase();
  const name = String(model?.name || model?.model || "").toLowerCase();
  const parameterSize = String(model?.details?.parameter_size || "").toLowerCase();
  if (capabilities.includes("vision") || /vl|vision|llava/.test(name)) return "Vision";
  if (capabilities.includes("thinking") || /r1|think/.test(name)) return "Reasoning";
  if (/coder|code|starcoder/.test(family) || /coder|code/.test(name)) return "Code";
  const billions = Number.parseFloat(parameterSize);
  if (Number.isFinite(billions) && billions > 0 && billions <= 1) return "Fast";
  return "Chat";
}

/**
 * The capability flags a recommendation can rely on.
 *
 * The runtime's own capability list is used first. Family and name fallbacks
 * only cover what the publisher states for the model (a vision projector or a
 * code-tuned family); nothing is invented from a marketing word.
 */
export function modelCapabilities(model) {
  const reported = Array.isArray(model?.capabilities) ? model.capabilities.map(value => String(value).toLowerCase()) : [];
  const name = String(model?.name || model?.model || "").toLowerCase();
  const family = String(model?.details?.family || model?.family || "").toLowerCase();
  const flags = new Set(["chat"]);
  if (reported.includes("vision") || /vl|vision|llava|mllama/.test(name)) flags.add("vision");
  if (reported.includes("thinking")) flags.add("thinking");
  if (/coder|code|starcoder/.test(name) || /coder|code|starcoder/.test(family)) flags.add("coding");
  if (reported.includes("thinking") || /r1|qwq/.test(name)) flags.add("reasoning");
  return [...flags];
}

export function formatModelSize(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return "";
  const gb = value / (1024 * 1024 * 1024);
  if (gb >= 1024) return `${(gb / 1024).toFixed(1)} TB`;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = value / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${Math.round(mb)} MB`;
}

/**
 * A model the runtime reports as installed.
 *
 * `name` is exactly what the runtime calls it, so a model installed from a
 * terminal appears here under the same name it has everywhere else.
 */
export function installedModel(model) {
  const name = String(model?.name || model?.model || "").trim();
  if (!name) return null;
  return {
    id: name,
    name,
    size: formatModelSize(model?.size),
    bytes: Number(model?.size) || 0,
    capability: capabilityFor(model),
    capabilities: modelCapabilities(model),
    parameterSize: String(model?.details?.parameter_size || ""),
    quantization: String(model?.details?.quantization_level || ""),
    contextLength: Number(model?.details?.context_length) || 0,
    family: String(model?.details?.family || ""),
    digest: String(model?.digest || "")
  };
}

/**
 * What the local runtime can do right now.
 *
 * `ready` means the runtime answered and its models are known. `unavailable`
 * means the runtime is not running or not installed. `unsupported` means this
 * build has no local runtime at all.
 */
export async function detectLocalRuntime(shell, { fetchImpl = fetch } = {}) {
  if (!localAiSupported(shell)) {
    return {
      state: LOCAL_AI_STATES.unsupported,
      runtime: null,
      models: [],
      reason:
        normalizeNativeShell(shell) === NATIVE_SHELLS.android
          ? "On-device AI is not available in the Android app yet."
          : "Local AI is available in the Windows and Android apps."
    };
  }
  const base = runtimeBaseUrl();
  const request = fetchImpl || fetch;
  try {
    const payload = await readJson(`${base}/api/tags`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(TAGS_TIMEOUT_MS),
      request
    });
    const models = (Array.isArray(payload?.models) ? payload.models : [])
      .map(installedModel)
      .filter(Boolean);
    return { state: LOCAL_AI_STATES.ready, runtime: "ollama", models, baseUrl: base, reason: "" };
  } catch {
    return {
      state: LOCAL_AI_STATES.unavailable,
      runtime: "ollama",
      models: [],
      baseUrl: base,
      reason: "The local AI runtime is not running on this computer."
    };
  }
}

/**
 * Download a model, reporting the runtime's own progress.
 *
 * The runtime streams one line per step, so the progress shown is the
 * runtime's progress and not an estimate.
 */
export async function pullLocalModel(name, { onProgress, signal } = {}) {
  const base = runtimeBaseUrl();
  const response = await fetch(`${base}/api/pull`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, stream: true }),
    signal
  });
  if (!response.ok || !response.body) {
    throw new Error(`The local runtime could not start the download (${response.status}).`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let last = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const text = line.trim();
      if (!text) continue;
      let event;
      try {
        event = JSON.parse(text);
      } catch {
        continue;
      }
      if (event.error) throw new Error(String(event.error));
      last = event;
      if (typeof onProgress === "function") onProgress(event);
    }
  }
  return last;
}

/** Remove a model from the runtime. */
export async function removeLocalModel(name) {
  const base = runtimeBaseUrl();
  const response = await fetch(`${base}/api/delete`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name })
  });
  if (!response.ok) throw new Error(`The local runtime could not remove the model (${response.status}).`);
  return true;
}

function toolUnsupportedError() {
  const error = new Error("This model does not support tool calls.");
  error.code = "tool_calling_unsupported";
  return error;
}

async function streamChat(name, { messages, tools, onChunk, signal, request } = {}) {
  const base = runtimeBaseUrl();
  const body = {
    model: name,
    messages: Array.isArray(messages) ? messages : [],
    stream: true
  };
  if (Array.isArray(tools) && tools.length) body.tools = tools;
  const response = await (request || fetch)(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal
  });
  if (!response.ok) {
    let detail = "";
    try {
      detail = await response.text();
    } catch {
      detail = "";
    }
    if (response.status === 400 && /does not support tools|tools are not supported|tool calling/i.test(detail)) {
      throw toolUnsupportedError();
    }
    throw new Error(`The local runtime could not answer (${response.status}).`);
  }
  if (!response.body) throw new Error(`The local runtime could not answer (${response.status}).`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  const toolCalls = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const text = line.trim();
      if (!text) continue;
      let event;
      try {
        event = JSON.parse(text);
      } catch {
        continue;
      }
      if (event.error) {
        const message = String(event.error);
        if (/does not support tools|tools are not supported|tool calling/i.test(message)) throw toolUnsupportedError();
        throw new Error(message);
      }
      const piece = event?.message?.content;
      if (typeof piece === "string" && piece) {
        content += piece;
        if (typeof onChunk === "function") onChunk(piece);
      }
      if (Array.isArray(event?.message?.tool_calls)) toolCalls.push(...event.message.tool_calls);
    }
  }
  return { content, toolCalls };
}

/**
 * Ask the local runtime for an answer.
 *
 * The answer arrives the way the runtime produces it: in pieces, so the chat
 * shows the reply as it is written.
 */
export async function chatLocalModel(name, options = {}) {
  const { content } = await streamChat(name, options);
  return content;
}

/**
 * One tool-aware turn. The runtime returns text and, when the model supports
 * them, structured tool calls. A runtime that rejects the `tools` field is
 * reported as `tool_calling_unsupported` so the caller can route the request
 * itself instead of pretending the model cannot answer.
 */
export async function chatLocalModelTurn(name, options = {}) {
  return streamChat(name, options);
}
