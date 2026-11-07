import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowsClockwise,
  CaretUp,
  FilePlus,
  FileText,
  FolderSimple,
  FolderSimplePlus,
  MagnifyingGlass,
  PencilSimple,
  Trash,
  ArrowRight
} from "@phosphor-icons/react";
import { formatBytes } from "../../chat/attachments.js";
import { validateProjectName } from "../workspaceRequest.js";
import { useWorkspaces } from "../WorkspaceContext.jsx";
import { usePanel } from "./PanelContext.jsx";
import {
  createWorkspaceFile,
  deleteWorkspacePath,
  listWorkspaceTree,
  makeWorkspaceDirectory,
  moveWorkspacePath,
  readWorkspaceText,
  renameWorkspacePath,
  searchWorkspace,
  writeWorkspaceFile
} from "../workspaceBridge.js";

function parentPath(path) {
  if (!path) return "";
  const parts = path.split("/");
  parts.pop();
  return parts.join("/");
}

function joinPath(directory, name) {
  return directory ? `${directory}/${name}` : name;
}

// The native layer refuses a path that escapes the workspace, but saying so here
// costs nothing and turns a round trip into an instant message.
function pathStaysInside(path) {
  return !path.split("/").some(part => part === ".." || /^[A-Za-z]:/.test(part) || path.startsWith("\\"));
}

export default function FilesPane() {
  const { supported, owner, activeWorkspace, addWorkspace, revisions, touchWorkspace } = useWorkspaces();
  const { activeTab, open } = usePanel();
  const active = open && activeTab === "files";

  const [path, setPath] = useState("");
  const [tree, setTree] = useState({ path: "", entries: [], truncated: false });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState(null);
  const [searching, setSearching] = useState(false);
  const [file, setFile] = useState(null);
  const [opening, setOpening] = useState(false);
  const [creating, setCreating] = useState(null);
  const [createName, setCreateName] = useState("");
  const [renaming, setRenaming] = useState(null);
  const [renameValue, setRenameValue] = useState("");
  const [moving, setMoving] = useState(null);
  const [moveValue, setMoveValue] = useState("");
  const [confirming, setConfirming] = useState(null);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [working, setWorking] = useState(false);

  const workspaceId = activeWorkspace?.id || "";
  const revision = revisions?.[workspaceId] || 0;
  // The preview is re-read from disk after a real change, so the pane needs to
  // know which file it is showing without that knowledge feeding the effect's
  // dependency list — re-reading sets the file, which would re-run the effect.
  const previewPathRef = useRef("");

  const loadTree = useCallback(
    target => {
      if (!supported || !owner || !workspaceId) return;
      setLoading(true);
      setError("");
      listWorkspaceTree(owner, workspaceId, target)
        .then(result => {
          setTree({
            path: result?.path ?? target,
            entries: Array.isArray(result?.entries) ? result.entries : [],
            truncated: Boolean(result?.truncated)
          });
        })
        .catch(loadError => setError(loadError.message))
        .finally(() => setLoading(false));
    },
    [supported, owner, workspaceId]
  );

  const loadFile = useCallback(
    target => {
      if (!supported || !owner || !workspaceId) return;
      readWorkspaceText(owner, workspaceId, target)
        .then(result => setFile(result))
        .catch(() => {
          // The file is gone: say so once, and stop showing a body that no longer exists.
          setFile(null);
          previewPathRef.current = "";
          setEditing(false);
          setError(`${target} is no longer in this folder.`);
        });
    },
    [supported, owner, workspaceId]
  );

  useEffect(() => {
    setPath("");
    setHits(null);
    setQuery("");
    setFile(null);
    setEditing(false);
    previewPathRef.current = "";
    setCreating(null);
    setRenaming(null);
    setMoving(null);
    setConfirming(null);
  }, [workspaceId]);

  useEffect(() => {
    if (!active || !workspaceId || hits) return;
    loadTree(path);
  }, [active, workspaceId, path, hits, loadTree, revision]);

  // An agent write, a terminal command, or the pane's own save all bump the
  // revision; the preview follows the disk unless the user is mid-edit, in which
  // case their unsaved text wins.
  useEffect(() => {
    if (!revision || !active || !workspaceId || hits || editing) return;
    if (!previewPathRef.current) return;
    loadFile(previewPathRef.current);
  }, [revision, active, workspaceId, hits, editing, loadFile]);

  const run = async (action, successNotice) => {
    setWorking(true);
    setError("");
    setNotice("");
    try {
      await action();
      touchWorkspace(workspaceId);
      if (successNotice) setNotice(successNotice);
      return true;
    } catch (mutationError) {
      setError(mutationError.message);
      return false;
    } finally {
      setWorking(false);
    }
  };

  const submitCreate = async event => {
    event.preventDefault();
    const name = createName.trim();
    const invalid = validateProjectName(name);
    if (invalid) {
      setError(invalid);
      return;
    }
    const target = joinPath(path, name);
    if (!pathStaysInside(target)) {
      setError("That name cannot point outside the project folder.");
      return;
    }
    const isFolder = creating === "directory";
    const ok = await run(() =>
      isFolder
        ? makeWorkspaceDirectory(owner, workspaceId, target)
        : createWorkspaceFile(owner, workspaceId, target, "")
    );
    if (!ok) return;
    setCreating(null);
    setCreateName("");
    setNotice(`${target} was created on disk.`);
  };

  const submitRename = async entry => {
    const name = renameValue.trim();
    const invalid = validateProjectName(name);
    if (invalid) {
      setError(invalid);
      return;
    }
    const ok = await run(() => renameWorkspacePath(owner, workspaceId, entry.path, name));
    if (!ok) return;
    if (previewPathRef.current === entry.path) {
      previewPathRef.current = joinPath(parentPath(entry.path), name);
    }
    setRenaming(null);
    setNotice(`${entry.path} is now named ${name}.`);
  };

  const submitMove = async entry => {
    const destination = moveValue.trim().replace(/\\/g, "/").replace(/\/+$/, "");
    if (destination && !pathStaysInside(destination)) {
      setError("Choose a folder inside this project.");
      return;
    }
    const ok = await run(() => moveWorkspacePath(owner, workspaceId, entry.path, destination || "."));
    if (!ok) return;
    if (previewPathRef.current === entry.path) {
      previewPathRef.current = joinPath(destination, entry.name);
    }
    setMoving(null);
    setNotice(`${entry.name} moved to ${destination || activeWorkspace?.title || "the project root"}.`);
  };

  const confirmDelete = async entry => {
    const ok = await run(() => deleteWorkspacePath(owner, workspaceId, entry.path));
    if (!ok) return;
    if (previewPathRef.current === entry.path) {
      previewPathRef.current = "";
      setFile(null);
      setEditing(false);
    }
    setConfirming(null);
    setNotice(`${entry.path} was deleted from disk.`);
  };

  const saveDraft = async () => {
    if (!file) return;
    setSaving(true);
    const ok = await run(() => writeWorkspaceFile(owner, workspaceId, file.path, draft));
    setSaving(false);
    if (!ok) return;
    setEditing(false);
    setNotice(`${file.path} saved to disk.`);
  };

  const runSearch = () => {
    const needle = query.trim();
    if (!needle || !workspaceId) return;
    setSearching(true);
    setError("");
    searchWorkspace(owner, workspaceId, needle)
      .then(result => setHits(Array.isArray(result?.hits) ? result.hits : []))
      .catch(searchError => setError(searchError.message))
      .finally(() => setSearching(false));
  };

  const openFile = entry => {
    if (!entry.readable || entry.restricted) return;
    setOpening(true);
    setError("");
    setEditing(false);
    readWorkspaceText(owner, workspaceId, entry.path)
      .then(result => {
        setFile(result);
        setDraft(result?.content || "");
        previewPathRef.current = entry.path;
      })
      .catch(readError => setError(readError.message))
      .finally(() => setOpening(false));
  };

  const startRename = entry => {
    setConfirming(null);
    setMoving(null);
    setRenaming(entry);
    setRenameValue(entry.name);
  };

  const startMove = entry => {
    setConfirming(null);
    setRenaming(null);
    setMoving(entry);
    setMoveValue(parentPath(entry.path));
  };

  const startDelete = entry => {
    setRenaming(null);
    setMoving(null);
    setConfirming(entry);
  };

  const entries = useMemo(
    () =>
      // ASCII-lowercase comparison repeats the native sort so a re-sort cannot disagree with Rust.
      [...tree.entries].sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
        const left = a.name.toLowerCase();
        const right = b.name.toLowerCase();
        if (left === right) return 0;
        return left < right ? -1 : 1;
      }),
    [tree.entries]
  );

  if (!supported) {
    return <div className="vr-pane-note">Workspace files are available in the Windows app.</div>;
  }
  if (!activeWorkspace) {
    return (
      <div className="vr-pane-note">
        Choose a project folder to browse its files here.
        <button type="button" className="vr-panel-action" onClick={() => addWorkspace().catch(() => {})}>
          <FolderSimplePlus size={14} aria-hidden="true" />
          Choose folder
        </button>
      </div>
    );
  }

  return (
    <div className="vr-files-pane">
      <div className="vr-pane-toolbar">
        <span className="vr-pane-title" title={activeWorkspace.path || activeWorkspace.title}>
          {activeWorkspace.title || "Workspace"}
        </span>
        <button
          type="button"
          className="vr-icon-btn"
          onClick={() => setCreating("directory")}
          disabled={Boolean(creating) || working}
          aria-label="New folder in this location"
          title="New folder"
        >
          <FolderSimplePlus size={14} />
        </button>
        <button
          type="button"
          className="vr-icon-btn"
          onClick={() => setCreating("file")}
          disabled={Boolean(creating) || working}
          aria-label="New file in this location"
          title="New file"
        >
          <FilePlus size={14} />
        </button>
        <button
          type="button"
          className="vr-icon-btn"
          onClick={() => loadTree(path)}
          disabled={loading || working}
          aria-label="Refresh files"
          title="Refresh"
        >
          <ArrowsClockwise size={14} />
        </button>
      </div>

      <form
        className="vr-pane-search"
        onSubmit={event => {
          event.preventDefault();
          runSearch();
        }}
      >
        <MagnifyingGlass size={14} aria-hidden="true" />
        <input
          type="search"
          value={query}
          onChange={event => setQuery(event.target.value)}
          placeholder="Search file names and contents"
          aria-label="Search workspace"
        />
      </form>

      {creating ? (
        <form className="vr-pane-inline-form" onSubmit={submitCreate}>
          <input
            autoFocus
            type="text"
            value={createName}
            onChange={event => setCreateName(event.target.value)}
            placeholder={creating === "directory" ? "New folder name" : "New file name, e.g. index.html"}
            aria-label={creating === "directory" ? "New folder name" : "New file name"}
          />
          <button type="submit" className="vr-panel-action" disabled={working}>
            {working ? "Creating…" : creating === "directory" ? "Create folder" : "Create file"}
          </button>
          <button type="button" className="vr-link-btn" onClick={() => setCreating(null)}>
            Cancel
          </button>
        </form>
      ) : null}

      {hits ? (
        <div className="vr-pane-crumb">
          <span>{hits.length} search result{hits.length === 1 ? "" : "s"}</span>
          <button type="button" className="vr-link-btn" onClick={() => setHits(null)}>
            Back to folder
          </button>
        </div>
      ) : (
        <div className="vr-pane-crumb">
          <button
            type="button"
            className="vr-link-btn"
            disabled={!path}
            onClick={() => setPath(parentPath(path))}
            aria-label="Up one folder"
          >
            <CaretUp size={13} aria-hidden="true" /> Up
          </button>
          <span className="vr-pane-crumb__path" title={path}>{path || activeWorkspace.title || "root"}</span>
        </div>
      )}

      {error ? <div className="vr-inline-error">{error}</div> : null}
      {notice ? <div className="vr-pane-note">{notice}</div> : null}

      {searching || loading || opening ? <div className="vr-pane-note">Loading…</div> : null}

      {confirming ? (
        <div className="vr-pane-confirm" role="group" aria-label="Confirm delete">
          <span>
            Delete <strong>{confirming.path}</strong>
            {confirming.kind === "directory" ? " and everything inside it" : ""} from disk?
          </span>
          <button type="button" className="vr-panel-action vr-pane-confirm__danger" onClick={() => confirmDelete(confirming)} disabled={working}>
            {working ? "Deleting…" : "Delete"}
          </button>
          <button type="button" className="vr-link-btn" onClick={() => setConfirming(null)}>
            Keep it
          </button>
        </div>
      ) : null}

      {hits ? (
        hits.length === 0 ? (
          <div className="vr-pane-note">No files match “{query.trim()}”.</div>
        ) : (
          <ul className="vr-pane-list">
            {hits.map(hit => (
              <li key={`${hit.path}:${hit.line ?? 0}`}>
                <button
                  type="button"
                  className="vr-pane-row"
                  onClick={() => openFile({ path: hit.path, name: hit.name, readable: true, restricted: false })}
                >
                  <FileText size={14} aria-hidden="true" />
                  <span className="vr-pane-row__name">{hit.name}</span>
                  <span className="vr-pane-row__path">{hit.path}</span>
                </button>
              </li>
            ))}
          </ul>
        )
      ) : (
        <ul className="vr-pane-list">
          {entries.map(entry => (
            <li key={entry.path}>
              {renaming?.path === entry.path ? (
                <div className="vr-pane-inline-form">
                  <input
                    autoFocus
                    type="text"
                    value={renameValue}
                    onChange={event => setRenameValue(event.target.value)}
                    onKeyDown={event => event.key === "Enter" && submitRename(entry)}
                    aria-label="New name"
                  />
                  <button type="button" className="vr-panel-action" onClick={() => submitRename(entry)} disabled={working}>
                    {working ? "Renaming…" : "Rename"}
                  </button>
                  <button type="button" className="vr-link-btn" onClick={() => setRenaming(null)}>
                    Cancel
                  </button>
                </div>
              ) : moving?.path === entry.path ? (
                <div className="vr-pane-inline-form">
                  <input
                    autoFocus
                    type="text"
                    value={moveValue}
                    onChange={event => setMoveValue(event.target.value)}
                    onKeyDown={event => event.key === "Enter" && submitMove(entry)}
                    placeholder="Destination folder inside the project"
                    aria-label="Destination folder"
                  />
                  <button type="button" className="vr-panel-action" onClick={() => submitMove(entry)} disabled={working}>
                    {working ? "Moving…" : "Move"}
                  </button>
                  <button type="button" className="vr-link-btn" onClick={() => setMoving(null)}>
                    Cancel
                  </button>
                </div>
              ) : (
                <div className="vr-pane-row" data-restricted={entry.restricted ? "true" : undefined}>
                  {entry.kind === "directory" ? (
                    <button type="button" className="vr-pane-row__main" onClick={() => setPath(entry.path)}>
                      <FolderSimple size={14} aria-hidden="true" />
                      <span className="vr-pane-row__name">{entry.name}/</span>
                      {entry.restricted ? <span className="vr-pane-badge">restricted</span> : null}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="vr-pane-row__main"
                      disabled={!entry.readable || entry.restricted}
                      onClick={() => openFile(entry)}
                    >
                      <FileText size={14} aria-hidden="true" />
                      <span className="vr-pane-row__name">{entry.name}</span>
                      {entry.readable ? (
                        <span className="vr-pane-row__path">{formatBytes(entry.size)}</span>
                      ) : (
                        <span className="vr-pane-badge">{entry.restricted ? "restricted" : "not previewable"}</span>
                      )}
                    </button>
                  )}
                  <span className="vr-pane-row__actions">
                    <button
                      type="button"
                      className="vr-icon-btn"
                      onClick={() => startRename(entry)}
                      disabled={Boolean(confirming)}
                      aria-label={`Rename ${entry.name}`}
                      title="Rename"
                    >
                      <PencilSimple size={13} />
                    </button>
                    <button
                      type="button"
                      className="vr-icon-btn"
                      onClick={() => startMove(entry)}
                      disabled={Boolean(confirming)}
                      aria-label={`Move ${entry.name}`}
                      title="Move"
                    >
                      <ArrowRight size={13} />
                    </button>
                    <button
                      type="button"
                      className="vr-icon-btn"
                      onClick={() => startDelete(entry)}
                      aria-label={`Delete ${entry.name}`}
                      title="Delete"
                    >
                      <Trash size={13} />
                    </button>
                  </span>
                </div>
              )}
            </li>
          ))}
          {entries.length === 0 && !loading ? (
            <li className="vr-pane-note">
              This folder is empty. Use
              <button type="button" className="vr-link-btn" onClick={() => setCreating("file")}>
                New file
              </button>
              to start the project, or ask the agent to build it here.
            </li>
          ) : null}
        </ul>
      )}

      {file ? (
        <div className="vr-file-preview">
          <div className="vr-file-preview__head">
            <span title={file.path}>{file.path}</span>
            {editing ? (
              <>
                <button type="button" className="vr-panel-action" onClick={saveDraft} disabled={saving}>
                  {saving ? "Saving…" : "Save"}
                </button>
                <button
                  type="button"
                  className="vr-link-btn"
                  onClick={() => {
                    setEditing(false);
                    setDraft(file.content || "");
                  }}
                >
                  Discard edits
                </button>
              </>
            ) : (
              <button
                type="button"
                className="vr-panel-action"
                // Saving a truncated preview would write back only the part that
                // was read, so the rest of the file would silently disappear.
                disabled={file.truncated}
                title={file.truncated ? "Too large to edit safely from the panel" : "Edit this file"}
                onClick={() => {
                  setDraft(file.content || "");
                  setEditing(true);
                }}
              >
                Edit
              </button>
            )}
            <button
              type="button"
              className="vr-link-btn"
              onClick={() => {
                setFile(null);
                setEditing(false);
                previewPathRef.current = "";
              }}
            >
              Close
            </button>
          </div>
          {editing ? (
            <textarea
              className="vr-file-editor"
              value={draft}
              onChange={event => setDraft(event.target.value)}
              spellCheck={false}
              aria-label={`Edit ${file.path}`}
            />
          ) : (
            <pre className="vr-file-preview__body">{file.content}</pre>
          )}
          {file.truncated ? <p className="vr-pane-note">Preview truncated at the size limit.</p> : null}
        </div>
      ) : null}

      {tree.truncated && !hits ? (
        <p className="vr-pane-note">The listing stopped at the folder limit; use search to reach deeper files.</p>
      ) : null}
    </div>
  );
}
