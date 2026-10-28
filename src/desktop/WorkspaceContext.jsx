import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useAuth } from "../context/AuthContext.jsx";
import {
  isTauriRuntime,
  listWorkspaces,
  pickWorkspace,
  readWorkspaceFile,
  removeWorkspace as removeWorkspaceBridge,
  renameWorkspace as renameWorkspaceBridge,
  scanWorkspace
} from "./workspaceBridge.js";

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
  const [activeId, setActiveId] = useState(() => loadActiveId(owner));
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    setActiveId(loadActiveId(owner));
    if (!supported || !owner) {
      setWorkspaces([]);
      setError("");
      return;
    }
    let cancelled = false;
    setLoading(true);
    listWorkspaces(owner)
      .then(list => {
        if (cancelled) return;
        setWorkspaces(list);
        setError("");
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
  }, [owner, supported]);

  useEffect(() => {
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
  }, [workspaces, activeId, owner]);

  const selectWorkspace = useCallback(
    id => {
      const next = workspaces.some(workspace => workspace.id === id) ? id : "";
      setActiveId(next);
      saveActiveId(owner, next);
    },
    [workspaces, owner]
  );

  const refresh = useCallback(async () => {
    if (!supported || !owner) return [];
    setLoading(true);
    try {
      const list = await listWorkspaces(owner);
      setWorkspaces(list);
      setError("");
      return list;
    } catch (loadError) {
      setError(loadError.message);
      throw loadError;
    } finally {
      setLoading(false);
    }
  }, [owner, supported]);

  const addWorkspace = useCallback(async () => {
    if (!supported || !owner) {
      throw new Error("Workspace folders are available in the Windows app.");
    }
    setBusy("add");
    setError("");
    try {
      const workspace = await pickWorkspace(owner);
      if (!workspace) return null;
      setWorkspaces(current => [workspace, ...current.filter(item => item.id !== workspace.id)]);
      setActiveId(workspace.id);
      saveActiveId(owner, workspace.id);
      return workspace;
    } catch (pickError) {
      setError(pickError.message);
      throw pickError;
    } finally {
      setBusy("");
    }
  }, [owner, supported]);

  const renameWorkspace = useCallback(
    async (id, title) => {
      setBusy(`rename:${id}`);
      setError("");
      try {
        const renamed = await renameWorkspaceBridge(owner, id, title);
        setWorkspaces(current =>
          current.map(workspace => (workspace.id === id ? { ...workspace, ...renamed } : workspace))
        );
        return renamed;
      } catch (renameError) {
        setError(renameError.message);
        throw renameError;
      } finally {
        setBusy("");
      }
    },
    [owner]
  );

  const removeWorkspace = useCallback(
    async id => {
      setBusy(`remove:${id}`);
      setError("");
      try {
        await removeWorkspaceBridge(owner, id);
        setWorkspaces(current => {
          const next = current.filter(workspace => workspace.id !== id);
          if (id === activeId) {
            const fallback = next[0]?.id || "";
            setActiveId(fallback);
            saveActiveId(owner, fallback);
          }
          return next;
        });
      } catch (removeError) {
        setError(removeError.message);
        throw removeError;
      } finally {
        setBusy("");
      }
    },
    [activeId, owner]
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
      refresh,
      addWorkspace,
      selectWorkspace,
      renameWorkspace,
      removeWorkspace,
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
      refresh,
      addWorkspace,
      selectWorkspace,
      renameWorkspace,
      removeWorkspace,
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
