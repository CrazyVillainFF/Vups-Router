import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "../context/AuthContext.jsx";
import {
  addWorkspacePath,
  createTaskProject as createTaskProjectBridge,
  createWorkspaceFolder,
  defaultTaskWorkspace,
  isTauriRuntime,
  listWorkspaces,
  pickContainerFolder,
  pickWorkspace,
  readWorkspaceFile,
  removeWorkspace as removeWorkspaceBridge,
  renameWorkspace as renameWorkspaceBridge,
  scanWorkspace,
  touchWorkspace as touchWorkspaceNative
} from "./workspaceBridge.js";
import {
  chatWorkspaceFor,
  readChatBindings,
  setChatBinding,
  withoutWorkspace,
  writeChatBindings
} from "./chatWorkspaceBindings.js";

const WorkspaceContext = createContext(null);

function browserStorage() {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function activeKey(owner) {
  return `vupsrouter.desktop.active-workspace.${owner || "guest"}.v1`;
}

function loadActiveId(owner) {
  try {
    return browserStorage()?.getItem(activeKey(owner)) || "";
  } catch {
    return "";
  }
}

function saveActiveId(owner, id) {
  try {
    const storage = browserStorage();
    if (!storage) return;
    if (id) storage.setItem(activeKey(owner), id);
    else storage.removeItem(activeKey(owner));
  } catch {
    /* storage is best-effort */
  }
}

export function WorkspaceProvider({ children }) {
  const { user } = useAuth();
  const owner = user?.id || "";
  const supported = isTauriRuntime();
  const [workspaces, setWorkspaces] = useState([]);
  // Binding a chat to a folder is validated against the registry, and a folder
  // created moments ago is in state only after a render. The ref is the list as
  // it is right now, so the same tick that adopts a workspace can also bind it.
  const workspacesRef = useRef([]);
  const applyWorkspaces = useCallback(next => {
    const list = Array.isArray(next) ? next : [];
    workspacesRef.current = list;
    setWorkspaces(list);
  }, []);
  const [activeId, setActiveId] = useState(() => loadActiveId(owner));
  const [chatBindings, setChatBindings] = useState(() => readChatBindings(browserStorage(), owner));
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  // A folder's contents change from three directions — the panel's own edits, the
  // agent's native tools, and a terminal command. Each bumps this counter so an
  // open explorer re-reads disk instead of showing a listing the project has
  // already outgrown. Nothing here polls or ticks; it only reacts to real events.
  const [revisions, setRevisions] = useState({});
  const touchWorkspace = useCallback(id => {
    if (!id) return;
    setRevisions(current => ({ ...current, [id]: (current[id] || 0) + 1 }));
  }, []);

  // Every native flow returns one workspace record; this is the single place
  // that makes it the active folder so the three entry points cannot drift.
  const adopt = useCallback(
    workspace => {
      if (!workspace) return null;
      applyWorkspaces([workspace, ...workspacesRef.current.filter(item => item.id !== workspace.id)]);
      setActiveId(workspace.id);
      saveActiveId(owner, workspace.id);
      return workspace;
    },
    [applyWorkspaces, owner]
  );

  // An empty registry is not a question for the user. The app owns one folder —
  // VupsRouter\Files inside the Windows Documents folder — and Rust both makes
  // it and registers it, so the files panel, the terminal and the agent start
  // with the same real root on a machine that has never picked a project.
  const seedDefaultWorkspace = useCallback(async () => {
    try {
      const workspace = await defaultTaskWorkspace(owner);
      if (!workspace) return null;
      adopt(workspace);
      setError("");
      return workspace;
    } catch (seedError) {
      setError(seedError.message);
      return null;
    }
  }, [adopt, owner]);

  useEffect(() => {
    setActiveId(loadActiveId(owner));
    setChatBindings(readChatBindings(browserStorage(), owner));
    if (!supported || !owner) {
      applyWorkspaces([]);
      setError("");
      return;
    }
    let cancelled = false;
    setLoading(true);
    listWorkspaces(owner)
      .then(list => {
        if (cancelled) return;
        applyWorkspaces(list);
        setError("");
        if (!list.length) return seedDefaultWorkspace();
      })
      .catch(loadError => {
        if (!cancelled) setError(loadError.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [applyWorkspaces, owner, seedDefaultWorkspace, supported]);

  useEffect(() => {
    // The workspace list is empty while it is still loading. Clearing the saved
    // id at that moment would erase the folder the user had open and make the
    // first row the fallback; wait until there is a real list to validate against.
    if (!workspaces.length) return;
    if (workspaces.some(workspace => workspace.id === activeId)) return;
    const next = workspaces[0].id;
    setActiveId(next);
    saveActiveId(owner, next);
  }, [workspaces, activeId, owner]);

  const selectWorkspace = useCallback(
    id => {
      const next = workspaces.some(workspace => workspace.id === id) ? id : "";
      setActiveId(next);
      saveActiveId(owner, next);
      // The native registry is the source of truth across launches. Browser
      // storage is origin-scoped, and the desktop server port can change, so a
      // folder selection must also update the native recency order.
      if (next) touchWorkspaceNative(owner, next).catch(() => {});
    },
    [workspaces, owner]
  );

  const refresh = useCallback(async () => {
    if (!supported || !owner) return [];
    setLoading(true);
    try {
      const list = await listWorkspaces(owner);
      applyWorkspaces(list);
      setError("");
      if (!list.length) await seedDefaultWorkspace();
      return list;
    } catch (loadError) {
      setError(loadError.message);
      throw loadError;
    } finally {
      setLoading(false);
    }
  }, [applyWorkspaces, owner, seedDefaultWorkspace, supported]);

  const requireNative = useCallback(() => {
    if (!supported || !owner) {
      throw new Error("Workspace folders are available in the Windows app.");
    }
  }, [owner, supported]);

  const addWorkspace = useCallback(async () => {
    requireNative();
    setBusy("add");
    setError("");
    try {
      return adopt(await pickWorkspace(owner));
    } catch (pickError) {
      setError(pickError.message);
      throw pickError;
    } finally {
      setBusy("");
    }
  }, [adopt, owner, requireNative]);

  const pickProjectLocation = useCallback(async () => {
    requireNative();
    setBusy("parent");
    setError("");
    try {
      return await pickContainerFolder();
    } catch (pickError) {
      setError(pickError.message);
      throw pickError;
    } finally {
      setBusy("");
    }
  }, [requireNative]);

  const createProject = useCallback(
    async (parent, name) => {
      requireNative();
      setBusy("create");
      setError("");
      try {
        return adopt(await createWorkspaceFolder(owner, parent, name));
      } catch (createError) {
        setError(createError.message);
        throw createError;
      } finally {
        setBusy("");
      }
    },
    [adopt, owner, requireNative]
  );

  // The folder a project task writes into, made in the location the app owns in
  // the Windows Documents folder. Nothing is asked of the user: the name comes
  // from the task, and Rust picks a free spelling of it.
  const createTaskProject = useCallback(
    async name => {
      requireNative();
      setBusy("task-project");
      setError("");
      try {
        return adopt(await createTaskProjectBridge(owner, name));
      } catch (taskError) {
        setError(taskError.message);
        throw taskError;
      } finally {
        setBusy("");
      }
    },
    [adopt, owner, requireNative]
  );

  const openFolderPath = useCallback(
    async (path, title) => {
      requireNative();
      setBusy("open");
      setError("");
      try {
        return adopt(await addWorkspacePath(owner, path, title));
      } catch (openError) {
        setError(openError.message);
        throw openError;
      } finally {
        setBusy("");
      }
    },
    [adopt, owner, requireNative]
  );

  const renameWorkspace = useCallback(
    async (id, title) => {
      setBusy(`rename:${id}`);
      setError("");
      try {
        const renamed = await renameWorkspaceBridge(owner, id, title);
        applyWorkspaces(
          workspacesRef.current.map(workspace =>
            workspace.id === id ? { ...workspace, ...renamed } : workspace
          )
        );
        return renamed;
      } catch (renameError) {
        setError(renameError.message);
        throw renameError;
      } finally {
        setBusy("");
      }
    },
    [applyWorkspaces, owner]
  );

  const removeWorkspace = useCallback(
    async id => {
      setBusy(`remove:${id}`);
      setError("");
      try {
        await removeWorkspaceBridge(owner, id);
        const next = workspacesRef.current.filter(workspace => workspace.id !== id);
        applyWorkspaces(next);
        if (id === activeId) {
          const fallback = next[0]?.id || "";
          setActiveId(fallback);
          saveActiveId(owner, fallback);
        }
        // A removed folder must not stay attached to any chat.
        setChatBindings(current => {
          const bindings = withoutWorkspace(current, id);
          writeChatBindings(browserStorage(), owner, bindings);
          return bindings;
        });
      } catch (removeError) {
        setError(removeError.message);
        throw removeError;
      } finally {
        setBusy("");
      }
    },
    [activeId, applyWorkspaces, owner]
  );

  const workspaceForChat = useCallback(
    chatKey => chatWorkspaceFor(workspaces, chatBindings, chatKey),
    [chatBindings, workspaces]
  );

  // Attaching or replacing a chat's folder is an explicit user decision. An
  // empty id detaches the chat without touching any other chat or the folder.
  const bindChatWorkspace = useCallback(
    (chatKey, workspaceId) => {
      setChatBindings(current => {
        const next = setChatBinding(current, chatKey, workspaceId, workspacesRef.current);
        writeChatBindings(browserStorage(), owner, next);
        return next;
      });
    },
    [owner]
  );

  const scanWorkspaceById = useCallback(
    async id => scanWorkspace(owner, id || activeId),
    [activeId, owner]
  );

  const readFile = useCallback(
    async (path, id) => readWorkspaceFile(owner, id || activeId, path),
    [activeId, owner]
  );

  const activeWorkspace = useMemo(
    () => workspaces.find(workspace => workspace.id === activeId) || null,
    [workspaces, activeId]
  );

  const value = useMemo(
    () => ({
      supported,
      owner,
      workspaces,
      activeWorkspace,
      activeId,
      loading,
      busy,
      error,
      revisions,
      touchWorkspace,
      refresh,
      addWorkspace,
      pickProjectLocation,
      createProject,
      createTaskProject,
      openFolderPath,
      selectWorkspace,
      renameWorkspace,
      removeWorkspace,
      workspaceForChat,
      bindChatWorkspace,
      scanWorkspace: scanWorkspaceById,
      readFile
    }),
    [
      supported,
      owner,
      workspaces,
      activeWorkspace,
      activeId,
      loading,
      busy,
      error,
      revisions,
      touchWorkspace,
      refresh,
      addWorkspace,
      pickProjectLocation,
      createProject,
      createTaskProject,
      openFolderPath,
      selectWorkspace,
      renameWorkspace,
      removeWorkspace,
      workspaceForChat,
      bindChatWorkspace,
      scanWorkspaceById,
      readFile
    ]
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspaces() {
  const context = useContext(WorkspaceContext);
  if (!context) throw new Error("useWorkspaces must be used inside a WorkspaceProvider.");
  return context;
}
