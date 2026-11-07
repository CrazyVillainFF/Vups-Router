import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useAuth } from "../context/AuthContext.jsx";
import {
  answerTrackedClarification,
  getTaskTrackerSnapshot,
  pollTaskTrackerOnce,
  refreshTrackedTask,
  setTaskTrackerOwner,
  startTaskTracker,
  stopTaskTracker,
  submitTrackedTask,
  cancelTrackedTask,
  resumeTrackedTask,
  subscribeToTaskTracker,
  watchTrackedTask
} from "./taskTracker.js";

/**
 * React's view of the module-level tracker.
 *
 * The provider adds nothing to the tracker's lifetime: it subscribes, and
 * unsubscribes. What it does own is the account the registry belongs to — the
 * tracker holds one user's tasks, so the provider hands the authenticated id
 * down and the registry is wiped when that id changes. Navigating between pages
 * inside the protected app does not unmount it, and a task is unaffected either
 * way.
 */

const TaskTrackerContext = createContext(null);

function subscribe(listener) {
  const unsubscribe = subscribeToTaskTracker(() => listener());
  return () => {
    unsubscribe();
  };
}

export function TaskTrackerProvider({ children, intervalMs }) {
  const { user, isAuthenticated } = useAuth();
  const snapshot = useSyncExternalStore(subscribe, getTaskTrackerSnapshot, getTaskTrackerSnapshot);
  const ownerId = isAuthenticated ? String(user?.id || user?.email || "") : "";
  // One intent, one task: the id names the submit that is currently wanted, and
  // survives a remount under it so nothing re-sends the same brief.
  const submissionSeq = useRef(0);

  useEffect(() => {
    setTaskTrackerOwner(ownerId);
    if (!ownerId) {
      stopTaskTracker();
      return undefined;
    }
    startTaskTracker({ intervalMs });
    return () => {
      stopTaskTracker();
    };
  }, [ownerId, intervalMs]);

  // Coming back from a suspend or a backgrounded tab should read what happened
  // while the app was away, not wait for the next interval.
  useEffect(() => {
    if (!ownerId || typeof document === "undefined") return undefined;
    const onVisible = () => {
      if (document.visibilityState === "visible") pollTaskTrackerOnce().catch(() => {});
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [ownerId]);

  const submit = useCallback((input, options = {}) => {
    const key = options.key ?? `submit-${++submissionSeq.current}`;
    return submitTrackedTask(input, { key });
  }, []);
  const cancel = useCallback(taskId => cancelTrackedTask(taskId), []);
  const resume = useCallback(taskId => resumeTrackedTask(taskId), []);
  const answer = useCallback(
    (taskId, clarificationId, text) => answerTrackedClarification(taskId, clarificationId, text),
    []
  );
  const refresh = useCallback(taskId => refreshTrackedTask(taskId), []);
  const poll = useCallback(() => pollTaskTrackerOnce(), []);

  const value = useMemo(
    () => ({
      snapshot,
      tasks: snapshot.tasks,
      status: snapshot.status,
      error: snapshot.error,
      errorKind: snapshot.errorKind,
      hydration: snapshot.hydration,
      owner: snapshot.owner,
      submit,
      cancel,
      resume,
      answer,
      refresh,
      poll
    }),
    [snapshot, submit, cancel, resume, answer, refresh, poll]
  );

  return <TaskTrackerContext.Provider value={value}>{children}</TaskTrackerContext.Provider>;
}

export function useTaskTracker() {
  const context = useContext(TaskTrackerContext);
  if (!context) throw new Error("useTaskTracker must be used inside a TaskTrackerProvider.");
  return context;
}

/**
 * One task, live. The returned value is null until the tracker knows the id,
 * which is what keeps a screen from rendering a placeholder row for work the
 * backend has never heard of.
 */
export function useTrackedTask(taskId) {
  const { poll } = useTaskTracker();
  const id = String(taskId || "");
  useEffect(() => {
    if (!id) return undefined;
    return watchTrackedTask(id);
  }, [id]);
  const select = useCallback(() => (id ? getTaskTrackerSnapshot().tasks.find(task => task.taskId === id) || null : null), [id]);
  const task = useSyncExternalStore(subscribe, select, select);
  useEffect(() => {
    if (!id) return;
    // A viewer that arrives late still has to see the progress already made.
    poll().catch(() => {});
  }, [id, poll]);
  return task;
}
