import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowsClockwise,
  CaretUp,
  FileText,
  FolderSimple,
  FolderSimplePlus,
  MagnifyingGlass
} from "@phosphor-icons/react";
import { formatBytes } from "../../chat/attachments.js";
import { useWorkspaces } from "../WorkspaceContext.jsx";
import { usePanel } from "./PanelContext.jsx";
import { listWorkspaceTree, readWorkspaceText, searchWorkspace } from "../workspaceBridge.js";

function parentPath(path) {
  if (!path) return "";
  const parts = path.split("/");
  parts.pop();
  return parts.join("/");
}

export default function FilesPane() {
  const { supported, owner, activeWorkspace, addWorkspace } = useWorkspaces();
  const { activeTab, open } = usePanel();
  const active = open && activeTab === "files";

  const [path, setPath] = useState("");
  const [tree, setTree] = useState({ path: "", entries: [], truncated: false });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState(null);
  const [searching, setSearching] = useState(false);
  const [file, setFile] = useState(null);
  const [opening, setOpening] = useState(false);

  const workspaceId = activeWorkspace?.id || "";

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

  useEffect(() => {
    setPath("");
    setHits(null);
    setQuery("");
    setFile(null);
  }, [workspaceId]);

  useEffect(() => {
    if (!active || !workspaceId || hits) return;
    loadTree(path);
  }, [active, workspaceId, path, hits, loadTree]);

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
    readWorkspaceText(owner, workspaceId, entry.path)
      .then(result => setFile(result))
      .catch(readError => setError(readError.message))
      .finally(() => setOpening(false));
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
          onClick={() => loadTree(path)}
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

      {searching || loading || opening ? <div className="vr-pane-note">Loading…</div> : null}

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
                  onClick={() => openFile({ path: hit.path, readable: true, restricted: false })}
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
              {entry.kind === "directory" ? (
                <button
                  type="button"
                  className="vr-pane-row"
                  onClick={() => setPath(entry.path)}
                  data-restricted={entry.restricted ? "true" : undefined}
                >
                  <FolderSimple size={14} aria-hidden="true" />
                  <span className="vr-pane-row__name">{entry.name}/</span>
                  {entry.restricted ? <span className="vr-pane-badge">restricted</span> : null}
                </button>
              ) : (
                <button
                  type="button"
                  className="vr-pane-row"
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
            </li>
          ))}
          {entries.length === 0 && !loading ? <li className="vr-pane-note">This folder is empty.</li> : null}
        </ul>
      )}

      {file ? (
        <div className="vr-file-preview">
          <div className="vr-file-preview__head">
            <span title={file.path}>{file.path}</span>
            <button type="button" className="vr-link-btn" onClick={() => setFile(null)}>
              Close
            </button>
          </div>
          <pre className="vr-file-preview__body">{file.content}</pre>
          {file.truncated ? <p className="vr-pane-note">Preview truncated at the size limit.</p> : null}
        </div>
      ) : null}

      {tree.truncated && !hits ? (
        <p className="vr-pane-note">The listing stopped at the folder limit; use search to reach deeper files.</p>
      ) : null}
    </div>
  );
}
