import { apiClient } from "./api.js";
import { toRequestMessages } from "./chat.js";
import { desktopToolLabel, executeDesktopTool } from "../native/desktopTools.js";

const MAX_STEPS = 6;
const MAX_CALLS_PER_STEP = 5;
const MAX_TOOL_RESULT_CHARS = 16000;

export class DesktopChatError extends Error {
  constructor(message, code = "desktop_chat_failed", status = null) {
    super(message);
    this.name = "DesktopChatError";
    this.code = code;
    this.status = status;
  }
}

function createRunId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `desktop_${crypto.randomUUID().replace(/-/g, "")}`;
  }
  return `desktop_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
}

export function requestError(error) {
  const data = error?.response?.data;
  const status = error?.response?.status ?? null;
  // 404/405 here means the connected server has no tool route at all, which is
  // a server-build gap rather than a rejected message. The caller can resend
  // the same turn without local tools, so keep it apart from real failures.
  const routeMissing = status === 404 || status === 405;
  return new DesktopChatError(
    data?.message || error?.message || "The desktop tool request failed.",
    routeMissing ? "desktop_tools_unavailable" : data?.code || error?.code || "desktop_chat_failed",
    status
  );
}

function toolContent(value) {
  let text;
  try {
    text = JSON.stringify(value);
  } catch {
    text = JSON.stringify({ error: { code: "tool_result_unserializable", message: "The tool result could not be encoded." } });
  }
  if (typeof text !== "string") text = String(text);
  return text.length > MAX_TOOL_RESULT_CHARS ? `${text.slice(0, MAX_TOOL_RESULT_CHARS)}...` : text;
}

function parseArguments(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  if (typeof value !== "string") throw new Error("The tool arguments were not valid JSON.");
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("The tool arguments must be a JSON object.");
  }
  return parsed;
}

function emit(activity, phase, message) {
  activity?.({ phase, message });
}

export async function runDesktopToolChat({
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
  assistantMessageId,
  onMeta,
  onChunk,
  onActivity
} = {}) {
  const runId = createRunId();
  const conversation = toRequestMessages(messages);
  let step = 0;

  while (step <= MAX_STEPS) {
    if (signal?.aborted) {
      const error = new Error("The request was cancelled.");
      error.name = "AbortError";
      throw error;
    }
    const body = {
      runId,
      conversationId: conversationId || undefined,
      messages: conversation,
      model: model || undefined,
      mode,
      assistantMessageId
    };
    if (configId) body.configId = configId;
    if (providerId) body.providerId = providerId;
    if (source) body.source = source;
    if (vups) body.vups = true;
    if (typeof temperature === "number") body.temperature = temperature;

    let data;
    try {
      const response = await apiClient.post("/chat/desktop-tools", body, { signal });
      data = response.data;
    } catch (error) {
      if (signal?.aborted) {
        const aborted = new Error("The request was cancelled.");
        aborted.name = "AbortError";
        throw aborted;
      }
      throw requestError(error);
    }

    if (data?.type === "final") {
      const content = String(data.content ?? data.message?.content ?? "");
      if (data.conversationId) {
        onMeta?.({
          conversationId: data.conversationId,
          messageId: data.message?.messageId || assistantMessageId
        });
      }
      if (content) onChunk?.(content);
      return {
        content,
        conversationId: data.conversationId || conversationId || null,
        messageId: data.message?.messageId || assistantMessageId || null,
        finishReason: data.finishReason || "stop",
        saveWarning: null,
        artifact: data.artifact || null,
        artifacts: Array.isArray(data.artifacts) ? data.artifacts : [],
        continuedFile: null
      };
    }

    if (data?.type !== "tool_calls" || !Array.isArray(data.toolCalls) || data.toolCalls.length === 0) {
      throw new DesktopChatError("The desktop tool response was not recognized.", "invalid_tool_response");
    }
    if (step === MAX_STEPS) {
      throw new DesktopChatError(
        "The assistant used too many local filesystem tool rounds. Ask a narrower question and try again.",
        "tool_round_limit"
      );
    }

    const calls = data.toolCalls.slice(0, MAX_CALLS_PER_STEP);
    conversation.push({
      role: "assistant",
      content: typeof data.assistantMessage?.content === "string" ? data.assistantMessage.content : null,
      tool_calls: calls
    });

    for (const call of calls) {
      const name = call?.function?.name || "";
      const label = desktopToolLabel(name);
      emit(onActivity, "desktop_tool", label);
      let args;
      let result;
      try {
        args = parseArguments(call?.function?.arguments);
        result = await executeDesktopTool(name, args);
      } catch (error) {
        result = {
          ok: false,
          error: {
            code: "tool_execution_failed",
            message: error?.message || "The Windows filesystem tool did not run."
          }
        };
      }
      emit(
        onActivity,
        "desktop_tool",
        result?.ok ? `${label} completed` : `${label} failed`
      );
      conversation.push({
        role: "tool",
        tool_call_id: call?.id || `desktop_call_${step}`,
        content: toolContent(result)
      });
    }
    step += 1;
  }

  throw new DesktopChatError(
    "The assistant used too many local filesystem tool rounds. Ask a narrower question and try again.",
    "tool_round_limit"
  );
}
