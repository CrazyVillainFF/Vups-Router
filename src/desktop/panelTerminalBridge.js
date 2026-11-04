import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isTauriRuntime } from "../native/shell.js";

export { isTauriRuntime };

const NOT_AVAILABLE = "The terminal is available in the Windows app.";

export const TERMINAL_OUTPUT_EVENT = "panel-terminal:output";
export const TERMINAL_EXIT_EVENT = "panel-terminal:exit";
export const TERMINAL_READY_EVENT = "panel-terminal:ready";

function call(command, args) {
  if (!isTauriRuntime()) return Promise.reject(new Error(NOT_AVAILABLE));
  return invoke(command, args);
}

function fail(error, fallback) {
  if (typeof error === "string" && error.trim()) return new Error(error.trim());
  if (error instanceof Error && error.message) return error;
  return new Error(fallback);
}

async function run(command, args, fallback) {
  try {
    return await call(command, args);
  } catch (error) {
    throw fail(error, fallback);
  }
}

export function startTerminalSession(sessionId, cwd) {
  return run(
    "panel_terminal_start",
    { sessionId: sessionId || null, cwd: cwd || null },
    "Windows PowerShell could not be started."
  );
}

export function sendTerminalInput(sessionId, text) {
  return run("panel_terminal_send", { sessionId, text }, "The command could not be sent.");
}

export function terminalSessionStatus(sessionId) {
  return run("panel_terminal_status", { sessionId }, "The terminal status is unavailable.");
}

export function listTerminalSessions() {
  return run("panel_terminal_list", {}, "The terminal sessions could not be listed.");
}

export function stopTerminalSession(sessionId) {
  return run("panel_terminal_stop", { sessionId }, "The terminal could not be stopped.");
}

export function closeTerminalSession(sessionId) {
  return run("panel_terminal_close", { sessionId }, "The terminal could not be closed.");
}

// Streams are pushed by the native shell thread, so the pane subscribes once
// per event name and filters by session id itself.
function subscribe(eventName, onEvent) {
  if (!isTauriRuntime()) return () => {};
  let disposed = false;
  let unlisten = null;
  listen(eventName, event => {
    if (!disposed) onEvent(event.payload);
  })
    .then(dispose => {
      if (disposed) dispose();
      else unlisten = dispose;
    })
    .catch(() => {});
  return () => {
    disposed = true;
    unlisten?.();
  };
}

export function onTerminalOutput(onPacket) {
  return subscribe(TERMINAL_OUTPUT_EVENT, packet => {
    if (packet && typeof packet.text === "string") onPacket(packet);
  });
}

export function onTerminalExit(onExit) {
  return subscribe(TERMINAL_EXIT_EVENT, onExit);
}

export function onTerminalReady(onReady) {
  return subscribe(TERMINAL_READY_EVENT, onReady);
}
