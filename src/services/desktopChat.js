import { apiClient } from "./api.js";
import { toRequestMessages } from "./chat.js";
import { matchLocalFileTask } from "./localFileTask.js";
import { formatBytes } from "../chat/attachments.js";
import {
  cancelDesktopToolApprovals,
  cancelDesktopToolOperation,
  desktopToolLabel,
  executeDesktopTool
} from "../native/desktopTools.js";

// Development work needs more rounds than a folder question: inspect, read,
// edit, run tests, read the failure, fix it, rerun. Each round is still bounded.
const MAX_STEPS = 12;
const MAX_CALLS_PER_STEP = 6;
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
  // Axios adds transport codes such as ERR_BAD_REQUEST that name the HTTP
  // library, not the failure. Only a code the server itself sent is evidence;
  // anything else falls back to the tool-turn code and keeps the real message.
  const serverCode = typeof data?.code === "string" && data.code.trim() ? data.code.trim() : "";
  const transportCode =
    typeof error?.code === "string" && error.code && !error.code.startsWith("ERR_") ? error.code : "";
  return new DesktopChatError(
    data?.message || error?.message || "The desktop tool request failed.",
    routeMissing
      ? "desktop_tools_unavailable"
      : status === null
        ? "network_error"
        : serverCode || transportCode || "desktop_chat_failed",
    status
  );
}

// A tool round has no client-side side effects until its response arrives, so
// re-asking after a transient server answer cannot run a file operation twice.
// A lost response stays ambiguous for that reason too: the tool calls it may
// have contained were never executed, so nothing is duplicated by retrying.
const RETRY_DELAYS_MS = [350, 900];

function retryableDesktopFailure(failure) {
  if (!failure) return false;
  if (failure.status === null) return true;
  if (failure.status === 409) return true;
  if (failure.status === 429) return failure.code === "concurrency_limit" || failure.code === "run_busy";
  return failure.status === 500 || failure.status === 502 || failure.status === 503 || failure.status === 504;
}

function waitForRetry(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(abortError());
    }
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

async function postDesktopToolRound(body, { signal } = {}) {
  let lastFailure = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      const response = await apiClient.post("/chat/desktop-tools", body, { signal, timeout: 0 });
      return response.data;
    } catch (error) {
      if (signal?.aborted) throw abortError();
      const failure = requestError(error);
      lastFailure = failure;
      if (attempt >= RETRY_DELAYS_MS.length || !retryableDesktopFailure(failure)) throw failure;
      await waitForRetry(RETRY_DELAYS_MS[attempt], signal);
    }
  }
  throw lastFailure;
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

// Absolute paths are the answer to "find my folder", so search rows keep the
// real path the native layer returned instead of only the leaf name.
function searchEntryLine(entry) {
  if (!entry || typeof entry !== "object") return "";
  const path = typeof entry.path === "string" && entry.path.trim() ? entry.path.trim() : "";
  const name = typeof entry.name === "string" ? entry.name : "";
  if (!path && !name) return "";
  const parts = [`\`${path || name}\``];
  const size = Number.isFinite(entry.size) ? formatBytes(entry.size) : "";
  if (size) parts.push(size);
  return parts.join(" · ");
}

function pathName(path) {
  const parts = String(path || "").split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) || "";
}

function uniquePaths(values) {
  const seen = new Set();
  const paths = [];
  for (const value of values) {
    const path = typeof value === "string" ? value.trim() : "";
    if (!path) continue;
    const key = path.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    paths.push(path);
  }
  return paths;
}

// The Windows folders a name lookup may read without guessing a username.
const SEARCH_ROOT_FOLDERS = Object.freeze(["documents", "desktop", "downloads"]);

/**
 * Only the native layer knows why an operation stopped, and its error codes are
 * the difference between "you declined", "this folder isn't there" and "Windows
 * refused". These lines keep those three apart without a model call, and none of
 * them tells the user to change Windows access control.
 */
const FAILURE_REMEDIES = {
  approval_denied: "Nothing was read, written or run; the operation stopped where it was denied.",
  cancelled: "The operation was stopped before it finished, and nothing further runs for this turn.",
  path_not_found: "Check the path or pick it again — the app never creates a folder for you.",
  access_denied:
    "This is a Windows access decision, not a VupsRouter setting. The app made no permission, ownership or elevation changes.",
  outside_workspace:
    "That path is outside the authorized workspace. Add the folder as a workspace or switch modes; the app will not widen itself.",
  protected_root:
    "That is a protected Windows location. The app did not bypass Windows security or change ownership.",
  not_a_directory: "The path exists but is a file, so it has no entries to list.",
  not_a_file: "The path exists but is a folder, so it has no contents to read.",
  sensitive_file: "This file is excluded from AI access to protect credentials and secrets.",
  symlink_rejected: "Symbolic links and junctions are outside what these tools may follow.",
  network_path_rejected: "Network and UNC paths are outside what these tools may access.",
  file_too_large: "The file is over the 256 KB text read limit; the app did not read a partial copy.",
  binary_file:
    "Only UTF-8 text can be read. PDF, Office, image, audio, video and archive files can be reported as metadata or opened, but not read or edited.",
  unsupported_format:
    "That format cannot be edited as text. VupsRouter can report its metadata or open it, but it will not pretend to change its contents.",
  content_too_large: "That write would exceed the 2 MB text limit, so nothing was changed.",
  match_not_found: "The exact text to replace was not found, so the file was not changed.",
  path_exists: "The destination already exists, and the app never overwrites silently.",
  too_deep: "The folder tree is deeper than the bounded traversal allows; nothing further was touched.",
  too_many_entries: "The operation would exceed the entry limit, so it stopped without finishing.",
  app_not_found:
    "No installed app matched in Windows App Paths or the Start Menu, so nothing was launched.",
  app_exited: "The app started and exited immediately; Windows reported no running process.",
  app_discovery_failed: "Windows did not finish listing its applications, so no app list was invented.",
  discovery_timeout: "Windows did not finish listing its applications in time; try again.",
  unknown_process:
    "That process is not in VupsRouter's own registry. Only apps and commands VupsRouter launched can be closed or stopped.",
  not_a_command: "That process is an app, not a background command; use close_app instead.",
  not_an_app: "That process is a background command; use stop_command instead.",
  stop_failed: "Windows did not confirm the process stopped; it may still be running.",
  close_failed: "Windows did not confirm the app closed; it may still be running.",
  not_found: "Nothing matching that was found.",
  open_failed: "Windows could not open that item; nothing was launched by VupsRouter.",
  grant_store_failed: "The file permission could not be saved, so it will be asked again next time."
};

function failureLine(step) {
  const code = step?.error?.code || "unknown";
  const message = String(step?.error?.message || "The local tool did not run.").trim();
  const remedy = FAILURE_REMEDIES[code];
  return `- ${step?.label || "Local operation"}: ${message}${remedy ? ` ${remedy}` : ""}`;
}

function quoted(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? `\`${text}\`` : "";
}

// Command output is shown verbatim but bounded, and a fence inside the output
// cannot break out of the summary block.
function outputBlock(text, limit = 1400) {
  const value = typeof text === "string" ? text.trim() : "";
  if (!value) return "";
  const clipped = value.length > limit ? `${value.slice(0, limit)}\n…` : value;
  return `\n\`\`\`\n${clipped.replace(/```/g, "'''")}\n\`\`\``;
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
    // The fast path may run several probes to find one answer; only the step
    // that states the answer belongs in the user-facing summary.
    if (step?.summary === false) continue;
    if (!step?.ok) {
      failures.push(failureLine(step));
      continue;
    }
    const data = step.data || {};
    if (step.tool === "locate_folder") {
      const matches = Array.isArray(data.matches) ? data.matches : [];
      const paths = matches
        .map(match => (typeof match?.path === "string" ? match.path.trim() : ""))
        .filter(Boolean);
      if (paths.length > 0) {
        lines.push(
          `**${step.label}** — ${paths.length === 1 ? "found" : `${paths.length} matches`}\n` +
            paths.map(path => `- \`${path}\``).join("\n")
        );
      }
      continue;
    }
    if (step.tool === "find_file") {
      const entries = Array.isArray(data.entries) ? data.entries : [];
      const rows = entries.slice(0, 15).map(searchEntryLine).filter(Boolean);
      if (rows.length > 0) {
        lines.push(
          `**${step.label}** — ${data.entries.length} match(es) in \`${data.root || "the selected folder"}\`\n` +
            rows.map(row => `- ${row}`).join("\n")
        );
      }
      continue;
    }
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
      const rows = data.entries.slice(0, 15).map(searchEntryLine).filter(Boolean);
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
      continue;
    }
    if (step.tool === "search_file_contents" && Array.isArray(data.matches)) {
      const rows = data.matches
        .slice(0, 12)
        .map(match => {
          const path = quoted(match?.path);
          const line = Number.isFinite(match?.line) ? `:${match.line}` : "";
          const text = typeof match?.text === "string" ? match.text.trim() : "";
          return path ? `- ${path}${line}${text ? ` — ${text}` : ""}` : "";
        })
        .filter(Boolean);
      lines.push(
        `**${step.label}** — ${data.matches.length} match(es) in ${quoted(data.root) || "the folder"}, ` +
          `${data.filesScanned ?? 0} file(s) scanned` +
          (rows.length > 0 ? `\n${rows.join("\n")}` : "")
      );
      continue;
    }
    if (["write_file", "append_file", "edit_file", "create_directory"].includes(step.tool)) {
      const path = quoted(data.path);
      let detail = "";
      if (step.tool === "edit_file") {
        detail = `${data.replacements ?? 1} replacement(s)`;
      } else if (step.tool === "create_directory") {
        detail = data.created ? "folder created" : "folder already existed";
      } else {
        const written = Number.isFinite(data.bytesWritten) ? `${data.bytesWritten} bytes written` : "text written";
        detail = Number.isFinite(data.size) ? `${written}, file is now ${formatBytes(data.size)}` : written;
        if (step.tool === "append_file") detail += ", earlier contents kept";
      }
      lines.push(`**${step.label}** — ${detail}${path ? `: ${path}` : ""}`);
      continue;
    }
    if (step.tool === "rename_path" || step.tool === "move_path" || step.tool === "copy_path") {
      const from = quoted(data.from);
      const to = quoted(data.to);
      if (from && to) lines.push(`**${step.label}** — ${from} → ${to}`);
      continue;
    }
    if (step.tool === "delete_path") {
      const removed = Number.isFinite(data.entriesDeleted) ? data.entriesDeleted : 1;
      lines.push(
        `**${step.label}** — permanently deleted ${quoted(data.path) || "the item"} ` +
          `(${removed} item(s), not moved to the Recycle Bin)`
      );
      continue;
    }
    if (step.tool === "open_path") {
      lines.push(`**${step.label}** — opened ${quoted(data.path) || "the item"} in ${data.opener || "Windows"}`);
      continue;
    }
    if (step.tool === "open_url") {
      lines.push(`**${step.label}** — opened ${quoted(data.url) || "the link"} in ${data.opener || "the default browser"}`);
      continue;
    }
    if (step.tool === "launch_app" || (step.tool === "open_with_app" && data.name)) {
      const pid = data.pid ?? data.processId ?? "?";
      lines.push(
        `**${step.label}** — ${data.name || "the app"} launched (PID ${pid}), ` +
          `${data.running === true ? "confirmed running" : "not confirmed running"}. ` +
          "VupsRouter launched the process but cannot interact with the app's window."
      );
      continue;
    }
    if (step.tool === "open_with_app") {
      lines.push(`**${step.label}** — opened ${quoted(data.path) || "the file"} in ${data.opener || "the default app"}`);
      continue;
    }
    if (step.tool === "list_installed_apps" && Array.isArray(data.apps)) {
      const names = data.apps.slice(0, 15).map(app => (typeof app?.name === "string" ? app.name : "")).filter(Boolean);
      lines.push(
        `**${step.label}** — ${data.total ?? data.apps.length} installed app(s)` +
          (names.length > 0 ? `\n${names.map(name => `- ${name}`).join("\n")}` : "")
      );
      continue;
    }
    if (step.tool === "find_app" && data.best) {
      const best = data.best;
      lines.push(
        `**${step.label}** — ${best.name || "match"}${best.path ? ` (${best.path})` : ""}` +
          (Number.isFinite(data.total) && data.total > 1 ? `, ${data.total - 1} other match(es)` : "")
      );
      continue;
    }
    if (step.tool === "list_processes" && Array.isArray(data.processes)) {
      const rows = data.processes
        .slice(0, 12)
        .map(process => {
          const name = typeof process?.label === "string" && process.label ? process.label : `PID ${process?.pid ?? "?"}`;
          const status = typeof process?.status === "string" ? process.status : "";
          return `- ${name}${process?.pid ? ` (PID ${process.pid})` : ""}${status ? ` — ${status}` : ""}`;
        })
        .filter(Boolean);
      lines.push(
        `**${step.label}** — ${data.processes.length} windowed process(es)` +
          (rows.length > 0 ? `\n${rows.join("\n")}` : "")
      );
      continue;
    }
    if (step.tool === "close_app") {
      const state = data.alreadyExited ? "already exited" : data.closed === false ? "still running" : "closed";
      lines.push(`**${step.label}** — ${data.label || `PID ${data.pid}`} ${state}${data.forced ? " (force-terminated)" : ""}`);
      continue;
    }
    if (step.tool === "run_command") {
      const status =
        data.status === "exited"
          ? `exit code ${data.exitCode ?? "?"}`
          : data.status === "timed_out"
            ? "timed out"
            : data.status || "finished";
      lines.push(
        `**${step.label}** — ${status}${Number.isFinite(data.durationMs) ? ` in ${data.durationMs} ms` : ""}` +
          outputBlock(data.stdout) +
          (typeof data.stderr === "string" && data.stderr.trim() ? `\nstderr:${outputBlock(data.stderr)}` : "")
      );
      continue;
    }
    if (step.tool === "start_command") {
      lines.push(
        `**${step.label}** — started (processId \`${data.processId}\`, PID ${data.pid ?? "?"}), ` +
          `${data.running === true ? "running" : data.status || "not confirmed running"}`
      );
      continue;
    }
    if (step.tool === "command_output") {
      lines.push(
        `**${step.label}** — ${data.status || "unknown"}${data.running === true ? ", running" : ""}` +
          outputBlock(data.stdout) +
          (typeof data.stderr === "string" && data.stderr.trim() ? `\nstderr:${outputBlock(data.stderr)}` : "")
      );
      continue;
    }
    if (step.tool === "stop_command") {
      lines.push(
        `**${step.label}** — ${data.alreadyExited ? "already exited" : "stopped"} ` +
          `(processId \`${data.processId}\`)`
      );
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
async function runLocalTool(tool, args, { callId, conversation, steps, onActivity, signal, executeTool, summary = true }) {
  if (signal?.aborted) throw abortError();
  const label = desktopToolLabel(tool);
  emit(onActivity, "desktop_tool", `${label} — running`);
  // Stop can land while the progress entry is being painted; an operation that
  // was already announced must still not reach the native layer after that.
  if (signal?.aborted) throw abortError();
  let result;
  try {
    result = await executeTool(tool, args);
  } catch (error) {
    result = {
      ok: false,
      error: {
        code: "tool_execution_failed",
        message: error?.message || "The Windows filesystem tool did not run."
      }
    };
  }
  // A stop during a native call must not be followed by feeding its result
  // back to the model or starting the next call in the same batch.
  if (signal?.aborted) throw abortError();
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
    error: result?.error || null,
    ...(summary ? {} : { summary: false })
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
 *
 * The same path answers "find my Qoder folder": the Win32 known-folder resolver
 * supplies the real roots and the existing native listing/search tools do the
 * lookup. Nothing here invents a path or a tool.
 */
async function runFastPath(task, context) {
  emit(context.onActivity, "desktop_tool", task.intent);
  if (task.kind === "locate_named") return runFolderLocate(task, context);
  if (task.kind === "find") return runFileSearch(task, context);

  const { conversation, steps, onActivity, signal, executeTool } = context;
  const located = await runLocalTool("get_windows_known_folder", { name: task.folder }, {
    callId: "fast_locate",
    conversation,
    steps,
    onActivity,
    signal,
    executeTool
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
    signal,
    executeTool
  });
  return true;
}

async function resolveKnownFolder(name, context, callId) {
  const located = await runLocalTool("get_windows_known_folder", { name }, {
    callId,
    conversation: context.conversation,
    steps: context.steps,
    onActivity: context.onActivity,
    signal: context.signal,
    executeTool: context.executeTool,
    summary: false
  });
  return folderPathFrom(located);
}

function folderLocateStep(task, ok, data, error = null) {
  return {
    tool: "locate_folder",
    label: task.intent,
    ok,
    data,
    error
  };
}

async function runFolderLocate(task, { conversation, steps, onActivity, signal, executeTool, searchRoots = [] }) {
  const query = task.query;
  const needle = query.toLowerCase();
  const context = { conversation, steps, onActivity, signal, executeTool };

  // A configured workspace is already an approved folder. If its own name is
  // the answer, no listing or prompt is needed.
  if (!task.folder) {
    const workspaceMatch = uniquePaths(searchRoots).find(path => pathName(path).toLowerCase().includes(needle));
    if (workspaceMatch) {
      steps.push(
        folderLocateStep(task, true, {
          query,
          matches: [{ name: pathName(workspaceMatch), path: workspaceMatch }],
          searched: []
        })
      );
      return true;
    }
  }

  const targets = [];
  if (task.folder) {
    targets.push({ name: task.folder });
  } else {
    // Workspace folders were already picked by the user, so they are searched
    // before any Windows known folder needs its own permission question.
    for (const path of uniquePaths(searchRoots)) targets.push({ path });
    for (const name of SEARCH_ROOT_FOLDERS) targets.push({ name });
  }

  const matches = [];
  const searched = [];
  const failures = [];
  const seen = new Set();
  for (let index = 0; index < targets.length; index += 1) {
    if (signal?.aborted) throw abortError();
    const target = targets[index];
    let path = target.path || "";
    if (target.name) {
      path = await resolveKnownFolder(target.name, context, `fast_locate_${target.name}`);
      if (!path) {
        failures.push({ code: "known_folder_unavailable", message: `Windows did not report a ${target.name} folder.` });
        continue;
      }
    }
    const key = path.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    searched.push(path);
    emit(onActivity, "desktop_tool", `${task.intent} — searching ${path}`);

    const listed = await runLocalTool("list_directory", { path }, {
      callId: `fast_list_${index}`,
      conversation,
      steps,
      onActivity,
      signal,
      executeTool,
      summary: false
    });
    if (!listed?.ok) {
      failures.push(listed?.error || { code: "tool_execution_failed", message: `Could not list ${path}.` });
      // A denial is a decision about this run; asking for another folder right
      // away would only repeat the same card.
      if (listed?.error?.code === "approval_denied") break;
      continue;
    }
    const entries = Array.isArray(listed.data?.entries) ? listed.data.entries : [];
    for (const entry of entries) {
      if (entry?.kind !== "directory") continue;
      if (!String(entry.name || "").toLowerCase().includes(needle)) continue;
      if (typeof entry.path !== "string" || !entry.path.trim()) continue;
      matches.push({ name: entry.name, path: entry.path });
    }
    if (matches.length > 0) break;
  }

  if (matches.length > 0) {
    steps.push(folderLocateStep(task, true, { query, matches, searched }));
    return true;
  }

  const denied = failures.find(failure => failure?.code === "approval_denied");
  if (denied) {
    steps.push(folderLocateStep(task, false, { query, matches: [], searched }, denied));
    return false;
  }
  const detail = searched.length > 0
    ? `No folder named "${query}" was found in ${searched.join(", ")}.`
    : `No Windows folder could be read to look for "${query}".`;
  const firstFailure = failures[0];
  steps.push(
    folderLocateStep(
      task,
      false,
      { query, matches: [], searched },
      firstFailure && searched.length === 0
        ? firstFailure
        : { code: "not_found", message: detail }
    )
  );
  return false;
}

async function runFileSearch(task, { conversation, steps, onActivity, signal, executeTool, searchRoots = [] }) {
  const context = { conversation, steps, onActivity, signal, executeTool };
  const targets = [];
  if (task.folder) {
    targets.push({ name: task.folder });
  } else {
    for (const path of uniquePaths(searchRoots)) targets.push({ path });
    for (const name of SEARCH_ROOT_FOLDERS) targets.push({ name });
  }
  const searched = [];
  const failures = [];
  const seen = new Set();

  for (let index = 0; index < targets.length; index += 1) {
    if (signal?.aborted) throw abortError();
    const target = targets[index];
    let root = target.path || "";
    if (target.name) {
      root = await resolveKnownFolder(target.name, context, `fast_locate_${target.name}`);
      if (!root) {
        failures.push({ code: "known_folder_unavailable", message: `Windows did not report a ${target.name} folder.` });
        continue;
      }
    }
    const key = root.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    searched.push(root);
    emit(onActivity, "desktop_tool", `${task.intent} — searching ${root}`);
    const found = await runLocalTool("search_files", {
      root,
      query: task.query,
      maxDepth: 4,
      maxResults: task.limit || 20
    }, {
      callId: `fast_search_${index}`,
      conversation,
      steps,
      onActivity,
      signal,
      executeTool,
      summary: false
    });
    if (!found?.ok) {
      failures.push(found?.error || { code: "tool_execution_failed", message: `Could not search ${root}.` });
      if (found?.error?.code === "approval_denied") break;
      continue;
    }
    const entries = Array.isArray(found.data?.entries) ? found.data.entries : [];
    if (entries.length > 0) {
      steps.push({
        tool: "find_file",
        label: task.intent,
        ok: true,
        data: {
          query: task.query,
          root,
          entries,
          truncated: Boolean(found.data?.truncated),
          timedOut: Boolean(found.data?.timedOut)
        },
        error: null
      });
      return true;
    }
    // A timed-out search is a bounded answer, not a reason to spend the same
    // budget on every remaining folder.
    if (found.data?.timedOut) {
      failures.push({ code: "search_timed_out", message: `The search in ${root} reached the 5-second limit before finding a match.` });
      break;
    }
  }

  const denied = failures.find(failure => failure?.code === "approval_denied");
  const error = denied || (searched.length === 0 && failures[0]) || {
    code: "not_found",
    message: searched.length > 0
      ? `No file matching "${task.query}" was found in ${searched.join(", ")}.`
      : `No Windows folder could be read to search for "${task.query}".`
  };
  steps.push({
    tool: "find_file",
    label: task.intent,
    ok: false,
    data: { query: task.query, root: "", entries: [], searched },
    error
  });
  return false;
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
  operationId,
  chatId,
  userText,
  searchRoots = [],
  executeTool,
  onMeta,
  onChunk,
  onActivity
} = {}) {
  const runId = operationId || createRunId();
  const conversation = toRequestMessages(messages);
  const steps = [];
  const toolExecutor = typeof executeTool === "function" ? executeTool : executeDesktopTool;
  // Every native call carries the turn's operation id, so Stop can cancel the
  // exact paused approval or running scan and cannot touch another chat's work.
  // The chat id scopes "Allow Always" answers to this conversation only.
  const executeForOperation = (tool, args) =>
    toolExecutor(tool, args, {
      ...(operationId ? { operationId } : {}),
      ...(chatId ? { chatId } : {})
    });
  let step = 0;

  try {
    const fastTask = matchLocalFileTask(userText || lastUserText(messages));
    if (fastTask) {
      try {
        await runFastPath(fastTask, {
          conversation,
          steps,
          onActivity,
          signal,
          executeTool: executeForOperation,
          searchRoots
        });
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
        // A model step may legitimately take minutes (long reasoning, a large
        // tool result). Stop still aborts through the signal; there is no
        // artificial wall-clock cutoff on this request. A busy or unreachable
        // round is retried a bounded number of times before the turn is failed.
        data = await postDesktopToolRound(body, { signal });
      } catch (error) {
        if (signal?.aborted) throw abortError();
        // postDesktopToolRound already mapped the HTTP failure into this
        // taxonomy; mapping it again would erase the server status and turn a
        // 404 into a null-status network error.
        const failure = error instanceof DesktopChatError ? error : requestError(error);
        // The provider cannot receive tool definitions, so the model can never
        // see these tools. The tools already ran on the real filesystem, so the
        // verified local result is the answer; handing the turn to a model that
        // cannot see it is what produced "I can't search your filesystem".
        const localOnly = steps.length > 0 && failure.code === "tool_calling_unsupported";
        if (localOnly) {
          const content = localFilesystemSummary(steps);
          if (content) {
            onChunk?.(content);
            return {
              content,
              conversationId: conversationId || null,
              messageId: assistantMessageId || null,
              finishReason: "stop",
              saveWarning: null,
              artifact: null,
              artifacts: [],
              continuedFile: null,
              localSteps: steps,
              localOnly: true
            };
          }
        }
        throw attachLocalResults(failure, steps);
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
        if (signal?.aborted) throw abortError();
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
          signal,
          executeTool: executeForOperation
        });
        if (signal?.aborted) throw abortError();
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
    // waiting tool call no longer exists. Scoped to this operation so ending
    // one turn cannot deny a prompt raised by another.
    if (operationId) await cancelDesktopToolOperation(operationId).catch(() => {});
    else await cancelDesktopToolApprovals().catch(() => {});
  }
}
