import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import {
  CaretDown,
  CaretUp,
  ChatCircle,
  Check,
  FolderSimple,
  Folders,
  Gear,
  MagnifyingGlass,
  PencilSimple,
  Plus,
  PuzzlePiece,
  Question,
  Robot,
  Sidebar as SidebarIcon,
  SignOut,
  SlidersHorizontal,
  Sparkle,
  Trash,
  X
} from "@phosphor-icons/react";
import VupsLogo from "../components/VupsLogo.jsx";
import { useAuth } from "../context/AuthContext.jsx";
import { detectNativeShell } from "../native/shell.js";
import { getApiErrorMessage, searchConversations } from "../services/api.js";
import { usePreferences } from "./PreferencesContext.jsx";
import { useTasks } from "./TaskContext.jsx";
import { useWorkspaces } from "./WorkspaceContext.jsx";
import WorkspaceManagerDialog from "./WorkspaceManagerDialog.jsx";
import HoldToDeleteDialog from "../components/HoldToDeleteDialog.jsx";

const TOOLS_CLOSED_KEY = "vupsrouter.sidebarToolsClosed";

function formatTaskTime(value, show) {
  if (!show || !value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  return sameDay
    ? date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function initialsFor(user) {
  const source = String(user?.name || user?.email || "U").trim();
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length > 1) return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  return source.slice(0, 2).toUpperCase();
}

export default function DesktopSidebar({
  collapsed,
  onToggle,
  onExpand,
  mobileOpen,
  onMobileClose,
  user,
  onSignOut
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const sidebarSearch = useRef(null);
  const { preferences } = usePreferences();
  const { tasks, renameTask, removeTask, usage, usageError } = useTasks();
  const {
    supported: workspaceSupported,
    workspaces,
    activeId: activeWorkspaceId,
    busy: workspaceBusy,
    error: workspaceError,
    addWorkspace,
    selectWorkspace
  } = useWorkspaces();
  const nativeShell = detectNativeShell();
  const [term, setTerm] = useState("");
  const [results, setResults] = useState(null);
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [renamingId, setRenamingId] = useState("");
  const [renameValue, setRenameValue] = useState("");
  const [renameError, setRenameError] = useState("");
  const [renaming, setRenaming] = useState("");
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [workspaceActionError, setWorkspaceActionError] = useState("");
  const [deleteTarget, setDeleteTarget] = useState(null);
  const searchSeq = useRef(0);

  const activeTaskId = location.pathname === "/chat" ? searchParams.get("task") || "" : "";
  const showWorkspaces = workspaceSupported && nativeShell === "windows";
  const searchMode = term.trim().length > 0;
  const visibleTasks = searchMode ? results || [] : tasks.slice(0, 24);

  useEffect(() => {
    const query = term.trim();
    searchSeq.current += 1;
    const seq = searchSeq.current;
    if (!query) {
      setResults(null);
      setSearchBusy(false);
      setSearchError("");
      return undefined;
    }
    setSearchBusy(true);
    setSearchError("");
    const timer = window.setTimeout(() => {
      searchConversations(query)
        .then(list => {
          if (seq !== searchSeq.current) return;
          setResults(list);
        })
        .catch(error => {
          if (seq !== searchSeq.current) return;
          setResults([]);
          setSearchError(getApiErrorMessage(error));
        })
        .finally(() => {
          if (seq === searchSeq.current) setSearchBusy(false);
        });
    }, 240);
    return () => window.clearTimeout(timer);
  }, [term]);

  const [toolsClosed, setToolsClosed] = useState(() => window.localStorage.getItem(TOOLS_CLOSED_KEY) === "1");

  useEffect(() => {
    window.localStorage.setItem(TOOLS_CLOSED_KEY, toolsClosed ? "1" : "0");
  }, [toolsClosed]);

  const usageLabel = useMemo(() => {
    if (!usage) return usageError ? "Usage unavailable" : "Loading usage...";
    return `${usage.dailyUsed} of ${usage.dailyQuota} requests today`;
  }, [usage, usageError]);

  const usagePercent = usage && usage.dailyQuota > 0
    ? Math.min(100, Math.round((usage.dailyUsed / usage.dailyQuota) * 100))
    : 0;

  const taskHref = id => {
    const params = new URLSearchParams(searchParams);
    params.delete("new");
    params.set("task", id);
    return `/chat?${params.toString()}`;
  };

  const openSearch = () => {
    if (collapsed) onExpand();
    window.requestAnimationFrame(() => sidebarSearch.current?.focus({ preventScroll: true }));
  };

  const newTask = () => {
    onMobileClose();
    navigate("/chat", { state: { newTask: Date.now() } });
  };

  const beginRename = task => {
    setRenamingId(task.id);
    setRenameValue(task.title || "");
    setRenameError("");
  };

  const submitRename = async event => {
    event.preventDefault();
    if (!renamingId) return;
    const title = renameValue.replace(/\s+/g, " ").trim();
    if (!title) {
      setRenameError("Enter a task name.");
      return;
    }
    setRenaming(renamingId);
    setRenameError("");
    try {
      await renameTask(renamingId, title);
      setResults(current =>
        current ? current.map(task => (task.id === renamingId ? { ...task, title } : task)) : current
      );
      setRenamingId("");
      setRenameValue("");
    } catch (error) {
      setRenameError(error.message || "Could not rename this task.");
    } finally {
      setRenaming("");
    }
  };

  const requestDeleteTask = task => {
    setDeleteTarget(task);
  };

  const deleteTask = async () => {
    const task = deleteTarget;
    if (!task?.id) {
      throw new Error("This task is no longer available.");
    }
    try {
      await removeTask(task.id);
    } catch (error) {
      throw new Error(getApiErrorMessage(error));
    }
    setResults(current => (current ? current.filter(item => item.id !== task.id) : current));
    if (task.id === activeTaskId) {
      navigate("/chat", { replace: true, state: { newTask: Date.now() } });
    }
  };

  const addWorkspaceFolder = async () => {
    setWorkspaceActionError("");
    try {
      await addWorkspace();
    } catch (error) {
      setWorkspaceActionError(error.message);
    }
  };

  const navClass = path => `vr-nav-item${location.pathname === path ? " vr-nav-item--active" : ""}`;

  useEffect(() => {
    const onKeyDown = event => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === "k") {
        event.preventDefault();
        openSearch();
      } else if (key === "n") {
        event.preventDefault();
        newTask();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [collapsed]);

  return (
    <>
      {mobileOpen && <div className="vr-sidebar-backdrop" onClick={onMobileClose} aria-hidden="true" />}
      <aside
        id="vr-sidebar"
        className={`vr-sidebar vr-desktop-sidebar${collapsed ? " vr-sidebar--collapsed" : ""}${
          mobileOpen ? " vr-sidebar--mobile-open" : ""
        }`}
        aria-label="Workspace sidebar"
      >
        <div className="vr-sidebar-top">
          <Link
            to="/chat"
            className="vr-brand"
            aria-label="VupsRouter chat"
            onClick={onMobileClose}
          >
            <span className="vr-brand-mark" aria-hidden="true"><VupsLogo /></span>
            {!collapsed && <span className="vr-brand-name">vups<span>router</span></span>}
          </Link>
          <button
            className="vr-sidebar-toggle"
            onClick={onToggle}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            <SidebarIcon size={18} />
          </button>
        </div>

        <button className="vr-new-chat-btn" onClick={newTask} aria-label="New task" title="New task">
          <Plus size={16} weight="bold" />
          {!collapsed && <span>New task</span>}
        </button>

        {!collapsed ? (
          <div className="vr-task-search" data-active={searchMode ? "" : undefined}>
            <MagnifyingGlass size={15} aria-hidden="true" />
            <input
              ref={sidebarSearch}
              type="search"
              value={term}
              onChange={event => setTerm(event.target.value)}
              placeholder="Search tasks"
              aria-label="Search tasks"
              spellCheck={false}
            />
            {term ? (
              <button type="button" onClick={() => setTerm("")} aria-label="Clear task search">
                <X size={13} />
              </button>
            ) : null}
          </div>
        ) : (
          <button type="button" className="vr-sidebar-icon-btn" onClick={openSearch} aria-label="Search tasks" title="Search tasks">
            <MagnifyingGlass size={17} />
          </button>
        )}

          <div className="vr-sidebar-scroll">
            <div className="vr-sidebar-body">
            {showWorkspaces && !collapsed ? (
              <section className="vr-sidebar-section vr-workspaces-section" aria-label="Workspaces">
                <div className="vr-sidebar-label-row">
                  <span className="vr-sidebar-label">Workspaces</span>
                  <span className="vr-sidebar-label-actions">
                    <button
                      type="button"
                      onClick={addWorkspaceFolder}
                      disabled={Boolean(workspaceBusy)}
                      aria-label="Add workspace folder"
                      title="Add workspace folder"
                    >
                      <Plus size={13} />
                    </button>
                    <button
                      type="button"
                      onClick={() => setWorkspaceOpen(true)}
                      aria-label="Manage workspaces"
                      title="Manage workspaces"
                    >
                      <Gear size={13} />
                    </button>
                  </span>
                </div>
                {workspaces.length === 0 ? (
                  <button type="button" className="vr-workspace-empty" onClick={addWorkspaceFolder} disabled={Boolean(workspaceBusy)}>
                    <Folders size={15} />
                    <span>Add a project folder</span>
                  </button>
                ) : (
                  <ul className="vr-workspace-shortlist" role="list">
                    {workspaces.slice(0, 4).map(workspace => (
                      <li key={workspace.id}>
                        <button
                          type="button"
                          className="vr-workspace-shortcut"
                          data-active={workspace.id === activeWorkspaceId ? "" : undefined}
                          onClick={() => selectWorkspace(workspace.id)}
                          title={workspace.path}
                        >
                          <FolderSimple size={14} />
                          <span>{workspace.title}</span>
                          {workspace.id === activeWorkspaceId ? <Check size={12} /> : null}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {workspaces.length > 4 ? (
                  <button type="button" className="vr-workspace-more" onClick={() => setWorkspaceOpen(true)}>
                    +{workspaces.length - 4} more
                  </button>
                ) : null}
                {workspaceActionError || workspaceError ? (
                  <span className="vr-sidebar-error">{workspaceActionError || workspaceError}</span>
                ) : null}
              </section>
            ) : null}

            <section className="vr-sidebar-section vr-tasks-section" aria-label="Task history">
              <div className="vr-sidebar-label-row">
                <span className="vr-sidebar-label">{searchMode ? "Search results" : "Recent tasks"}</span>
                {searchBusy ? <span className="vr-sidebar-mini-status">Searching...</span> : null}
              </div>
              {searchError ? <div className="vr-sidebar-error">{searchError}</div> : null}
              {visibleTasks.length === 0 && !searchBusy ? (
                <div className="vr-sidebar-empty">
                  {searchMode ? "No tasks match this search." : "No tasks yet. Start with New task."}
                </div>
              ) : (
                <ul className="vr-conv-list" role="list">
                  {visibleTasks.map(task => (
                    <li key={task.id} className="vr-conv-row">
                      {renamingId === task.id ? (
                        <form className="vr-task-rename" onSubmit={submitRename}>
                          <input
                            value={renameValue}
                            onChange={event => setRenameValue(event.target.value)}
                            maxLength={60}
                            autoFocus
                            aria-label="Task name"
                            onKeyDown={event => {
                              if (event.key === "Escape") {
                                event.preventDefault();
                                setRenamingId("");
                                setRenameError("");
                              }
                            }}
                          />
                          <button type="submit" aria-label="Save task name" disabled={renaming === task.id}>
                            <Check size={13} />
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setRenamingId("");
                              setRenameError("");
                            }}
                            aria-label="Cancel rename"
                          >
                            <X size={13} />
                          </button>
                          {renameError ? <span className="vr-task-rename-error">{renameError}</span> : null}
                        </form>
                      ) : (
                        <>
                          <Link
                            to={taskHref(task.id)}
                            className={`vr-conv-item${task.id === activeTaskId ? " vr-conv-item--active" : ""}`}
                            onClick={onMobileClose}
                            title={task.title}
                          >
                            <ChatCircle size={14} aria-hidden="true" className="vr-conv-icon" />
                            <span className="vr-conv-copy">
                              <span className="vr-conv-title">{task.title || "Untitled task"}</span>
                              {searchMode && task.match ? (
                                <span className="vr-conv-match">{task.match}</span>
                              ) : preferences.showTaskTimestamps ? (
                                <span className="vr-conv-time">{formatTaskTime(task.updatedAt, true)}</span>
                              ) : null}
                            </span>
                          </Link>
                          <span className="vr-conv-actions">
                            <button
                              type="button"
                              onClick={() => beginRename(task)}
                              aria-label={`Rename ${task.title}`}
                              title="Rename task"
                            >
                              <PencilSimple size={13} />
                            </button>
                            <button
                              type="button"
                              className="vr-conv-delete"
                              onClick={() => requestDeleteTask(task)}
                              aria-label={`Delete ${task.title}`}
                              title="Delete task"
                            >
                              <Trash size={13} />
                            </button>
                          </span>
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
            </div>

          </div>

          <div className="vr-sidebar-nav-wrap">
            <nav
              className={`vr-sidebar-nav${!collapsed && toolsClosed ? " vr-sidebar-nav--closed" : ""}`}
              aria-label="App navigation"
            >
              <div className="vr-sidebar-nav-inner" inert={!collapsed && toolsClosed}>
                <Link to="/automations" className={navClass("/automations")} title="Automations" onClick={onMobileClose}>
                  <Robot size={16} aria-hidden="true" />
                  {!collapsed && <span>Automations</span>}
                </Link>
                <Link to="/plugins" className={navClass("/plugins")} title="Plugins" onClick={onMobileClose}>
                  <PuzzlePiece size={16} aria-hidden="true" />
                  {!collapsed && <span>Plugins</span>}
                </Link>
                <Link to="/help" className={navClass("/help")} title="Help" onClick={onMobileClose}>
                  <Question size={16} aria-hidden="true" />
                  {!collapsed && <span>Help</span>}
                </Link>
                <Link to="/settings" className={navClass("/settings")} title="API settings" onClick={onMobileClose}>
                  <Gear size={16} aria-hidden="true" />
                  {!collapsed && <span>API settings</span>}
                </Link>
                <Link to="/app-settings" className={navClass("/app-settings")} title="Application settings" onClick={onMobileClose}>
                  <SlidersHorizontal size={16} aria-hidden="true" />
                  {!collapsed && <span>Application settings</span>}
                </Link>
              </div>
            </nav>

            {!collapsed ? (
              <div className="vr-nav-toggle">
                <button
                  type="button"
                  onClick={() => setToolsClosed(true)}
                  disabled={toolsClosed}
                  aria-label="Close tools menu"
                  title="Close tools menu"
                  aria-expanded={!toolsClosed}
                >
                  <CaretUp size={13} weight="bold" />
                </button>
                <button
                  type="button"
                  onClick={() => setToolsClosed(false)}
                  disabled={!toolsClosed}
                  aria-label="Open tools menu"
                  title="Open tools menu"
                  aria-expanded={!toolsClosed}
                >
                  <CaretDown size={13} weight="bold" />
                </button>
              </div>
            ) : null}
          </div>

          {!collapsed ? (
            <Link to="/account" className={`vr-usage-card${location.pathname === "/account" ? " vr-usage-card--active" : ""}`} title={usageError || usageLabel}>
              <span className="vr-usage-head">
                <span><Sparkle size={13} /> Daily usage</span>
                <strong>{usage ? `${usage.remaining} left` : "—"}</strong>
              </span>
              <span className="vr-usage-bar" aria-hidden="true">
                <span style={{ width: `${usagePercent}%` }} />
              </span>
              <span className="vr-usage-foot">
                <span>{usageLabel}</span>
                {usage?.resetAt ? <span>Resets {new Date(usage.resetAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span> : null}
              </span>
            </Link>
          ) : null}

        <div className="vr-account-row">
          <Link to="/account" className="vr-account-link" title={user?.email || "Account"} onClick={onMobileClose}>
            <span className="vr-account-avatar" aria-hidden="true">{initialsFor(user)}</span>
            {!collapsed && (
              <span className="vr-account-copy">
                <strong>{user?.name || "Account"}</strong>
                <span>{user?.email || ""}</span>
              </span>
            )}
          </Link>
          <button type="button" className="vr-account-signout" onClick={onSignOut} aria-label="Sign out" title="Sign out">
            <SignOut size={16} />
          </button>
        </div>
      </aside>

      <WorkspaceManagerDialog open={workspaceOpen} onClose={() => setWorkspaceOpen(false)} />
      <HoldToDeleteDialog
        open={Boolean(deleteTarget)}
        title="Delete this task?"
        itemName={deleteTarget?.title || "Untitled task"}
        description="This permanently deletes the conversation and its messages. This cannot be undone."
        successMessage="Task deleted."
        onCancel={() => setDeleteTarget(null)}
        onConfirm={deleteTask}
      />
    </>
  );
}
