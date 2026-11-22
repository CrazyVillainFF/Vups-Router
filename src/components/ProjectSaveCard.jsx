import { useCallback, useMemo, useState } from "react";
import {
  CheckCircle,
  FolderSimple,
  SpinnerGap,
  WarningCircle
} from "@phosphor-icons/react";
import { fileSizeLabel } from "../chat/codeFiles.js";
import { normalizeProjectPath, utf8Bytes } from "../localai/localProjectSave.js";
import "./ProjectSaveCard.css";

const STATE_LABELS = {
  created: "saved",
  unchanged: "already there",
  conflict: "not overwritten",
  failed: "failed",
  pending: "waiting for a folder"
};

function statusCopy(record) {
  const status = record?.status || "unsaved";
  if (status === "saved") return "Saved to your project";
  if (status === "conflict") return "Saved with skipped files";
  if (status === "failed") return "Could not save all files";
  if (status === "needs-folder") return "Choose a project folder";
  return "Files not saved yet";
}

export default function ProjectSaveCard({
  artifact,
  record = null,
  onSave,
  onChooseFolder
}) {
  const [busy, setBusy] = useState("");
  const status = record?.status || "unsaved";
  const failed = status === "failed" || status === "conflict";

  const files = useMemo(() => {
    if (Array.isArray(record?.files) && record.files.length > 0) return record.files;
    return (Array.isArray(artifact?.files) ? artifact.files : [])
      .filter(file => file && typeof file.content === "string" && String(file.content).trim())
      .map(file => ({
        path: normalizeProjectPath(file.path) || "index.txt",
        status: "pending",
        bytes: utf8Bytes(file.content)
      }));
  }, [artifact, record]);

  const run = useCallback(async (kind, action) => {
    if (busy || typeof action !== "function") return;
    setBusy(kind);
    try {
      await action();
    } finally {
      setBusy("");
    }
  }, [busy]);

  if (files.length === 0) return null;

  const showPath = Boolean(record?.location) && status !== "needs-folder";
  const canRetry = status === "failed" || status === "conflict";
  const needsFolder = status === "needs-folder";
  const notSaved = status === "unsaved";

  return (
    <section
      className="vr-saved"
      aria-label="Project files"
      data-status={status}
      data-task-id={record?.taskId || undefined}
    >
      <div className="vr-saved__head">
        {failed ? (
          <WarningCircle size={14} aria-hidden="true" />
        ) : (
          <FolderSimple size={14} aria-hidden="true" />
        )}
        <strong>{statusCopy(record)}</strong>
        <span className="vr-saved__count">
          {files.length} file{files.length === 1 ? "" : "s"}
        </span>
      </div>

      {showPath ? (
        <div className="vr-saved__path">
          <span>Folder</span>
          <code title={record.location}>{record.location}</code>
        </div>
      ) : null}

      <ul className="vr-saved__list">
        {files.map(file => (
          <li key={`${file.path}:${file.status}`} className="vr-saved__row">
            <span className="vr-saved__name" title={file.path}>{file.path}</span>
            <span className="vr-saved__bytes">{fileSizeLabel(file.bytes)}</span>
            <span
              className={`vr-saved__state${file.status === "failed" || file.status === "conflict" ? " vr-saved__state--bad" : ""}`}
            >
              {STATE_LABELS[file.status] || file.status}
            </span>
          </li>
        ))}
      </ul>

      {record?.error ? (
        <p className={`vr-saved__note${failed ? " vr-saved__note--bad" : ""}`} role="status">
          {record.error}
        </p>
      ) : status === "saved" ? (
        <p className="vr-saved__note">
          <CheckCircle size={12} weight="fill" aria-hidden="true" />
          Files are in the project folder and open like any other project file.
        </p>
      ) : null}

      {needsFolder ? (
        <div className="vr-saved__actions">
          <button
            type="button"
            className="vr-saved__action"
            onClick={() => run("folder", onChooseFolder)}
            disabled={Boolean(busy)}
          >
            {busy === "folder" ? <SpinnerGap size={12} className="vr-saved__spin" aria-hidden="true" /> : null}
            Choose project folder
          </button>
        </div>
      ) : null}

      {canRetry ? (
        <div className="vr-saved__actions">
          <button
            type="button"
            className="vr-saved__action"
            onClick={() => run("save", onSave)}
            disabled={Boolean(busy)}
          >
            {busy === "save" ? <SpinnerGap size={12} className="vr-saved__spin" aria-hidden="true" /> : null}
            Retry save
          </button>
        </div>
      ) : null}

      {notSaved ? (
        <div className="vr-saved__actions">
          <button
            type="button"
            className="vr-saved__action"
            onClick={() => run("save", onSave)}
            disabled={Boolean(busy)}
          >
            {busy === "save" ? <SpinnerGap size={12} className="vr-saved__spin" aria-hidden="true" /> : null}
            Save to project
          </button>
        </div>
      ) : null}
    </section>
  );
}
