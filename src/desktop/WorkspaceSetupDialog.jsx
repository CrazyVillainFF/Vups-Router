import React, { useEffect, useMemo, useState } from "react";
import { FolderSimplePlus, FolderOpen, X, MapPin } from "@phosphor-icons/react";
import { useWorkspaces } from "./WorkspaceContext.jsx";
import { pathCandidates, suggestProjectName, validateProjectName } from "./workspaceRequest.js";

/* The Windows workspace decision point. The agent will not invent a folder, so
   this dialog is the only place one is created: a name the user types, a parent
   location taken from the native picker, and one native call that makes the real
   directory. Cancelling never leaves a half-made workspace behind. */
export default function WorkspaceSetupDialog({ open, onClose, prompt = "", suggestedPath = "", onReady }) {
  const { supported, busy, error, addWorkspace, pickProjectLocation, createProject, openFolderPath } =
    useWorkspaces();
  const [name, setName] = useState("");
  const [parent, setParent] = useState("");
  const [nameError, setNameError] = useState("");
  const [localError, setLocalError] = useState("");

  useEffect(() => {
    if (!open) return;
    setName(suggestProjectName(prompt));
    setParent("");
    setNameError("");
    setLocalError("");
  }, [open, prompt]);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = event => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  const completedPath = useMemo(() => {
    if (!parent || !name.trim()) return "";
    const separator = parent.endsWith("\\") || parent.endsWith("/") ? "" : parent.includes("\\") ? "\\" : "/";
    return `${parent}${separator}${name.trim()}`;
  }, [name, parent]);

  const typedPaths = useMemo(() => {
    const fromPrompt = pathCandidates(prompt);
    if (fromPrompt.length) return fromPrompt;
    return suggestedPath ? [suggestedPath] : [];
  }, [prompt, suggestedPath]);

  if (!open) return null;

  const fail = setupError => setLocalError(setupError?.message || String(setupError));

  const chooseLocation = async () => {
    setLocalError("");
    try {
      const location = await pickProjectLocation();
      if (location) setParent(location);
    } catch (pickError) {
      fail(pickError);
    }
  };

  const create = async event => {
    event.preventDefault();
    const problem = validateProjectName(name);
    setNameError(problem);
    if (problem) return;
    if (!parent) {
      setLocalError("Choose the folder to create the project inside.");
      return;
    }
    try {
      const workspace = await createProject(parent, name.trim());
      if (workspace) onReady?.(workspace);
      onClose();
    } catch (createError) {
      fail(createError);
    }
  };

  const useExisting = async () => {
    setLocalError("");
    try {
      const workspace = await addWorkspace();
      if (workspace) onReady?.(workspace);
      onClose();
    } catch (addError) {
      fail(addError);
    }
  };

  // The folder the user named is the longest prefix of their own text that
  // exists on this PC, so the candidates are tried in that order and the record
  // that comes back — with its real path — is what the chat is given.
  const openTypedPath = async () => {
    setLocalError("");
    let lastMessage = "";
    for (const candidate of typedPaths) {
      try {
        const workspace = await openFolderPath(candidate);
        if (workspace) onReady?.(workspace);
        onClose();
        return;
      } catch (openError) {
        lastMessage = openError?.message || String(openError);
      }
    }
    setLocalError(lastMessage || "That folder was not found on this PC.");
  };

  return (
    <div
      className="vr-modal-backdrop"
      onPointerDown={event => event.target === event.currentTarget && onClose()}
    >
      <section
        className="vr-modal vr-workspace-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="vr-workspace-setup-title"
      >
        <header className="vr-modal-head">
          <div>
            <span className="vr-modal-kicker">WINDOWS PROJECT FOLDER</span>
            <h2 id="vr-workspace-setup-title">Where should this work live?</h2>
          </div>
          <button type="button" className="vr-icon-btn" onClick={onClose} aria-label="Close workspace setup">
            <X size={18} />
          </button>
        </header>

        {!supported ? (
          <div className="vr-empty-state">
            Project folders are created by the Windows app. On the website, attach files with the composer instead.
          </div>
        ) : (
          <>
            <p className="vr-modal-copy">
              VupsRouter works directly inside a real folder on this PC. Nothing is uploaded and nothing is created
              until you choose.
            </p>

            {suggestedPath ? (
              <div className="vr-workspace-item">
                <span className="vr-workspace-icon" aria-hidden="true">
                  <MapPin size={18} />
                </span>
                <div className="vr-workspace-main">
                  <span className="vr-workspace-name">Open the folder you named</span>
                  <span className="vr-workspace-path" title={suggestedPath}>
                    {suggestedPath}
                  </span>
                </div>
                <div className="vr-workspace-actions">
                  <button type="button" className="vr-primary-small" onClick={openTypedPath} disabled={Boolean(busy)}>
                    {busy === "open" ? "Opening…" : "Open"}
                  </button>
                </div>
              </div>
            ) : null}

            <form className="vr-workspace-rename" onSubmit={create}>
              <input
                value={name}
                onChange={event => {
                  setName(event.target.value);
                  if (nameError) setNameError(validateProjectName(event.target.value));
                }}
                maxLength={60}
                placeholder="Project name"
                aria-label="Project name"
              />
              <button
                type="button"
                className="vr-secondary-small"
                onClick={chooseLocation}
                disabled={Boolean(busy)}
              >
                <FolderOpen size={14} /> {busy === "parent" ? "Opening…" : parent ? "Change location" : "Choose location"}
              </button>
              <button type="submit" className="vr-primary-small" disabled={Boolean(busy) || !parent}>
                <FolderSimplePlus size={15} weight="bold" /> {busy === "create" ? "Creating…" : "Create project folder"}
              </button>
            </form>

            {parent ? (
              <p className="vr-page-note">
                Creates <strong>{completedPath}</strong> on this PC and opens it as the workspace.
              </p>
            ) : (
              <p className="vr-page-note">Pick the parent folder first — VupsRouter never guesses where to write.</p>
            )}

            <p className="vr-inline-error">{nameError || localError || error || ""}</p>

            <div className="vr-workspace-toolbar">
              <button type="button" className="vr-secondary-small" onClick={useExisting} disabled={Boolean(busy)}>
                <FolderOpen size={14} /> {busy === "add" ? "Opening picker…" : "Choose an existing folder instead"}
              </button>
            </div>
          </>
        )}

        <footer className="vr-modal-foot">
          <span>Existing files are never replaced. Secrets, dependencies, and build output stay excluded.</span>
          <button type="button" className="vr-secondary-small" onClick={onClose}>
            Cancel
          </button>
        </footer>
      </section>
    </div>
  );
}
