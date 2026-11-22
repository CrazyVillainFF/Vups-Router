import { isOpenTaskState, isTerminalTaskState } from "../services/taskApi.js";
import { createAssistantTurn, TURN_STATUS } from "./turnLifecycle.js";

export function taskProgressEvents(task) {
  const events = Array.isArray(task?.events) ? task.events : [];
  return events.filter(event => event && typeof event === "object");
}

export function taskRunsForConversation(tasks, conversationId) {
  const id = String(conversationId || "");
  if (!id) return [];
  return (Array.isArray(tasks) ? tasks : []).filter(
    view => String(view?.conversationId || "") === id &&
      (isOpenTaskState(view?.state) || isTerminalTaskState(view?.state))
  );
}

export function taskRunFor(taskId, conversationId) {
  const id = String(taskId || "");
  const assistantId = `task-run-${id}`;
  return {
    taskId: id,
    assistantId,
    runId: assistantId,
    conversationId: String(conversationId || "")
  };
}

export function restoreTaskTurn(messages, run, task) {
  const messageId = task.assistantMessageId || task.output?.messageId;
  const syntheticIndex = messages.findIndex(message => message.id === run.assistantId);
  // The placeholder can already wear the saved row's messageId (the submit path
  // renames it as soon as the task reports one). Matching it here would relabel
  // the placeholder and leave the real saved row beside it — the duplicate that
  // draws a second "Thought for". Only a row that is not the placeholder counts.
  const savedIndex = messageId
    ? messages.findIndex((message, index) =>
        index !== syntheticIndex && message.role === "assistant" && message.messageId === messageId
      )
    : -1;
  if (savedIndex >= 0) {
    if (syntheticIndex >= 0 && syntheticIndex !== savedIndex) {
      // The screen's placeholder and the server's saved row are the same turn.
      // Keeping both is what draws a second "Thought for" beside the answer:
      // the placeholder collects the run's progress while the saved row carries
      // the answer. The saved row wins; the placeholder is dropped.
      const merged = {
        ...messages[savedIndex],
        id: run.assistantId,
        ...(isOpenTaskState(task.state) ? { status: TURN_STATUS.STREAMING, error: null } : {})
      };
      return messages.flatMap((message, index) =>
        index === savedIndex ? [merged] : index === syntheticIndex ? [] : [message]
      );
    }
    return messages.map((message, index) => index === savedIndex ? {
      ...message,
      id: run.assistantId,
      ...(isOpenTaskState(task.state) ? { status: TURN_STATUS.STREAMING, error: null } : {})
    } : message);
  }
  if (syntheticIndex >= 0) return messages;
  const turn = { ...createAssistantTurn({ id: run.assistantId }), ...(messageId ? { messageId } : {}) };
  const userIndex = task.userMessageId
    ? messages.findIndex(message => message.role === "user" && message.messageId === task.userMessageId)
    : -1;
  const insertAt = userIndex < 0 ? messages.length : userIndex + 1;
  return [...messages.slice(0, insertAt), turn, ...messages.slice(insertAt)];
}

/**
 * Whether a run's answer is already on screen.
 *
 * A finished run that answered says nothing more that the answer does not
 * already say, so it needs no card of its own.
 */
export function taskRunHasAnswer(task) {
  const text = task?.output?.text;
  return typeof text === "string" && text.trim().length > 0;
}
