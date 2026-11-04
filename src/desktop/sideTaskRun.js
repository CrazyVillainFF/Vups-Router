import { COMBO_MODEL_ID, VUPS_MODEL_ID, loadStoredSelection } from "../chat/modelCatalog.js";
import { runDesktopToolChat } from "../services/desktopChat.js";

// A side task runs on the same native tool engine as the main chat, so its
// approvals must be attributable to the panel and not to a chat turn. The
// prefix is the contract ChatPage uses to leave those prompts alone.
export const SIDE_TASK_PREFIX = "sidetask_";

export function sideTaskOperationId(taskId, turn) {
  return `${SIDE_TASK_PREFIX}${taskId}-${turn}`;
}

export function sideTaskChatId(taskId) {
  return `${SIDE_TASK_PREFIX}${taskId}`;
}

export function taskIdFromOperation(operationId) {
  if (!isSideTaskOperation(operationId)) return "";
  const rest = String(operationId).slice(SIDE_TASK_PREFIX.length);
  const split = rest.lastIndexOf("-");
  return split > 0 ? rest.slice(0, split) : rest;
}

export function isSideTaskOperation(operationId) {
  return typeof operationId === "string" && operationId.startsWith(SIDE_TASK_PREFIX);
}

// The side task uses the model the user already picked for chat; it has no
// picker of its own, so an absent or multi-model selection is refused plainly.
export function sideTaskModel(storage) {
  const selection = loadStoredSelection(storage);
  if (!selection || typeof selection.model !== "string" || !selection.model) {
    return { error: "Pick a model in the chat composer first — a side task uses that same model." };
  }
  if (selection.kind === "combo" || selection.model === COMBO_MODEL_ID) {
    return { error: "Vups Combo AI cannot run a side task. Choose a single model in the chat composer." };
  }
  if (selection.kind === "vups" || selection.model === VUPS_MODEL_ID) {
    return { model: VUPS_MODEL_ID, vups: true, label: "Vups v3 Galax" };
  }
  if (selection.kind === "gateway") {
    return { model: selection.model, source: selection.source || undefined, label: selection.model };
  }
  if (selection.kind === "saved") {
    return {
      model: selection.model,
      configId: selection.configId || undefined,
      label: selection.model
    };
  }
  return { model: selection.model, label: selection.model };
}

export function runSideTaskTurn({
  taskId,
  turn,
  conversationId,
  messages,
  userText,
  workspacePath,
  storage,
  signal,
  onChunk,
  onActivity,
  onMeta,
  executeTool
} = {}) {
  const model = sideTaskModel(storage);
  if (model.error) {
    return Promise.reject(Object.assign(new Error(model.error), { code: "side_task_model_unset" }));
  }
  return runDesktopToolChat({
    conversationId: conversationId || undefined,
    messages,
    model: model.model,
    configId: model.configId,
    source: model.source,
    vups: model.vups,
    userText,
    operationId: sideTaskOperationId(taskId, turn),
    chatId: sideTaskChatId(taskId),
    searchRoots: workspacePath ? [workspacePath] : [],
    signal,
    onChunk,
    onActivity,
    onMeta,
    executeTool
  });
}
