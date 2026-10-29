import { useCallback, useEffect, useRef, useState } from "react";
import { CaretDown, Check, ShieldCheck, Warning } from "@phosphor-icons/react";
import {
  WINDOWS_PERMISSION_MODES,
  permissionModeInfo
} from "./permissions.js";

export default function NativeChatControls({ mode, disabled = false, applying = false, bridgeError = "", onChange }) {
  const selected = permissionModeInfo(mode);
  const selectedIndex = Math.max(
    0,
    WINDOWS_PERMISSION_MODES.findIndex(item => item.id === selected.id)
  );
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const triggerRef = useRef(null);
  const optionRefs = useRef([]);

  const close = useCallback((restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) {
      requestAnimationFrame(() => triggerRef.current?.focus({ preventScroll: true }));
    }
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = event => {
      if (!rootRef.current?.contains(event.target)) close();
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open, close]);

  useEffect(() => {
    if (!open) return;
    optionRefs.current[selectedIndex]?.focus({ preventScroll: true });
  }, [open, selectedIndex]);

  const choose = id => {
    close(true);
    onChange?.(id);
  };

  const onTriggerKeyDown = event => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (!disabled) setOpen(true);
    } else if (event.key === "Escape" && open) {
      event.preventDefault();
      close(true);
    }
  };

  const onMenuKeyDown = event => {
    const count = WINDOWS_PERMISSION_MODES.length;
    const current = optionRefs.current.findIndex(item => item === document.activeElement);
    let next = -1;
    if (event.key === "ArrowDown") next = (Math.max(0, current) + 1) % count;
    else if (event.key === "ArrowUp") next = (current <= 0 ? count : current) - 1;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = count - 1;
    else if (event.key === "Escape") {
      event.preventDefault();
      close(true);
      return;
    }
    if (next >= 0) {
      event.preventDefault();
      optionRefs.current[next]?.focus({ preventScroll: true });
    }
  };

  const bridgeDown = Boolean(bridgeError);

  return (
    <div className="vr-permission" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="prompt-bar__pick vr-permission__trigger"
        data-risk={selected.id}
        data-bridge={bridgeDown ? "down" : undefined}
        data-open={open ? "" : undefined}
        aria-label={
          applying
            ? "Permission mode: applying the new mode"
            : bridgeDown
              ? `Permission mode: ${selected.label} (not confirmed by the desktop app)`
              : `Permission mode: ${selected.label}`
        }
        aria-busy={applying || undefined}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={bridgeDown ? bridgeError : selected.description}
        disabled={disabled}
        onKeyDown={onTriggerKeyDown}
        onClick={() => {
          if (!disabled) setOpen(current => !current);
        }}
      >
        {bridgeDown ? (
          <Warning size={14} weight="fill" aria-hidden="true" />
        ) : (
          <ShieldCheck size={14} aria-hidden="true" />
        )}
        <b className="vr-permission__label">
          {applying ? "Applying…" : bridgeDown ? "Access not active" : selected.label}
        </b>
        <b className="vr-permission__label-short">
          {applying ? "Applying" : bridgeDown ? "Not active" : selected.shortLabel}
        </b>
        <CaretDown size={11} aria-hidden="true" />
      </button>

      {open ? (
        <div
          className="vr-permission__menu"
          role="listbox"
          aria-label="Permission mode"
          onKeyDown={onMenuKeyDown}
        >
          <div className="vr-permission__head">
            <span>File access</span>
            <span className="vr-permission__risk" data-risk={selected.id}>{selected.risk}</span>
          </div>
          {WINDOWS_PERMISSION_MODES.map((item, index) => (
            <button
              key={item.id}
              ref={element => {
                optionRefs.current[index] = element;
              }}
              type="button"
              className="vr-permission__option"
              data-risk={item.id}
              role="option"
              aria-selected={item.id === selected.id}
              onClick={() => choose(item.id)}
            >
              <span className="vr-permission__option-top">
                <strong>{item.label}</strong>
                {item.id === selected.id ? <Check size={13} weight="bold" aria-hidden="true" /> : null}
              </span>
              <span className="vr-permission__option-copy">{item.description}</span>
              {item.id === "full" ? (
                <span className="vr-permission__option-warning">
                  <Warning size={12} weight="fill" aria-hidden="true" />
                  Requires confirmation before enabling
                </span>
              ) : null}
            </button>
          ))}
          {bridgeDown ? (
            <p className="vr-permission__note" data-bridge="down">
              <Warning size={12} weight="fill" aria-hidden="true" />
              {bridgeError} The app is not running local filesystem tools, whatever this selector says.
            </p>
          ) : null}
          <p className="vr-permission__note">
            These modes control read-only Windows filesystem tools and attached file contents. Shell, file-write, and administrator actions are not available.
          </p>
        </div>
      ) : null}
    </div>
  );
}
