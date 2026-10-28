import { useEffect, useState } from "react";
import { CaretDown, Check } from "@phosphor-icons/react";
import { formatDuration } from "../chat/progress.js";

export default function ProgressDock({ steps = [], startedAt, isGenerating = false }) {
  const [open, setOpen] = useState(true);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!isGenerating) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [isGenerating, startedAt]);

  if (!steps.length) return null;

  const elapsed = startedAt ? Math.max(0, Math.floor((now - startedAt) / 1000)) : 0;
  const count = steps.length;

  return (
    <section className="vr-progress-dock" aria-label="Generation progress">
      <button
        type="button"
        className="vr-progress-dock__head"
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
      >
        <span className="vr-progress-spinner" aria-hidden="true" />
        <span className="vr-progress-dock__title">Generating response</span>
        <span className="vr-progress-dock__meta">
          <span>{elapsed}s</span>
          <span aria-hidden="true">·</span>
          <span>{count} {count === 1 ? "step" : "steps"}</span>
        </span>
        <CaretDown
          size={15}
          weight="bold"
          className={`vr-progress-dock__chevron${open ? " is-open" : ""}`}
          aria-hidden="true"
        />
      </button>
      {open ? (
        <ol className="vr-progress-dock__steps">
          {steps.map(step => {
            const active = step.status === "active" && isGenerating;
            const duration = active
              ? Math.max(0, now - step.startedAt)
              : step.durationMs;
            return (
              <li key={step.id} className="vr-progress-step" data-status={active ? "active" : "completed"}>
                <span className="vr-progress-step__mark" aria-hidden="true">
                  {active ? <span className="vr-progress-step__spinner" /> : <Check size={13} weight="bold" />}
                </span>
                <span className="vr-progress-step__label">{step.label}</span>
                <span className="vr-progress-step__duration">{formatDuration(duration)}</span>
              </li>
            );
          })}
        </ol>
      ) : null}
    </section>
  );
}
