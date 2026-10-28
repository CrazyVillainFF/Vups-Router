import { useEffect, useId, useRef } from "react";

export default function NativePermissionDialog({
  title,
  description,
  details = [],
  confirmLabel,
  cancelLabel = "Cancel",
  tone = "default",
  onConfirm,
  onCancel
}) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef(null);
  const cancelRef = useRef(null);

  useEffect(() => {
    cancelRef.current?.focus();

    function onKeyDown(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel?.();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = dialogRef.current?.querySelectorAll(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

  return (
    <div className="vr-permission-backdrop" role="presentation">
      <div
        ref={dialogRef}
        className="vr-permission-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        data-tone={tone}
      >
        <span className="vr-permission-dialog__eyebrow">Windows local files</span>
        <h2 id={titleId}>{title}</h2>
        <p id={descriptionId}>{description}</p>
        {details.length > 0 ? (
          <ul className="vr-permission-dialog__files">
            {details.map((item, index) => (
              <li key={item.id || `${item.name}-${index}`}>
                <span title={item.name}>{item.name}</span>
                <em>{item.sizeLabel}</em>
                <small>{item.source}</small>
              </li>
            ))}
          </ul>
        ) : null}
        <p className="vr-permission-dialog__limit">
          This permission covers sending attached file contents only. It does not grant AI shell access or permission to modify files.
        </p>
        <div className="vr-permission-dialog__actions">
          <button
            ref={cancelRef}
            type="button"
            className="vr-permission-dialog__button"
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className="vr-permission-dialog__button vr-permission-dialog__button--confirm"
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
