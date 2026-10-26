import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  CaretDown,
  CheckCircle,
  CircleNotch,
  MinusCircle,
  WarningCircle
} from "@phosphor-icons/react";
import {
  ACTIVITY_STATUS,
  formatElapsed,
  measuredSeconds,
  mergeActivityFiles
} from "../chat/activity.js";
import { generationProgress } from "../chat/progress.js";
import ThoughtLine from "./reactbits/ThoughtLine.jsx";
import "./AgentActivity.css";

const STATUS_TEXT = {
  failed: "Failed",
  cancelled: "Stopped"
};

function baseName(path) {
  return String(path || "").split("/").pop() || "file";
}

function rowIcon(status) {
  if (status === ACTIVITY_STATUS.RUNNING) {
    return <CircleNotch size={13} weight="bold" className="vr-activity__spin" />;
  }
  if (status === ACTIVITY_STATUS.FAILED) return <WarningCircle size={14} weight="fill" />;
  if (status === ACTIVITY_STATUS.CANCELLED) return <MinusCircle size={14} weight="fill" />;
  return <CheckCircle size={14} weight="bold" />;
}

function rowDuration(event) {
  if (!Number.isFinite(event?.startedAt) || !Number.isFinite(event?.endedAt)) return "";
  const ms = event.endedAt - event.startedAt;
  return ms >= 1000 ? formatElapsed(ms) : "";
}

export default function AgentActivity({
  events = [],
  files = [],
  active = false,
  status = ACTIVITY_STATUS.COMPLETED,
  startedAt = null,
  completedAt = null,
  pinned = false,
  className = ""
}) {
  const rows = useMemo(() => mergeActivityFiles(events, files), [events, files]);
  // The live timeline opens itself so the thoughts are visible while the turn
  // runs, then stays readable until a newer turn takes over.
  const [open, setOpen] = useState(active);
  const [now, setNow] = useState(() => Date.now());
  const panelRef = useRef(null);
  const panelId = useId();

  useEffect(() => {
    if (active) setOpen(true);
  }, [active]);

  useEffect(() => {
    if (!pinned) setOpen(false);
  }, [pinned]);

  useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);

  useEffect(() => {
    if (!active || !open) return;
    const panel = panelRef.current;
    if (panel) panel.scrollTop = panel.scrollHeight;
  }, [active, open, rows.length]);

  const firstStartedAt = useMemo(() => {
    const values = rows.map(event => event.startedAt).filter(Number.isFinite);
    if (Number.isFinite(startedAt)) values.push(startedAt);
    return values.length > 0 ? Math.min(...values) : null;
  }, [rows, startedAt]);
  const lastEndedAt = useMemo(() => {
    const values = rows.map(event => event.endedAt).filter(Number.isFinite);
    if (Number.isFinite(completedAt)) values.push(completedAt);
    return values.length > 0 ? Math.max(...values) : null;
  }, [rows, completedAt]);

  const progress = useMemo(
    () => generationProgress({ events, files, active, startedAt, now }),
    [events, files, active, startedAt, now]
  );

  const elapsed =
    active
      ? progress?.elapsed || ""
      : firstStartedAt != null
        ? formatElapsed((lastEndedAt ?? now) - firstStartedAt)
        : "";
  const stateLabel = active
    ? progress?.label || "Thinking\u2026"
    : STATUS_TEXT[status] || "Completed";
  const elapsedSeconds = useMemo(
    () =>
      measuredSeconds({
        startedAt: firstStartedAt,
        endedAt: active ? null : lastEndedAt,
        now
      }),
    [firstStartedAt, lastEndedAt, active, now]
  );
  // Cancel and failure keep their own wording; only a measured run claims a duration.
  const doneLabel =
    elapsedSeconds == null
      ? status === ACTIVITY_STATUS.FAILED
        ? "Failed"
        : status === ACTIVITY_STATUS.CANCELLED
          ? "Stopped"
          : "Done thinking"
      : status === ACTIVITY_STATUS.FAILED
        ? "Failed after"
        : status === ACTIVITY_STATUS.CANCELLED
          ? "Stopped after"
          : "Thought for";
  const countLabel = `${rows.length} ${rows.length === 1 ? "step" : "steps"}`;
  const detail = active ? progress?.detail || "" : "";
  const statusBits = [stateLabel, elapsed, detail, rows.length > 0 ? countLabel : ""].filter(Boolean);

  if (rows.length === 0 && !active) return null;

  return (
    <section
      className={`vr-activity ${className}`.trim()}
      data-active={active ? "" : undefined}
      data-open={open ? "" : undefined}
      aria-label="Agent activity"
    >
      <div className="vr-activity__head">
        {rows.length > 0 ? (
          <button
            type="button"
            className="vr-activity__toggle"
            aria-expanded={open}
            aria-controls={panelId}
            aria-label={`${statusBits.join(" \u00b7 ")}. ${open ? "Collapse" : "Expand"} activity details`}
            onClick={() => setOpen(value => !value)}
          >
            <span className="vr-activity__chevron" aria-hidden="true">
              <CaretDown size={12} weight="bold" />
            </span>
          </button>
        ) : null}
        <ThoughtLine
          className="vr-activity__thought"
          working={active}
          label={stateLabel}
          doneLabel={doneLabel}
          glyph="sparkle"
          // A concrete color keeps the shimmer gradient readable; currentColor
          // would resolve against the transparent text fill.
          color={active ? "var(--accent)" : "#c7d2e3"}
          fontSize={13}
          breathPeriod={1.6}
          breathDepth={0.45}
          settleDuration={350}
          settleBlur={2}
          collapsible={false}
          collapseOnSettle={false}
          showTimer={active || elapsedSeconds != null}
          elapsed={elapsedSeconds}
        />
        {detail ? (
          <>
            <span className="vr-activity__dot vr-activity__dot--optional" aria-hidden="true">·</span>
            <span className="vr-activity__meta" title={detail} aria-hidden="true">{detail}</span>
          </>
        ) : null}
        {rows.length > 0 ? (
          <span className="vr-activity__count" aria-hidden="true">{countLabel}</span>
        ) : null}
      </div>

      <div className="vr-activity__panel" id={panelId} hidden={!open} ref={panelRef}>
        <ul className="vr-activity__list">
          {rows.map((event, index) => {
            const duration = rowDuration(event);
            return (
              <li
                key={event.id || `${event.phase}-${index}`}
                className="vr-activity__row"
                data-status={event.status}
              >
                <span className="vr-activity__mark" aria-hidden="true">
                  {rowIcon(event.status)}
                </span>
                <span className="vr-activity__label">
                  <span className="vr-activity__text">{event.label}</span>
                  {event.filePath ? (
                    <code className="vr-activity__file" title={event.filePath}>
                      {baseName(event.filePath)}
                    </code>
                  ) : null}
                  {event.summary ? (
                    <span className="vr-activity__summary">{event.summary}</span>
                  ) : null}
                </span>
                {duration ? (
                  <span className="vr-activity__duration" aria-hidden="true">{duration}</span>
                ) : null}
              </li>
            );
          })}
        </ul>
      </div>

      <span className="sr-only" role="status">
        {active ? "Agent is working." : `Agent ${stateLabel.toLowerCase()}.`}
      </span>
    </section>
  );
}
