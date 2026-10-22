import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle, DownloadSimple, FileZip, WarningCircle } from "@phosphor-icons/react";
import { extractCodeFiles, fileSizeLabel, isWebsitePackage } from "../chat/codeFiles.js";
import { buildProjectZip, downloadBlob, downloadGeneratedFile, projectZipName } from "../chat/downloads.js";
import "./MessageDownloads.css";

function baseName(path) {
  return String(path || "").split("/").pop() || "file";
}

export default function MessageDownloads({ content }) {
  const files = useMemo(() => extractCodeFiles(content), [content]);
  const urlsRef = useRef(new Set());
  const [busy, setBusy] = useState("");
  const [status, setStatus] = useState(null);
  const website = isWebsitePackage(files);

  useEffect(() => () => {
    for (const url of urlsRef.current) URL.revokeObjectURL(url);
    urlsRef.current.clear();
  }, []);

  const handleZip = useCallback(async () => {
    if (busy || files.length < 2) return;
    setBusy("zip");
    setStatus(null);
    try {
      const blob = await buildProjectZip(files);
      downloadBlob(blob, projectZipName(), urlsRef.current);
      setStatus({ type: "success", text: "ZIP download started." });
    } catch {
      setStatus({ type: "error", text: "Could not create the ZIP. Try downloading the individual files instead." });
    } finally {
      setBusy("");
    }
  }, [busy, files]);

  const handleFile = useCallback((file) => {
    if (busy) return;
    setBusy(file.path);
    setStatus(null);
    try {
      downloadGeneratedFile(file, urlsRef.current);
      setStatus({ type: "success", text: `${baseName(file.path)} download started.` });
    } catch {
      setStatus({ type: "error", text: `Could not download ${baseName(file.path)}.` });
    } finally {
      setBusy("");
    }
  }, [busy]);

  if (!content || files.length === 0) return null;

  return (
    <section className="vr-downloads" aria-label="Generated code downloads">
      <div className="vr-downloads__head">
        <div className="vr-downloads__heading">
          <span className="vr-downloads__icon" aria-hidden="true">
            <FileZip size={17} weight="duotone" />
          </span>
          <span>
            <strong>{website ? "Generated website" : "Generated code"}</strong>
            <span className="vr-downloads__count">
              {files.length} {files.length === 1 ? "file" : "files"}
            </span>
          </span>
        </div>
        {files.length > 1 ? (
          <button
            type="button"
            className="vr-downloads__primary"
            onClick={handleZip}
            disabled={Boolean(busy)}
          >
            <DownloadSimple size={15} weight="bold" aria-hidden="true" />
            {busy === "zip" ? "Preparing ZIP..." : website ? "Download Website (.zip)" : "Download Files (.zip)"}
          </button>
        ) : (
          <button
            type="button"
            className="vr-downloads__primary"
            onClick={() => handleFile(files[0])}
            disabled={Boolean(busy)}
          >
            <DownloadSimple size={15} weight="bold" aria-hidden="true" />
            {busy ? "Preparing..." : `Download ${baseName(files[0].path)}`}
          </button>
        )}
      </div>

      {files.length > 1 ? (
        <ul className="vr-downloads__files" aria-label="Generated files">
          {files.map(file => (
            <li key={file.path}>
              <button
                type="button"
                className="vr-downloads__file"
                onClick={() => handleFile(file)}
                disabled={Boolean(busy)}
                title={`Download ${file.path}`}
              >
                <DownloadSimple size={13} aria-hidden="true" />
                <span className="vr-downloads__path">{file.path}</span>
                <span className="vr-downloads__size">{fileSizeLabel(file.bytes)}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {status ? (
        <p className={`vr-downloads__status vr-downloads__status--${status.type}`} role={status.type === "error" ? "alert" : "status"}>
          {status.type === "error" ? <WarningCircle size={14} weight="fill" aria-hidden="true" /> : <CheckCircle size={14} weight="fill" aria-hidden="true" />}
          {status.text}
        </p>
      ) : null}
    </section>
  );
}
