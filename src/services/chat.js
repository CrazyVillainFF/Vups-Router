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
import {
  contentWithTextAttachments,
  readyTextAttachments,
  toPayloadImages
} from "../chat/attachments.js";
import {
  isFirewallBlockedResponse,
  isPersistenceFailureCode,
  REQUEST_BLOCKED_MESSAGE
} from "../chat/chatErrors.js";
import { sanitizeHistoryMessages } from "../chat/turnLifecycle.js";

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
    continuedFile = null,
    deadline = null,
    requestChars = null,
    messageCount = null
  } = {}) {
    super(message);
    this.name = "ChatNetworkError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.partialContent = partialContent;
    this.diagnostic = diagnostic;
    this.model = model;
    this.requestChars = requestChars;
    this.messageCount = messageCount;
    this.resetAt = resetAt;
    this.retryAfterSeconds = retryAfterSeconds;
    this.resetSource = resetSource;
    this.conversationId = conversationId;
    this.messageId = messageId;
    this.artifact = artifact;
    this.artifacts = Array.isArray(artifacts) ? artifacts : [];
    this.continuedFile = continuedFile;
    this.deadline = deadline;
  }
}

export class ChatPersistenceError extends ChatNetworkError {
  constructor(message, options = {}) {
    super(message, options.status ?? null, options);
    this.name = "ChatPersistenceError";
    this.stage = "persist";
  }
}

// There is deliberately no "connect" or total-execution timer: a provider may
// legitimately spend minutes queued, loading a local model, or reasoning before
// its first byte. `idle` only measures real silence after the stream opened, and
// the server sends SSE keepalives while it waits on the provider. `overall: 0`
// disables a total wall-clock cutoff by default; callers that genuinely need one
// can pass it explicitly.
export const DEFAULT_CHAT_TIMEOUTS = Object.freeze({
  idle: 120000,
  overall: 0
});

export const CHAT_MESSAGES = Object.freeze({
  connection: "Can't connect to Vups Router. Try again shortly.",
  timeout: "The connection stalled before the model answered. Try again.",
  interrupted: "The response stopped early. Continue or retry.",
  unavailable: "This model is unavailable. Try another model.",
  empty: "No answer received. Please try again."
});

function resolveTimeouts(overrides) {
  const result = { ...DEFAULT_CHAT_TIMEOUTS };
  for (const key of Object.keys(result)) {
    const value = Number(overrides?.[key]);
    // Zero is meaningful: it disables that timer.
    if (Number.isFinite(value) && value >= 0) result[key] = value;
  }
  return result;
}

function cancelledError() {
  const error = new Error("The request was cancelled.");
  error.name = "AbortError";
  return error;
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
  const filtered = sanitizeHistoryMessages(messages);
  return filtered.map((message, index) => {
    const entry = { role: message.role, content: String(message.content ?? "") };
    if (index === filtered.length - 1 && Array.isArray(message.textFiles) && message.textFiles.length > 0) {
      const textFiles = readyTextAttachments(message.textFiles);
      if (textFiles.length > 0) {
        entry.content = contentWithTextAttachments(entry.content, textFiles);
      }
    }
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
 * @param {{idle?: number, overall?: number}} [options.timeouts] Test override for deadlines. `idle` is post-connection silence; `overall: 0` disables the optional total deadline.
 * @param {(payload: {conversationId: string}) => void} [options.onMeta] Called once with the conversation id.
 * @param {(chunk: string) => void} [options.onChunk] Called with each streamed text chunk.
 * @param {(step: string) => void} [options.onStep] Called with truthful progress steps.
 * @param {(activity: {phase: string, message?: string}) => void} [options.onActivity] Called with structured progress events.
 * @param {string} [options.assistantMessageId] Stable client id for the assistant turn.
 * @param {{messageId: string, targetFile?: string}} [options.continuation] Continue an incomplete saved response.
 * @returns {Promise<{content: string, conversationId: string|null, messageId: string|null, finishReason: string|null, saveWarning: object|null, artifact: object|null, artifacts: object[], continuedFile: object|null}>}
 */
export async function streamChatResponse({
  conversationId,
  messages,
  model,
  configId,
  providerId,
  source,
  vups,
  mode,
  temperature,
  signal,
  timeouts: timeoutOverrides,
  onMeta,
  onChunk,
  onStep,
  onActivity,
  assistantMessageId,
  continuation
} = {}) {
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

  const requestChars = body.messages.reduce(
    (total, message) => total + (message.content?.length || 0),
    0
  );
  const messageCount = body.messages.length;

  const timeouts = resolveTimeouts(timeoutOverrides);
  const controller = new AbortController();
  let deadline = null;
  let userCancelled = false;

  const onExternalAbort = () => {
    userCancelled = true;
    controller.abort();
  };
  if (signal) {
    if (signal.aborted) onExternalAbort();
    else signal.addEventListener("abort", onExternalAbort, { once: true });
  }

  let idleTimer = null;
  let overallTimer = null;
  let drainTimer = null;
  const clearTimers = () => {
    if (idleTimer) clearTimeout(idleTimer);
    if (overallTimer) clearTimeout(overallTimer);
    if (drainTimer) clearTimeout(drainTimer);
    idleTimer = null;
    overallTimer = null;
    drainTimer = null;
  };
  const trip = (kind) => {
    if (deadline) return;
    deadline = kind;
    clearTimers();
    controller.abort();
  };
  const clearIdle = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };
  const armIdle = () => {
    clearIdle();
    if (timeouts.idle > 0) {
      idleTimer = setTimeout(() => trip("idle"), timeouts.idle);
    }
  };

  const timeoutError = (partialContent = "", extra = {}) => new ChatNetworkError(
    partialContent ? CHAT_MESSAGES.interrupted : CHAT_MESSAGES.timeout,
    null,
    {
      code: partialContent ? "stream_interrupted" : "timeout",
      deadline,
      partialContent,
      requestId: extra.requestId ?? null,
      conversationId: extra.conversationId ?? null,
      messageId: extra.messageId ?? null,
      artifact: extra.artifact ?? null,
      artifacts: extra.artifacts ?? [],
      continuedFile: extra.continuedFile ?? null
    }
  );

  const readingTimeout = (partialContent, extra) => {
    // A timeout is a distinct outcome from a dropped connection, but a timeout
    // after partial output is reported as an interruption so Continue stays useful.
    if (partialContent) return timeoutError(partialContent, extra);
    return new ChatNetworkError(CHAT_MESSAGES.timeout, null, {
      code: "timeout",
      deadline,
      conversationId: extra?.conversationId ?? null,
      messageId: extra?.messageId ?? null
    });
  };

  if (userCancelled) throw cancelledError();

  // The provider may be queued, cold-starting, or loading a local model before
  // it sends anything. That wait is visible and cancellable, never a failure.
  onStep?.("Waiting for model");
  onActivity?.({ phase: "waiting", message: "Waiting for model" });
  if (timeouts.overall > 0) {
    overallTimer = setTimeout(() => trip("overall"), timeouts.overall);
  }

  try {
    let response;
    try {
      response = await fetch(chatEndpoint(vups === true), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify(body),
        signal: controller.signal
      });
    } catch (error) {
      if (deadline) throw readingTimeout("", null);
      if (userCancelled) throw cancelledError();
      if (error?.name === "AbortError") throw cancelledError();
      throw new ChatNetworkError(CHAT_MESSAGES.connection, null, {
        code: "connection_unavailable"
      });
    }

    if (deadline) throw readingTimeout("", null);

    const responseRequestId = response.headers.get("x-request-id");

    if (!response.ok) {
      let message = CHAT_MESSAGES.interrupted;
      let code = null;
      let requestId = responseRequestId;
      let diagnostic = null;
      let model = null;
      let resetAt = null;
      let retryAfterSeconds = null;
      let resetSource = null;
      let bodyText = "";
      try {
        bodyText = await response.text();
      } catch {
        /* body unavailable */
      }
      let data = null;
      if (bodyText) {
        try {
          data = JSON.parse(bodyText);
        } catch {
          data = null;
        }
      }
      if (data && typeof data === "object") {
        if (typeof data?.message === "string") message = data.message;
        if (typeof data?.code === "string") code = data.code;
        if (typeof data?.requestId === "string") requestId = data.requestId;
        if (data?.diagnostic && typeof data.diagnostic === "object") diagnostic = data.diagnostic;
        if (typeof data?.model === "string") model = data.model;
        if (typeof data?.resetAt === "string") resetAt = data.resetAt;
        if (Number.isFinite(data?.retryAfterSeconds)) retryAfterSeconds = data.retryAfterSeconds;
        if (typeof data?.resetSource === "string") resetSource = data.resetSource;
        if (data?.retryAfterSeconds && Number.isFinite(data.retryAfterSeconds)) {
          const retryAt = new Date(Date.now() + data.retryAfterSeconds * 1000).toISOString();
          if (!resetAt) resetAt = retryAt;
        }
      } else if (
        isFirewallBlockedResponse(response.headers.get("content-type"), bodyText)
      ) {
        // An edge WAF rejection never reaches the backend, so it carries no
        // provider evidence. Report the real cause instead of inferring one
        // from the HTTP status.
        message = REQUEST_BLOCKED_MESSAGE;
        code = "request_blocked";
      }
      throw new ChatNetworkError(message, response.status, {
        code,
        requestId,
        diagnostic,
        model,
        resetAt,
        retryAfterSeconds,
        resetSource,
        deadline,
        requestChars,
        messageCount
      });
    }

    if (!response.body) {
      throw new ChatNetworkError(CHAT_MESSAGES.empty, null, { code: "empty_stream" });
    }

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
    let usage = null;
    let saveWarning = null;
    let sawDone = false;
    let terminalEvent = null;

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
      // Ignore every event after the turn reached a terminal stream state.
      // A done event is authoritative: a later cleanup/error event must never
      // turn a completed, persisted response into a failure.
      if (terminalEvent === "done") return;
      if (terminalEvent === "error" && event.type !== "done") return;
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
      if (event.type === "progress") {
        if (typeof event.message === "string" && event.message.trim()) onStep?.(event.message.trim());
        onActivity?.({
          phase: typeof event.phase === "string" && event.phase ? event.phase : "progress",
          ...(typeof event.message === "string" ? { message: event.message } : {})
        });
        return;
      }
      if (event.type === "delta") {
        if (event.content) {
          if (!fullText) {
            onStep?.("Receiving response");
            onActivity?.({ phase: "responding", message: "Receiving response" });
          }
          fullText += event.content;
          onChunk?.(event.content);
        }
        return;
      }
      if (event.type === "done") {
        terminalEvent = "done";
        // The answer is complete; transport deadlines no longer apply.
        clearTimers();
        streamError = null;
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
        if (event.usage && typeof event.usage === "object") usage = event.usage;
        if (event.saveWarning && typeof event.saveWarning === "object") {
          saveWarning = {
            code: typeof event.saveWarning.code === "string" ? event.saveWarning.code : "save_failed",
            message: typeof event.saveWarning.message === "string" ? event.saveWarning.message : ""
          };
        } else if (typeof event.saveWarning === "string" && event.saveWarning.trim()) {
          saveWarning = { code: "save_failed", message: event.saveWarning.trim() };
        }
        onStep?.("Response complete");
        return;
      }
      if (event.type === "error") {
        terminalEvent = "error";
        clearTimers();
        // Keep a short drain window so a done event already in flight can
        // still win, then close the socket ourselves.
        drainTimer = setTimeout(() => {
          drainTimer = null;
          reader.cancel().catch(() => {});
        }, 2000);
        if (event.conversationId) resolvedConversationId = event.conversationId;
        if (event.messageId) resolvedMessageId = event.messageId;
        if (event.artifact) artifact = event.artifact;
        if (Array.isArray(event.artifacts)) artifacts = event.artifacts;
        if (event.continuedFile) continuedFile = event.continuedFile;
        streamError = {
          message: event.message || CHAT_MESSAGES.interrupted,
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

    const streamContext = () => ({
      requestId: responseRequestId,
      conversationId: resolvedConversationId,
      messageId: resolvedMessageId,
      artifact,
      artifacts,
      continuedFile
    });

    try {
      armIdle();
      while (true) {
        const { done, value } = await reader.read();
        armIdle();
        if (done) break;
        consume(decoder.decode(value, { stream: true }));
        // A done event closes the turn even if the server holds the
        // connection open; do not wait on a socket that may never end.
        // An error event may still be superseded by a later done event.
        if (terminalEvent === "done") {
          await reader.cancel().catch(() => {});
          break;
        }
      }
      buffer += decoder.decode();
      for (const line of buffer.split("\n")) handleLine(line);
    } catch (error) {
      if (deadline) throw readingTimeout(fullText, streamContext());
      if (userCancelled) throw cancelledError();
      if (error?.name === "AbortError" || signal?.aborted) throw cancelledError();
      // A confirmed done event wins over a later transport hiccup.
      if (!sawDone) {
        throw new ChatNetworkError(
          CHAT_MESSAGES.interrupted,
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
    } finally {
      clearIdle();
    }

    if (streamError) {
      const options = {
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
        continuedFile: streamError.continuedFile,
        requestChars,
        messageCount
      };
      if (isPersistenceFailureCode(streamError.code)) {
        throw new ChatPersistenceError(streamError.message, options);
      }
      throw new ChatNetworkError(streamError.message, null, options);
    }
    if (!sawDone) {
      if (fullText) {
        throw new ChatNetworkError(
          CHAT_MESSAGES.interrupted,
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
      throw new ChatNetworkError(CHAT_MESSAGES.empty, null, {
        code: "empty_stream",
        requestId: responseRequestId,
        conversationId: resolvedConversationId,
        messageId: resolvedMessageId
      });
    }
    if (!fullText.trim() && !savedMessage?.content?.trim() && !artifact) {
      throw new ChatNetworkError(CHAT_MESSAGES.empty, null, {
        code: "empty_stream",
        requestId: responseRequestId,
        conversationId: resolvedConversationId,
        messageId: resolvedMessageId
      });
    }

    return {
      content: savedMessage?.content ?? fullText,
      rawContent: fullText,
      message: savedMessage,
      conversationId: resolvedConversationId,
      messageId: resolvedMessageId,
      finishReason,
      ...(usage ? { usage } : {}),
      saveWarning,
      artifact,
      artifacts,
      continuedFile
    };
  } finally {
    clearTimers();
    signal?.removeEventListener("abort", onExternalAbort);
  }
}
