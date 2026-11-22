import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "../context/AuthContext.jsx";
import {
  addWorkspacePath,
  createWorkspaceFolder,
  isTauriRuntime,
  listWorkspaces,
  pickContainerFolder,
  pickWorkspace,
  readWorkspaceFile,
  removeWorkspace as removeWorkspaceBridge,
  renameWorkspace as renameWorkspaceBridge,
  scanWorkspace,
  touchWorkspace as touchWorkspaceNative,
  validateWorkspace as validateWorkspaceNative
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
  // A load that has finished at least once. An empty registry is only proof of
  // "no project" after this flips; before that, the saved id is still valid.
  const [loaded, setLoaded] = useState(false);
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

  // An empty registry stays empty. The app never invents a project folder for a
  // user: the first terminal or agent request asks through the native picker,
  // and the folder the user chooses is what gets saved for this account on this
  // device. App storage (Documents\VupsRouter) is not a project and is never
  // adopted as one.
  useEffect(() => {
    setActiveId(loadActiveId(owner));
    setChatBindings(readChatBindings(browserStorage(), owner));
    setLoaded(false);
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
      })
      .catch(loadError => {
        if (!cancelled) setError(loadError.message);
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
          setLoaded(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [applyWorkspaces, owner, supported]);

  useEffect(() => {
    // The registry is empty while it is still loading and for a fresh account.
    // Only a completed load clears a stale id, and an empty registry leaves no
    // active project: the picker asks instead of the app choosing a folder.
    if (!loaded) return;
    if (!workspaces.length) {
      if (activeId) {
        setActiveId("");
        saveActiveId(owner, "");
      }
      return;
    }
    if (workspaces.some(workspace => workspace.id === activeId)) return;
    const next = workspaces[0].id;
    setActiveId(next);
    saveActiveId(owner, next);
  }, [activeId, loaded, owner, workspaces]);

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
      return list;
    } catch (loadError) {
      setError(loadError.message);
      throw loadError;
    } finally {
      setLoading(false);
      setLoaded(true);
    }
  }, [applyWorkspaces, owner, supported]);

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

  // The id a chat was explicitly bound to, even if that workspace is no longer
  // in this owner's registry. That distinction is what keeps a chat from
  // silently following the active project when its own folder disappeared.
  const chatBindingFor = useCallback(
    chatKey => {
      const key = typeof chatKey === "string" ? chatKey.trim() : "";
      return key ? chatBindings[key] || "" : "";
    },
    [chatBindings]
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

  // Re-checks an existing selection against the native registry before a chat
  // runs tools in it. A folder that has been deleted or moved fails here, so the
  // page can ask for a replacement instead of using a stale path.
  const validateWorkspaceById = useCallback(
    async id => {
      const verified = await validateWorkspaceNative(owner, id || activeId);
      applyWorkspaces(
        workspacesRef.current.map(workspace =>
          workspace.id === verified.id ? { ...workspace, ...verified } : workspace
        )
      );
      return verified;
    },
    [activeId, applyWorkspaces, owner]
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
      openFolderPath,
      selectWorkspace,
      renameWorkspace,
      removeWorkspace,
      workspaceForChat,
      chatBindingFor,
      bindChatWorkspace,
      scanWorkspace: scanWorkspaceById,
      validateWorkspace: validateWorkspaceById,
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
      openFolderPath,
      selectWorkspace,
      renameWorkspace,
      removeWorkspace,
      workspaceForChat,
      chatBindingFor,
      bindChatWorkspace,
      scanWorkspaceById,
      validateWorkspaceById,
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
