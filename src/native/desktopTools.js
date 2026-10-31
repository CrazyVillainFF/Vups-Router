import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isTauriRuntime } from "./shell.js";

export const DESKTOP_TOOL_LABELS = Object.freeze({
  get_windows_known_folder: "Finding the Windows folder",
  list_directory: "Listing a local folder",
  list_recent_files: "Finding the newest local files",
  read_file: "Reading a local file",
  search_files: "Searching local files",
  read_file_metadata: "Reading file metadata",
  search_file_contents: "Searching inside local files",
  create_directory: "Creating a folder",
  write_file: "Writing a local file",
  append_file: "Appending to a local file",
  edit_file: "Editing a local file",
  rename_path: "Renaming a local item",
  move_path: "Moving a local item",
  copy_path: "Copying a local item",
  delete_path: "Deleting a local item",
  open_path: "Opening a local item",
  open_url: "Opening a link",
  list_installed_apps: "Checking installed apps",
  find_app: "Finding an installed app",
  launch_app: "Launching an app",
  open_with_app: "Opening a file with an app",
  list_processes: "Checking running apps",
  close_app: "Closing an app",
  run_command: "Running a command",
  start_command: "Starting a background command",
  command_output: "Reading command output",
  stop_command: "Stopping a background command"
});

const ACCESS_VALUES = new Set(["read", "contents", "write", "delete", "launch", "execute", "app", "system"]);

export const DESKTOP_TOOL_PERMISSION_EVENT = "desktop-tool:approval";
export const DESKTOP_TOOL_PERMISSION_TTL_MS = 120_000;

function bridgeError(error, fallback) {
  if (typeof error === "string" && error.trim()) return error.trim();
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

function requireDesktop() {
  if (!isTauriRuntime()) {
    throw new Error("Local Windows filesystem tools are available in the VupsRouter desktop app.");
  }
}

export function desktopToolLabel(name) {
  return DESKTOP_TOOL_LABELS[name] || "Using a local Windows tool";
}

export async function setDesktopToolPolicy({ owner, mode, workspaceId }) {
  requireDesktop();
  try {
    return await invoke("desktop_tool_set_policy", {
      input: {
        owner,
        mode,
        workspaceId: workspaceId || null
      }
    });
  } catch (error) {
    throw new Error(bridgeError(error, "Could not update the Windows filesystem permission mode."));
  }
}

export async function getDesktopToolPolicy() {
  requireDesktop();
  try {
    return await invoke("desktop_tool_policy_status");
  } catch (error) {
    throw new Error(bridgeError(error, "Could not read the Windows filesystem permission mode."));
  }
}

export async function executeDesktopTool(tool, args, { operationId } = {}) {
  requireDesktop();
  try {
    return await invoke("desktop_tool_execute", {
      request: {
        tool,
        args: args && typeof args === "object" ? args : {},
        operationId: typeof operationId === "string" && operationId ? operationId : null
      }
    });
  } catch (error) {
    throw new Error(bridgeError(error, "The Windows filesystem tool did not run."));
  }
}

export function normalizeDesktopToolPrompt(payload) {
  const request = payload?.payload || payload || {};
  const requestId = typeof request.requestId === "string" ? request.requestId : "";
  const scopePath = typeof request.scopePath === "string" ? request.scopePath : "";
  if (!requestId) return null;
  if (!scopePath && typeof request.command !== "string") return null;
  const access = ACCESS_VALUES.has(request.access) ? request.access : "read";
  return {
    requestId,
    approvalKey: typeof request.approvalKey === "string" ? request.approvalKey : requestId,
    operationId: typeof request.operationId === "string" ? request.operationId : "",
    tool: typeof request.tool === "string" ? request.tool : "",
    action: typeof request.action === "string" ? request.action : "read",
    scopePath,
    scopeName: typeof request.scopeName === "string" ? request.scopeName : "",
    summary:
      typeof request.summary === "string" && request.summary
        ? request.summary
        : scopePath
          ? `Access ${scopePath}`
          : "Approve a local Windows operation",
    access,
    // The native layer decides whether this exact file or executable may be
    // remembered. The card must never infer a broader grant than that.
    canPersist: request.canPersist === true,
    readOnly: request.readOnly !== false,
    modifiesData: request.modifiesData === true,
    destructive: request.destructive === true,
    command: typeof request.command === "string" && request.command.trim() ? request.command : "",
    details: Array.isArray(request.details)
      ? request.details.filter(detail => typeof detail === "string" && detail.trim()).slice(0, 12)
      : [],
    expiresAt: Number.isFinite(request.expiresAt) ? request.expiresAt : Date.now() + DESKTOP_TOOL_PERMISSION_TTL_MS
  };
}

// Subscribes to the native layer's approval requests. The native tool call is
// paused until the card is answered, so nothing here can grant access on its
// own: the decision is revalidated against the pending request id in Rust.
export function onDesktopToolApproval(onRequest) {
  if (!isTauriRuntime()) return () => {};
  let disposed = false;
  let unlisten = null;
  listen(DESKTOP_TOOL_PERMISSION_EVENT, event => {
    if (disposed) return;
    const prompt = normalizeDesktopToolPrompt(event);
    if (prompt) onRequest(prompt);
  })
    .then(dispose => {
      if (disposed) dispose();
      else unlisten = dispose;
    })
    .catch(() => {});
  return () => {
    disposed = true;
    unlisten?.();
  };
}

// Only the three decisions the native layer understands can leave this module;
// anything else is a denial, so a mis-wired button can never grant access.
export function normalizeApprovalDecision(decision) {
  return ["once", "always", "deny"].includes(decision) ? decision : "deny";
}

export async function respondDesktopToolApproval(requestId, decision) {
  requireDesktop();
  const normalized = normalizeApprovalDecision(decision);
  try {
    return await invoke("desktop_tool_respond", {
      input: { requestId: String(requestId || ""), decision: normalized }
    });
  } catch (error) {
    throw new Error(bridgeError(error, "That permission request could not be delivered."));
  }
}

export async function cancelDesktopToolApprovals() {
  if (!isTauriRuntime()) return [];
  try {
    const ids = await invoke("desktop_tool_approvals_cancel");
    return Array.isArray(ids) ? ids : [];
  } catch {
    return [];
  }
}

// Cancels one turn: denies approvals it is still waiting on and tells a running
// native tool to stop before its next filesystem access. Nothing outside this
// operation is affected.
export async function cancelDesktopToolOperation(operationId) {
  if (!isTauriRuntime()) return [];
  const id = typeof operationId === "string" ? operationId.trim() : "";
  if (!id) return [];
  try {
    const ids = await invoke("desktop_tool_cancel_operation", {
      input: { operationId: id }
    });
    return Array.isArray(ids) ? ids : [];
  } catch {
    return [];
  }
}

export async function listDesktopToolGrants() {
  if (!isTauriRuntime()) return [];
  try {
    const grants = await invoke("desktop_tool_grants_list");
    return Array.isArray(grants) ? grants : [];
  } catch (error) {
    // The list is the user's view of what the app may keep accessing, so a silent
    // empty list would look like "nothing is allowed" when it means "unknown".
    throw new Error(bridgeError(error, "Could not read the saved file permissions."));
  }
}

export async function revokeDesktopToolGrant(id) {
  requireDesktop();
  try {
    return await invoke("desktop_tool_grant_revoke", { id: String(id || "") });
  } catch (error) {
    throw new Error(bridgeError(error, "That file permission could not be revoked."));
  }
}

export async function clearDesktopToolGrants() {
  requireDesktop();
  try {
    return await invoke("desktop_tool_grants_clear");
  } catch (error) {
    throw new Error(bridgeError(error, "The saved file permissions could not be cleared."));
  }
}
