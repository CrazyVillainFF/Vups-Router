import React, { useCallback, useEffect, useId, useRef, useState } from "react";
import { CheckCircle, Trash, WarningCircle } from "@phosphor-icons/react";
import HoldToDeleteButton from "./HoldToDeleteButton.jsx";
import { HOLD_TO_DELETE_MS, formatHoldSeconds } from "./holdToDelete.js";
import "./HoldToDeleteDialog.css";

const FOCUSABLE =
  'button:not([disabled]), summary, [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export default function HoldToDeleteDialog({
  open,
  title = "Delete this item?",
  itemName,
  description = "This action cannot be undone.",
  confirmLabel = "Hold to Delete",
  successMessage = "Deleted.",
  holdTime = HOLD_TO_DELETE_MS,
  onCancel,
  onConfirm
}) {
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState("");
  const [resetKey, setResetKey] = useState(0);
  const busyRef = useRef(false);
  const closeTimerRef = useRef(0);
  const returnFocusRef = useRef(null);
  const dialogRef = useRef(null);
  const cancelRef = useRef(null);
  const titleId = useId();
  const descriptionId = useId();
  const errorId = useId();

  useEffect(() => {
    if (!open) return undefined;
    returnFocusRef.current = document.activeElement;
    setStatus("idle");
    setError("");
    setResetKey(0);
    busyRef.current = false;
    const focusTimer = window.setTimeout(() => cancelRef.current?.focus({ preventScroll: true }), 0);
    return () => {
      window.clearTimeout(focusTimer);
      const returnTo = returnFocusRef.current;
      if (returnTo?.isConnected) returnTo.focus({ preventScroll: true });
    };
  }, [open]);

  useEffect(() => () => {
    if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current);
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = event => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (!busyRef.current) onCancel?.();
        return;
      }
      if (event.key !== "Tab") return;
      const nodes = Array.from(dialogRef.current?.querySelectorAll(FOCUSABLE) || []).filter(
        node => node.getClientRects().length > 0
      );
      if (nodes.length === 0) {
        event.preventDefault();
        return;
      }
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const active = document.activeElement;
      if (!dialogRef.current?.contains(active)) {
        event.preventDefault();
        first.focus();
        return;
      }
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [onCancel, open]);

  const handleConfirm = useCallback(async () => {
    if (busyRef.current || status === "success") return;
    if (typeof onConfirm !== "function") {
      setError("Deletion is unavailable for this item.");
      setStatus("error");
      return;
    }
    busyRef.current = true;
    setError("");
    setStatus("deleting");
    try {
      await onConfirm();
      setStatus("success");
      closeTimerRef.current = window.setTimeout(() => {
        busyRef.current = false;
        onCancel?.();
      }, 1800);
    } catch (confirmError) {
      setError(confirmError?.message || "Could not delete this item. Nothing was changed.");
      setStatus("error");
      setResetKey(current => current + 1);
      busyRef.current = false;
    }
  }, [onCancel, onConfirm, status]);

  if (!open) return null;

  const busy = status === "deleting" || status === "success";
  const describedBy = [descriptionId, status === "error" ? errorId : ""].filter(Boolean).join(" ");

  return (
    <div
      className="vr-hold-delete-backdrop"
      onPointerDown={event => {
        if (event.target === event.currentTarget && !busyRef.current) onCancel?.();
      }}
    >
      <section
        ref={dialogRef}
        className="vr-hold-delete-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={describedBy}
        aria-busy={status === "deleting" ? "true" : undefined}
      >
        <header className="vr-hold-delete-head">
          <span className="vr-hold-delete-icon" aria-hidden="true">
            <Trash size={19} weight="bold" />
          </span>
          <div>
            <span className="vr-hold-delete-kicker">PERMANENT ACTION</span>
            <h2 id={titleId}>{title}</h2>
          </div>
        </header>

        <p className="vr-hold-delete-item">
          <span>Selected item</span>
          <strong>{itemName || "this item"}</strong>
        </p>
        <p id={descriptionId} className="vr-hold-delete-copy">{description}</p>

        <p className="vr-hold-delete-instruction">
          Press and hold the button for {formatHoldSeconds(holdTime)} seconds. Releasing early, pressing Escape, or
          moving focus away cancels the action.
        </p>

        {status === "error" ? (
          <div id={errorId} className="vr-hold-delete-error" role="alert">
            <WarningCircle size={17} weight="fill" aria-hidden="true" />
            <span>{error}</span>
          </div>
        ) : null}

        {status === "success" ? (
          <div className="vr-hold-delete-success" role="status">
            <CheckCircle size={18} weight="fill" aria-hidden="true" />
            <span>{successMessage}</span>
          </div>
        ) : null}

        <div className="vr-hold-delete-actions">
          <button
            ref={cancelRef}
            type="button"
            className="vr-hold-delete-cancel"
            onClick={() => onCancel?.()}
            disabled={busy}
          >
            Cancel
          </button>
          <HoldToDeleteButton
            onHold={handleConfirm}
            disabled={busy}
            holdTime={holdTime}
            resetKey={resetKey}
            label={confirmLabel}
            describedBy={descriptionId}
          />
        </div>

        <details className="vr-hold-delete-alternative">
          <summary>Keyboard or screen reader confirmation</summary>
          <p>Use an explicit confirmation if holding is difficult with your keyboard or assistive technology.</p>
          <button
            type="button"
            className="vr-hold-delete-explicit"
            onClick={handleConfirm}
            disabled={busy}
          >
            Delete permanently
          </button>
        </details>
      </section>
    </div>
  );
}
