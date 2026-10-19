/**
 * VupsRouter chat service.
 *
 * All model traffic goes through the VupsRouter backend proxy at
 * POST /api/chat. The backend resolves the signed-in user's saved provider
 * (base URL + encrypted API key), performs the upstream request, streams the
 * reply back as SSE, and persists the conversation.
 *
 * The client never sees or stores the provider API key.
 */

import { apiClient } from "./api.js";
import { toPayloadImages } from "../chat/attachments.js";

export class ChatConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ChatConfigError";
  }
}

export class ChatNetworkError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "ChatNetworkError";
    this.status = status;
  }
}

function chatEndpoint() {
  const base = apiClient.defaults.baseURL;
  if (!base) {
    throw new ChatConfigError("Set VITE_API_BASE_URL to your deployed backend API URL to enable chat.");
  }
  return `${base}/chat`;
}

// Exported for tests. Images are only ever attached to the final message —
// the backend rejects attachments on earlier messages by design.
export function toRequestMessages(messages) {
  const filtered = messages.filter(message => message.role === "user" || message.role === "assistant");
  return filtered.map((message, index) => {
    const entry = { role: message.role, content: String(message.content ?? "") };
    if (index === filtered.length - 1 && Array.isArray(message.images) && message.images.length > 0) {
      const images = toPayloadImages(message.images);
      if (images.length > 0) entry.images = images;
    }
    return entry;
  });
}

/**
 * Streams a chat response through the backend proxy.
 *
 * @param {object} options
 * @param {string|null} options.conversationId Existing conversation id, or null for a new one.
 * @param {Array<{role: string, content: string}>} options.messages Full conversation history, ending with the new user message.
 * @param {string} [options.model] Model id to use. The backend falls back to the saved model only when omitted.
 * @param {string} [options.configId] Stable saved configuration id. Omit for the shared/free model.
 * @param {string} [options.source] Server-configured gateway source (for example "omniroute"). Never a URL.
 * @param {number} [options.temperature]
 * @param {AbortSignal} [options.signal]
 * @param {(payload: {conversationId: string}) => void} [options.onMeta] Called once with the conversation id.
 * @param {(chunk: string) => void} [options.onChunk] Called with each streamed text chunk.
 * @param {(step: string) => void} [options.onStep] Called with progress steps.
 * @returns {Promise<{content: string, conversationId: string|null, finishReason: string|null}>}
 */
export async function streamChatResponse({ conversationId, messages, model, configId, source, temperature, signal, onMeta, onChunk, onStep } = {}) {
  const body = {
    conversationId: conversationId || undefined,
    messages: toRequestMessages(messages),
    model: model || undefined,
    stream: true
  };
  if (configId) body.configId = configId;
  if (source) body.source = source;
  if (typeof temperature === "number") body.temperature = temperature;

  onStep?.("Sending request");

  let response;
  try {
    response = await fetch(chatEndpoint(), {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify(body),
      signal
    });
  } catch (error) {
    if (error.name === "AbortError") throw error;
    throw new ChatNetworkError("Could not reach the VupsRouter backend. Check your connection and try again.", null);
  }

  if (!response.ok) {
    let message = `Chat request failed (HTTP ${response.status}).`;
    try {
      const data = await response.json();
      if (typeof data?.message === "string") message = data.message;
    } catch {
      /* non-JSON error body */
    }
    throw new ChatNetworkError(message, response.status);
  }

  if (!response.body) {
    throw new ChatNetworkError("The backend returned no response stream.", null);
  }

  onStep?.("Waiting for model");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullText = "";
  let resolvedConversationId = conversationId || null;
  let streamError = null;
  let finishReason = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const raw = trimmed.slice(5).trim();
        if (!raw) continue;
        let event;
        try {
          event = JSON.parse(raw);
        } catch {
          continue;
        }
        if (event.type === "meta") {
          if (event.conversationId) {
            resolvedConversationId = event.conversationId;
            onMeta?.({ conversationId: event.conversationId });
          }
        } else if (event.type === "delta") {
          if (event.content) {
            if (!fullText) onStep?.("Receiving response");
            fullText += event.content;
            onChunk?.(event.content);
          }
        } else if (event.type === "done") {
          if (event.conversationId) resolvedConversationId = event.conversationId;
          if (typeof event.finishReason === "string" && event.finishReason) {
            finishReason = event.finishReason;
          }
          onStep?.("Response complete");
        } else if (event.type === "error") {
          streamError = event.message || "The provider reported an error.";
        }
      }
    }
  } catch (error) {
    if (error.name === "AbortError" || signal?.aborted) throw error;
    throw new ChatNetworkError("The response stream was interrupted. Please try again.", null);
  }

  if (streamError) throw new ChatNetworkError(streamError, null);
  if (!fullText.trim()) throw new ChatNetworkError("The provider returned an empty response. Check the model ID in Settings.", null);

  return { content: fullText, conversationId: resolvedConversationId, finishReason };
}
