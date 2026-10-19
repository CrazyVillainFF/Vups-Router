// CodeSlots — animated numeric one-time-code input in the React Bits style.
//
// NOTE: VupsRouter currently has NO one-time-code (OTP) verification screen —
// password recovery uses emailed single-use links — so this component is not
// wired to a backend endpoint yet. When an OTP screen is added, render it there
// with the props below and connect `onComplete` to the real verification
// endpoint (see src/auth/PasswordRecovery.jsx for the email-link flow).
//
// Props:
//   length       number of digits (default 6; match the backend's code length)
//   value        controlled digit string
//   status       "idle" | "error" | "success"
//   onChange     (nextValue: string) => void   (fires with digits only)
//   onComplete   (code: string) => void        (fires once per fill)
//   ariaLabel, autoFocus, disabled
//   accentColor, inkColor, slotColor, digitColor, dangerColor
//   slotSize, gap, radius, bounce, settle, rise, cascade
//
// Behavior: paste support, keyboard entry/backspace, duplicate completion
// suppression, error draining + clearing (consumer clears value on error),
// success lock, and prefers-reduced-motion support.
import { useEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Tick02Icon } from "@hugeicons/core-free-icons";
import "./CodeSlots.css";

const EASE_SETTLE = [0.23, 1, 0.32, 1];

function onlyDigits(input, length) {
  return String(input ?? "").replace(/\D/g, "").slice(0, length);
}

export default function CodeSlots({
  length = 6,
  value = "",
  status = "idle",
  onChange,
  onComplete,
  ariaLabel = "Verification code",
  autoFocus = false,
  disabled = false,
  accentColor = "#d4ff3f",
  inkColor = "#f2f4ef",
  slotColor = "rgba(242, 244, 239, 0.06)",
  digitColor = "#f2f4ef",
  dangerColor = "#ff5d5d",
  slotSize = 48,
  gap = 10,
  radius = 12,
  bounce = 0.2,
  settle = 0.3,
  rise = 10,
  cascade = 25
}) {
  const digits = onlyDigits(value, length);
  const reducedMotion = useReducedMotion();
  const inputRef = useRef(null);
  const wasComplete = useRef(false);
  const [focused, setFocused] = useState(false);

  const locked = disabled || status === "success";
  const complete = digits.length === length;

  useEffect(() => {
    if (!complete) wasComplete.current = false;
  }, [complete]);

  useEffect(() => {
    if (autoFocus && !locked) inputRef.current?.focus();
  }, [autoFocus, locked]);

  function commit(nextValue) {
    const next = onlyDigits(nextValue, length);
    if (next !== digits && typeof onChange === "function") onChange(next);
    if (next.length === length && !wasComplete.current && !locked) {
      wasComplete.current = true;
      if (typeof onComplete === "function") onComplete(next);
    }
  }

  const slots = Array.from({ length }, (_, index) => digits[index] ?? null);
  const activeIndex = complete ? -1 : digits.length;

  return <div
    className={`cs-root cs-root--${status}${focused ? " is-focused" : ""}${locked ? " is-locked" : ""}`}
    style={{
      "--cs-accent": accentColor,
      "--cs-ink": inkColor,
      "--cs-slot-bg": slotColor,
      "--cs-digit": digitColor,
      "--cs-danger": dangerColor,
      "--cs-slot-size": `${slotSize}px`,
      "--cs-gap": `${gap}px`,
      "--cs-radius": `${radius}px`
    }}
    onMouseDown={event => {
      if (event.target.closest("input")) return;
      event.preventDefault();
      if (!locked) inputRef.current?.focus();
    }}
  >
    <input
      ref={inputRef}
      className="cs-input"
      type="text"
      inputMode="numeric"
      pattern="[0-9]*"
      autoComplete="one-time-code"
      spellCheck="false"
      value={digits}
      onChange={event => commit(event.target.value)}
      onPaste={event => {
        event.preventDefault();
        commit(event.clipboardData.getData("text"));
      }}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      aria-label={ariaLabel}
      aria-invalid={status === "error"}
      disabled={disabled}
      readOnly={status === "success"}
    />

    <div className="cs-slots" aria-hidden="true">
      {slots.map((digit, index) => <motion.span
        key={index}
        className={`cs-slot${digit ? " cs-slot--filled" : ""}${index === activeIndex && focused ? " cs-slot--active" : ""}`}
        animate={
          status === "error" && !reducedMotion
            ? { x: [0, -5, 5, -3, 3, 0], opacity: [1, 0.55, 1] }
            : { x: 0, opacity: 1 }
        }
        transition={status === "error" ? { duration: 0.42, delay: index * 0.045 } : { duration: 0.2 }}
      >
        {digit ? <motion.span
          key={digit}
          className="cs-digit"
          initial={reducedMotion ? false : { y: rise, opacity: 0, scale: Math.max(0, 1 - bounce) }}
          animate={{ y: 0, opacity: 1, scale: 1 }}
          transition={{ duration: reducedMotion ? 0 : settle, delay: reducedMotion ? 0 : (index * cascade) / 1000, ease: EASE_SETTLE }}
        >{digit}</motion.span> : null}
        {index === activeIndex && focused && !locked ? <motion.span
          className="cs-caret"
          animate={reducedMotion ? { opacity: 1 } : { opacity: [1, 0.2, 1] }}
          transition={reducedMotion ? { duration: 0 } : { duration: 1.1, repeat: Infinity, ease: "easeInOut" }}
        /> : null}
      </motion.span>)}
    </div>

    {status === "success" && <motion.span
      className="cs-success"
      initial={reducedMotion ? false : { scale: 0.6, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={{ duration: reducedMotion ? 0 : 0.25, ease: EASE_SETTLE }}
    >
      <HugeiconsIcon icon={Tick02Icon} size={18} strokeWidth={2} />
    </motion.span>}
  </div>;
}
