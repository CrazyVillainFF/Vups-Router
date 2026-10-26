import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DownloadSimple,
  FileCode,
  FileZip,
  SpinnerGap,
  WarningCircle
} from "@phosphor-icons/react";
import { artifactBytes } from "../chat/artifacts.js";
import { fileSizeLabel } from "../chat/codeFiles.js";
import {
  buildProjectZip,
  downloadBlob,
  downloadGeneratedFile,
  projectZipName
} from "../chat/downloads.js";
import "./GeneratedFiles.css";

function baseName(path) {
  return String(path || "").split("/").pop() || "file";
}

export default function GeneratedFiles({ artifact, className = "" }) {
  const files = useMemo(
    () =>
      (Array.isArray(artifact?.files) ? artifact.files : []).filter(
        file => file && typeof file.path === "string" && String(file.content || "").trim()
      ),
    [artifact]
  );
  const urlsRef = useRef(new Set());
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState(null);

  useEffect(() => () => {
    for (const url of urlsRef.current) URL.revokeObjectURL(url);
    urlsRef.current.clear();
  }, []);

  const handleFile = useCallback((file) => {
    if (file?.complete === false) return;
    setNotice(null);
    try {
      downloadGeneratedFile(file, urlsRef.current);
    } catch {
      setNotice(`Could not download ${baseName(file.path)}. Try again.`);
    }
  }, []);

  const handleZip = useCallback(async () => {
    if (files.length < 2 || busy) return;
    setBusy("zip");
    setNotice(null);
    try {
      const blob = await buildProjectZip(files);
      downloadBlob(blob, projectZipName(), urlsRef.current);
    } catch {
      setNotice("Could not prepare the ZIP. Try downloading the files individually.");
    } finally {
      setBusy("");
    }
  }, [busy, files]);

  if (files.length === 0) return null;

  const totalBytes = artifactBytes(files);
  const hasIncomplete = artifact?.status !== "complete" || files.some(file => file.complete === false);
  // Downloads stay unavailable until the turn commits a complete artifact, so a
  // half-written project is never presented as a finished one.
  const actionsReady = !hasIncomplete;
  const zipReady = actionsReady && !busy && files.length > 1;

  const fileSize = file => {
    if (file.complete === false) return "Incomplete";
    return fileSizeLabel(file.bytes);
  };

  return (
    <section
      className={`vr-files ${className}`.trim()}
      aria-label={actionsReady ? "Generated files" : "Partial generated files"}
      data-partial={actionsReady ? undefined : ""}
    >
      {files.length > 1 ? (
        <div className="vr-files__head">
          <FileCode size={14} aria-hidden="true" />
          <span className="vr-files__summary">
            {files.length} files{actionsReady ? "" : " · incomplete"}
          </span>
          <span className="vr-files__size">
            {actionsReady ? fileSizeLabel(totalBytes) : "Partial"}
          </span>
          {actionsReady ? (
            <button
              type="button"
              className="vr-files__zip"
              onClick={handleZip}
              disabled={!zipReady}
              title={zipReady ? "Download all as ZIP" : "Preparing the ZIP"}
              aria-label={`Download all ${files.length} files as a ZIP`}
            >
              {busy === "zip" ? (
                <SpinnerGap size={14} className="vr-files__spin" aria-hidden="true" />
              ) : (
                <FileZip size={14} aria-hidden="true" />
              )}
            </button>
          ) : null}
        </div>
      ) : null}

      <ul className="vr-files__list">
        {files.map(file => (
          <li key={file.path} className="vr-files__row">
            <FileCode size={14} className="vr-files__icon" aria-hidden="true" />
            <span className="vr-files__name" title={file.path}>{file.path}</span>
            <span className="vr-files__size">
              {fileSize(file)}
            </span>
            {actionsReady && file.complete !== false ? (
              <button
                type="button"
                className="vr-files__download"
                onClick={() => handleFile(file)}
                disabled={Boolean(busy)}
                title="Download file"
                aria-label={`Download ${file.path}`}
              >
                <DownloadSimple size={14} aria-hidden="true" />
              </button>
            ) : null}
          </li>
        ))}
      </ul>

      {notice ? (
        <p className="vr-files__notice" role="alert">
          <WarningCircle size={12} weight="fill" aria-hidden="true" />
          {notice}
        </p>
      ) : null}
    </section>
  );
}
