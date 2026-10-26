import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import hljs from "highlight.js/lib/common";
import {
  ArrowsOutSimple,
  Check,
  Code,
  Copy,
  DownloadSimple,
  FileZip,
  SpinnerGap,
  WarningCircle
} from "@phosphor-icons/react";
import { artifactBytes } from "../chat/artifacts.js";
import { fileSizeLabel } from "../chat/codeFiles.js";
import { buildProjectZip, downloadBlob, downloadGeneratedFile, projectZipName } from "../chat/downloads.js";
import { copyText } from "../chat/clipboard.js";
import "./CodeArtifact.css";

function baseName(path) {
  return String(path || "").split("/").pop() || "file";
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function highlightedCode(content, language) {
  const source = String(content || "");
  if (source.length > 200_000) return escapeHtml(source);
  const lang = String(language || "").toLowerCase().replace(/[^\w+#-]/g, "");
  if (!lang || !hljs.getLanguage(lang)) return escapeHtml(source);
  try {
    return hljs.highlight(source, { language: lang, ignoreIllegals: true }).value;
  } catch {
    return escapeHtml(source);
  }
}

export default function CodeArtifact({ artifact, streaming = false, className = "" }) {
  const files = Array.isArray(artifact?.files) ? artifact.files : [];
  const firstIncomplete = files.findIndex(file => file.complete === false);
  const [activePath, setActivePath] = useState(files[firstIncomplete >= 0 ? firstIncomplete : 0]?.path || "");
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState("");
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState(null);
  const urlsRef = useRef(new Set());
  const copiedTimer = useRef(null);

  useEffect(() => {
    if (files.length === 0) {
      setActivePath("");
      return;
    }
    if (!files.some(file => file.path === activePath)) {
      const next = files.findIndex(file => file.complete === false);
      setActivePath(files[next >= 0 ? next : 0].path);
    }
  }, [files, activePath]);

  useEffect(() => () => {
    clearTimeout(copiedTimer.current);
    for (const url of urlsRef.current) URL.revokeObjectURL(url);
    urlsRef.current.clear();
  }, []);

  const activeIndex = Math.max(0, files.findIndex(file => file.path === activePath));
  const active = files[activeIndex] || files[0] || null;
  const html = useMemo(
    () => highlightedCode(active?.content || "", active?.language),
    [active?.content, active?.language]
  );
  const totalBytes = useMemo(() => artifactBytes(files), [files]);
  const complete = artifact?.status === "complete" && !streaming && files.every(file => file.complete !== false);
  const statusLabel = streaming
    ? "Generating"
    : complete
      ? "Complete"
      : "Incomplete";

  const markCopied = useCallback((path) => {
    setCopied(path);
    clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(""), 2000);
  }, []);

  const handleCopyFile = useCallback(async () => {
    if (!active) return;
    setNotice(null);
    try {
      await copyText(active.content);
      markCopied(active.path);
    } catch {
      setNotice({ type: "error", text: `Could not copy ${baseName(active.path)}.` });
    }
  }, [active, markCopied]);

  const handleDownloadFile = useCallback(() => {
    if (!active) return;
    setNotice(null);
    setBusy(`file:${active.path}`);
    try {
      downloadGeneratedFile(active, urlsRef.current);
      setNotice({ type: "success", text: `${baseName(active.path)} download started.` });
    } catch {
      setNotice({ type: "error", text: `Could not download ${baseName(active.path)}.` });
    } finally {
      setBusy("");
    }
  }, [active]);

  const handleCopyAll = useCallback(async () => {
    setNotice(null);
    const text = files
      .map(file => `FILE: ${file.path}\n\`\`\`${file.language || ""}\n${file.content}\`\`\``)
      .join("\n\n");
    try {
      await copyText(text);
      markCopied("*");
    } catch {
      setNotice({ type: "error", text: "Could not copy the generated files." });
    }
  }, [files, markCopied]);

  const handleDownloadProject = useCallback(async () => {
    if (files.length === 0) return;
    setNotice(null);
    setBusy("zip");
    try {
      if (files.length === 1) {
        downloadGeneratedFile(files[0], urlsRef.current);
        setNotice({ type: "success", text: `${baseName(files[0].path)} download started.` });
      } else {
        const blob = await buildProjectZip(files);
        downloadBlob(blob, projectZipName(), urlsRef.current);
        setNotice({ type: "success", text: "Project ZIP download started." });
      }
    } catch {
      setNotice({ type: "error", text: "Could not prepare the download. Try an individual file instead." });
    } finally {
      setBusy("");
    }
  }, [files]);

  if (!active) return null;

  return (
    <section className={`vr-artifact ${className}`.trim()} aria-label={artifact?.title || "Generated code"}>
      <header className="vr-artifact__head">
        <span className="vr-artifact__icon" aria-hidden="true">
          <Code size={18} weight="bold" />
        </span>
        <div className="vr-artifact__identity">
          <strong>{artifact?.title || "Generated code"}</strong>
          <span>
            {files.length} {files.length === 1 ? "file" : "files"}
            <em>·</em>
            {fileSizeLabel(totalBytes)}
          </span>
        </div>
        <span
          className={`vr-artifact__status vr-artifact__status--${complete ? "complete" : "partial"}`}
          role="status"
        >
          {streaming ? <SpinnerGap size={13} className="vr-artifact__spin" aria-hidden="true" /> : null}
          {statusLabel}
        </span>
        <div className="vr-artifact__head-actions">
          <button
            type="button"
            className="vr-artifact__icon-btn"
            onClick={handleCopyAll}
            title="Copy all files"
            aria-label="Copy all generated files"
          >
            {copied === "*" ? <Check size={15} weight="bold" /> : <Copy size={15} />}
          </button>
          <button
            type="button"
            className="vr-artifact__icon-btn"
            onClick={handleDownloadProject}
            disabled={Boolean(busy)}
            title={files.length > 1 ? "Download project ZIP" : "Download file"}
            aria-label={files.length > 1 ? "Download project ZIP" : "Download generated file"}
          >
            {busy === "zip" ? <SpinnerGap size={15} className="vr-artifact__spin" /> : files.length > 1 ? <FileZip size={15} /> : <DownloadSimple size={15} />}
          </button>
          <button
            type="button"
            className="vr-artifact__icon-btn"
            onClick={() => setExpanded(value => !value)}
            title={expanded ? "Collapse code panel" : "Expand code panel"}
            aria-label={expanded ? "Collapse code panel" : "Expand code panel"}
            aria-expanded={expanded}
          >
            <ArrowsOutSimple size={15} />
          </button>
        </div>
      </header>

      {files.length > 1 ? (
        <div className="vr-artifact__tabs" role="tablist" aria-label="Generated files">
          {files.map(file => (
            <button
              key={file.path}
              type="button"
              role="tab"
              aria-selected={file.path === active.path}
              className={`vr-artifact__tab${file.path === active.path ? " is-active" : ""}`}
              onClick={() => setActivePath(file.path)}
              title={file.path}
            >
              <span>{file.path}</span>
              {file.complete === false ? <i aria-label="Incomplete">…</i> : null}
            </button>
          ))}
        </div>
      ) : null}

      <div className="vr-artifact__filebar">
        <div className="vr-artifact__file">
          <span className="vr-artifact__filename">{active.path}</span>
          <span className="vr-artifact__meta">
            {active.language || "text"} · {fileSizeLabel(active.bytes)}
            {active.complete === false ? " · still generating" : ""}
          </span>
        </div>
        <div className="vr-artifact__file-actions">
          <button type="button" className="vr-artifact__text-btn" onClick={handleCopyFile}>
            {copied === active.path ? <Check size={14} weight="bold" /> : <Copy size={14} />}
            {copied === active.path ? "Copied" : "Copy"}
          </button>
          <button type="button" className="vr-artifact__text-btn" onClick={handleDownloadFile} disabled={Boolean(busy)}>
            <DownloadSimple size={14} />
            Download
          </button>
        </div>
      </div>

      <div className="vr-artifact__viewer" data-expanded={expanded ? "" : undefined}>
        <pre tabIndex={0} aria-label={`${active.path} source code`}>
          <code
            className={`hljs language-${String(active.language || "text").replace(/[^\w+#-]/g, "")}`}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        </pre>
        {!expanded ? <span className="vr-artifact__fade" aria-hidden="true" /> : null}
      </div>

      {!expanded && active.content.length > 2600 ? (
        <button type="button" className="vr-artifact__expand" onClick={() => setExpanded(true)}>
          <ArrowsOutSimple size={14} />
          Expand full source
        </button>
      ) : null}

      {!complete ? (
        <p className="vr-artifact__hint" role="status">
          {streaming ? "Source is still being generated." : "This artifact is incomplete. Continue generating to finish it."}
        </p>
      ) : null}

      {notice ? (
        <p className={`vr-artifact__notice vr-artifact__notice--${notice.type}`} role={notice.type === "error" ? "alert" : "status"}>
          {notice.type === "error" ? <WarningCircle size={14} weight="fill" /> : <Check size={14} weight="bold" />}
          {notice.text}
        </p>
      ) : null}
    </section>
  );
}
