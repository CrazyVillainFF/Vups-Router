import { apiClient } from "./api.js";
import { toRequestMessages } from "./chat.js";
import { matchLocalFileTask } from "./localFileTask.js";
import { formatBytes } from "../chat/attachments.js";
import {
  cancelDesktopToolApprovals,
  desktopToolLabel,
  executeDesktopTool
} from "../native/desktopTools.js";

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

function localDate(value) {
  if (!Number.isFinite(value)) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
}

function entryLine(entry) {
  if (!entry || typeof entry !== "object") return "";
  const name = typeof entry.name === "string" ? entry.name : "";
  if (!name) return "";
  const parts = [`\`${name}\``];
  const size = Number.isFinite(entry.size) ? formatBytes(entry.size) : "";
  if (size) parts.push(size);
  const modified = localDate(entry.modifiedAt);
  if (modified) parts.push(modified);
  return parts.join(" · ");
}

/**
 * Only the native layer knows why an operation stopped, and its error codes are
 * the difference between "you declined", "this folder isn't there" and "Windows
 * refused". These lines keep those three apart without a model call, and none of
 * them tells the user to change Windows access control.
 */
const FAILURE_REMEDIES = {
  approval_denied: "Nothing was read; the operation stopped where it was denied.",
  path_not_found: "Check the folder name or pick it again — the app never creates a folder for you.",
  access_denied:
    "This is a Windows access decision, not a VupsRouter setting. The app made no permission, ownership or elevation changes.",
  not_a_directory: "The path exists but is a file, so it has no entries to list.",
  not_a_file: "The path exists but is a folder, so it has no contents to read.",
  sensitive_file: "This file is excluded from AI reads to protect credentials and secrets.",
  symlink_rejected: "Symbolic links and junctions are outside what these tools may follow.",
  network_path_rejected: "Network and UNC paths are outside what these tools may read.",
  file_too_large: "The file is over the 256 KB read limit; the app did not read a partial copy.",
  grant_store_failed: "The folder grant could not be saved, so it will be asked again next time."
};

function failureLine(step) {
  const code = step?.error?.code || "unknown";
  const message = String(step?.error?.message || "The local tool did not run.").trim();
  const remedy = FAILURE_REMEDIES[code];
  return `- ${step?.label || "Local operation"}: ${message}${remedy ? ` ${remedy}` : ""}`;
}

/**
 * Deterministic text built only from data the native tool actually returned.
 * It never paraphrases the user's question and never includes file contents, so
 * a model failure after a successful filesystem step still leaves the real
 * result on screen instead of destroying it.
 */
export function localFilesystemSummary(steps = []) {
  const lines = [];
  const failures = [];
  for (const step of steps) {
    if (!step?.ok) {
      failures.push(failureLine(step));
      continue;
    }
    const data = step.data || {};
    if (step.tool === "list_recent_files" && Array.isArray(data.files)) {
      const rows = data.files.map(entryLine).filter(Boolean);
      if (rows.length === 0) {
        lines.push(`**${step.label}**\nNo files were found in ${data.path || "that folder"}.`);
        continue;
      }
      lines.push(
        `**${step.label}** — ${data.path || "folder"}, newest first\n` +
          rows.map((row, index) => `${index + 1}. ${row}`).join("\n")
      );
      continue;
    }
    if (step.tool === "list_directory" && Array.isArray(data.entries)) {
      const rows = data.entries.slice(0, 15).map(entryLine).filter(Boolean);
      lines.push(
        `**${step.label}** — ${data.path || "folder"}: ${data.entries.length} entries\n` +
          rows.map(row => `- ${row}`).join("\n")
      );
      continue;
    }
    if (step.tool === "search_files" && Array.isArray(data.entries)) {
      const rows = data.entries.slice(0, 15).map(entryLine).filter(Boolean);
      lines.push(
        `**${step.label}** — ${data.entries.length} match(es) in \`${data.root || data.path || "folder"}\`\n` +
          rows.map(row => `- ${row}`).join("\n")
      );
      continue;
    }
    if (step.tool === "get_windows_known_folder") {
      const path = data.path || data.resolvedPath || "";
      if (path) lines.push(`**${step.label}** — ${path}`);
      continue;
    }
    if (step.tool === "read_file_metadata") {
      const row = entryLine(data) || (typeof data.path === "string" ? `\`${data.path}\`` : "");
      if (row) lines.push(`**${step.label}** — ${row}`);
      continue;
    }
    if (step.tool === "read_file") {
      // The bytes stay out of the summary: the user asked for a file listing,
      // not for their document to be quoted into the transcript.
      const path = typeof data.path === "string" ? data.path : "";
      lines.push(`**${step.label}** — read ${path ? `\`${path}\`` : "1 file"} (contents not shown)`);
    }
  }
  const failed = failures.filter(Boolean);
  if (failed.length > 0) {
    lines.push(`**Not completed**\n${failed.join("\n")}`);
  }
  return lines.filter(Boolean).join("\n\n");
}

function attachLocalResults(error, steps) {
  const summary = localFilesystemSummary(steps);
  error.toolSteps = steps;
  if (summary) error.localSummary = summary;
  // Only a step that actually returned data counts as filesystem work done; a
  // summary made purely of failures must not be reported as a successful read.
  if (steps.some(step => step?.ok)) error.filesystemCompleted = true;
  return error;
}

function abortError() {
  const error = new Error("The request was cancelled.");
  error.name = "AbortError";
  return error;
}

/**
 * Runs one native tool and appends the real assistant/tool pair to the
 * conversation, so the model sees the same shape whether the call came from its
 * own tool_calls or from the deterministic fast path.
 */
async function runLocalTool(tool, args, { callId, conversation, steps, onActivity, signal }) {
  if (signal?.aborted) throw abortError();
  const label = desktopToolLabel(tool);
  emit(onActivity, "desktop_tool", `${label} — running`);
  let result;
  try {
    result = await executeDesktopTool(tool, args);
  } catch (error) {
    result = {
      ok: false,
      error: {
        code: "tool_execution_failed",
        message: error?.message || "The Windows filesystem tool did not run."
      }
    };
  }
  if (result?.ok) {
    emit(onActivity, "desktop_tool", `${label} — completed`);
  } else {
    // The failure code is what separates "you denied this" from "Windows
    // refused", and the progress list must not blur the two.
    const code = result?.error?.code || "unknown";
    emit(onActivity, "desktop_tool", `${label} — failed (${code})`);
  }
  const id = callId || `local_${steps.length + 1}`;
  conversation.push({
    role: "assistant",
    content: null,
    tool_calls: [{ id, type: "function", function: { name: tool, arguments: JSON.stringify(args || {}) } }]
  });
  conversation.push({ role: "tool", tool_call_id: id, content: toolContent(result) });
  steps.push({
    tool,
    label,
    ok: Boolean(result?.ok),
    data: result?.data ?? null,
    error: result?.error || null
  });
  return result;
}

function folderPathFrom(result) {
  if (!result?.ok) return "";
  const path = result?.data?.path;
  return typeof path === "string" && path.trim() ? path : "";
}

/**
 * The expensive bug was the model spending two round trips and a prompt per file
 * to answer "what are my five latest downloads". The app knows how to do that
 * with one enumeration, so it runs it first and hands the model the data.
 */
async function runFastPath(task, { conversation, steps, onActivity, signal }) {
  emit(onActivity, "desktop_tool", task.intent);
  const located = await runLocalTool("get_windows_known_folder", { name: task.folder }, {
    callId: "fast_locate",
    conversation,
    steps,
    onActivity,
    signal
  });
  const path = folderPathFrom(located);
  if (!path) return false;
  if (task.kind === "locate") return true;
  const tool = task.kind === "recent" ? "list_recent_files" : "list_directory";
  const args = task.kind === "recent" ? { path, limit: task.limit } : { path };
  await runLocalTool(tool, args, {
    callId: "fast_read",
    conversation,
    steps,
    onActivity,
    signal
  });
  return true;
}

function lastUserText(messages = []) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user" && typeof message.content === "string") return message.content;
  }
  return "";
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
  userText,
  onMeta,
  onChunk,
  onActivity
} = {}) {
  const runId = createRunId();
  const conversation = toRequestMessages(messages);
  const steps = [];
  let step = 0;

  try {
    const fastTask = matchLocalFileTask(userText || lastUserText(messages));
    if (fastTask) {
      try {
        await runFastPath(fastTask, { conversation, steps, onActivity, signal });
        step = 1;
      } catch (error) {
        if (error?.name === "AbortError") throw error;
        // A failed fast path is not a reason to lose the turn: the ordinary
        // model-driven loop still runs, and the honest tool error is already in
        // the conversation.
        emit(onActivity, "desktop_tool", "Local fast path unavailable, asking the model");
      }
    }

    while (step <= MAX_STEPS) {
      if (signal?.aborted) throw abortError();
      if (steps.length > 0) {
        emit(onActivity, "desktop_tool", "Model is writing up the local results");
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
        if (signal?.aborted) throw abortError();
        throw attachLocalResults(requestError(error), steps);
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
          continuedFile: null,
          localSteps: steps.length > 0 ? steps : undefined
        };
      }

      if (data?.type !== "tool_calls" || !Array.isArray(data.toolCalls) || data.toolCalls.length === 0) {
        throw attachLocalResults(
          new DesktopChatError("The desktop tool response was not recognized.", "invalid_tool_response"),
          steps
        );
      }
      if (step === MAX_STEPS) {
        throw attachLocalResults(
          new DesktopChatError(
            "The assistant used too many local filesystem tool rounds. Ask a narrower question and try again.",
            "tool_round_limit"
          ),
          steps
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
        let args;
        try {
          args = parseArguments(call?.function?.arguments);
        } catch (error) {
          conversation.push({
            role: "tool",
            tool_call_id: call?.id || `desktop_call_${step}`,
            content: toolContent({
              ok: false,
              error: { code: "invalid_arguments", message: error?.message || "The tool arguments were not valid JSON." }
            })
          });
          steps.push({ tool: name, label: desktopToolLabel(name), ok: false, data: null, error: null });
          continue;
        }
        await runLocalTool(name, args, {
          callId: call?.id || `desktop_call_${step}`,
          conversation,
          steps,
          onActivity,
          signal
        });
      }
      step += 1;
    }

    throw attachLocalResults(
      new DesktopChatError(
        "The assistant used too many local filesystem tool rounds. Ask a narrower question and try again.",
        "tool_round_limit"
      ),
      steps
    );
  } finally {
    // A run that ends for any reason must not leave a card on screen whose
    // waiting tool call no longer exists.
    await cancelDesktopToolApprovals().catch(() => {});
  }
}
