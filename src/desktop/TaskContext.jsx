import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  deleteConversation,
  fetchUsage,
  listConversations,
  renameConversation
} from "../services/api.js";

const TaskContext = createContext(null);

export function TaskProvider({ children }) {
  const [conversations, setConversations] = useState([]);
  const [localChats, setLocalChats] = useState([]);
  const [usage, setUsage] = useState(null);
  const [taskError, setTaskError] = useState("");
  const [usageError, setUsageError] = useState("");
  const [draftRequest, setDraftRequest] = useState(null);
  const localChatsRef = useRef(new Map());

  const refreshConversations = useCallback(async () => {
    try {
      const list = await listConversations();
      setConversations(list);
      setTaskError("");
      return list;
    } catch (error) {
      setTaskError(error.message || "Could not load task history.");
      throw error;
    }
  }, []);

  const refreshUsage = useCallback(async () => {
    try {
      const next = await fetchUsage();
      setUsage(next);
      setUsageError("");
      return next;
    } catch (error) {
      const message =
        error?.response?.status === 404
          ? "Usage is unavailable from the backend right now."
          : error.message || "Could not load usage.";
      setUsageError(message);
      return null;
    }
  }, []);

  useEffect(() => {
    refreshConversations().catch(() => {});
    refreshUsage();
  }, [refreshConversations, refreshUsage]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      refreshUsage();
    }, 60000);
    const onVisible = () => {
      if (document.visibilityState === "visible") refreshUsage();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refreshUsage]);

  const saveLocalChat = useCallback((entry, messages) => {
    if (!entry?.id) return;
    localChatsRef.current.set(entry.id, { entry, messages: Array.isArray(messages) ? messages : [] });
    setLocalChats(current => [entry, ...current.filter(chat => chat.id !== entry.id)]);
  }, []);

  const getLocalChat = useCallback(id => localChatsRef.current.get(id) || null, []);

  const renameTask = useCallback(
    async (id, title) => {
      if (String(id).startsWith("local-")) {
        const existing = localChatsRef.current.get(id);
        if (!existing) throw new Error("This local task is no longer available.");
        const entry = { ...existing.entry, title, updatedAt: new Date().toISOString() };
        localChatsRef.current.set(id, { ...existing, entry });
        setLocalChats(current => current.map(chat => (chat.id === id ? entry : chat)));
        return entry;
      }
      const updated = await renameConversation(id, title);
      setConversations(current => current.map(task => (task.id === id ? { ...task, ...updated } : task)));
      return updated;
    },
    []
  );

  const removeTask = useCallback(async id => {
    if (String(id).startsWith("local-")) {
      localChatsRef.current.delete(id);
      setLocalChats(current => current.filter(chat => chat.id !== id));
      return;
    }
    await deleteConversation(id);
    setConversations(current => current.filter(task => task.id !== id));
  }, []);

  const requestDraft = useCallback(text => {
    const value = String(text || "");
    if (!value.trim()) return;
    setDraftRequest({ text: value, key: Date.now() });
  }, []);

  const tasks = useMemo(() => {
    const known = new Set(conversations.map(task => task.id));
    const local = localChats.filter(task => !known.has(task.id));
    return local.length > 0 ? [...local, ...conversations] : conversations;
  }, [conversations, localChats]);

  const value = useMemo(
    () => ({
      conversations,
      setConversations,
      tasks,
      localChats,
      saveLocalChat,
      getLocalChat,
      refreshConversations,
      renameTask,
      removeTask,
      taskError,
      usage,
      usageError,
      refreshUsage,
      draftRequest,
      requestDraft
    }),
    [
      conversations,
      tasks,
      localChats,
      saveLocalChat,
      getLocalChat,
      refreshConversations,
      renameTask,
      removeTask,
      taskError,
      usage,
      usageError,
      refreshUsage,
      draftRequest,
      requestDraft
    ]
  );

  return <TaskContext.Provider value={value}>{children}</TaskContext.Provider>;
}

export function useTasks() {
  const context = useContext(TaskContext);
  if (!context) throw new Error("useTasks must be used inside a TaskProvider.");
  return context;
}
