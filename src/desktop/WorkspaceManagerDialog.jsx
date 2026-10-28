import React, { useEffect, useState } from "react";
import {
  ArrowsClockwise,
  Check,
  FolderSimple,
  PencilSimple,
  Plus,
  Trash,
  X
} from "@phosphor-icons/react";
import HoldToDeleteDialog from "../components/HoldToDeleteDialog.jsx";
import { useWorkspaces } from "./WorkspaceContext.jsx";

export default function WorkspaceManagerDialog({ open, onClose }) {
  const {
    supported,
    workspaces,
    activeId,
    loading,
    busy,
    error,
    refresh,
    addWorkspace,
    selectWorkspace,
    renameWorkspace,
    removeWorkspace
  } = useWorkspaces();
  const [renamingId, setRenamingId] = useState("");
  const [title, setTitle] = useState("");
  const [localError, setLocalError] = useState("");
  const [deleteTarget, setDeleteTarget] = useState(null);

  useEffect(() => {
    if (!open) {
      setRenamingId("");
      setTitle("");
      setLocalError("");
      setDeleteTarget(null);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = event => {
      if (event.key === "Escape" && !deleteTarget) onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [deleteTarget, open, onClose]);

  if (!open) return null;

  const beginRename = workspace => {
    setRenamingId(workspace.id);
    setTitle(workspace.title);
    setLocalError("");
  };

  const submitRename = async event => {
    event.preventDefault();
    if (!renamingId) return;
    try {
      await renameWorkspace(renamingId, title);
      setRenamingId("");
      setTitle("");
    } catch (renameError) {
      setLocalError(renameError.message);
    }
  };

  const add = async () => {
    setLocalError("");
    try {
      await addWorkspace();
    } catch (addError) {
      setLocalError(addError.message);
    }
  };

  const requestRemove = workspace => {
    setDeleteTarget(workspace);
  };

  const remove = async () => {
    const workspace = deleteTarget;
    if (!workspace?.id) {
      throw new Error("This workspace is no longer available.");
    }
    setLocalError("");
    try {
      await removeWorkspace(workspace.id);
    } catch (removeError) {
      throw new Error(removeError.message);
    }
  };

  return (
    <>
    <div className="vr-modal-backdrop" onPointerDown={event => event.target === event.currentTarget && onClose()}>
      <section className="vr-modal vr-workspace-modal" role="dialog" aria-modal="true" aria-labelledby="vr-workspace-title">
        <header className="vr-modal-head">
          <div>
            <span className="vr-modal-kicker">LOCAL FOLDERS</span>
            <h2 id="vr-workspace-title">Workspaces</h2>
          </div>
          <button type="button" className="vr-icon-btn" onClick={onClose} aria-label="Close workspaces">
            <X size={18} />
          </button>
        </header>

        <p className="vr-modal-copy">
          Add a project folder to browse text files and attach selected files to a task. VupsRouter keeps the folder
          on your PC and never uploads files until you send a task.
        </p>

        {!supported ? (
          <div className="vr-empty-state">
            Folder workspaces are available in the Windows desktop app. The website can still attach files with the
            composer.
          </div>
        ) : (
          <>
            <div className="vr-workspace-toolbar">
              <button type="button" className="vr-primary-small" onClick={add} disabled={Boolean(busy)}>
                <Plus size={15} weight="bold" /> {busy === "add" ? "Opening picker..." : "Add folder"}
              </button>
              <button type="button" className="vr-secondary-small" onClick={() => refresh().catch(() => {})} disabled={loading}>
                <ArrowsClockwise size={14} /> Refresh
              </button>
            </div>

            {localError || error ? <div className="vr-inline-error">{localError || error}</div> : null}

            {workspaces.length === 0 && !loading ? (
              <div className="vr-empty-state">No workspaces yet. Add a project folder to get started.</div>
            ) : (
              <ul className="vr-workspace-list">
                {workspaces.map(workspace => (
                  <li key={workspace.id} className="vr-workspace-item" data-active={workspace.id === activeId ? "" : undefined}>
                    <span className="vr-workspace-icon" aria-hidden="true"><FolderSimple size={18} /></span>
                    <div className="vr-workspace-main">
                      {renamingId === workspace.id ? (
                        <form className="vr-workspace-rename" onSubmit={submitRename}>
                          <input
                            value={title}
                            onChange={event => setTitle(event.target.value)}
                            maxLength={60}
                            autoFocus
                            aria-label="Workspace name"
                          />
                          <button type="submit" aria-label="Save workspace name"><Check size={14} /></button>
                          <button type="button" onClick={() => setRenamingId("")} aria-label="Cancel rename"><X size={14} /></button>
                        </form>
                      ) : (
                        <>
                          <span className="vr-workspace-name">{workspace.title}</span>
                          <span className="vr-workspace-path" title={workspace.path}>{workspace.path}</span>
                        </>
                      )}
                    </div>
                    <div className="vr-workspace-actions">
                      <button
                        type="button"
                        className="vr-workspace-use"
                        aria-pressed={workspace.id === activeId}
                        onClick={() => selectWorkspace(workspace.id)}
                      >
                        {workspace.id === activeId ? "Active" : "Use"}
                      </button>
                      <button type="button" className="vr-icon-btn" onClick={() => beginRename(workspace)} aria-label={`Rename ${workspace.title}`} title="Rename">
                        <PencilSimple size={14} />
                      </button>
                      <button type="button" className="vr-icon-btn vr-icon-btn--danger" onClick={() => requestRemove(workspace)} aria-label={`Remove ${workspace.title}`} title="Remove">
                        <Trash size={14} />
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}

        <footer className="vr-modal-foot">
          <span>Excluded automatically: secrets, keys, environment files, dependencies, build output, and binary files.</span>
          <button type="button" className="vr-secondary-small" onClick={onClose}>Done</button>
        </footer>
      </section>
    </div>
    <HoldToDeleteDialog
      open={Boolean(deleteTarget)}
      title="Remove this workspace?"
      itemName={deleteTarget?.title || "Workspace"}
      description="This removes the workspace from VupsRouter. The folder and its files on disk are not deleted."
      successMessage="Workspace removed."
      onCancel={() => setDeleteTarget(null)}
      onConfirm={remove}
    />
    </>
  );
}
