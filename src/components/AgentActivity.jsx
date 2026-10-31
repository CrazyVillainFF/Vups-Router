import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  CaretDown,
  CheckCircle,
  CircleNotch,
  MinusCircle,
  WarningCircle
} from "@phosphor-icons/react";
import {
  ACTIVITY_COLLAPSE_HOLD_MS,
  ACTIVITY_STATUS,
  formatElapsed,
  measuredSeconds,
  mergeActivityFiles,
  shouldAutoCollapseActivity
} from "../chat/activity.js";
import { generationProgress } from "../chat/progress.js";
import ThoughtLine from "./reactbits/ThoughtLine.jsx";
import { ThinkingBouncy } from "./LoadingVisuals.jsx";
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
  className = ""
}) {
  const rows = useMemo(() => mergeActivityFiles(events, files), [events, files]);
  // A live turn is expanded while it works; a turn loaded from history mounts
  // folded so reopening the transcript never flashes a wall of steps.
  const [open, setOpen] = useState(active);
  const [userToggled, setUserToggled] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const panelRef = useRef(null);
  const ranLiveRef = useRef(active);
  const panelId = useId();

  useEffect(() => {
    if (!active) return undefined;
    ranLiveRef.current = true;
    setOpen(true);
  }, [active]);

  useEffect(() => {
    const fold = shouldAutoCollapseActivity({
      active,
      status,
      userToggled,
      ranLive: ranLiveRef.current
    });
    if (!fold) return undefined;
    const timer = setTimeout(() => setOpen(false), ACTIVITY_COLLAPSE_HOLD_MS);
    return () => clearTimeout(timer);
  }, [active, status, userToggled]);

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
  const hasTrace = rows.length > 0;

  if (rows.length === 0 && !active) return null;

  const toggle = () => {
    setUserToggled(true);
    setOpen(value => !value);
  };

  const head = (
    <>
      <span className="vr-activity__chevron" aria-hidden="true">
        <CaretDown size={12} weight="bold" />
      </span>
      {active ? <ThinkingBouncy className="vr-activity__loader" /> : null}
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
      {hasTrace ? (
        <span className="vr-activity__count" aria-hidden="true">{countLabel}</span>
      ) : null}
    </>
  );

  return (
    <section
      className={`vr-activity ${className}`.trim()}
      data-active={active ? "" : undefined}
      data-open={open ? "" : undefined}
      aria-label="Agent activity"
    >
      {hasTrace ? (
        <button
          type="button"
          className="vr-activity__head"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={toggle}
        >
          {head}
        </button>
      ) : (
        <div className="vr-activity__head">{head}</div>
      )}

      <div className="vr-activity__trace" data-open={open ? "" : undefined}>
        <div className="vr-activity__fold">
          <div
            className="vr-activity__panel"
            id={panelId}
            ref={panelRef}
            aria-hidden={open ? undefined : "true"}
            inert={open ? undefined : true}
          >
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
        </div>
      </div>

      <span className="sr-only" role="status">
        {active ? "Agent is working." : `Agent ${stateLabel.toLowerCase()}.`}
      </span>
    </section>
  );
}
