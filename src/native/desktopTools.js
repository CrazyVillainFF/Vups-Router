import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isTauriRuntime } from "./shell.js";

export const DESKTOP_TOOL_LABELS = Object.freeze({
  get_windows_known_folder: "Finding the Windows folder",
  list_directory: "Listing a local folder",
  list_recent_files: "Finding the newest local files",
  read_file: "Reading a local file",
  search_files: "Searching local files",
  read_file_metadata: "Reading file metadata"
});

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
  return DESKTOP_TOOL_LABELS[name] || "Using a local filesystem tool";
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

export async function executeDesktopTool(tool, args) {
  requireDesktop();
  try {
    return await invoke("desktop_tool_execute", {
      request: {
        tool,
        args: args && typeof args === "object" ? args : {}
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
  if (!requestId || !scopePath) return null;
  return {
    requestId,
    approvalKey: typeof request.approvalKey === "string" ? request.approvalKey : requestId,
    tool: typeof request.tool === "string" ? request.tool : "",
    action: typeof request.action === "string" ? request.action : "read",
    scopePath,
    scopeName: typeof request.scopeName === "string" ? request.scopeName : "",
    summary: typeof request.summary === "string" ? request.summary : `Read ${scopePath}`,
    access: request.access === "contents" ? "contents" : "read",
    readOnly: request.readOnly !== false,
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

export async function listDesktopToolGrants() {
  if (!isTauriRuntime()) return [];
  try {
    const grants = await invoke("desktop_tool_grants_list");
    return Array.isArray(grants) ? grants : [];
  } catch (error) {
    // The list is the user's view of what the app may keep reading, so a silent
    // empty list would look like "nothing is allowed" when it means "unknown".
    throw new Error(bridgeError(error, "Could not read the saved folder permissions."));
  }
}

export async function revokeDesktopToolGrant(id) {
  requireDesktop();
  try {
    return await invoke("desktop_tool_grant_revoke", { id: String(id || "") });
  } catch (error) {
    throw new Error(bridgeError(error, "That folder permission could not be revoked."));
  }
}

export async function clearDesktopToolGrants() {
  requireDesktop();
  try {
    return await invoke("desktop_tool_grants_clear");
  } catch (error) {
    throw new Error(bridgeError(error, "The saved folder permissions could not be cleared."));
  }
}
