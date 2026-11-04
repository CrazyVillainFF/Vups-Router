import React, { useCallback, useEffect, useState } from "react";
import { ArrowsClockwise, GitBranch } from "@phosphor-icons/react";
import { useWorkspaces } from "../WorkspaceContext.jsx";
import { usePanel } from "./PanelContext.jsx";
import { reviewWorkspaceGit } from "../workspaceBridge.js";

const STATUS_LABELS = {
  M: "modified",
  A: "added",
  D: "deleted",
  R: "renamed",
  C: "copied",
  U: "unmerged",
  "?": "untracked",
  "!": "ignored"
};

function statusMark(value) {
  if (!value || value === " ") return "";
  return STATUS_LABELS[value] || value;
}

export default function ReviewPane() {
  const { supported, owner, activeWorkspace } = useWorkspaces();
  const { activeTab, open } = usePanel();
  const active = open && activeTab === "review";

  const [review, setReview] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const workspaceId = activeWorkspace?.id || "";

  const load = useCallback(() => {
    if (!supported || !owner || !workspaceId) return;
    setLoading(true);
    setError("");
    reviewWorkspaceGit(owner, workspaceId)
      .then(result => setReview(result))
      .catch(reviewError => {
        setReview(null);
        setError(reviewError.message);
      })
      .finally(() => setLoading(false));
  }, [supported, owner, workspaceId]);

  useEffect(() => {
    setReview(null);
    setError("");
  }, [workspaceId]);

  useEffect(() => {
    if (active && workspaceId && !review && !loading && !error) load();
  }, [active, workspaceId, review, loading, error, load]);

  if (!supported) {
    return <div className="vr-pane-note">Code review is available in the Windows app.</div>;
  }
  if (!activeWorkspace) {
    return <div className="vr-pane-note">Choose a project folder to review its Git changes.</div>;
  }

  const files = review?.files || [];

  return (
    <div className="vr-review-pane">
      <div className="vr-pane-toolbar">
        <span className="vr-pane-title">
          <GitBranch size={14} aria-hidden="true" /> {review?.branch || "…"}
        </span>
        <button
          type="button"
          className="vr-icon-btn"
          onClick={load}
          aria-label="Refresh Git status"
          title="Refresh"
        >
          <ArrowsClockwise size={14} />
        </button>
      </div>

      {loading ? <div className="vr-pane-note">Reading Git status…</div> : null}
      {error ? <div className="vr-inline-error">{error}</div> : null}

      {review ? (
        <>
          <div className="vr-review-head">
            <span>{files.length} changed file{files.length === 1 ? "" : "s"}</span>
            {review.head ? <span className="vr-review-head__sha" title={review.head}>at {review.head.slice(0, 8)}</span> : null}
          </div>

          {files.length === 0 ? <div className="vr-pane-note">Working tree is clean.</div> : null}

          <ul className="vr-pane-list">
            {files.map(file => (
              <li key={file.path} className="vr-review-file">
                <span className="vr-review-file__status" title={`${statusMark(file.indexStatus)} / ${statusMark(file.worktreeStatus)}`}>
                  {file.staged ? statusMark(file.indexStatus) || "S" : ""}
                  {file.unstaged ? statusMark(file.worktreeStatus) || "U" : ""}
                  {!file.staged && !file.unstaged ? statusMark(file.indexStatus) || file.kind : ""}
                </span>
                <span className="vr-review-file__path" title={file.path}>{file.path}</span>
              </li>
            ))}
          </ul>

          {review.stagedDiff ? (
            <details className="vr-review-diff" open>
              <summary>Staged changes</summary>
              <pre>{review.stagedDiff}</pre>
            </details>
          ) : null}

          {review.unstagedDiff ? (
            <details className="vr-review-diff" open={!review.stagedDiff}>
              <summary>Unstaged changes</summary>
              <pre>{review.unstagedDiff}</pre>
            </details>
          ) : null}

          {review.truncated ? <p className="vr-pane-note">The diff was truncated at the size limit.</p> : null}

          {review.diagnostics && review.diagnostics.length > 0 ? (
            <div className="vr-review-diagnostics">
              <strong>Diagnostics</strong>
              <ul>
                {review.diagnostics.map(line => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
