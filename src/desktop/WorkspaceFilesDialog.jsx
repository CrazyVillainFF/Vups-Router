import React, { useEffect, useMemo, useState } from "react";
import { ArrowsClockwise, FileText, FolderSimple, MagnifyingGlass, X } from "@phosphor-icons/react";
import { formatBytes, TEXT_LIMITS, workspaceTextFile } from "../chat/attachments.js";
import { useWorkspaces } from "./WorkspaceContext.jsx";

export default function WorkspaceFilesDialog({ open, onClose, onAttach }) {
  const { activeWorkspace, scanWorkspace, readFile } = useWorkspaces();
  const [entries, setEntries] = useState([]);
  const [truncated, setTruncated] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState([]);
  const [loading, setLoading] = useState(false);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (!open) {
      setEntries([]);
      setSelected([]);
      setQuery("");
      setError("");
      setNotice("");
      return;
    }
    if (!activeWorkspace) {
      setError("Select a workspace first.");
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError("");
    scanWorkspace(activeWorkspace.id)
      .then(result => {
        if (cancelled) return;
        setEntries(Array.isArray(result?.entries) ? result.entries : []);
        setTruncated(Boolean(result?.truncated));
      })
      .catch(scanError => {
        if (!cancelled) setError(scanError.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, activeWorkspace, scanWorkspace]);

  const files = useMemo(
    () => entries.filter(entry => entry.kind === "file" && entry.readable),
    [entries]
  );
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return files;
    return files.filter(entry => entry.path.toLowerCase().includes(needle));
  }, [files, query]);

  const selectedSet = useMemo(() => new Set(selected), [selected]);

  const toggle = entry => {
    setNotice("");
    setSelected(current => {
      if (current.includes(entry.path)) return current.filter(path => path !== entry.path);
      if (current.length >= TEXT_LIMITS.count) {
        setNotice(`You can attach up to ${TEXT_LIMITS.count} files at a time.`);
        return current;
      }
      return [...current, entry.path];
    });
  };

  const attach = async () => {
    if (!activeWorkspace || selected.length === 0 || reading) return;
    setReading(true);
    setError("");
    setNotice("");
    const loaded = [];
    for (const path of selected) {
      try {
        const result = await readFile(path, activeWorkspace.id);
        if (!result?.content) throw new Error(`${path} is empty or unreadable.`);
        if (result.content.length > TEXT_LIMITS.chars) {
          throw new Error(`${path} is longer than ${TEXT_LIMITS.chars.toLocaleString()} characters.`);
        }
        loaded.push(workspaceTextFile(result.content, path));
      } catch (readError) {
        setNotice(readError.message);
        setReading(false);
        return;
      }
    }
    setReading(false);
    onAttach(loaded);
    onClose();
  };

  if (!open) return null;

  return (
    <div className="vr-modal-backdrop" onPointerDown={event => event.target === event.currentTarget && onClose()}>
      <section className="vr-modal vr-files-modal" role="dialog" aria-modal="true" aria-labelledby="vr-files-title">
        <header className="vr-modal-head">
          <div>
            <span className="vr-modal-kicker">WORKSPACE FILES</span>
            <h2 id="vr-files-title">{activeWorkspace?.title || "Select a workspace"}</h2>
          </div>
          <button type="button" className="vr-icon-btn" onClick={onClose} aria-label="Close workspace files">
            <X size={18} />
          </button>
        </header>

        <div className="vr-file-search">
          <MagnifyingGlass size={16} aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder="Filter files by path"
            aria-label="Filter workspace files"
          />
          <button
            type="button"
            className="vr-icon-btn"
            onClick={() => {
              if (!activeWorkspace) return;
              setLoading(true);
              scanWorkspace(activeWorkspace.id)
                .then(result => {
                  setEntries(Array.isArray(result?.entries) ? result.entries : []);
                  setTruncated(Boolean(result?.truncated));
                  setError("");
                })
                .catch(scanError => setError(scanError.message))
                .finally(() => setLoading(false));
            }}
            aria-label="Rescan workspace"
            title="Rescan"
          >
            <ArrowsClockwise size={15} />
          </button>
        </div>

        {error || notice ? <div className="vr-inline-error">{error || notice}</div> : null}

        {loading ? (
          <div className="vr-empty-state">Scanning workspace files...</div>
        ) : filtered.length === 0 ? (
          <div className="vr-empty-state">
            {files.length === 0 ? "No readable text files were found." : "No files match this filter."}
          </div>
        ) : (
          <ul className="vr-file-list">
            {filtered.map(entry => (
              <li key={entry.path}>
                <label className="vr-file-row" data-selected={selectedSet.has(entry.path) ? "" : undefined}>
                  <input
                    type="checkbox"
                    checked={selectedSet.has(entry.path)}
                    onChange={() => toggle(entry)}
                  />
                  <span className="vr-file-icon" aria-hidden="true">
                    {entry.path.includes("/") ? <FolderSimple size={15} /> : <FileText size={15} />}
                  </span>
                  <span className="vr-file-path" title={entry.path}>{entry.path}</span>
                  <span className="vr-file-size">{formatBytes(entry.size)}</span>
                </label>
              </li>
            ))}
          </ul>
        )}

        <p className="vr-file-note">
          Files are read only when you attach them, and secrets, keys, environment files, dependencies, and build
          output are excluded. Each file must be under {TEXT_LIMITS.chars.toLocaleString()} characters; up to {TEXT_LIMITS.count} files can be attached.
          {truncated ? " The scan stopped at the workspace limit; narrow the folder or use search." : ""}
        </p>

        <footer className="vr-modal-foot">
          <span>{selected.length} of {TEXT_LIMITS.count} selected</span>
          <div className="vr-modal-actions">
            <button type="button" className="vr-secondary-small" onClick={onClose}>Cancel</button>
            <button type="button" className="vr-primary-small" onClick={attach} disabled={selected.length === 0 || reading}>
              {reading ? "Reading files..." : "Attach files"}
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}
