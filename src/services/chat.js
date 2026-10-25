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
  constructor(message, status, {
    code = null,
    requestId = null,
    partialContent = "",
    diagnostic = null,
    model = null,
    resetAt = null,
    retryAfterSeconds = null,
    resetSource = null,
    conversationId = null,
    messageId = null,
    artifact = null,
    artifacts = [],
    continuedFile = null
  } = {}) {
    super(message);
    this.name = "ChatNetworkError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.partialContent = partialContent;
    this.diagnostic = diagnostic;
    this.model = model;
    this.resetAt = resetAt;
    this.retryAfterSeconds = retryAfterSeconds;
    this.resetSource = resetSource;
    this.conversationId = conversationId;
    this.messageId = messageId;
    this.artifact = artifact;
    this.artifacts = Array.isArray(artifacts) ? artifacts : [];
    this.continuedFile = continuedFile;
  }
}

function chatEndpoint(vups = false) {
  const base = apiClient.defaults.baseURL;
  if (!base) {
    throw new ChatConfigError("Set VITE_API_BASE_URL to your deployed backend API URL to enable chat.");
  }
  return `${base}/chat${vups ? "/vups-v3-galax" : ""}`;
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
 * @param {boolean} [options.vups] Route to the first-party Vups v3 Galax endpoint.
 * @param {"general"|"motion"} [options.mode] Assistant behavior mode. Defaults to general.
 * @param {number} [options.temperature]
 * @param {AbortSignal} [options.signal]
 * @param {(payload: {conversationId: string}) => void} [options.onMeta] Called once with the conversation id.
 * @param {(chunk: string) => void} [options.onChunk] Called with each streamed text chunk.
 * @param {(step: string) => void} [options.onStep] Called with truthful progress steps.
 * @param {string} [options.assistantMessageId] Stable client id for the assistant turn.
 * @param {{messageId: string, targetFile?: string}} [options.continuation] Continue an incomplete saved response.
 * @returns {Promise<{content: string, conversationId: string|null, messageId: string|null, finishReason: string|null, artifact: object|null, artifacts: object[], continuedFile: object|null}>}
 */
export async function streamChatResponse({ conversationId, messages, model, configId, providerId, source, vups, mode, temperature, signal, onMeta, onChunk, onStep, assistantMessageId, continuation } = {}) {
  const body = {
    conversationId: conversationId || undefined,
    messages: toRequestMessages(messages),
    model: model || undefined,
    stream: true
  };
  if (configId) body.configId = configId;
  if (providerId) body.providerId = providerId;
  if (source) body.source = source;
  if (assistantMessageId) body.assistantMessageId = assistantMessageId;
  if (continuation?.messageId) body.continuation = continuation;
  if (mode === "motion" || mode === "general") body.mode = mode;
  if (typeof temperature === "number") body.temperature = temperature;

  onStep?.("Sending request");

  let response;
  try {
    response = await fetch(chatEndpoint(vups === true), {
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

  const responseRequestId = response.headers.get("x-request-id");

  if (!response.ok) {
    let message = `Chat request failed (HTTP ${response.status}).`;
    let code = null;
    let requestId = responseRequestId;
    let diagnostic = null;
    let model = null;
    let resetAt = null;
    let retryAfterSeconds = null;
    let resetSource = null;
    try {
      const data = await response.json();
      if (typeof data?.message === "string") message = data.message;
      if (typeof data?.code === "string") code = data.code;
      if (typeof data?.requestId === "string") requestId = data.requestId;
      if (data?.diagnostic && typeof data.diagnostic === "object") diagnostic = data.diagnostic;
      if (typeof data?.model === "string") model = data.model;
      if (typeof data?.resetAt === "string") resetAt = data.resetAt;
      if (Number.isFinite(data?.retryAfterSeconds)) retryAfterSeconds = data.retryAfterSeconds;
      if (typeof data?.resetSource === "string") resetSource = data.resetSource;
    } catch {
      /* non-JSON error body */
    }
    throw new ChatNetworkError(message, response.status, { code, requestId, diagnostic, model, resetAt, retryAfterSeconds, resetSource });
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
  let resolvedMessageId = assistantMessageId || continuation?.messageId || null;
  let savedMessage = null;
  let artifact = null;
  let artifacts = [];
  let continuedFile = null;
  let streamError = null;
  let finishReason = null;
  let sawDone = false;

  const handleLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(":") || !trimmed.startsWith("data:")) return;
    const raw = trimmed.slice(5).trim();
    if (!raw) return;
    let event;
    try {
      event = JSON.parse(raw);
    } catch {
      return;
    }
    if (event.type === "meta") {
      if (event.conversationId) {
        resolvedConversationId = event.conversationId;
        onMeta?.({
          conversationId: event.conversationId,
          ...(event.messageId ? { messageId: event.messageId } : {})
        });
      }
      if (event.messageId) resolvedMessageId = event.messageId;
      return;
    }
    if (streamError) return;
    if (event.type === "progress") {
      if (typeof event.message === "string" && event.message.trim()) onStep?.(event.message.trim());
      return;
    }
    if (event.type === "delta") {
      if (event.content) {
        if (!fullText) onStep?.("Receiving response");
        fullText += event.content;
        onChunk?.(event.content);
      }
      return;
    }
    if (event.type === "done") {
      sawDone = true;
      if (event.conversationId) resolvedConversationId = event.conversationId;
      if (event.messageId) resolvedMessageId = event.messageId;
      if (event.message?.content) savedMessage = event.message;
      if (event.artifact) artifact = event.artifact;
      if (Array.isArray(event.artifacts)) artifacts = event.artifacts;
      if (event.continuedFile) continuedFile = event.continuedFile;
      if (typeof event.finishReason === "string" && event.finishReason) {
        finishReason = event.finishReason;
      }
      onStep?.("Response complete");
      return;
    }
    if (event.type === "error") {
      if (event.conversationId) resolvedConversationId = event.conversationId;
      if (event.messageId) resolvedMessageId = event.messageId;
      if (event.artifact) artifact = event.artifact;
      if (Array.isArray(event.artifacts)) artifacts = event.artifacts;
      if (event.continuedFile) continuedFile = event.continuedFile;
      streamError = {
        message: event.message || "The provider reported an error.",
        code: typeof event.code === "string" ? event.code : null,
        requestId:
          typeof event.requestId === "string" ? event.requestId : responseRequestId,
        diagnostic: event.diagnostic && typeof event.diagnostic === "object" ? event.diagnostic : null,
        model: typeof event.model === "string" ? event.model : null,
        resetAt: typeof event.resetAt === "string" ? event.resetAt : null,
        retryAfterSeconds: Number.isFinite(event.retryAfterSeconds) ? event.retryAfterSeconds : null,
        resetSource: typeof event.resetSource === "string" ? event.resetSource : null,
        conversationId: event.conversationId || resolvedConversationId,
        messageId: event.messageId || resolvedMessageId,
        artifact,
        artifacts,
        continuedFile
      };
    }
  };

  const consume = (text) => {
    buffer += text;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) handleLine(line);
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      consume(decoder.decode(value, { stream: true }));
    }
    buffer += decoder.decode();
    for (const line of buffer.split("\n")) handleLine(line);
  } catch (error) {
    if (error.name === "AbortError" || signal?.aborted) throw error;
    throw new ChatNetworkError(
      fullText
        ? "The response stream was interrupted. The partial answer was kept — use Continue generating to finish it."
        : "The response stream was interrupted. Please try again.",
      null,
      {
        code: "stream_interrupted",
        requestId: responseRequestId,
        partialContent: fullText,
        conversationId: resolvedConversationId,
        messageId: resolvedMessageId,
        artifact,
        artifacts,
        continuedFile
      }
    );
  }


  if (streamError) {
    throw new ChatNetworkError(streamError.message, null, {
      code: streamError.code,
      requestId: streamError.requestId,
      partialContent: fullText,
      diagnostic: streamError.diagnostic,
      model: streamError.model,
      resetAt: streamError.resetAt,
      retryAfterSeconds: streamError.retryAfterSeconds,
      resetSource: streamError.resetSource,
      conversationId: streamError.conversationId,
      messageId: streamError.messageId,
      artifact: streamError.artifact,
      artifacts: streamError.artifacts,
      continuedFile: streamError.continuedFile
    });
  }
  if (!sawDone) {
    if (fullText) {
      throw new ChatNetworkError(
        "The response ended before the model signalled completion. The partial answer was kept — use Continue generating to finish it.",
        null,
        {
          code: "stream_interrupted",
          requestId: responseRequestId,
          partialContent: fullText,
          conversationId: resolvedConversationId,
          messageId: resolvedMessageId
        }
      );
    }
    throw new ChatNetworkError("The provider returned an empty response. Check the model ID in Settings.", null, {
      code: "empty_stream",
      requestId: responseRequestId,
      conversationId: resolvedConversationId,
      messageId: resolvedMessageId
    });
  }
  if (!fullText.trim()) throw new ChatNetworkError("The provider returned an empty response. Check the model ID in Settings.", null, {
    code: "empty_stream",
    requestId: responseRequestId,
    conversationId: resolvedConversationId,
    messageId: resolvedMessageId
  });

  return {
    content: savedMessage?.content ?? fullText,
    rawContent: fullText,
    message: savedMessage,
    conversationId: resolvedConversationId,
    messageId: resolvedMessageId,
    finishReason,
    artifact,
    artifacts,
    continuedFile
  };
}
