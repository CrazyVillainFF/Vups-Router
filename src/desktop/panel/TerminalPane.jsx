import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { ArrowsClockwise, Play, Stop, Terminal as TerminalIcon, Trash } from "@phosphor-icons/react";
import { useWorkspaces } from "../WorkspaceContext.jsx";
import { usePanel } from "./PanelContext.jsx";
import {
  closeTerminalSession,
  listTerminalSessions,
  onTerminalExit,
  onTerminalOutput,
  sendTerminalInput,
  startTerminalSession,
  stopTerminalSession,
  terminalSessionStatus
} from "../panelTerminalBridge.js";

// The pane keeps more scrollback than the native tail it is seeded from, and a
// ceiling of its own so a chatty command cannot grow the document forever.
const LOG_LIMIT = 120_000;
const SEED_LIMIT = 6_000;

function tail(text, limit) {
  if (text.length <= limit) return text;
  return text.slice(text.length - limit);
}

function nextSessionId(used) {
  for (let index = 1; index <= 32; index += 1) {
    const id = index === 1 ? "panel" : `panel-${index}`;
    if (!used.has(id)) return id;
  }
  return `panel-${Date.now()}`;
}

const initialState = {
  logs: {},
  sessions: {},
  activeId: "",
  limit: 0,
  busy: "",
  error: ""
};

function reducer(state, action) {
  switch (action.type) {
    case "log": {
      const id = action.sessionId;
      if (!id) return state;
      const merged = tail((state.logs[id] || "") + action.text, LOG_LIMIT);
      return { ...state, logs: { ...state.logs, [id]: merged } };
    }
    case "snapshot": {
      const snap = action.snapshot;
      if (!snap || !snap.sessionId) return state;
      const id = snap.sessionId;
      const logs =
        !state.logs[id] && typeof snap.transcript === "string"
          ? { ...state.logs, [id]: tail(snap.transcript, SEED_LIMIT) }
          : state.logs;
      const sessions = {
        ...state.sessions,
        [id]: { ...state.sessions[id], ...snap }
      };
      return action.clearLog ? { ...state, sessions, logs: { ...state.logs, [id]: "" } } : { ...state, sessions, logs };
    }
    case "list": {
      const sessions = { ...state.sessions };
      for (const item of action.sessions) {
        if (item && item.sessionId) sessions[item.sessionId] = { ...sessions[item.sessionId], ...item };
      }
      return { ...state, sessions, limit: action.limit || state.limit };
    }
    case "active":
      return { ...state, activeId: action.sessionId };
    case "drop": {
      if (!state.sessions[action.sessionId]) return state;
      const sessions = { ...state.sessions };
      delete sessions[action.sessionId];
      const logs = { ...state.logs };
      delete logs[action.sessionId];
      return { ...state, sessions, logs };
    }
    case "busy":
      return { ...state, busy: action.value };
    case "error":
      return { ...state, error: action.value };
    default:
      return state;
  }
}

export default function TerminalPane() {
  const { supported, activeWorkspace, touchWorkspace } = useWorkspaces();
  const { activeTab, open } = usePanel();
  const active = open && activeTab === "terminal";

  const [state, dispatch] = useReducer(reducer, initialState);
  const [draft, setDraft] = useState("");
  const [cwdDraft, setCwdDraft] = useState("");
  const [history, setHistory] = useState([]);
  const [recallAt, setRecallAt] = useState(-1);
  const [autoscroll, setAutoscroll] = useState(true);

  const logRef = useRef(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const cwdRef = useRef(cwdDraft);
  cwdRef.current = cwdDraft;
  // A finished command may have written files (an install, a build, a test run
  // that snapshots), so the exit event is what tells the explorer to re-read
  // disk. These refs keep the one-shot native subscription from going stale.
  const workspaceIdRef = useRef("");
  workspaceIdRef.current = activeWorkspace?.id || "";
  const touchRef = useRef(null);
  touchRef.current = touchWorkspace;

  // The native session name is only valid once, so the workspace folder is
  // resolved lazily and remembered per session.
  const sessionIds = useMemo(() => Object.keys(state.sessions), [state.sessions]);
  const current = state.activeId ? state.sessions[state.activeId] : null;
  const log = state.activeId ? state.logs[state.activeId] || "" : "";

  // The folder field is a starting point, not live state: it defaults to the
  // selected workspace and then to whatever the shell reported for that session.
  useEffect(() => {
    const id = state.activeId;
    const known = id ? stateRef.current.sessions[id]?.cwd : "";
    setCwdDraft(known || activeWorkspace?.path || "");
  }, [state.activeId, activeWorkspace]);

  useEffect(() => {
    const node = logRef.current;
    if (!node || !autoscroll) return;
    node.scrollTop = node.scrollHeight;
  }, [log, autoscroll]);

  useEffect(() => {
    const unsubscribeOutput = onTerminalOutput(packet => {
      dispatch({ type: "log", sessionId: packet.sessionId, text: packet.text });
    });
    const unsubscribeExit = onTerminalExit(payload => {
      if (payload && payload.sessionId) {
        dispatch({
          type: "snapshot",
          snapshot: { sessionId: payload.sessionId, status: payload.status, exitCode: payload.exitCode, running: false }
        });
        if (payload.status === "exited") touchRef.current?.(workspaceIdRef.current);
      }
    });
    return () => {
      unsubscribeOutput();
      unsubscribeExit();
    };
  }, []);

  // Re-adopt whatever the shell is doing when the tab comes back into focus.
  useEffect(() => {
    if (!active || !supported) return;
    listTerminalSessions()
      .then(result => dispatch({ type: "list", sessions: result?.sessions || [], limit: result?.limit }))
      .catch(() => {});
    const id = stateRef.current.activeId;
    if (id) terminalSessionStatus(id).then(snapshot => dispatch({ type: "snapshot", snapshot })).catch(() => {});
  }, [active, supported]);

  const start = useCallback(async target => {
    dispatch({ type: "busy", value: "start" });
    dispatch({ type: "error", value: "" });
    try {
      const used = new Set(Object.keys(stateRef.current.sessions));
      const id = target || nextSessionId(used);
      const cwd = cwdRef.current.trim() || stateRef.current.sessions[id]?.cwd || "";
      const snapshot = await startTerminalSession(id, cwd);
      dispatch({ type: "snapshot", snapshot });
      dispatch({ type: "active", sessionId: snapshot.sessionId || id });
      return snapshot.sessionId || id;
    } catch (startError) {
      dispatch({ type: "error", value: startError.message });
      return null;
    } finally {
      dispatch({ type: "busy", value: "" });
    }
  }, []);

  const send = async () => {
    const text = draft;
    if (!text.trim()) return;
    dispatch({ type: "error", value: "" });
    let id = state.activeId;
    if (!id || !state.sessions[id]?.running) {
      id = await start(id || undefined);
      if (!id) return;
    }
    dispatch({ type: "busy", value: "send" });
    try {
      await sendTerminalInput(id, text.endsWith("\n") ? text : `${text}\n`);
      setHistory(items => [...items.slice(-49), text]);
      setRecallAt(-1);
      setDraft("");
    } catch (sendError) {
      dispatch({ type: "error", value: sendError.message });
    } finally {
      dispatch({ type: "busy", value: "" });
    }
  };

  const stop = async () => {
    if (!state.activeId) return;
    dispatch({ type: "busy", value: "stop" });
    dispatch({ type: "error", value: "" });
    try {
      const snapshot = await stopTerminalSession(state.activeId);
      dispatch({ type: "snapshot", snapshot });
    } catch (stopError) {
      dispatch({ type: "error", value: stopError.message });
    } finally {
      dispatch({ type: "busy", value: "" });
    }
  };

  const close = async () => {
    if (!state.activeId) return;
    const id = state.activeId;
    const remaining = sessionIds.filter(key => key !== id);
    dispatch({ type: "busy", value: "close" });
    dispatch({ type: "error", value: "" });
    try {
      const snapshot = await closeTerminalSession(id);
      dispatch({ type: "snapshot", snapshot });
      dispatch({ type: "drop", sessionId: id });
      dispatch({ type: "active", sessionId: remaining[0] || "" });
    } catch (closeError) {
      dispatch({ type: "error", value: closeError.message });
    } finally {
      dispatch({ type: "busy", value: "" });
    }
  };

  const refresh = () => {
    if (!state.activeId) return;
    dispatch({ type: "error", value: "" });
    terminalSessionStatus(state.activeId)
      .then(snapshot => dispatch({ type: "snapshot", snapshot }))
      .catch(refreshError => dispatch({ type: "error", value: refreshError.message }));
  };

  const clear = () => {
    if (!state.activeId) return;
    dispatch({ type: "snapshot", snapshot: { sessionId: state.activeId, transcript: "" }, clearLog: true });
  };

  const onDraftKeys = event => {
    if (event.key === "ArrowUp" && history.length) {
      event.preventDefault();
      const index = recallAt < 0 ? history.length - 1 : Math.max(0, recallAt - 1);
      setRecallAt(index);
      setDraft(history[index]);
    } else if (event.key === "ArrowDown" && recallAt >= 0) {
      event.preventDefault();
      const index = recallAt + 1;
      if (index >= history.length) {
        setRecallAt(-1);
        setDraft("");
      } else {
        setRecallAt(index);
        setDraft(history[index]);
      }
    }
  };

  if (!supported) {
    return <div className="vr-pane-note">The terminal is available in the Windows app.</div>;
  }

  return (
    <div className="vr-terminal-pane">
      <div className="vr-pane-toolbar">
        <span className="vr-pane-title">
          <TerminalIcon size={14} aria-hidden="true" />
          {current ? current.sessionId : "No session"}
          {current ? <span className="vr-terminal-state" data-status={current.status}>{current.status}</span> : null}
        </span>
        <span className="vr-terminal-actions">
          <button
            type="button"
            className="vr-icon-btn"
            onClick={clear}
            disabled={!state.activeId}
            aria-label="Clear this terminal"
            title="Clear"
          >
            <Trash size={14} />
          </button>
          <button
            type="button"
            className="vr-icon-btn"
            onClick={refresh}
            disabled={!state.activeId}
            aria-label="Refresh terminal status"
            title="Refresh status"
          >
            <ArrowsClockwise size={14} />
          </button>
          <button
            type="button"
            className="vr-icon-btn"
            onClick={() => start()}
            disabled={Boolean(state.busy)}
            aria-label="New terminal session"
            title="New session"
          >
            <Play size={13} />
          </button>
        </span>
      </div>

      {sessionIds.length > 1 ? (
        <div className="vr-terminal-sessions" role="group" aria-label="Terminal sessions">
          {sessionIds.map(id => (
            <button
              type="button"
              key={id}
              className="vr-terminal-chip"
              data-active={id === state.activeId ? "true" : undefined}
              onClick={() => dispatch({ type: "active", sessionId: id })}
            >
              {id}
              <span className="vr-terminal-state" data-status={state.sessions[id].status}>
                {state.sessions[id].status}
              </span>
            </button>
          ))}
        </div>
      ) : null}

      {!current?.running ? (
        <label className="vr-terminal-cwd">
          <span>Start in</span>
          <input
            type="text"
            value={cwdDraft}
            onChange={event => setCwdDraft(event.target.value)}
            placeholder="Your home folder"
            aria-label="Terminal working folder"
            spellCheck={false}
          />
        </label>
      ) : null}

      {state.error ? <div className="vr-inline-error">{state.error}</div> : null}

      <pre className="vr-terminal-log" ref={logRef} tabIndex={0} aria-label="Terminal output">
        {log || "No session yet. Run a command to start Windows PowerShell."}
      </pre>

      <div className="vr-terminal-foot">
        <div className="vr-terminal-meta">
          <span title={current?.cwd || ""}>{current?.cwd || "not started"}</span>
          {current?.exitCode != null ? <span>exit {current.exitCode}</span> : null}
          {current?.transcriptTruncated ? <span>older output scrolled off</span> : null}
        </div>
        <form
          className="vr-terminal-input"
          onSubmit={event => {
            event.preventDefault();
            send();
          }}
        >
          <input
            type="text"
            value={draft}
            onChange={event => {
              setDraft(event.target.value);
              setRecallAt(-1);
            }}
            onKeyDown={onDraftKeys}
            placeholder="Type a PowerShell command"
            aria-label="PowerShell command"
            spellCheck={false}
          />
          <button type="submit" className="vr-panel-action" disabled={Boolean(state.busy) || !draft.trim()}>
            Run
          </button>
          <button
            type="button"
            className="vr-panel-action"
            onClick={stop}
            disabled={!current?.running || Boolean(state.busy)}
            title="A piped shell has no interrupt key, so this ends the session and its child processes."
          >
            <Stop size={13} aria-hidden="true" /> Stop
          </button>
          <button type="button" className="vr-panel-action" onClick={close} disabled={!state.activeId || Boolean(state.busy)}>
            Close
          </button>
        </form>
        <label className="vr-terminal-option">
          <input type="checkbox" checked={autoscroll} onChange={() => setAutoscroll(value => !value)} />
          Follow output
        </label>
        {current?.running ? (
          <p className="vr-terminal-hint">
            This session stays open between commands. Stop ends it and its child processes, because a piped shell has
            no interrupt key.
          </p>
        ) : null}
      </div>
    </div>
  );
}
