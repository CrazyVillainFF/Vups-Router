import React, { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { Plus, Stop, Play, Trash } from "@phosphor-icons/react";
import { useWorkspaces } from "../WorkspaceContext.jsx";
import {
  cancelDesktopToolOperation,
  onDesktopToolApproval,
  respondDesktopToolApproval
} from "../../native/desktopTools.js";
import {
  isSideTaskOperation,
  runSideTaskTurn,
  sideTaskModel,
  sideTaskOperationId,
  taskIdFromOperation
} from "../sideTaskRun.js";

const ACTIVITY_LIMIT = 40;

function nextTaskId(order) {
  for (let index = 1; index <= 64; index += 1) {
    const id = `task-${index}`;
    if (!order.includes(id)) return id;
  }
  return `task-${Date.now()}`;
}

const initialState = { tasks: {}, order: [], activeId: "", error: "" };

function patchTask(state, id, patch) {
  const task = state.tasks[id];
  if (!task) return state;
  return { ...state, tasks: { ...state.tasks, [id]: { ...task, ...patch } } };
}

function reducer(state, action) {
  switch (action.type) {
    case "create": {
      if (state.tasks[action.id]) return { ...state, activeId: action.id };
      return {
        ...state,
        order: [...state.order, action.id],
        activeId: action.id,
        error: "",
        tasks: {
          ...state.tasks,
          [action.id]: {
            id: action.id,
            title: "",
            conversationId: "",
            messages: [],
            activity: [],
            approvals: [],
            status: "idle",
            turn: 0,
            result: "",
            error: ""
          }
        }
      };
    }
    case "active":
      return state.tasks[action.id] ? { ...state, activeId: action.id } : state;
    case "drop": {
      const order = state.order.filter(id => id !== action.id);
      const tasks = { ...state.tasks };
      delete tasks[action.id];
      return {
        ...state,
        order,
        tasks,
        activeId: state.activeId === action.id ? order[0] || "" : state.activeId
      };
    }
    case "send":
      return patchTask(state, action.id, {
        title: state.tasks[action.id]?.title || action.text,
        status: "running",
        turn: (state.tasks[action.id]?.turn || 0) + 1,
        messages: [...(state.tasks[action.id]?.messages || []), { role: "user", content: action.text }],
        result: "",
        error: ""
      });
    case "activity":
      return patchTask(state, action.id, {
        activity: [...(state.tasks[action.id]?.activity || []), action.entry].slice(-ACTIVITY_LIMIT)
      });
    case "approval":
      return action.remove
        ? patchTask(state, action.id, {
            approvals: (state.tasks[action.id]?.approvals || []).filter(
              entry => entry.requestId !== action.requestId
            )
          })
        : patchTask(state, action.id, {
            approvals: [...(state.tasks[action.id]?.approvals || []), action.prompt]
          });
    case "conversation":
      return patchTask(state, action.id, { conversationId: action.conversationId });
    case "settled":
      return patchTask(state, action.id, {
        status: action.status,
        result: action.result ?? state.tasks[action.id]?.result ?? "",
        error: action.error ?? "",
        messages: action.message
          ? [...(state.tasks[action.id]?.messages || []), action.message]
          : state.tasks[action.id]?.messages || [],
        approvals: []
      });
    default:
      return state;
  }
}

export default function SideTaskPane() {
  const { supported, activeWorkspace } = useWorkspaces();
  const [state, dispatch] = useReducer(reducer, initialState);
  const [draft, setDraft] = useState("");
  const stateRef = useRef(state);
  const runs = useRef(new Map());
  const logRef = useRef(null);

  stateRef.current = state;
  const task = state.activeId ? state.tasks[state.activeId] : null;
  const running = task?.status === "running";
  // Re-read on every render: the model is chosen in the chat composer, and a
  // side task must say honestly which model it is about to run.
  const model = sideTaskModel();

  useEffect(() => {
    if (!supported || state.order.length > 0) return;
    dispatch({ type: "create", id: nextTaskId(state.order) });
  }, [supported, state.order.length]);

  useEffect(() => {
    if (!supported) return undefined;
    return onDesktopToolApproval(prompt => {
      // Chat approval prompts are ChatPage's to answer; this pane only takes
      // the ones carrying its own operation prefix.
      if (!isSideTaskOperation(prompt.operationId)) return;
      const id = taskIdFromOperation(prompt.operationId);
      if (!stateRef.current.tasks[id]) return;
      dispatch({ type: "approval", id, prompt });
    });
  }, [supported]);

  useEffect(() => {
    const node = logRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [task?.activity, task?.result, task?.messages.length, state.activeId]);

  useEffect(() => {
    const active = runs.current;
    return () => {
      // A pane that goes away stops its own runs: no orphaned approval stays
      // open and no native call keeps working behind an unmounted surface.
      for (const [, run] of active) {
        run.controller.abort();
        cancelDesktopToolOperation(run.operationId).catch(() => {});
      }
      active.clear();
    };
  }, []);

  const runTurn = useCallback(
    async (id, turn, text, messages) => {
      const operationId = sideTaskOperationId(id, turn);
      const controller = new AbortController();
      runs.current.set(id, { controller, operationId });
      try {
        const result = await runSideTaskTurn({
          taskId: id,
          turn,
          conversationId: stateRef.current.tasks[id]?.conversationId || "",
          messages,
          userText: text,
          workspacePath: activeWorkspace?.path || "",
          signal: controller.signal,
          onActivity: entry => dispatch({ type: "activity", id, entry }),
          onMeta: meta => {
            if (meta?.conversationId) {
              dispatch({ type: "conversation", id, conversationId: meta.conversationId });
            }
          }
        });
        const content = String(result?.content || "").trim();
        dispatch({
          type: "settled",
          id,
          status: "done",
          result: content || "The task finished without a written answer.",
          message: { role: "assistant", content: content || "(no answer)" }
        });
      } catch (error) {
        if (error?.name === "AbortError") {
          dispatch({ type: "settled", id, status: "stopped" });
          return;
        }
        const detail = String(error?.message || "The side task did not run.").trim();
        const failed = (Array.isArray(error?.toolSteps) ? error.toolSteps : [])
          .filter(step => step?.ok === false)
          .map(step => step?.label || step?.tool);
        dispatch({
          type: "settled",
          id,
          status: "failed",
          error: failed.length ? `${detail} Failed: ${failed.join(", ")}.` : detail
        });
      } finally {
        runs.current.delete(id);
      }
    },
    [activeWorkspace?.path]
  );

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text) return;
    const current = stateRef.current;
    const id = current.activeId || nextTaskId(current.order);
    if (!current.tasks[id]) dispatch({ type: "create", id });
    // The turn number is decided here instead of re-read after the dispatch:
    // React has not re-rendered yet, so reading the reducer would hand every
    // turn the first one's operation id and Stop could no longer tell them apart.
    const turn = (current.tasks[id]?.turn || 0) + 1;
    const messages = [...(current.tasks[id]?.messages || []), { role: "user", content: text }];
    dispatch({ type: "send", id, text });
    setDraft("");
    await runTurn(id, turn, text, messages);
  }, [draft, runTurn]);

  const stop = useCallback(() => {
    const id = stateRef.current.activeId;
    const run = runs.current.get(id);
    if (!run) return;
    run.controller.abort();
    cancelDesktopToolOperation(run.operationId).catch(() => {});
  }, []);

  const answer = useCallback((id, prompt, decision) => {
    dispatch({ type: "approval", id, requestId: prompt.requestId, remove: true });
    respondDesktopToolApproval(prompt.requestId, decision).catch(() => {});
  }, []);

  if (!supported) {
    return <div className="vr-pane-note">Side Task runs in the Windows app, where the local tools live.</div>;
  }

  const lastActivity = task?.activity.at(-1)?.message || "";
  const removable = state.order.length > 1 && !running;

  return (
    <div className="vr-side-pane">
      <div className="vr-pane-toolbar">
        <span className="vr-pane-title" title={model.label || "No model selected"}>
          {model.label || "No model selected"}
        </span>
        <button
          type="button"
          className="vr-icon-btn"
          aria-label="New side task"
          title="New task"
          onClick={() => dispatch({ type: "create", id: nextTaskId(state.order) })}
        >
          <Plus size={14} />
        </button>
        {removable ? (
          <button
            type="button"
            className="vr-icon-btn"
            aria-label="Delete this side task"
            title="Delete task"
            onClick={() => dispatch({ type: "drop", id: state.activeId })}
          >
            <Trash size={14} />
          </button>
        ) : null}
      </div>

      {state.order.length > 1 ? (
        <div className="vr-side-chips">
          {state.order.map(id => (
            <button
              key={id}
              type="button"
              className={`vr-side-chip${id === state.activeId ? " is-active" : ""}`}
              data-status={state.tasks[id].status}
              onClick={() => dispatch({ type: "active", id })}
            >
              {state.tasks[id].title || id}
            </button>
          ))}
        </div>
      ) : null}

      {model.error ? <div className="vr-inline-error">{model.error}</div> : null}
      {task?.error ? <div className="vr-inline-error">{task.error}</div> : null}

      <div className="vr-side-log" ref={logRef}>
        {!task || task.messages.length === 0 ? (
          <div className="vr-pane-note">
            Describe a job for this task. It runs on the model you picked for chat and the same Windows tools, with
            its own approvals and its own transcript, so the conversation you have open is untouched.
          </div>
        ) : null}
        {task?.messages.map((message, index) => (
          <div key={`${message.role}-${index}`} className={`vr-side-msg vr-side-msg--${message.role}`}>
            <strong>{message.role === "user" ? "You" : model.label || "Model"}</strong>
            <p>{message.content}</p>
          </div>
        ))}
        {running && task.activity.length > 0 ? (
          <ul className="vr-side-activity">
            {task.activity.map((entry, index) => (
              <li key={`a-${index}`} data-phase={entry.phase}>
                {entry.message || entry.phase}
              </li>
            ))}
          </ul>
        ) : null}
        {task?.approvals.map(prompt => (
          <div className="vr-side-approval" key={prompt.requestId}>
            <p className="vr-side-approval__summary">{prompt.summary}</p>
            {prompt.details?.length ? (
              <ul className="vr-side-approval__details">
                {prompt.details.map((line, index) => (
                  <li key={`d-${index}`}>{line}</li>
                ))}
              </ul>
            ) : null}
            <div className="vr-side-approval__acts">
              <button type="button" className="vr-panel-action" onClick={() => answer(task.id, prompt, "once")}>
                Allow once
              </button>
              {prompt.canPersist ? (
                <button type="button" className="vr-panel-action" onClick={() => answer(task.id, prompt, "always")}>
                  Allow always
                </button>
              ) : null}
              <button type="button" className="vr-panel-ghost" onClick={() => answer(task.id, prompt, "deny")}>
                Deny
              </button>
            </div>
          </div>
        ))}
        {!running && task?.result ? (
          <div className="vr-side-result">
            <strong>Result</strong>
            <p>{task.result}</p>
          </div>
        ) : null}
      </div>

      <div className="vr-side-foot">
        <span className="vr-side-state" data-status={task?.status || "idle"}>
          {running ? (lastActivity ? `Running — ${lastActivity}` : "Running") : `Status: ${task?.status || "idle"}`}
        </span>
        {running ? (
          <button type="button" className="vr-panel-action" onClick={stop} aria-label="Stop this side task">
            <Stop size={13} aria-hidden="true" /> Stop
          </button>
        ) : null}
      </div>

      <form
        className="vr-side-input"
        onSubmit={event => {
          event.preventDefault();
          send().catch(() => {});
        }}
      >
        <input
          type="text"
          value={draft}
          onChange={event => setDraft(event.target.value)}
          placeholder="Describe the task"
          aria-label="Side task instruction"
          spellCheck={false}
        />
        <button type="submit" className="vr-panel-action" disabled={!draft.trim() || Boolean(model.error) || running}>
          <Play size={13} aria-hidden="true" /> {running ? "Running…" : "Run"}
        </button>
      </form>
    </div>
  );
}
