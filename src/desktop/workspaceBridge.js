import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "../native/shell.js";

export { isTauriRuntime };

function tauriInvoke(command, args) {
  if (!isTauriRuntime()) {
    return Promise.reject(new Error("Workspace folders are available in the Windows app."));
  }
  return invoke(command, args);
}

function bridgeError(error, fallback) {
  if (typeof error === "string" && error.trim()) return error.trim();
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

export async function listWorkspaces(owner) {
  try {
    const workspaces = await tauriInvoke("workspace_list", { owner });
    return Array.isArray(workspaces) ? workspaces : [];
  } catch (error) {
    throw new Error(bridgeError(error, "Could not load local workspaces."));
  }
}

export async function touchWorkspace(owner, id) {
  try {
    return await tauriInvoke("workspace_touch", { owner, id });
  } catch (error) {
    throw new Error(bridgeError(error, "Could not update the workspace."));
  }
}

export async function pickWorkspace(owner) {
  try {
    return await tauriInvoke("workspace_pick", { owner });
  } catch (error) {
    throw new Error(bridgeError(error, "Could not open the folder picker."));
  }
}

// The parent half of creating a project: the dialog picks a location and
// registers nothing, so cancelling leaves no half-made workspace.
export async function pickContainerFolder() {
  try {
    return await tauriInvoke("workspace_pick_container", {});
  } catch (error) {
    throw new Error(bridgeError(error, "Could not open the folder picker."));
  }
}

export async function createWorkspaceFolder(owner, parent, name) {
  try {
    return await tauriInvoke("workspace_create", { owner, parent, name });
  } catch (error) {
    throw new Error(bridgeError(error, "Could not create the project folder."));
  }
}

// A task's folder is the app's own: the Rust side resolves the Windows Documents
// known folder, makes VupsRouter\Projects\<name> there, and registers it, so a
// project task never has to stop and ask where it should live.
export async function createTaskProject(owner, name) {
  const signedOwner = String(owner || "").trim();
  if (!signedOwner) throw new Error("A project task needs a signed-in owner.");
  const projectName = String(name || "").trim();
  if (!projectName) throw new Error("A project task needs a project name.");
  try {
    return await tauriInvoke("vups_root_project", { owner: signedOwner, name: projectName });
  } catch (error) {
    throw new Error(bridgeError(error, "Could not create the project folder."));
  }
}

// A machine with no registered folder still has one the app owns: the Rust side
// resolves Documents through the known-folder API, makes VupsRouter\Files there
// and registers it, so the panels get a real root without asking anyone.
export async function defaultTaskWorkspace(owner) {
  const signedOwner = String(owner || "").trim();
  if (!signedOwner) throw new Error("A default workspace needs a signed-in owner.");
  try {
    return await tauriInvoke("vups_root_default_workspace", { owner: signedOwner });
  } catch (error) {
    throw new Error(bridgeError(error, "VupsRouter could not prepare its own folder."));
  }
}

// The four settings-page actions on the app's own folder. Each one calls the
// command that actually does it; none of them reports a path the app invented.
export async function readStorageStatus() {
  try {
    return await tauriInvoke("vups_root_status", {});
  } catch (error) {
    throw new Error(bridgeError(error, "Could not read the workspace storage status."));
  }
}

export async function ensureStorageRoot() {
  try {
    return await tauriInvoke("vups_root_ensure", {});
  } catch (error) {
    throw new Error(bridgeError(error, "Could not create the VupsRouter folder."));
  }
}

export async function openStorageRoot() {
  try {
    return await tauriInvoke("vups_root_open", {});
  } catch (error) {
    throw new Error(bridgeError(error, "Windows could not open the folder."));
  }
}

export async function revealStorageRoot() {
  try {
    return await tauriInvoke("vups_root_reveal", {});
  } catch (error) {
    throw new Error(bridgeError(error, "Windows could not reveal the folder."));
  }
}

export async function addWorkspacePath(owner, path, title) {
  try {
    return await tauriInvoke("workspace_add_path", {
      owner,
      path,
      title: title === undefined || title === null ? null : String(title)
    });
  } catch (error) {
    throw new Error(bridgeError(error, "Could not open that folder."));
  }
}

export async function makeWorkspaceDirectory(owner, id, path) {
  try {
    return await tauriInvoke("workspace_make_directory", { owner, id, path });
  } catch (error) {
    throw new Error(bridgeError(error, "Could not create that folder."));
  }
}

export async function createWorkspaceFile(owner, id, path, content) {
  try {
    return await tauriInvoke("workspace_create_file", { owner, id, path, content });
  } catch (error) {
    throw new Error(bridgeError(error, "Could not create that file."));
  }
}

export async function writeWorkspaceFile(owner, id, path, content) {
  try {
    return await tauriInvoke("workspace_write_file", { owner, id, path, content });
  } catch (error) {
    throw new Error(bridgeError(error, "Could not save that file."));
  }
}

export async function renameWorkspacePath(owner, id, path, newName) {
  try {
    return await tauriInvoke("workspace_rename_path", { owner, id, path, newName });
  } catch (error) {
    throw new Error(bridgeError(error, "Could not rename that item."));
  }
}

export async function moveWorkspacePath(owner, id, path, directory) {
  try {
    return await tauriInvoke("workspace_move_path", { owner, id, path, directory });
  } catch (error) {
    throw new Error(bridgeError(error, "Could not move that item."));
  }
}

export async function deleteWorkspacePath(owner, id, path) {
  try {
    return await tauriInvoke("workspace_delete_path", { owner, id, path });
  } catch (error) {
    throw new Error(bridgeError(error, "Could not delete that item."));
  }
}

export async function renameWorkspace(owner, id, title) {
  try {
    return await tauriInvoke("workspace_rename", { owner, id, title });
  } catch (error) {
    throw new Error(bridgeError(error, "Could not rename the workspace."));
  }
}

export async function removeWorkspace(owner, id) {
  try {
    await tauriInvoke("workspace_remove", { owner, id });
  } catch (error) {
    throw new Error(bridgeError(error, "Could not remove the workspace."));
  }
}

export async function scanWorkspace(owner, id) {
  try {
    return await tauriInvoke("workspace_scan", { owner, id });
  } catch (error) {
    throw new Error(bridgeError(error, "Could not scan the workspace folder."));
  }
}

export async function readWorkspaceFile(owner, id, path) {
  try {
    return await tauriInvoke("workspace_read", { owner, id, path });
  } catch (error) {
    throw new Error(bridgeError(error, "Could not read this workspace file."));
  }
}

export async function readWorkspaceText(owner, id, path) {
  try {
    return await tauriInvoke("workspace_read_text", { owner, id, path });
  } catch (error) {
    throw new Error(bridgeError(error, "Could not read this workspace file."));
  }
}

export async function listWorkspaceTree(owner, id, path) {
  try {
    return await tauriInvoke("workspace_tree", { owner, id, path });
  } catch (error) {
    throw new Error(bridgeError(error, "Could not list this workspace folder."));
  }
}

export async function searchWorkspace(owner, id, query) {
  try {
    return await tauriInvoke("workspace_search", { owner, id, query });
  } catch (error) {
    throw new Error(bridgeError(error, "Could not search the workspace."));
  }
}

export async function reviewWorkspaceGit(owner, id) {
  try {
    return await tauriInvoke("workspace_git_review", { owner, id });
  } catch (error) {
    throw new Error(bridgeError(error, "Could not review this workspace's Git changes."));
  }
}
