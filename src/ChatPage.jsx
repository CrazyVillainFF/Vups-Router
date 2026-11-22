import React, {
  useState,
  useRef,
  useEffect,
  useCallback,
  useMemo,
  useId,
} from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import {
  ArrowClockwise,
  Warning,
  Copy,
  Check,
  DownloadSimple,
  ThumbsUp,
  ThumbsDown,
  ShareNetwork,
  Image as ImageIcon,
  FileText,
  FolderSimple,
  CaretDown,
  CaretUp,
  Wrench,
  GithubLogo,
} from "@phosphor-icons/react";
import PromptBar from "./components/reactbits/PromptBar.jsx";
import NativeChatControls from "./native/NativeChatControls.jsx";
import NativePermissionDialog from "./native/NativePermissionDialog.jsx";
import InChatPermissionCard from "./native/InChatPermissionCard.jsx";
import ToolAccessDialog from "./native/ToolAccessDialog.jsx";
import HoldToDeleteDialog from "./components/HoldToDeleteDialog.jsx";
import { NATIVE_SHELLS, detectNativeShell, isTauriRuntime } from "./native/shell.js";
import {
  DEFAULT_PERMISSION_MODE,
  isPermissionMode,
  permissionModeInfo,
  readPermissionMode,
  savePermissionMode,
} from "./native/permissions.js";
import { effectivePolicyProblem } from "./native/effectivePolicy.js";
import { chatScopeStorageKey } from "./desktop/accountSessionState.js";
import AgentActivity from "./components/AgentActivity.jsx";
import GeneratedFiles from "./components/GeneratedFiles.jsx";
import ProjectSaveCard from "./components/ProjectSaveCard.jsx";
import ContextLimitNotice, {
  ApiKeyNotice,
  ContextHandoffCard,
  RequestBlockedNotice
} from "./components/ContextLimitNotice.jsx";
import {
  artifactForTurn,
  artifactFromResponse,
  codingIntent,
  continueArtifact,
  mergeTextContinuation,
  responseSummary,
  streamingArtifact,
  wantsInlineCode
} from "./chat/artifacts.js";
import { copyText } from "./chat/clipboard.js";
import { applyProgressRows } from "./chat/activity.js";
import { trackApprovalTransition } from "./chat/approvalEvents.js";
import { downloadBlob } from "./chat/downloads.js";
import { collapseMessageText } from "./chat/messageText.js";
import GitHubRepoBrowser from "./github/GitHubRepoBrowser.jsx";
import { classifySlash, helpText, slashMenuItems } from "./chat/slashCommands.js";
import { ownerRepoFrom, repoLabel, repoScopeMessage } from "./github/githubBrowser.js";
import {
  canPersistFeedback,
  feedbackRequest,
  nextFeedback,
  sharePayload
} from "./chat/messageActions.js";
import {
  ACCEPTED_IMAGE_ACCEPT_ATTR,
  ATTACHMENT_LIMITS,
  IMAGE_LIMITS,
  NATIVE_ATTACHMENT_ACCEPT_ATTR,
  TEXT_LIMITS,
  attachmentTotals,
  contentWithTextAttachments,
  fileIdentity,
  formatBytes,
  generateAttachmentId,
  isImageFile,
  isTextAttachmentFile,
  readImageAttachment,
  readTextAttachment,
  readyTextAttachments,
  skipRecord,
  textAttachmentChars,
  toPayloadImages,
  unsupportedAttachmentReason,
  validateImageFile,
  validateTextFile,
} from "./chat/attachments.js";
import {
  folderAttachmentFromReport,
  prepareFolderAttachment,
} from "./chat/folderAttachments.js";
import {
  pickComposerFolder,
  readComposerFiles,
  releaseComposerFolder,
} from "./desktop/composerFiles.js";
import { stopChatTurn, streamChatResponse } from "./services/chat.js";
import { isCloudOnline, useConnectivity } from "./connectivity/connectivity.js";
import { runDesktopToolChat } from "./services/desktopChat.js";
import { fetchComboState } from "./combo/comboApi.js";
import { comboCatalogState } from "./combo/comboSelection.js";
import { endComboRun, reportComboEvent, startComboRun } from "./combo/comboLive.js";
import { runComboTurn } from "./combo/comboTurn.js";
import {
  cancelDesktopToolApprovals,
  cancelDesktopToolOperation,
  executeDesktopTool,
  onDesktopToolApproval,
  respondDesktopToolApproval,
  setDesktopToolPolicy
} from "./native/desktopTools.js";
import { presentChatError } from "./chat/chatErrors.js";
import { presentSaveWarning, settleTurnFromError } from "./chat/turnOutcome.js";
import { resolveTurnNotice, TURN_NOTICE } from "./chat/turnPresentation.js";
import {
  contextHandoffGoal,
  isContextHandoffContent
} from "./chat/contextLimit.js";
import {
  appendTurnChunk,
  beginContinuation,
  cancelTurn,
  completeTurn,
  createAssistantTurn,
  failTurn,
  hasRecoverableOutput,
  markTurnMeta,
  recordTurnActivity,
  recordTurnProgress,
  sanitizeHistoryMessages,
  storedMessageId,
  syncTurnContent,
  TURN_STATUS
} from "./chat/turnLifecycle.js";
import {
  taskProgressEvents,
  taskRunFor,
  taskRunHasAnswer,
  taskRunsForConversation,
  restoreTaskTurn
} from "./chat/taskRun.js";
import TaskTurnPanel from "./chat/TaskTurnPanel.jsx";
import { durableChatRun, taskRunRequest, taskRunSubmissionKey } from "./tasks/taskSubmission.js";
import {
  LOCAL_AI_STATES,
  chatLocalModel,
  chatLocalModelTurn,
  detectLocalRuntime,
  localAiSupported
} from "./localai/localRuntime.js";
import { desktopRequestOpensTerminal, runLocalAgent } from "./localai/localAgent.js";
import { comboPlan, useLocalComboConfig } from "./localai/localCombo.js";
import { runLocalCombo } from "./localai/localComboRun.js";
import { buildRoutingPlan, planSummary, stageRoleLabel } from "./localai/localRouter.js";
import { readLocalRoutingMap, saveLocalRouting } from "./localai/localRoutingLog.js";
import {
  buildProjectSavePlan,
  joinProjectPath,
  readProjectSaveMap,
  saveGeneratedFiles,
  saveProjectSaveRecord,
  shouldAutoSaveProjectFiles,
  wantsDownloadDelivery
} from "./localai/localProjectSave.js";
import { createWorkspaceFile, readWorkspaceText } from "./desktop/workspaceBridge.js";
import {
  appendNativeLocalChatMessage,
  getNativeLocalChat,
  isNativeLocalChatId,
  nativeConversationApi,
  nativeLocalChatsAvailable,
  updateNativeLocalChat
} from "./localai/localChatStore.js";
import {
  ensureLocalChatsFolder,
  isLocalChat,
  markLocalChat,
  updateLocalChat
} from "./localai/localChats.js";
import {
  beginLocalRun,
  clearLocalRun,
  clearLocalRunDraft,
  finishLocalRun,
  getLocalRun,
  LOCAL_RUN_STATES,
  noteLocalRunStage,
  readLocalRunDraft,
  setLocalRunOwner,
  stopLocalRun,
  subscribeLocalRuns
} from "./localai/localRunStore.js";
import { isStaleAnswerError, taskRunIsLive } from "./tasks/taskRunView.js";
import { taskErrorLine } from "./tasks/taskProgress.js";
import { isTerminalTaskState } from "./services/taskApi.js";
import { useTaskTracker } from "./tasks/TaskTrackerContext.jsx";
import {
  buildCatalog,
  chatReference,
  fallbackRow,
  loadStoredSelection,
  resolveSelection,
  saveStoredSelection,
  selectionFromRow,
  CUSTOM_MODEL_TYPE,
  FREE_MODEL_TYPE,
} from "./chat/modelCatalog.js";
import {
  appendConversationMessage,
  createConversation,
  fetchConversationArtifacts,
  generateImage,
  getApiErrorMessage,
  getConversation,
  isConversationCreateUnavailable,
  removeProvider,
  saveMessageFeedback,
} from "./services/api.js";
import {
  cachedFetchFreeModels,
  cachedFetchOmniRouteStatus,
  cachedFetchProviderConfig,
  cachedFetchProviderModels,
  cachedFetchSharedModelStatus,
  invalidateSettingsKey,
} from "./services/settingsCache.js";
import {
  createContinuationGuard,
  prepareContinuation
} from "./chat/continuation.js";
import { flushPendingChatMessages, saveChatMessageFirst } from "./chat/messageOutbox.js";
import { usePreferences } from "./desktop/PreferencesContext.jsx";
import { useTasks } from "./desktop/TaskContext.jsx";
import { useWorkspaces } from "./desktop/WorkspaceContext.jsx";
import WorkspaceFilesDialog from "./desktop/WorkspaceFilesDialog.jsx";
import { pathCandidates, projectTaskReason } from "./desktop/workspaceRequest.js";
import { isSideTaskOperation } from "./desktop/sideTaskRun.js";
import "./chat.css";

// â”€â”€â”€ Chat configuration â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const VUPS_EFFORTS = ["Precise", "Balanced", "Creative"];
const EFFORT_TEMPERATURE = { Precise: 0.3, Balanced: 0.7, Creative: 1.0 };
// Mirrors the server's per-message cap so folder text is not rejected earlier
// on the client than the backend that accepts it.
const MAX_USER_MESSAGE_CHARS = 2_000_000;
const USER_MESSAGE_LIMIT_WARNING = `That message and its attached text are too long. Keep the total under ${MAX_USER_MESSAGE_CHARS.toLocaleString("en-US")} characters.`;
const COMPOSER_COMMANDS = slashMenuItems();
// The composer sends ordinary turns, so every turn names the server's default
// mode; Motion Design remains a real mode on the backend for any caller that asks.
const DEFAULT_CHAT_MODE = "general";

function localBrowserStorage() {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function sessionBrowserStorage() {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

// Web Speech API dictation (active only if supported by browser)
const handleDictate =
  typeof window !== "undefined" &&
  (window.SpeechRecognition || window.webkitSpeechRecognition)
    ? () =>
        new Promise((resolve) => {
          const SpeechRec =
            window.SpeechRecognition || window.webkitSpeechRecognition;
          const recognition = new SpeechRec();
          recognition.lang = "en-US";
          recognition.interimResults = false;
          recognition.maxAlternatives = 1;
          recognition.onresult = (e) => {
            const text = e.results[0]?.[0]?.transcript || "";
            resolve(text);
          };
          recognition.onerror = () => resolve(null);
          recognition.onend = () => resolve(null);
          recognition.start();
        })
    : undefined;

// â”€â”€â”€ Utilities â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function generateId() {
  return Math.random().toString(36).slice(2, 11);
}

// A chat-scoped "Allow Always" answer lives in native memory keyed by this id.
// The map only remembers which id a saved conversation used; it is never a
// permission by itself, so losing or clearing it can only cause a re-ask. The
// key itself is shared with the sign-out cleanup, which ends this map when an
// account's session does.
const CHAT_SCOPE_LIMIT = 200;

function newChatScopeId() {
  return `chat_scope_${generateId()}${generateId()}`;
}

function readChatScopes(owner) {
  const storage = localBrowserStorage();
  if (!storage) return {};
  try {
    const parsed = JSON.parse(storage.getItem(chatScopeStorageKey(owner)) || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeChatScopes(owner, scopes) {
  const storage = localBrowserStorage();
  if (!storage) return;
  try {
    storage.setItem(
      chatScopeStorageKey(owner),
      JSON.stringify(Object.fromEntries(Object.entries(scopes).slice(-CHAT_SCOPE_LIMIT)))
    );
  } catch {
    // A full or blocked storage only means the scope id is re-created later,
    // which at worst asks for permission again.
  }
}

function chatScopeForConversation(owner, conversationId) {
  const id = typeof conversationId === "string" ? conversationId.trim() : "";
  if (!id) return "";
  const scopes = readChatScopes(owner);
  if (typeof scopes[id] === "string" && scopes[id]) return scopes[id];
  const scope = newChatScopeId();
  scopes[id] = scope;
  writeChatScopes(owner, scopes);
  return scope;
}

function rememberChatScope(owner, conversationId, scopeId) {
  const id = typeof conversationId === "string" ? conversationId.trim() : "";
  const scope = typeof scopeId === "string" ? scopeId.trim() : "";
  if (!id || !scope) return;
  const scopes = readChatScopes(owner);
  if (scopes[id] === scope) return;
  scopes[id] = scope;
  writeChatScopes(owner, scopes);
}

// The repository a chat works on is remembered per saved conversation, so a
// reload restores the same chip its transcript already carries a scope note for.
const REPO_SCOPE_PREFIX = "vupsrouter.github.repo-scope.v1";
const REPO_SCOPE_LIMIT = 200;

function normalisedRepoScope(value) {
  if (!value || typeof value !== "object") return null;
  const owner = typeof value.owner === "string" ? value.owner.trim() : "";
  const name = typeof value.name === "string" ? value.name.trim() : "";
  if (!owner || !name) return null;
  return {
    owner,
    name,
    fullName: typeof value.fullName === "string" && value.fullName ? value.fullName : `${owner}/${name}`,
    branch: typeof value.branch === "string" ? value.branch.trim() : "",
    defaultBranch: typeof value.defaultBranch === "string" ? value.defaultBranch.trim() : "",
    url: typeof value.url === "string" ? value.url : ""
  };
}

function readRepoScopes(owner) {
  const storage = localBrowserStorage();
  if (!storage) return {};
  try {
    const parsed = JSON.parse(storage.getItem(`${REPO_SCOPE_PREFIX}.${owner || "guest"}`) || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeRepoScopes(owner, scopes) {
  const storage = localBrowserStorage();
  if (!storage) return;
  try {
    storage.setItem(
      `${REPO_SCOPE_PREFIX}.${owner || "guest"}`,
      JSON.stringify(Object.fromEntries(Object.entries(scopes).slice(-REPO_SCOPE_LIMIT)))
    );
  } catch {
    // A full or blocked storage only means the chip is not restored on reload;
    // the scope note already sent stays in the conversation.
  }
}

function repoScopeForConversation(owner, conversationId) {
  const id = typeof conversationId === "string" ? conversationId.trim() : "";
  if (!id) return null;
  return normalisedRepoScope(readRepoScopes(owner)[id]);
}

function rememberRepoScope(owner, conversationId, repo) {
  const id = typeof conversationId === "string" ? conversationId.trim() : "";
  const chosen = normalisedRepoScope(repo);
  if (!id || !chosen) return;
  const scopes = readRepoScopes(owner);
  scopes[id] = chosen;
  writeRepoScopes(owner, scopes);
}

function forgetRepoScope(owner, conversationId) {
  const id = typeof conversationId === "string" ? conversationId.trim() : "";
  if (!id) return;
  const scopes = readRepoScopes(owner);
  if (!(id in scopes)) return;
  delete scopes[id];
  writeRepoScopes(owner, scopes);
}

// The scope is stated once per repository and branch, so a repeated message does
// not pad the transcript and changing branch re-announces the new ref.
function hasRepoScopeNote(messages, repo) {
  const needle = `GitHub scope: ${repoLabel(repo)}`;
  const ref = `Branch: ${repo.branch || repo.defaultBranch || "its default branch"}`;
  return (messages || []).some(
    message =>
      message.role === "user" &&
      String(message.content || "").includes(needle) &&
      String(message.content || "").includes(ref)
  );
}

/**
 * A saved desktop turn carries the log of the steps it really ran. Replaying it
 * through the same merge the live turn uses means a reload shows the same lines
 * in the same order, and a turn that was interrupted still shows work that was
 * never finished as unfinished.
 */
function storedActivity(message) {
  if (message.role !== "assistant" || !Array.isArray(message.progress)) return null;
  const rows = applyProgressRows([], message.progress, {
    runId: `stored:${message.messageId || ""}`
  });
  return rows.length > 0 ? rows : null;
}

function toLocalMessage(stored, artifactMap = null) {
  const savedFailure = stored.role === "assistant" && stored.status === "failed";
  // A saved failure is a state, not an answer. Its stored sentence describes
  // the error card, so the turn reloads as retryable instead of reading as a
  // reply the model would then be asked to imitate.
  const message = savedFailure ? { ...stored, content: "" } : stored;
  const images = Array.isArray(message.attachments)
    ? message.attachments.map((attachment) => ({
        id: generateAttachmentId(),
        name: attachment.name || "image",
        mimeType: attachment.mimeType,
        bytes: attachment.bytes,
      }))
    : [];
  const storedArtifact = artifactMap?.get(message.messageId) || null;
  const savedInterrupted = message.role === "assistant" && message.status === "interrupted";
  const artifact = savedFailure
    ? null
    : storedArtifact ||
      (message.role === "assistant" && message.content ? artifactFromResponse(message.content) : null);
  const handoff =
    message.role === "user" && isContextHandoffContent(message.content)
      ? { goal: contextHandoffGoal(message.content) }
      : null;
  const storedProgress = storedActivity(message);
  return {
    id: generateId(),
    role: message.role,
    content: message.content,
    status: savedFailure
      ? TURN_STATUS.FAILED
      : message.role === "assistant" && message.status === "cancelled"
        ? TURN_STATUS.CANCELLED
        : savedInterrupted || (artifact && artifact.status !== "complete")
          ? TURN_STATUS.INTERRUPTED
          : TURN_STATUS.COMPLETED,
    error: savedFailure
      ? presentChatError({ message: stored.content, code: stored.errorCode })
      : null,
    saveWarning: null,
    truncated: null,
    ...(message.messageId ? { messageId: message.messageId } : {}),
    ...(message.feedback === "like" || message.feedback === "dislike"
      ? { feedback: message.feedback }
      : {}),
    ...(artifact ? { artifact } : {}),
    ...(storedProgress ? { activity: storedProgress } : {}),
    ...(handoff ? { handoff } : {}),
    ...(images.length > 0 ? { images } : {}),
  };
}

const NATIVE_INTERRUPTED_NOTE =
  "\n\n_Interrupted when the app closed. The part above was kept._";
const NATIVE_EMPTY_INTERRUPTED = "_Interrupted before any answer was written._";

/**
 * A turn the device stored itself. It is shown with the same shape as a cloud
 * turn, and its stored id is the turn id so re-opening the chat cannot paint
 * the same answer twice.
 */
function nativeMessageToTurn(message, chat) {
  const id = String(message.id || generateId());
  const role = message.role === "assistant" ? "assistant" : "user";
  const content = String(message.content || "");
  if (role === "user") {
    return {
      id,
      messageId: id,
      role,
      content,
      status: TURN_STATUS.COMPLETED,
      error: null,
      saveWarning: null,
      truncated: null
    };
  }
  const stored = String(message.status || "complete");
  const status =
    stored === "failed"
      ? TURN_STATUS.FAILED
      : stored === "stopped"
        ? TURN_STATUS.CANCELLED
        : stored === "interrupted"
          ? TURN_STATUS.INTERRUPTED
          : TURN_STATUS.COMPLETED;
  const plan = message.plan && typeof message.plan === "object" ? message.plan : null;
  return {
    ...createAssistantTurn({ id, status }),
    local: true,
    content,
    error:
      status === TURN_STATUS.FAILED
        ? presentChatError({
            message: chat.error || content || "The local model stopped."
          })
        : null,
    ...(plan ? { localPlan: plan } : {})
  };
}

// Local file tools need both a Windows shell and a server endpoint. When
// either is missing the turn is still answerable, so resend it as a plain chat
// and say why instead of failing the message.
const DESKTOP_TOOL_FALLBACK_REASONS = {
  tool_calling_unsupported: "This model's provider does not support local filesystem tools. The message was sent without them.",
  desktop_tools_unavailable: "The connected server has no local-file tool endpoint yet, so this message was sent as a normal chat."
};

// A server without the endpoint answers every tool turn with the same 404, so
// the first failure is remembered for the rest of the app session and later
// turns go straight to plain chat. The next launch re-probes, so a redeployed
// backend starts using tools again without the user clearing anything.
const DESKTOP_TOOLS_MISSING_KEY = "vr.desktopToolsMissing";

// The Apex row is drawn before its model set has loaded, and it reports that
// rather than pretending the user has no Combo models. A failed load says the
// same thing: the row stays visible with the real reason, never a fake count.
const COMBO_PENDING_STATE = { enabled: false, selectedCount: 0, workingCount: null, loading: true };
const COMBO_UNLOADED_STATE = {
  enabled: false,
  selectedCount: 0,
  workingCount: null,
  unavailable: true
};

// Only the final message may carry images — the backend rejects attachments
// on earlier messages, so trimmed history stays text-only. Each entry keeps the
// id its message is stored under, so resending a turn cannot duplicate it.
function requestHistory(messages) {
  const filtered = sanitizeHistoryMessages(messages);
  return filtered.map((message, index) => {
    const entry = { role: message.role, content: message.content };
    const messageId = storedMessageId(message);
    if (messageId) entry.messageId = messageId;
    if (index === filtered.length - 1 && Array.isArray(message.images) && message.images.length > 0) {
      entry.images = message.images;
    }
    if (index === filtered.length - 1 && Array.isArray(message.textFiles) && message.textFiles.length > 0) {
      entry.textFiles = message.textFiles;
    }
    return entry;
  });
}

function imageExtension(mimeType) {
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/webp") return "webp";
  if (mimeType === "image/gif") return "gif";
  return "jpg";
}

function sharedModelNotice(shared) {
  if (!shared) return "Checking the shared model \u2014 try again in a moment.";
  if (shared.status === "disabled") {
    return "The shared AI model has been disabled. Connect your own AI provider in API settings to keep chatting.";
  }
  if (shared.status === "unreachable") {
    return "The shared AI model server is unreachable right now. Try again shortly, or connect your own provider.";
  }
  if (shared.status === "missing_model") {
    return `The shared model (${shared.model}) is not available on the shared server right now. Try again later or connect your own provider.`;
  }
  if (shared.status === "not_configured") {
    return "No shared AI model is configured on this server. Connect your own AI provider to start chatting.";
  }
  return "The shared AI model is unavailable right now. Connect your own AI provider in API settings.";
}

function gatewayNotice(omniroute) {
  if (!omniroute) return "Checking the OmniRoute gateway \u2014 try again in a moment.";
  if (!omniroute.enabled) {
    return "The OmniRoute gateway is disabled on this server. Pick another model from the model menu.";
  }
  if (!omniroute.configured || ["not_configured", "invalid_config"].includes(omniroute.status)) {
    return "The OmniRoute gateway is not configured correctly on this server. Pick another model or ask the administrator.";
  }
  if (omniroute.status === "unauthorized") {
    return "The OmniRoute gateway rejected its server API key. Ask the administrator to verify OMNIROUTE_API_KEY.";
  }
  if (omniroute.status === "rate_limited") {
    return "The OmniRoute gateway is rate-limiting requests right now. Try again shortly or pick another model.";
  }
  if (omniroute.status === "timeout") {
    return "The OmniRoute gateway timed out. Try again shortly or pick another model.";
  }
  if (omniroute.status === "empty") {
    return "The OmniRoute gateway has no models configured. Add providers inside OmniRoute or pick another model.";
  }
  if (!omniroute.available) {
    return "The OmniRoute gateway is unreachable right now. Try again shortly or pick another model.";
  }
  return "";
}

function unavailableModelNotice(shared, omniroute) {
  if (omniroute?.enabled && omniroute.configured) {
    return `${gatewayNotice(omniroute)} Other providers keep working normally.`;
  }
  return sharedModelNotice(shared);
}

// â”€â”€â”€ Code Block with Copy â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function CodeBlock({ children }) {
  const [copied, setCopied] = useState(false);
  const preRef = useRef(null);

  const handleCopy = useCallback(async () => {
    const text = preRef.current?.textContent ?? "";
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  }, []);

  const codeChild = React.Children.toArray(children)[0];
  const className = React.isValidElement(codeChild) ? codeChild.props.className || "" : "";
  const lang = /language-([\w.+#-]+)/.exec(className)?.[1] ?? "";

  return (
    <div className="vr-code-block">
      <div className="vr-code-header">
        {lang && <span className="vr-code-lang">{lang}</span>}
        <button
          className="vr-code-copy"
          onClick={handleCopy}
          aria-label={copied ? "Copied" : "Copy code"}
        >
          {copied ? <Check size={13} weight="bold" /> : <Copy size={13} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre ref={preRef} tabIndex={0} aria-label={lang ? `${lang} code` : "Code"}>
        {children}
      </pre>
    </div>
  );
}

// â”€â”€â”€ Markdown Components â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// react-markdown v10 no longer passes an `inline` flag to `code`. Detect block
// code from its `pre` parent instead; everything else is inline.
const MARKDOWN_COMPONENTS = {
  pre({ children }) {
    return <CodeBlock>{children}</CodeBlock>;
  },
  code({ node, className, children, ...props }) {
    return (
      <code className={`vr-inline-code${className ? ` ${className}` : ""}`} {...props}>
        {children}
      </code>
    );
  },
  table({ node, children, ...props }) {
    return (
      <div className="vr-table-wrap" role="region" aria-label="Scrollable table" tabIndex={0}>
        <table {...props}>{children}</table>
      </div>
    );
  },
};

// â”€â”€â”€ Message Bubble â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// What the router decided for a local run, kept collapsed. The summary line
// still names the route, so the answer carries the compact result described
// by the feature without filling the transcript with internals.
function LocalRoutingDetails({ plan }) {
  if (!plan || !Array.isArray(plan.stages) || plan.stages.length === 0) return null;
  const count = plan.stages.length;
  return (
    <details className="vr-msg-routing">
      <summary className="vr-msg-routing__summary">
        <span>Routing details</span>
        <span className="vr-msg-routing__meta">
          {plan.label || plan.stages.map(stage => stageRoleLabel(stage.role)).join(" → ")}
          {` · ${count} model${count === 1 ? "" : "s"}`}
        </span>
      </summary>
      <div className="vr-msg-routing__body">
        {plan.taskPreview ? (
          <div className="vr-msg-routing__row">
            <span>Question</span>
            <span>{plan.taskPreview}</span>
          </div>
        ) : null}
        {plan.objective ? (
          <div className="vr-msg-routing__row">
            <span>Goal</span>
            <span>{plan.objective}</span>
          </div>
        ) : null}
        <div className="vr-msg-routing__row">
          <span>Selected</span>
          <span>{plan.stages.map(stage => stageRoleLabel(stage.role)).join(" → ")}</span>
        </div>
        <div className="vr-msg-routing__row">
          <span>Execution</span>
          <span>{count} model{count === 1 ? "" : "s"}</span>
        </div>
        <ul className="vr-msg-routing__stages">
          {plan.stages.map((stage, index) => (
            <li key={`${stage.role}-${stage.model}-${index}`}>
              <span className="vr-msg-routing__role">{stageRoleLabel(stage.role)}</span>
              <code>{stage.model}</code>
              {stage.final ? <span className="vr-msg-routing__final">final answer</span> : null}
              {stage.detail ? <span className="vr-msg-routing__detail">{stage.detail}</span> : null}
            </li>
          ))}
        </ul>
        {plan.reason ? <p className="vr-msg-routing__reason">{plan.reason}</p> : null}
        {(plan.notes || []).map(note => (
          <p className="vr-msg-routing__note" key={note}>{note}</p>
        ))}
      </div>
    </details>
  );
}

const MESSAGE_ACTION_STATUS = {
  copied: "Copied.",
  "copy-failed": "Clipboard is blocked. Select the text to copy it.",
  "feedback-like": "Thanks for the feedback.",
  "feedback-dislike": "Feedback recorded.",
  "feedback-cleared": "Feedback cleared.",
  "feedback-failed": "Feedback couldn't be saved. Try again.",
  "feedback-unavailable": "Feedback isn't available for this message.",
  shared: "Shared.",
  "share-copied": "Sharing isn't available here, so the response was copied.",
  "share-failed": "Couldn't share or copy the response."
};

const MESSAGE_ACTION_ERRORS = new Set([
  "copy-failed",
  "feedback-failed",
  "feedback-unavailable",
  "share-failed"
]);

function Message({
  message,
  isStreaming,
  prompt = "",
  conversationId = "",
  workspacePath = "",
  permissionLabel = "",
  taskPanel = null,
  projectSave = null,
  nativeWindows = false,
  onRetry,
  onContinue,
  onSwitchModel,
  onOpenSettings,
  onContinueNewChat,
  onProjectSave,
  onProjectSaveChooseFolder,
  contextHandoffState
}) {
  const isUser = message.role === "user";
  const status = message.status || (isStreaming ? TURN_STATUS.STREAMING : TURN_STATUS.COMPLETED);
  const inlineRequested = wantsInlineCode(prompt);
  const streamedArtifact = useMemo(
    () =>
      !isUser && isStreaming
        ? message.artifact || (inlineRequested ? null : streamingArtifact(message.content))
        : null,
    [isUser, isStreaming, message.artifact, message.content, inlineRequested]
  );
  const settledArtifact = useMemo(() => {
    if (isUser || isStreaming) return null;
    return artifactForTurn({
      artifact: message.artifact,
      content: inlineRequested && !message.artifact ? "" : message.content,
      status: status === TURN_STATUS.COMPLETED ? "complete" : "partial"
    });
  }, [isUser, isStreaming, message.artifact, message.content, inlineRequested, status]);
  const artifact = streamedArtifact || settledArtifact;
  const streamingCode =
    isStreaming &&
    !artifact &&
    !inlineRequested &&
    Boolean(codingIntent(prompt)) &&
    /```/.test(message.content || "");
  const displayContent = useMemo(
    () =>
      artifact || streamingCode
        ? responseSummary(message.content, artifact?.files || [])
        : message.content,
    [artifact, streamingCode, message.content]
  );
  const notice = resolveTurnNotice(message, isStreaming);
  const presentation = notice === TURN_NOTICE.ERROR ? message.error : null;
  const saveWarning = notice === TURN_NOTICE.SAVE_WARNING ? message.saveWarning : null;
  // Only the latest failed turn offers the recovery flow; an old context
  // warning must not compete with the active request.
  const contextFailure =
    notice === TURN_NOTICE.ERROR && presentation?.category === "context_limit";
  const apiKeyFailure =
    notice === TURN_NOTICE.ERROR &&
    (presentation?.category === "missing_api_key" ||
      presentation?.category === "invalid_api_key");
  const requestBlockedFailure =
    notice === TURN_NOTICE.ERROR && presentation?.category === "request_blocked";
  const contextLimit = Boolean(contextFailure && onContinueNewChat);
  const apiKeyNotice = Boolean(apiKeyFailure && onOpenSettings);
  const requestBlockedNotice = Boolean(requestBlockedFailure && onContinueNewChat);
  const handoffTarget = contextLimit || apiKeyNotice || requestBlockedNotice;
  const handoffBusy = Boolean(
    handoffTarget &&
    contextHandoffState?.sourceId === message.id &&
    contextHandoffState.status === "preparing"
  );
  const handoffError = handoffTarget &&
    contextHandoffState?.sourceId === message.id &&
    contextHandoffState.status === "error"
    ? contextHandoffState.error
    : "";
  const canContinue = Boolean(onContinue && !isStreaming && hasRecoverableOutput(message));
  const [recovery, setRecovery] = useState("");
  const recoveryTimer = useRef(null);

  const [expanded, setExpanded] = useState(false);
  const textId = useId();
  const collapsedMessage = useMemo(
    () => (isUser && !message.handoff ? collapseMessageText(message.content) : null),
    [isUser, message.handoff, message.content]
  );
  const activityFiles = useMemo(() => {
    if (isUser) return [];
    if (Array.isArray(message.artifact?.files)) return message.artifact.files;
    if (!isStreaming || inlineRequested) return [];
    return streamingArtifact(message.content)?.files || [];
  }, [isUser, message.artifact, message.content, isStreaming, inlineRequested]);
  const showActivity =
    !isUser &&
    (isStreaming || (Array.isArray(message.activity) && message.activity.length > 0));

  const [reaction, setReaction] = useState(
    message.feedback === "like" || message.feedback === "dislike" ? message.feedback : null
  );
  const [feedbackPending, setFeedbackPending] = useState(false);
  const [copied, setCopied] = useState(false);
  const [actionStatus, setActionStatus] = useState("");
  const actionTimer = useRef(null);
  const copyTimer = useRef(null);

  useEffect(() => {
    setReaction(
      message.feedback === "like" || message.feedback === "dislike" ? message.feedback : null
    );
  }, [message.feedback]);

  useEffect(
    () => () => {
      clearTimeout(recoveryTimer.current);
      clearTimeout(actionTimer.current);
      clearTimeout(copyTimer.current);
    },
    []
  );

  const markRecovery = useCallback((value) => {
    setRecovery(value);
    clearTimeout(recoveryTimer.current);
    recoveryTimer.current = setTimeout(() => setRecovery(""), 3000);
  }, []);

  const markAction = useCallback((value) => {
    setActionStatus(value);
    clearTimeout(actionTimer.current);
    actionTimer.current = setTimeout(() => setActionStatus(""), 3200);
  }, []);

  const feedbackTarget = {
    conversationId: message.conversationId || conversationId,
    messageId: message.messageId
  };
  const feedbackAvailable = canPersistFeedback(feedbackTarget);
  const showActions =
    !isUser &&
    !isStreaming &&
    status === TURN_STATUS.COMPLETED &&
    Boolean(message.content?.trim());

  const handleCopyAnswer = useCallback(async () => {
    try {
      await copyText(message.content);
      markRecovery("copied");
    } catch {
      markRecovery("copy-failed");
    }
  }, [message.content, markRecovery]);

  const handleDownloadAnswer = useCallback(() => {
    const fail = () => markRecovery("download-failed");
    try {
      const pending = downloadBlob(
        new Blob([message.content], { type: "text/plain;charset=utf-8" }),
        "vups-answer.txt"
      );
      // Native Android hands the bytes to the download service and resolves
      // once accepted; web saves synchronously right here.
      if (pending?.then) {
        pending.then(() => markRecovery("downloaded"), fail);
        return;
      }
      markRecovery("downloaded");
    } catch {
      fail();
    }
  }, [message.content, markRecovery]);

  const handleCopyResponse = useCallback(async () => {
    try {
      await copyText(message.content);
      setCopied(true);
      markAction("copied");
      clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      markAction("copy-failed");
    }
  }, [message.content, markAction]);

  const handleShareResponse = useCallback(async () => {
    if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
      try {
        await navigator.share(sharePayload(message.content));
        markAction("shared");
        return;
      } catch (error) {
        if (error?.name === "AbortError") return;
      }
    }
    try {
      await copyText(message.content);
      markAction("share-copied");
    } catch {
      markAction("share-failed");
    }
  }, [message.content, markAction]);

  const handleFeedback = useCallback(
    async (value) => {
      if (feedbackPending) return;
      const next = nextFeedback(reaction, value);
      const request = feedbackRequest({ ...feedbackTarget, value: next });
      if (!request) {
        markAction("feedback-unavailable");
        return;
      }
      const previous = reaction;
      setReaction(next);
      setFeedbackPending(true);
      try {
        await saveMessageFeedback(request);
        markAction(
          next === "like" ? "feedback-like" : next === "dislike" ? "feedback-dislike" : "feedback-cleared"
        );
      } catch {
        setReaction(previous);
        markAction("feedback-failed");
      } finally {
        setFeedbackPending(false);
      }
    },
    [
      feedbackPending,
      reaction,
      message.conversationId,
      message.messageId,
      conversationId,
      markAction
    ]
  );

  return (
    <div className={`vr-msg ${isUser ? "vr-msg--user" : `vr-msg--assistant vr-msg--${status}`}`}>
      <div className="vr-msg-body">
        {isUser ? (
          message.handoff ? (
            <ContextHandoffCard message={message} />
          ) : (
            <>
              {message.images?.length > 0 && (
                <div className="vr-msg-images">
                  {message.images.map((image, index) => {
                    const src = image.dataUrl || image.previewUrl;
                    const label = image.name || "image";
                    return src ? (
                      <span key={image.id ?? index} className="vr-msg-image">
                        <img src={src} alt={label} loading="lazy" />
                      </span>
                    ) : (
                      <span key={image.id ?? index} className="vr-msg-image vr-msg-image--file" title={label}>
                        <ImageIcon size={14} aria-hidden="true" />
                        <span>{label}</span>
                        <em>{formatBytes(image.bytes || image.size)}</em>
                      </span>
                    );
                  })}
                </div>
              )}
              {message.textFiles?.length > 0 && (
                <div className="vr-msg-files">
                  {message.textFiles.map((file, index) => (
                    <span
                      key={file.id ?? index}
                      className="vr-msg-file"
                      title={file.path || file.name}
                    >
                      <FileText size={14} aria-hidden="true" />
                      <span>{file.path || file.name}</span>
                      <em>{formatBytes(file.size)}</em>
                    </span>
                  ))}
                </div>
              )}
              {message.content ? (
                <p
                  id={textId}
                  className={`vr-msg-text${collapsedMessage?.truncated && !expanded ? " vr-msg-text--collapsed" : ""}`}
                >
                  {collapsedMessage?.truncated && !expanded
                    ? collapsedMessage.display
                    : message.content}
                </p>
              ) : null}
              {collapsedMessage?.truncated ? (
                <button
                  type="button"
                  className="vr-msg-expand"
                  aria-expanded={expanded}
                  aria-controls={textId}
                  onClick={() => setExpanded((value) => !value)}
                >
                  {expanded ? (
                    <>
                      <CaretUp size={11} weight="bold" aria-hidden="true" />
                      Show less
                    </>
                  ) : (
                    <>
                      <CaretDown size={11} weight="bold" aria-hidden="true" />
                      Show more
                    </>
                  )}
                </button>
              ) : null}
            </>
          )
        ) : (
          <>
            {showActivity ? (
              <AgentActivity
                className="vr-activity--message"
                events={message.activity || []}
                files={activityFiles}
                active={isStreaming}
                status={status}
                startedAt={message.startedAt}
                completedAt={message.completedAt}
                requestText={prompt}
                workspacePath={workspacePath}
                permissionLabel={permissionLabel}
              />
            ) : null}
            {displayContent ? (
              <div className={`vr-msg-md ${isStreaming ? "vr-streaming" : ""}`}>
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  rehypePlugins={[rehypeHighlight]}
                  components={MARKDOWN_COMPONENTS}
                >
                  {displayContent}
                </ReactMarkdown>
                {isStreaming && <span className="vr-cursor" aria-hidden="true" />}
              </div>
            ) : null}
            {artifact && !isStreaming ? (
              nativeWindows && (message.local || message.localPlan) ? (
                <>
                  {wantsDownloadDelivery(prompt) ? <GeneratedFiles artifact={artifact} /> : null}
                  <ProjectSaveCard
                    artifact={artifact}
                    record={projectSave}
                    onSave={onProjectSave}
                    onChooseFolder={onProjectSaveChooseFolder}
                  />
                </>
              ) : (
                <GeneratedFiles artifact={artifact} />
              )
            ) : null}
            {notice === TURN_NOTICE.LENGTH ? (
              <div className="vr-truncated" role="status">
                <Warning size={14} weight="fill" aria-hidden="true" />
                <span>Response reached its length limit.</span>
                {canContinue ? (
                  <button type="button" className="vr-continue-btn" onClick={onContinue}>
                    <ArrowClockwise size={13} />
                    Continue generating
                  </button>
                ) : null}
              </div>
            ) : null}
            {notice === TURN_NOTICE.INTERRUPTED ? (
              <div className="vr-truncated" role="status">
                <Warning size={14} weight="fill" aria-hidden="true" />
                <span>The response stopped early. Continue or retry.</span>
                {canContinue ? (
                  <button type="button" className="vr-continue-btn" onClick={onContinue}>
                    <ArrowClockwise size={13} />
                    Continue generating
                  </button>
                ) : null}
              </div>
            ) : null}
            {notice === TURN_NOTICE.CANCELLED ? (
              <div className="vr-truncated vr-truncated--muted" role="status">
                <span>Generation stopped.</span>
                {canContinue ? (
                  <button type="button" className="vr-continue-btn" onClick={onContinue}>
                    <ArrowClockwise size={13} />
                    Continue generating
                  </button>
                ) : null}
              </div>
            ) : null}
            {notice === TURN_NOTICE.SAVE_WARNING && saveWarning ? (
              <div className="vr-msg-save" role="status">
                <Warning size={14} weight="fill" aria-hidden="true" />
                <div>
                  <strong>{saveWarning.title}</strong>
                  <span>{saveWarning.message}</span>
                </div>
              </div>
            ) : null}
            {notice === TURN_NOTICE.SAVE_WARNING && saveWarning && !artifact && message.content ? (
              <div className="vr-msg-recovery">
                <button type="button" className="vr-retry-btn" onClick={handleCopyAnswer}>
                  <Copy size={13} aria-hidden="true" />
                  Copy answer
                </button>
                <button type="button" className="vr-retry-btn" onClick={handleDownloadAnswer}>
                  <DownloadSimple size={13} aria-hidden="true" />
                  Download .txt
                </button>
                {recovery ? (
                  <span
                    className={`vr-msg-recovery-status${recovery.endsWith("failed") ? " vr-msg-recovery-status--error" : ""}`}
                    role="status"
                  >
                    {recovery === "copied" ? "Copied." : null}
                    {recovery === "downloaded" ? "Download started." : null}
                    {recovery === "copy-failed" ? "Clipboard is blocked. Use Download .txt instead." : null}
                    {recovery === "download-failed" ? "Download failed. Try Copy answer instead." : null}
                  </span>
                ) : null}
              </div>
            ) : null}
            {notice === TURN_NOTICE.ERROR &&
            presentation &&
            !contextFailure &&
            !apiKeyFailure &&
            !requestBlockedFailure ? (
              <div className="vr-msg-error" role="alert">
                <Warning size={16} weight="fill" aria-hidden="true" />
                <div className="vr-msg-error-body">
                  <strong>{presentation.title}</strong>
                  <span>{presentation.message}</span>
                  {presentation.model ? (
                    <span className="vr-msg-error-model">Model: <code>{presentation.model}</code></span>
                  ) : null}
                  <div className="vr-msg-error-actions">
                    {canContinue ? (
                      <button className="vr-retry-btn" onClick={onContinue}>
                        <ArrowClockwise size={14} />
                        Continue generating
                      </button>
                    ) : null}
                    {onRetry && presentation.retry !== false ? (
                      <button className="vr-retry-btn" onClick={onRetry}>
                        <ArrowClockwise size={14} />
                        Try again
                      </button>
                    ) : null}
                    {onSwitchModel && presentation.canSwitchModel !== false ? (
                      <button className="vr-retry-btn" onClick={onSwitchModel}>
                        Try another model
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>
            ) : null}
            {contextLimit ? (
              <ContextLimitNotice
                busy={handoffBusy}
                error={handoffError}
                onContinue={() => onContinueNewChat(message.id)}
              />
            ) : null}
            {requestBlockedNotice ? (
              <RequestBlockedNotice
                busy={handoffBusy}
                error={handoffError}
                onContinue={() => onContinueNewChat(message.id)}
              />
            ) : null}
            {apiKeyNotice ? (
              <ApiKeyNotice
                model={presentation.model}
                busy={handoffBusy}
                error={handoffError}
                onOpenSettings={onOpenSettings}
                onChooseModel={onSwitchModel}
                onContinueNewChat={
                  onContinueNewChat ? () => onContinueNewChat(message.id) : undefined
                }
              />
            ) : null}
            {taskPanel}
            {message.localPlan ? <LocalRoutingDetails plan={message.localPlan} /> : null}
            {showActions ? (
              <div className="vr-msg-actions" role="group" aria-label="Message actions">
                <button
                  type="button"
                  className="vr-msg-action"
                  onClick={handleCopyResponse}
                  aria-label={copied ? "Copied" : "Copy response"}
                  title={copied ? "Copied" : "Copy response"}
                >
                  {copied ? (
                    <Check size={15} weight="bold" aria-hidden="true" />
                  ) : (
                    <Copy size={15} aria-hidden="true" />
                  )}
                </button>
                <button
                  type="button"
                  className="vr-msg-action"
                  aria-pressed={reaction === "like"}
                  aria-label="Like response"
                  title="Like response"
                  disabled={!feedbackAvailable || feedbackPending}
                  onClick={() => handleFeedback("like")}
                >
                  <ThumbsUp
                    size={15}
                    weight={reaction === "like" ? "fill" : "regular"}
                    aria-hidden="true"
                  />
                </button>
                <button
                  type="button"
                  className="vr-msg-action"
                  aria-pressed={reaction === "dislike"}
                  aria-label="Dislike response"
                  title="Dislike response"
                  disabled={!feedbackAvailable || feedbackPending}
                  onClick={() => handleFeedback("dislike")}
                >
                  <ThumbsDown
                    size={15}
                    weight={reaction === "dislike" ? "fill" : "regular"}
                    aria-hidden="true"
                  />
                </button>
                <button
                  type="button"
                  className="vr-msg-action"
                  onClick={handleShareResponse}
                  aria-label="Share response"
                  title="Share response"
                >
                  <ShareNetwork size={15} aria-hidden="true" />
                </button>
                {actionStatus && MESSAGE_ACTION_STATUS[actionStatus] ? (
                  <span
                    className={`vr-msg-action-status${
                      MESSAGE_ACTION_ERRORS.has(actionStatus)
                        ? " vr-msg-action-status--error"
                        : ""
                    }`}
                    role="status"
                  >
                    {MESSAGE_ACTION_STATUS[actionStatus]}
                  </span>
                ) : null}
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

// â”€â”€â”€ Welcome Screen â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const STARTER_PROMPTS = [
  {
    title: "Explain a codebase",
    hint: "Module map and risk notes",
    prompt:
      "Explain how this project is put together: the main modules, how they connect, and where the riskiest code lives."
  },
  {
    title: "Draft a bug report",
    hint: "Ask questions, then write it",
    prompt:
      "Help me write a bug report. Ask me for the symptom, the steps to reproduce, and the expected behavior, then draft it."
  },
  {
    title: "Plan a release",
    hint: "Checks, risks, rollback",
    prompt: "Plan a release for this project: the checks to run, the risks to watch, and the rollback steps."
  }
];

function WelcomeScreen({ configured, modelName, sharedActive, gatewayActive, vupsActive, sharedLoading, onStarter }) {
  return (
    <div className="vr-welcome">
      <div className="vr-welcome-inner">
        <p className="vr-welcome-eyebrow">
          VupsRouter <em>AI</em>
        </p>
        <h1 className="vr-welcome-title">
          Ask once. We pick the <span>block.</span>
        </h1>
        <p className="vr-welcome-desc">
          {configured
            ? vupsActive
              ? `Chatting with ${modelName || "Vups v3 Galax"}.`
              : sharedActive
                ? `Chatting with ${modelName || "the shared model"}.`
                : gatewayActive
                  ? `Chatting with ${modelName || "this model"} through the OmniRoute gateway.`
                  : `Chatting with ${modelName || "your configured model"} through your own provider.`
            : sharedLoading
              ? "Checking for an available AI model..."
              : "Vups v3 Galax is not configured on this server yet. Add your own AI provider in API settings."}
        </p>
        {configured ? (
          <p className="vr-welcome-note">
            The blocks are the models on this server. Pick one here or in the composer - the request
            goes to that model and its provider, nothing else.
          </p>
        ) : null}
        {configured && onStarter ? (
          <section className="vr-welcome-start" aria-label="Starting points">
            <p className="vr-welcome-start-label">
              Start with a prompt. It fills the message box, and nothing is sent until you press Enter.
              <span className="vr-welcome-start-keys">
                <kbd className="vr-welcome-kbd">Enter</kbd> send
                <kbd className="vr-welcome-kbd">Shift</kbd>
                <kbd className="vr-welcome-kbd">Enter</kbd> newline
              </span>
            </p>
            <div className="vr-welcome-starters">
              {STARTER_PROMPTS.map((item, index) => (
                <button
                  key={item.title}
                  type="button"
                  className="vr-welcome-starter"
                  onClick={() => onStarter(item.prompt)}
                >
                  <span className="vr-welcome-starter-num">{String(index + 1).padStart(2, "0")}</span>
                  <span className="vr-welcome-starter-body">
                    <span className="vr-welcome-starter-title">{item.title}</span>
                    <span className="vr-welcome-starter-hint">{item.hint}</span>
                  </span>
                </button>
              ))}
            </div>
          </section>
        ) : null}
        {!configured && !sharedLoading ? (
          <Link className="vr-welcome-cta" to="/settings">
            Open API settings
          </Link>
        ) : null}
      </div>
    </div>
  );
}

// â”€â”€â”€ Sidebar â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// â”€â”€â”€ Message List â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function MessageList({
  messages,
  streamingId,
  loading,
  conversationId = "",
  workspacePath = "",
  permissionLabel = "",
  liveTaskTurnIds = null,
  taskPanelFor = null,
  projectSaves = null,
  nativeWindows = false,
  onRetry,
  onContinue,
  onSwitchModel,
  onOpenSettings,
  onContinueNewChat,
  onProjectSave,
  onProjectSaveChooseFolder,
  contextHandoffState
}) {
  const bottomRef = useRef(null);
  const listRef = useRef(null);
  const isNearBottom = useRef(true);
  const lastAssistantIndex = messages.map(message => message.role).lastIndexOf("assistant");

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const onScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = el;
      isNearBottom.current = scrollHeight - scrollTop - clientHeight < 120;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    const viewport = typeof window !== "undefined" ? window.visualViewport : null;
    if (!viewport) return undefined;
    let frame = 0;
    const onViewportResize = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (isNearBottom.current) {
          bottomRef.current?.scrollIntoView({ block: "end" });
        }
      });
    };
    viewport.addEventListener("resize", onViewportResize);
    return () => {
      cancelAnimationFrame(frame);
      viewport.removeEventListener("resize", onViewportResize);
    };
  }, []);

  useEffect(() => {
    if (isNearBottom.current) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [messages, loading]);

  return (
    <div
      className="vr-message-list"
      ref={listRef}
      role="log"
      aria-live={loading ? "off" : "polite"}
      aria-label="Conversation"
    >
      {messages.map((msg, i) => {
        const prompt =
          msg.role === "assistant" && i > 0 && messages[i - 1].role === "user"
            ? messages[i - 1].content || ""
            : "";
        const isLatestTurn = i === messages.length - 1;
        return (
          <Message
            key={msg.id}
            message={msg}
            prompt={prompt}
            conversationId={conversationId}
            workspacePath={workspacePath}
            permissionLabel={permissionLabel}
            isStreaming={msg.id === streamingId || Boolean(liveTaskTurnIds?.has(msg.id))}
            taskPanel={taskPanelFor ? taskPanelFor(msg.id) : null}
            projectSave={projectSaves?.get?.(msg.messageId || msg.id) || null}
            nativeWindows={nativeWindows}
            onProjectSave={() => onProjectSave?.(msg, prompt)}
            onProjectSaveChooseFolder={() => onProjectSaveChooseFolder?.(msg, prompt)}
            onRetry={msg.status === TURN_STATUS.FAILED && isLatestTurn ? onRetry : undefined}
            onSwitchModel={msg.status === TURN_STATUS.FAILED && isLatestTurn ? onSwitchModel : undefined}
            onOpenSettings={
              msg.status === TURN_STATUS.FAILED && isLatestTurn ? onOpenSettings : undefined
            }
            onContinueNewChat={isLatestTurn ? onContinueNewChat : undefined}
            contextHandoffState={contextHandoffState}
            onContinue={
              msg.role === "assistant" &&
              !loading &&
              i === lastAssistantIndex &&
              (msg.status === TURN_STATUS.INTERRUPTED ||
                msg.status === TURN_STATUS.CANCELLED ||
                msg.status === TURN_STATUS.FAILED ||
                msg.truncated === "length")
                ? () => onContinue?.(msg.id)
                : undefined
            }
          />
        );
      })}
      <div ref={bottomRef} aria-hidden="true" />
    </div>
  );
}

// â”€â”€â”€ ChatPage (Root) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export default function ChatPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const {
    setConversations,
    refreshConversations,
    upsertConversation,
    saveLocalChat,
    getLocalChat,
    removeTask,
    draftRequest,
    refreshUsage
  } = useTasks();
  const { preferences } = usePreferences();
  const { online } = useConnectivity();
  const {
    activeWorkspace,
    owner: workspaceOwner,
    supported: nativeWorkspaces,
    loading: workspacesLoading,
    workspaceForChat,
    chatBindingFor,
    bindChatWorkspace,
    ensureDefault: ensureDefaultWorkspaceForOwner,
    validateWorkspace,
    addWorkspace,
    openFolderPath,
    touchWorkspace
  } = useWorkspaces();
  const activeConvId = searchParams.get("task") || "";
  // A local task has not reached the server yet, so it still counts as a draft
  // for choosing an initial folder; a saved chat keeps only its own binding.
  const draftChat = !activeConvId || String(activeConvId).startsWith("local-");
  const [chatScope, setChatScope] = useState("");
  // A chat's own folder wins; a chat that never chose one follows the project
  // the user selected on this device. A binding whose folder vanished from this
  // owner's registry does not fall through to a different project: it is shown
  // as unavailable so the page can ask for a replacement.
  const boundChatWorkspace = chatScope ? workspaceForChat(chatScope) : null;
  const boundChatId = chatScope ? chatBindingFor(chatScope) : "";
  const missingBoundWorkspace = Boolean(boundChatId && !boundChatWorkspace);
  const chatWorkspace = boundChatWorkspace || (missingBoundWorkspace ? null : activeWorkspace);

  const [messages, setMessages] = useState([]);
  // The last native save for each Local AI answer, keyed by its message id.
  // Kept apart from the message so a reload can restore the receipt and a retry
  // never has to ask a model for the same files again.
  const [projectSaves, setProjectSaves] = useState(() => new Map());
  const [loading, setLoading] = useState(false);
  const [streamingId, setStreamingId] = useState(null);
  const [config, setConfig] = useState(null);
  const [providerModels, setProviderModels] = useState([]);
  const [shared, setShared] = useState(null);
  const [omniroute, setOmniroute] = useState(null);
  const [selection, setSelection] = useState(null);
  const [comboState, setComboState] = useState(COMBO_PENDING_STATE);
  const [catalogReady, setCatalogReady] = useState(false);
  // Models that run on this device. They are read from the device's own
  // runtime, so a model installed from a terminal is here without the app
  // being restarted.
  const [localModels, setLocalModels] = useState([]);
  // Whether the device runtime has answered at least once. Restoring a local
  // selection before that answer would fail to resolve and overwrite it.
  const [localModelsSettled, setLocalModelsSettled] = useState(false);
  const localComboConfig = useLocalComboConfig();
  const localCombo = useMemo(
    () => comboPlan(localComboConfig, localModels),
    [localComboConfig, localModels]
  );
  // The installed models the user selected for the combo, with the runtime's
  // capability flags. The router binds roles to these, in selection order.
  const localComboModels = useMemo(() => {
    const byName = new Map(localModels.map(model => [String(model.name || "").toLowerCase(), model]));
    return localCombo.usable.map(
      name => byName.get(String(name).toLowerCase()) || { name, capabilities: ["chat"] }
    );
  }, [localCombo.usable, localModels]);
  const [modelType, setModelType] = useState(CUSTOM_MODEL_TYPE);
  const [freeCatalog, setFreeCatalog] = useState(null);
  const [freeCatalogSettled, setFreeCatalogSettled] = useState(false);
  const [openModelSignal, setOpenModelSignal] = useState(0);
  const [notice, setNotice] = useState("");
  const [deleteModelTarget, setDeleteModelTarget] = useState(null);
  const [composerWarning, setComposerWarning] = useState("");
  const [serverLacksToolEndpoint, setServerLacksToolEndpoint] = useState(
    () => sessionBrowserStorage()?.getItem(DESKTOP_TOOLS_MISSING_KEY) === "1"
  );
  const [imageGenerating, setImageGenerating] = useState(false);
  const [generatedImage, setGeneratedImage] = useState(null);
  const [imageError, setImageError] = useState("");
  const [currentEffort, setCurrentEffort] = useState("Balanced");
  // The durable tasks this screen is watching, keyed by their own ids. A watch is
  // not a request: no controller, no stream, nothing to abort — it only names the
  // turn in this transcript that a task's events belong to. Two open tasks in one
  // chat are two entries, so neither can consume the other's progress.
  const [taskRuns, setTaskRuns] = useState(() => ({}));
  // Which control on a durable turn is waiting on the server, and what the
  // server said when it refused one. Both name the task they belong to, so two
  // runs in one chat cannot borrow each other's busy state or error.
  const [taskActionPending, setTaskActionPending] = useState("");
  const [taskActionError, setTaskActionError] = useState(null);
  const [nativeShell] = useState(() => detectNativeShell());
  // Nothing device-wide is adopted at mount: the account that owns the chat has
  // to be known first, so the mode always starts at Ask and the owner-keyed
  // effect below replaces it with what that account actually chose.
  const [permissionMode, setPermissionMode] = useState(DEFAULT_PERMISSION_MODE);
  // The brief names the access a turn really has, so it is only stated when this
  // shell can run local file tools at all; on web there is no such mode.
  const localAccessLabel =
    nativeShell === NATIVE_SHELLS.windows && !serverLacksToolEndpoint
      ? permissionModeInfo(permissionMode).label
      : "";
  const [approvalRequests, setApprovalRequests] = useState([]);
  const [approvalBusyId, setApprovalBusyId] = useState("");
  const [approvalError, setApprovalError] = useState("");
  const seenApprovalKeys = useRef(new Set());
  // The native requests this page still has an unanswered card for, keyed by the
  // id the native layer issued. A withdrawn request is reported from the ids the
  // native cancel really returned, so this map is what turns an id back into the
  // operation, tool and target that line belongs to.
  const pendingApprovals = useRef(new Map());
  const streamingIdRef = useRef(null);
  const activityRunIdRef = useRef("run");
  const [nativeToolBridgeError, setNativeToolBridgeError] = useState("");
  const [fullAccessPending, setFullAccessPending] = useState(false);
  const [permissionApplying, setPermissionApplying] = useState(false);
  // What this account's stored mode refused to adopt, e.g. Full access never
  // survives an app restart, so the page says so instead of resetting silently.
  const [permissionNotice, setPermissionNotice] = useState("");
  const policySyncRef = useRef("");
  const [workspacePickerOpen, setWorkspacePickerOpen] = useState(false);
  // Why the last project task could not get a folder, shown above the composer
  // instead of stopping the message that was already sent.
  const [workspaceProvisionError, setWorkspaceProvisionError] = useState("");
  // A folder made during a send is only in the native registry and in React
  // state after this render, so the same send carries it by hand. It belongs to
  // one account and one send, never to the next account that signs in.
  const provisionedWorkspaceRef = useRef(null);
  useEffect(() => {
    provisionedWorkspaceRef.current = null;
  }, [workspaceOwner]);
  const [toolAccessOpen, setToolAccessOpen] = useState(false);
  const [workspaceAttachment, setWorkspaceAttachment] = useState(null);
  const [draftInsertion, setDraftInsertion] = useState(null);
  const [repoBrowserOpen, setRepoBrowserOpen] = useState(false);
  const [repoBrowserTarget, setRepoBrowserTarget] = useState(null);
  const [repoScope, setRepoScope] = useState(null);
  const abortRef = useRef(null);
  // A turn on the server's chat route belongs to the account, not to this
  // screen: it keeps generating after the socket closes and saves its own
  // answer. Native-tool and Combo turns are still bound to their request.
  const serverOwnedTurnRef = useRef(false);
  // A local run is owned here, not by the server: leaving the screen must not
  // abort it, and Stop must not ask the cloud to cancel a turn it never saw.
  const localRunRef = useRef(false);
  // Stop can land while the message is still being saved, before the run has a
  // conversation to register itself under. This is the one place that news
  // waits, and the run branch reads it before asking a model anything.
  const localStopRequestedRef = useRef(false);
  // Stop during the save-first POST must wait for the server-issued task id.
  const durableSubmitRef = useRef(null);
  const taskActionRef = useRef("");
  // A submission whose outcome the client never learned. The next send of the
  // same message reuses its key so the tracker can adopt the record the backend
  // may already have made, instead of asking for a second one.
  const uncertainSubmissionRef = useRef(null);
  const imageAbortRef = useRef(null);
  const submissionFailedRef = useRef(false);
  const sendingRef = useRef(false);
  const initializedRef = useRef(false);
  const outboxFlushedFor = useRef("");
  const requestSeqRef = useRef(0);
  const loadedTaskRef = useRef("");
  const loadingConversationRef = useRef("");
  // A brand-new chat has no id yet; this scope id is remapped to the server's
  // conversation id as soon as the first answer reports it.
  const draftChatScopeRef = useRef("");
  // A chosen repository for a not-yet-saved chat waits here, then is remapped
  // the same way the first answer names the conversation.
  const draftRepoScopeRef = useRef(null);
  const continuationGuardRef = useRef(null);
  if (!continuationGuardRef.current) continuationGuardRef.current = createContinuationGuard();
  const [handoffState, setHandoffState] = useState({
    status: "idle",
    sourceId: null,
    error: ""
  });

  useEffect(() => {
    const viewport = typeof window !== "undefined" ? window.visualViewport : null;
    if (!viewport) return undefined;
    const root = document.documentElement;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        root.style.setProperty("--vr-viewport-height", `${Math.round(viewport.height)}px`);
      });
    };
    update();
    viewport.addEventListener("resize", update);
    return () => {
      cancelAnimationFrame(frame);
      viewport.removeEventListener("resize", update);
      root.style.removeProperty("--vr-viewport-height");
    };
  }, []);

  useEffect(() => {
    if (!workspaceOwner) {
      setChatScope("");
      return;
    }
    if (!activeConvId) {
      if (!draftChatScopeRef.current) draftChatScopeRef.current = newChatScopeId();
      setChatScope(draftChatScopeRef.current);
      return;
    }
    setChatScope(chatScopeForConversation(workspaceOwner, activeConvId));
  }, [activeConvId, workspaceOwner]);

  useEffect(() => {
    if (!workspaceOwner) {
      setRepoScope(null);
      return;
    }
    if (!activeConvId) {
      setRepoScope(draftRepoScopeRef.current);
      return;
    }
    // A saved chat owns its repository; viewing one never carries a draft choice
    // over, and leaving it clears the draft ref so the next new chat starts bare.
    draftRepoScopeRef.current = null;
    setRepoScope(repoScopeForConversation(workspaceOwner, activeConvId));
  }, [activeConvId, workspaceOwner]);

  useEffect(() => {
    if (!draftRequest) return;
    setDraftInsertion({ text: draftRequest.text, key: draftRequest.key });
  }, [draftRequest]);

  const {
    owner: trackerOwner,
    tasks: trackedTasks,
    submit: submitTaskRun,
    cancel: cancelTaskRun,
    resume: resumeTaskRun,
    answer: answerTaskRun,
    refresh: refreshTaskRun
  } = useTaskTracker();

  // The tracker holds one account's tasks. When that identity changes — signing
  // out, or signing in as somebody else — this screen has nothing of its own left
  // to watch, so it drops the pointers. It does not and cannot stop the tasks
  // themselves: those records belong to the backend, and they keep running.
  useEffect(() => {
    setTaskRuns({});
  }, [trackerOwner]);

  // Which tasks this chat watches comes from the tracker's own rows, not from the
  // moment the transcript finished loading: hydration can land after the load, and
  // a task that ran while this screen was closed still owes the reader the progress
  // the backend wrote for it. A turn that this transcript has lost is re-added, so
  // a reload shows the running task instead of dropping its line.
  useEffect(() => {
    if (!activeConvId || String(activeConvId).startsWith("local-")) return;
    if (loadedTaskRef.current !== activeConvId || loadingConversationRef.current === activeConvId) return;
    const records = taskRunsForConversation(trackedTasks, activeConvId);
    if (records.length === 0) return;
    const created = [];
    const runs = records.map(view => {
      const existing = taskRuns[view.taskId];
      if (existing) return existing;
      const fresh = taskRunFor(view.taskId, view.conversationId || activeConvId);
      created.push(fresh);
      return fresh;
    });
    if (created.length > 0) {
      setTaskRuns(previous => {
        const merged = { ...previous };
        for (const run of created) {
          if (!merged[run.taskId]) merged[run.taskId] = run;
        }
        return merged;
      });
      // Only restore (re-add lost turns) when a brand-new run pointer was
      // created. Re-running restoreTaskTurn on every messages change while
      // terminal tasks remain watched is what replayed a second "Thought for"
      // cycle beside the answer.
      setMessages(previous => runs.reduce((history, run, index) =>
        restoreTaskTurn(history, run, records[index].task), previous));
    }
  }, [activeConvId, messages, taskRuns, trackedTasks]);

  // Live progress for every task watched here. Each run reads its own record and
  // writes into its own turn under its own run id, through the same forward-only
  // row merge a streamed chat turn uses — so one operation stays one line as it
  // moves from running to completed, and no task can consume or settle another's.
  useEffect(() => {
    const ids = Object.keys(taskRuns);
    if (ids.length === 0) return;
    for (const taskId of ids) {
      const view = trackedTasks.find(candidate => candidate.taskId === taskId);
      if (!view) continue;
      const run = taskRuns[taskId];
      const events = taskProgressEvents(view.task);
      if (events.length > 0) {
        setMessages(previous =>
          recordTurnProgress(previous, run.assistantId, events, { runId: run.runId })
        );
      }
      // The worker writes the answer into the conversation when it settles, but
      // it also reports the text it has so far on every event read. Painting that
      // here is what makes a background run look like an ordinary reply arriving.
      const partial = view.task?.output?.text;
      if (typeof partial === "string" && partial) {
        setMessages(previous => syncTurnContent(previous, run.assistantId, partial));
      }
      if (!run.conversationId && view.conversationId) {
        adoptTaskRunConversation(run, view.conversationId);
      }
      if (isTerminalTaskState(view.state) && run.settledState !== view.state) settleTaskRun(run, view.task);
    }
  }, [taskRuns, trackedTasks]);

  // Ask and Agent (workspace) are account settings, so the stored mode is read
  // under the owning account only: an empty owner is the signed-out guest key and
  // never inherits what a signed-in account chose. Full access is an
  // authorization, not a setting, so a saved or inherited `full` is refused and
  // `dropped` is what lets the access menu say the restart happened.
  useEffect(() => {
    if (nativeShell !== NATIVE_SHELLS.windows) return;
    const { mode, dropped } = readPermissionMode(localBrowserStorage(), workspaceOwner);
    setPermissionMode(mode);
    setPermissionNotice(
      dropped
        ? `${permissionModeInfo(dropped).label} was not restored: it is authorized for one app ` +
          `session only. Local access restarted at ${permissionModeInfo(mode).label.toLowerCase()}.`
        : ""
    );
  }, [nativeShell, workspaceOwner]);

  useEffect(() => {
    if (nativeShell !== NATIVE_SHELLS.windows || !workspaceOwner) return;
    let cancelled = false;
    const signature = `${workspaceOwner}|${permissionMode}|${chatWorkspace?.id || ""}`;
    const changed = Boolean(policySyncRef.current) && policySyncRef.current !== signature;
    policySyncRef.current = signature;
    if (changed) {
      // The native layer denies cards raised under the previous mode or
      // workspace, so the page must not keep offering those decisions.
      cancelDesktopToolApprovals().catch(() => {});
      clearApprovals();
    }
    setDesktopToolPolicy({
      owner: workspaceOwner,
      mode: permissionMode,
      workspaceId: chatWorkspace?.id || null
    }).then(status => {
      if (cancelled) return;
      // The reply is the policy this app really installed. Comparing it with
      // what the chat asked for is what tells the page whether local tools may
      // run at all, instead of trusting the label in the selector.
      setNativeToolBridgeError(
        effectivePolicyProblem(status, {
          owner: workspaceOwner,
          mode: permissionMode,
          workspaceId: chatWorkspace?.id || ""
        })
      );
    }).catch(error => {
      // The mode lives in localStorage, so the selector would otherwise keep
      // showing "Full access" while the native bridge silently refuses it.
      if (!cancelled) setNativeToolBridgeError(error?.message || "The Windows desktop tool bridge is unavailable.");
    });
    return () => {
      cancelled = true;
    };
  }, [nativeShell, workspaceOwner, permissionMode, chatWorkspace?.id]);

  // A save receipt belongs to its message and account, so reopening a Local
  // Chat restores the same folder and file list instead of looking unsaved.
  useEffect(() => {
    setProjectSaves(workspaceOwner ? readProjectSaveMap(workspaceOwner) : new Map());
  }, [workspaceOwner]);

  function beginRequest() {
    const controller = new AbortController();
    requestSeqRef.current += 1;
    abortRef.current = controller;
    return { controller, seq: requestSeqRef.current };
  }

  function isCurrentRequest(seq) {
    return requestSeqRef.current === seq;
  }

  function invalidateInFlight() {
    requestSeqRef.current += 1;
    const controller = abortRef.current;
    abortRef.current = null;
    const operationId = streamingIdRef.current;
    // Leaving a chat detaches this screen; it does not stop the work. A turn the
    // server owns keeps generating and still saves the answer it owes the
    // conversation, so only a request-bound turn is aborted here.
    if (!serverOwnedTurnRef.current) {
      controller?.abort();
      if (operationId && nativeShell === NATIVE_SHELLS.windows) {
        // The cancel answers with the request ids it closed for this operation.
        // Those are the waits that really ended here, so those are the ones the
        // task log says were withdrawn - not every card that happened to be up.
        cancelDesktopToolOperation(operationId)
          .then(noteWithdrawnApprovals)
          .catch(() => {});
      }
    }
    serverOwnedTurnRef.current = false;
    streamingIdRef.current = null;
    sendingRef.current = false;
    setLoading(false);
    setStreamingId(null);
  }

  function syncTaskParam(id, { replace = true } = {}) {
    loadedTaskRef.current = id || "";
    setSearchParams(current => {
      const next = new URLSearchParams(current);
      if (id) next.set("task", id);
      else next.delete("task");
      return next;
    }, { replace });
  }

  // The native layer keys chat-scoped approvals by this id. A saved chat keeps
  // the same id across reloads; a new chat gets one that becomes its saved
  // chat's id when the server reports the conversation.
  function currentChatScope() {
    if (activeConvId) return chatScopeForConversation(workspaceOwner, activeConvId);
    if (!draftChatScopeRef.current) {
      draftChatScopeRef.current = newChatScopeId();
      setChatScope(draftChatScopeRef.current);
    }
    return draftChatScopeRef.current;
  }

  async function loadTask(id) {
    invalidateInFlight();
    // A card belongs to the tool call of the task that raised it; switching
    // tasks abandons that call instead of leaving a decision hanging over a
    // different conversation.
    if (nativeShell === NATIVE_SHELLS.windows) {
      // The cards on screen are not the evidence; the ids the native cancel
      // answers with are. The map is copied because clearing it below happens
      // long before that answer arrives.
      const raised = new Map(pendingApprovals.current);
      cancelDesktopToolApprovals()
        .then(ids => noteWithdrawnApprovals(ids, raised))
        .catch(() => {});
      clearApprovals();
    }
    setNotice("");
    setComposerWarning("");
    setGeneratedImage(null);
    setImageError("");
    // Detach first: while this conversation loads, the screen must not still be
    // pointing at the task the previous one was watching. The watch is rebuilt
    // from the tracker's rows for whichever conversation this becomes.
    setTaskRuns({});
    if (String(id).startsWith("local-")) {
      const local = getLocalChat(id);
      setMessages(local ? local.messages : []);
      if (!local) setNotice("This local task is no longer available.");
      return;
    }
    if (isNativeLocalChatId(id)) {
      await loadNativeChat(id);
      return;
    }
    loadingConversationRef.current = id;
    setMessages([]);
    try {
      const [conversation, artifacts] = await Promise.all([
        getConversation(id),
        fetchConversationArtifacts(id).catch(() => [])
      ]);
      if (loadedTaskRef.current !== id) return;
      const artifactMap = new Map(
        artifacts
          .filter(artifact => artifact?.messageId)
          .map(artifact => [artifact.messageId, artifact])
      );
      const routingMap = readLocalRoutingMap(workspaceOwner);
      const history = conversation.messages
        .filter(
          message =>
            message.role !== "assistant" ||
            message.status === "failed" ||
            message.status === "cancelled" ||
            String(message.content || "").trim() ||
            artifactMap.has(message.messageId)
        )
        .map(message => {
          const mapped = toLocalMessage(message, artifactMap);
          if (message.role !== "assistant" || !message.messageId) return mapped;
          const localPlan = routingMap.get(String(message.messageId));
          return localPlan ? { ...mapped, localPlan } : mapped;
        });
      loadingConversationRef.current = "";
      setMessages(history);
      const localRun = getLocalRun(id);
      if (localRun) {
        const stored = history.some(message =>
          String(message.id) === localRun.assistantId ||
          String(message.messageId || "") === localRun.assistantId
        );
        if (localRun.status === LOCAL_RUN_STATES.RUNNING) {
          adoptLocalRunTurn(localRun, history);
        } else if (!stored) {
          const settled = localRun.content || localRun.stage;
          if (settled.trim()) {
            setMessages([
              ...history,
              {
                ...createAssistantTurn({ id: localRun.assistantId }),
                status: localRun.status === LOCAL_RUN_STATES.FAILED ? TURN_STATUS.FAILED : TURN_STATUS.COMPLETED,
                content: settled,
                error: localRun.status === LOCAL_RUN_STATES.FAILED
                  ? presentChatError({ message: localRun.error || "The local run stopped." })
                  : null,
                ...(localRun.plan ? { localPlan: localRun.plan } : {})
              }
            ]);
          }
          queueMicrotask(() => clearLocalRun(id, localRun.assistantId));
        } else {
          queueMicrotask(() => clearLocalRun(id, localRun.assistantId));
        }
        if (stored) clearLocalRunDraft(id);
        return;
      }
      // A draft survives the document that wrote it, so a run that ended with
      // the app is not allowed to leave only the user's message behind.
      const draft = readLocalRunDraft(id, workspaceOwner);
      if (draft) {
        recoverLocalRunDraft(id, draft, history);
        return;
      }
      const live = conversation.task;
      if (live && !live.taskId && !live.done && live.messageId) {
        adoptLiveChatTurn(id, live.messageId, history);
      }
    } catch (error) {
      if (loadedTaskRef.current !== id) return;
      loadingConversationRef.current = "";
      setNotice(getApiErrorMessage(error));
    }
  }

  /**
   * A Local Chat stored by the Windows app itself. The app owns this record;
   * no cloud conversation request is made for it. A run that was still marked
   * running when the process ended is shown as interrupted with whatever part
   * was already written, and the transition is stored once.
   */
  async function loadNativeChat(id) {
    loadingConversationRef.current = id;
    setMessages([]);
    try {
      const chat = await getNativeLocalChat(workspaceOwner, id);
      if (loadedTaskRef.current !== id) return;
      if (!chat) {
        loadingConversationRef.current = "";
        setNotice("This local chat is no longer on this device.");
        return;
      }
      let rows = Array.isArray(chat.messages) ? chat.messages.slice() : [];
      let history = rows.map(message => nativeMessageToTurn(message, chat));
      const live = getLocalRun(id);
      if (live) {
        loadingConversationRef.current = "";
        const withoutRunTurn = history.filter(message => String(message.id) !== String(live.assistantId));
        if (live.status === LOCAL_RUN_STATES.RUNNING) {
          adoptLocalRunTurn(live, withoutRunTurn);
          return;
        }
        const stored = history.some(
          message => String(message.id) === String(live.assistantId)
        );
        const liveText = String(live.content || live.stage || "");
        // A settled run's own text is the answer this session produced. It
        // replaces whatever the transcript holds for that message — a stored
        // placeholder is not allowed to win just because it is longer.
        if (stored) {
          setMessages(
            history.map(message =>
              String(message.id) === String(live.assistantId) && liveText.trim()
                ? {
                    ...message,
                    content: liveText,
                    status: live.status === LOCAL_RUN_STATES.FAILED
                      ? TURN_STATUS.FAILED
                      : TURN_STATUS.COMPLETED,
                    error: live.status === LOCAL_RUN_STATES.FAILED
                      ? presentChatError({ message: live.error || "The local run stopped." })
                      : null,
                    ...(live.plan ? { localPlan: live.plan } : {})
                  }
                : message
            )
          );
        } else if (liveText.trim()) {
          setMessages([
            ...history,
            {
              ...createAssistantTurn({ id: live.assistantId }),
              status: live.status === LOCAL_RUN_STATES.FAILED
                ? TURN_STATUS.FAILED
                : TURN_STATUS.COMPLETED,
              content: liveText,
              error: live.status === LOCAL_RUN_STATES.FAILED
                ? presentChatError({ message: live.error || "The local run stopped." })
                : null,
              ...(live.plan ? { localPlan: live.plan } : {})
            }
          ]);
        } else {
          setMessages(history);
        }
        queueMicrotask(() => clearLocalRun(id, live.assistantId));
        clearLocalRunDraft(id);
        return;
      }

      const last = rows[rows.length - 1] || null;
      const unfinished =
        chat.state === "running" ||
        (last?.role === "assistant" && last.status === "streaming");
      const storedText = last?.role === "assistant" ? String(last.content || "") : "";
      if (unfinished && last?.role === "assistant" && last.status === "complete" && storedText.trim()) {
        // The answer reached the transcript; only the chat-level state was
        // lost. Repairing the state is enough — the answer is not rewritten.
        try {
          await updateNativeLocalChat(workspaceOwner, id, {
            state: "completed",
            error: "",
            updatedAt: new Date().toISOString()
          });
          clearLocalRunDraft(id);
        } catch {
          // The record keeps its running state for the next open to repair.
        }
        refreshConversations().catch(() => {});
      } else if (unfinished) {
        const draft = readLocalRunDraft(id, workspaceOwner);
        const assistantId = String(
          (last?.role === "assistant" && last.id) || draft?.assistantId || generateId()
        );
        const draftText = draft?.stage ? String(draft.stage) : "";
        // The draft is written by the run itself, so it is the latest real
        // text; the stored row may still be an early progress line.
        const kept = draftText.trim() ? draftText : storedText;
        const content = kept.trim()
          ? `${kept}${NATIVE_INTERRUPTED_NOTE}`
          : NATIVE_EMPTY_INTERRUPTED;
        const plan = last?.plan || draft?.plan || null;
        const createdAt = last?.createdAt || new Date().toISOString();
        try {
          await appendNativeLocalChatMessage(workspaceOwner, id, {
            id: assistantId,
            role: "assistant",
            content,
            status: "interrupted",
            plan,
            createdAt,
            final: true
          });
          await updateNativeLocalChat(workspaceOwner, id, {
            state: "interrupted",
            error: "The app closed before this local run finished.",
            updatedAt: new Date().toISOString()
          });
          clearLocalRunDraft(id);
        } catch {
          // The transcript below still shows the part this device has. The
          // stored record keeps its unfinished state for the next attempt.
        }
        const interrupted = {
          id: assistantId,
          role: "assistant",
          content,
          status: "interrupted",
          plan,
          createdAt
        };
        rows = rows.some(message => String(message.id) === assistantId)
          ? rows.map(message => (String(message.id) === assistantId ? interrupted : message))
          : [...rows, interrupted];
        history = rows.map(message => nativeMessageToTurn(message, chat));
        refreshConversations().catch(() => {});
      } else {
        // A draft that outlived its run while the record already settled means
        // the answer never made it into the transcript. It is written now,
        // exactly once, without asking any model to produce it again.
        const draft = readLocalRunDraft(id, workspaceOwner);
        const draftText = draft?.stage ? String(draft.stage).trim() : "";
        const answerAlreadyStored =
          last?.role === "assistant" &&
          last.status !== "streaming" &&
          storedText.trim().length > 0;
        if (draft && draftText && !answerAlreadyStored) {
          const assistantId = String(
            (last?.role === "assistant" && last.id) || draft.assistantId || generateId()
          );
          const content = `${draftText}\n\n_Recovered from this device's draft. No model was run again._`;
          const plan = last?.plan || draft.plan || null;
          try {
            await appendNativeLocalChatMessage(workspaceOwner, id, {
              id: assistantId,
              role: "assistant",
              content,
              status: "interrupted",
              plan,
              createdAt: new Date().toISOString(),
              final: true
            });
            await updateNativeLocalChat(workspaceOwner, id, {
              state: "interrupted",
              error: "The answer was recovered from this device's draft after the app closed.",
              updatedAt: new Date().toISOString()
            });
            clearLocalRunDraft(id);
            const recovered = {
              id: assistantId,
              role: "assistant",
              content,
              status: "interrupted",
              plan,
              createdAt: new Date().toISOString()
            };
            rows = rows.some(message => String(message.id) === assistantId)
              ? rows.map(message => (String(message.id) === assistantId ? recovered : message))
              : [...rows, recovered];
            history = rows.map(message => nativeMessageToTurn(message, chat));
            refreshConversations().catch(() => {});
          } catch {
            // The draft stays on this device for the next attempt.
          }
        } else if (draft) {
          clearLocalRunDraft(id);
        }
      }
      loadingConversationRef.current = "";
      setMessages(history);
    } catch (error) {
      if (loadedTaskRef.current !== id) return;
      loadingConversationRef.current = "";
      setNotice(getApiErrorMessage(error));
    }
  }

  /**
   * A local run that outlived the screen that started it. Its answer is not in
   * the transcript yet — the run writes it when it settles — so the turn is
   * painted from the run's own draft, under the id the run will save it with,
   * and Stop is pointed at the run's controller rather than at this screen.
   */
  function adoptLocalRunTurn(run, history) {
    serverOwnedTurnRef.current = true;
    localRunRef.current = true;
    sendingRef.current = true;
    streamingIdRef.current = run.assistantId;
    setStreamingId(run.assistantId);
    setLoading(!run.stopRequested);
    setMessages([
      ...history,
      {
        ...createAssistantTurn({ id: run.assistantId }),
        local: true,
        status: TURN_STATUS.STREAMING,
        content: run.stage || "",
        ...(run.plan ? { localPlan: run.plan } : {})
      }
    ]);
  }

  /**
   * A draft the previous document wrote for a local run it did not outlive.
   *
   * The user message is already on the account; this is the only copy of the
   * part the model had written. It is appended once, under the id the run chose
   * before it started, so a retry or a second reopen cannot duplicate it. A
   * failed write leaves the draft for the next open to retry.
   */
  function recoverLocalRunDraft(conversationId, draft, history) {
    const kept = draft.stage.trim();
    if (!kept) {
      clearLocalRunDraft(conversationId);
      return;
    }
    const content = `${kept}\n\n_Kept on this device when the previous local run ended before it could finish._`;
    appendConversationMessage(conversationId, {
      role: "assistant",
      content,
      messageId: draft.assistantId
    }).then(() => clearLocalRunDraft(conversationId)).catch(() => {});
    setMessages([
      ...history,
      {
        ...createAssistantTurn({ id: draft.assistantId }),
        status: TURN_STATUS.COMPLETED,
        content,
        ...(draft.plan ? { localPlan: draft.plan } : {})
      }
    ]);
  }

  /**
   * A chat turn that outlived the screen that started it.
   *
   * Its answer is not in the transcript yet — the server writes it when the turn
   * settles — so the turn is shown as still running, under the id the server gave
   * it, which is also the id Stop has to name.
   */
  function adoptLiveChatTurn(conversationId, messageId, history) {
    const { seq } = beginRequest();
    serverOwnedTurnRef.current = true;
    streamingIdRef.current = messageId;
    setStreamingId(messageId);
    setLoading(true);
    setMessages([...history, createAssistantTurn({ id: messageId })]);
    watchLiveChatTurn(conversationId, messageId, seq);
  }

  async function watchLiveChatTurn(conversationId, messageId, seq) {
    // One read every few seconds: the answer is written once, so this only has
    // to notice that it happened.
    const pollMs = 3000;
    const watching = () => isCurrentRequest(seq) && loadedTaskRef.current === conversationId;
    while (watching()) {
      await new Promise(resolve => setTimeout(resolve, pollMs));
      if (!watching()) return;
      let conversation;
      try {
        conversation = await getConversation(conversationId);
      } catch {
        continue;
      }
      if (!watching()) return;
      const live = conversation.task;
      if (live && !live.taskId && !live.done && live.messageId === messageId) continue;
      // Settled, stopped or gone: re-read the conversation the way opening it
      // does, so the answer, its artifacts and its real status all come from the
      // server rather than from anything this screen remembered.
      await loadTask(conversationId);
      refreshConversations().catch(() => {});
      refreshUsage();
      return;
    }
  }

  /**
   * Adopt the conversation a task belongs to, once the backend names it.
   *
   * A task sent from an unsaved chat has no conversation id on the wire, and the
   * worker makes one for it. The chat already hands a new conversation over to
   * the URL when a streamed answer first reports its id; a task gets the same
   * treatment, but only while the reader is still on the draft that sent it —
   * nobody gets moved somewhere else because work finished in the background.
   */
  function adoptTaskRunConversation(run, conversationId) {
    if (activeConvId || loading || sendingRef.current) return;
    const id = String(conversationId || "");
    if (!id) return;
    setTaskRuns(previous => {
      const current = previous[run.taskId];
      if (!current || current.conversationId) return previous;
      return { ...previous, [run.taskId]: { ...current, conversationId: id } };
    });
    // A transcript the reader has moved on from no longer holds this run's turn,
    // and that is the signal to leave the URL where it is.
    if (!messages.some(message => message.id === run.assistantId)) return;
    syncTaskParam(id);
    refreshConversations().catch(() => {});
  }

  async function settleTaskRun(run, record) {
    // A terminal event is a notification, not the final payload. The worker
    // persists the answer before completing the task, but a client can still
    // observe the completion event while its replay/detail read contains an
    // empty or partial output (especially across a reconnect). Always perform
    // one authoritative detail read before settling the turn. This closes the
    // race where the task is marked settled with an empty answer and a later
    // refresh is the only thing that makes the real response appear.
    if (!run || run.settledState === record.state || run.settlingState === record.state) return;
    run.settlingState = record.state;
    const conversationId = String(record.conversationId || run.conversationId || "");
    try {
      record = await refreshTaskRun(run.taskId);
    } catch (error) {
      run.settlingState = "";
      if (loadedTaskRef.current === conversationId) {
        setTaskActionError({ taskId: run.taskId, message: getApiErrorMessage(error) });
      }
      return;
    }
    if (record.state !== "completed" && record.state !== "failed" && record.state !== "cancelled") {
      run.settlingState = "";
      return;
    }
    // Commit only after the authoritative read succeeds. If that read failed,
    // the next tracker poll is allowed to retry instead of leaving the turn
    // permanently stuck in its pre-refresh state.
    run.settledState = record.state;
    run.settlingState = "";
    setTaskRuns(previous => previous[run.taskId] ? {
      ...previous, [run.taskId]: { ...previous[run.taskId], settledState: record.state, settlingState: "" }
    } : previous);
    if (record.state === "completed") {
      if (loadedTaskRef.current !== conversationId) return;
      const answer = record.output?.text || "";
      setMessages(previous =>
        completeTurn(previous, run.assistantId, {
          // The answer is the answer. A run that produced one does not also
          // need a sentence saying that it finished.
          content: answer,
          messageId: record.output?.messageId || record.assistantMessageId || undefined,
          finishReason: record.output?.finishReason,
          artifact: answer ? artifactFromResponse(answer) : undefined
        })
      );
      refreshConversations().catch(() => {});
      refreshUsage();
      return;
    }
    if (loadedTaskRef.current !== conversationId) return;
    if (record.state === "cancelled") {
      setMessages(previous => cancelTurn(previous, run.assistantId, { keepEmpty: true }));
      return;
    }
    setMessages(previous =>
      failTurn(previous, run.assistantId, {
        error: {
          title: "Response failed",
          message: taskErrorLine(record) || "The run ended without an answer.",
          retry: true,
          canSwitchModel: false
        }
      })
    );
  }

  useEffect(() => {
    if (loadedTaskRef.current === activeConvId) return;
    loadedTaskRef.current = activeConvId;
    if (activeConvId) loadTask(activeConvId);
    else resetConversation();
  }, [activeConvId]);

  // The registry holds one account's local work. A document that stays mounted
  // across a sign-out must not paint the previous account's run.
  useEffect(() => {
    setLocalRunOwner(workspaceOwner);
  }, [workspaceOwner]);

  /**
   * The chat paints the local run that belongs to it, not the closure that
   * started it.
   *
   * A local run keeps writing into the registry wherever the reader goes. This
   * subscription is what makes the same conversation show the same work when it
   * comes back: the assistant turn is created (or filled) from the run's draft,
   * loading is restored so Stop is reachable, and a settled run becomes exactly
   * one completed or failed turn.
   */
  useEffect(() => {
    const paint = () => {
      const conversationId = loadedTaskRef.current;
      if (!conversationId || loadingConversationRef.current === conversationId) return;
      const run = getLocalRun(conversationId);
      if (!run) return;
      if (run.status === LOCAL_RUN_STATES.RUNNING) {
        if (streamingIdRef.current !== run.assistantId) {
          streamingIdRef.current = run.assistantId;
          serverOwnedTurnRef.current = true;
          localRunRef.current = true;
          sendingRef.current = true;
          setStreamingId(run.assistantId);
          setLoading(!run.stopRequested);
        }
        if (!run.stage) return;
        setMessages(prev => {
          const existing = prev.find(message => message.id === run.assistantId);
          if (!existing) {
            return [...prev, {
              ...createAssistantTurn({ id: run.assistantId }),
              status: TURN_STATUS.STREAMING,
              content: run.stage
            }];
          }
          if (existing.content === run.stage) return prev;
          return prev.map(message => message.id === run.assistantId
            ? { ...message, status: TURN_STATUS.STREAMING, content: run.stage }
            : message
          );
        });
        return;
      }
      const settled = run.content || run.stage;
      setMessages(prev => {
        if (!prev.some(message => message.id === run.assistantId)) return prev;
        if (run.status === LOCAL_RUN_STATES.FAILED) {
          return failTurn(prev, run.assistantId, {
            error: presentChatError({ message: run.error || "The local run stopped." }),
            content: settled
          });
        }
        if (run.status === LOCAL_RUN_STATES.STOPPED && !settled.trim()) {
          return cancelTurn(prev, run.assistantId);
        }
        return completeTurn(prev, run.assistantId, { content: settled });
      });
      if (streamingIdRef.current === run.assistantId) {
        streamingIdRef.current = null;
        serverOwnedTurnRef.current = false;
        sendingRef.current = false;
        setStreamingId(null);
        setLoading(false);
      }
      refreshConversations().catch(() => {});
      queueMicrotask(() => clearLocalRun(conversationId, run.assistantId));
    };
    const unsubscribe = subscribeLocalRuns(paint);
    paint();
    return unsubscribe;
  }, [refreshConversations]);

  // A message this device had to keep because its save was never confirmed is
  // sent again when the app opens. The message id makes that safe to attempt
  // every time: the backend either has it already or stores it once.
  useEffect(() => {
    if (!online || !workspaceOwner || outboxFlushedFor.current === workspaceOwner) return;
    outboxFlushedFor.current = workspaceOwner;
    let cancelled = false;
    const nativeApi =
      nativeLocalChatsAvailable() && workspaceOwner
        ? nativeConversationApi(workspaceOwner)
        : null;
    flushPendingChatMessages({
      createConversation,
      appendConversationMessage,
      nativeCreateConversation: nativeApi?.createConversation || null,
      nativeAppendConversationMessage: nativeApi?.appendConversationMessage || null,
      storage: localBrowserStorage(),
      userId: workspaceOwner
    })
      .then(synced => {
        if (cancelled || synced.length === 0) return;
        refreshConversations().catch(() => {});
        const current = loadedTaskRef.current;
        if (!sendingRef.current && current && synced.some(entry => entry.conversationId === current)) {
          loadTask(current).catch(() => {});
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [online, workspaceOwner]);

  useEffect(() => {
    if (!location.state?.newTask) return;
    loadedTaskRef.current = "";
    resetConversation();
    if (searchParams.get("task")) {
      setSearchParams(current => {
        const next = new URLSearchParams(current);
        next.delete("task");
        return next;
      }, { replace: true });
    }
  }, [location.state?.newTask]);

  useEffect(() => {
    if (!localAiSupported(nativeShell)) {
      setLocalModelsSettled(true);
      return undefined;
    }
    let cancelled = false;
    const read = () =>
      detectLocalRuntime(nativeShell)
        .then(next => {
          if (cancelled) return;
          // A failed probe is a temporary runtime-health result, not evidence
          // that models were uninstalled. Keep the last discovered catalog so
          // a busy/cold Ollama process cannot replace a local selection with a
          // cloud fallback while a chat is in progress.
          if (next.state === LOCAL_AI_STATES.ready) setLocalModels(next.models);
          setLocalModelsSettled(true);
        })
        .catch(() => {
          if (!cancelled) setLocalModelsSettled(true);
        });
    read();
    const timer = window.setInterval(read, 30000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [nativeShell]);

  useEffect(() => {
    // Cloud catalogues are optional in offline mode. Skipping them keeps the
    // startup quiet and leaves the locally discovered models in charge; the
    // same effect runs again when the connection returns.
    if (!online) {
      initializedRef.current = false;
      setFreeCatalogSettled(true);
      setCatalogReady(true);
      setComboState(COMBO_UNLOADED_STATE);
      return;
    }
    if (initializedRef.current) return;
    initializedRef.current = true;
    cachedFetchFreeModels()
      .then((freeData) => {
        setFreeCatalog(freeData?.catalog || null);
        if (freeData?.modelType === FREE_MODEL_TYPE || freeData?.modelType === CUSTOM_MODEL_TYPE) {
          setModelType(freeData.modelType);
        }
      })
      .catch(() => {})
      .finally(() => setFreeCatalogSettled(true));
    Promise.all([
      cachedFetchProviderConfig(),
      cachedFetchSharedModelStatus().catch(() => null),
      cachedFetchOmniRouteStatus().catch(() => null),
    ])
      .then(([stored, sharedStatus, gatewayStatus]) => {
        setConfig(stored);
        setShared(sharedStatus);
        setOmniroute(gatewayStatus);
        // fetchProviderConfig() resolves to data.config, which carries no
        // modelType; the preference comes from fetchFreeModels() above.
        return cachedFetchProviderModels()
          .then((models) => setProviderModels(models))
          .catch((error) => {
            setProviderModels([]);
            if (!sharedStatus?.available && !gatewayStatus?.available) setNotice(getApiErrorMessage(error));
          })
          .finally(() => setCatalogReady(true));
      })
      .catch((error) => {
        setCatalogReady(true);
        setNotice(getApiErrorMessage(error));
      });
  }, [online, refreshConversations]);

  useEffect(() => {
    if (!online) {
      setComboState(COMBO_UNLOADED_STATE);
      return undefined;
    }
    let cancelled = false;
    fetchComboState()
      .then(data => {
        if (!cancelled) setComboState(comboCatalogState(data?.config));
      })
      .catch(() => {
        if (!cancelled) setComboState(COMBO_UNLOADED_STATE);
      });
    return () => {
      cancelled = true;
    };
  }, [online]);

  const catalog = useMemo(
    () =>
      buildCatalog({
        models: providerModels,
        shared,
        omniroute,
        vups: true,
        modelType,
        freeCatalog,
        combo: comboState,
        localModels
      }),
    [providerModels, shared, omniroute, modelType, freeCatalog, comboState, localModels]
  );

  useEffect(() => {
    if (!catalogReady || catalog.length === 0) return;
    if (modelType === FREE_MODEL_TYPE && !freeCatalogSettled) return;
    const stored = loadStoredSelection();
    // A local selection has no configId; until the device runtime has named
    // its models, the combined/local row does not exist yet. Falling back now
    // would replace the user's local choice with the cloud default.
    if (
      !localModelsSettled &&
      localAiSupported(nativeShell) &&
      stored?.kind === "saved" &&
      !stored.configId
    ) {
      return;
    }
    const restored = resolveSelection(catalog, stored) || fallbackRow(catalog);
    if (!restored) return;
    const next = selectionFromRow(restored);
    setSelection((current) => {
      const currentKey = resolveSelection(catalog, current)?.key || "";
      if (currentKey === restored.key) return current;
      saveStoredSelection(next);
      return next;
    });
  }, [catalog, catalogReady, modelType, freeCatalogSettled, localModelsSettled, nativeShell]);

  const activeRow = resolveSelection(catalog, selection) || fallbackRow(catalog);
  const activeModelKey = activeRow?.key || "";
  const canChat = Boolean(activeRow && !activeRow.disabled);
  const activeIsShared = Boolean(activeRow?.shared);
  const activeIsGateway = Boolean(activeRow?.gateway);
  const activeIsVups = Boolean(activeRow?.vups);
  const activeIsCombo = Boolean(activeRow?.combo);

  // Offline, the cloud choice stored from an earlier session cannot answer.
  // The first installed local model is selected so the composer is usable
  // without a trip through the picker. The stored choice is untouched, so the
  // reconnect restores it instead of pretending the local pick replaced it.
  useEffect(() => {
    if (online || !catalogReady || !localModelsSettled || activeRow?.local) return;
    const localChoice = catalog.find(row => row.local && !row.disabled);
    if (!localChoice) return;
    setSelection(selectionFromRow(localChoice));
  }, [online, catalogReady, localModelsSettled, catalog, activeRow?.local]);

  const liveTaskTurnIds = new Set(
    Object.values(taskRuns)
      .filter(run => taskRunIsLive(trackedTasks.find(view => view.taskId === run.taskId)?.state))
      .map(run => run.assistantId)
  );

  async function actOnTaskTurn(taskId, action, request) {
    if (taskActionRef.current) return false;
    const token = `${taskId}:${action}`;
    taskActionRef.current = token;
    setTaskActionPending(token);
    setTaskActionError(null);
    try {
      await request(taskId);
      if (action === "refresh") {
        setTaskRuns(previous => previous[taskId] ? {
          ...previous, [taskId]: { ...previous[taskId], settledState: "" }
        } : previous);
      }
      refreshConversations().catch(() => {});
      return true;
    } catch (error) {
      setTaskActionError({ taskId, message: getApiErrorMessage(error) });
      return false;
    } finally {
      taskActionRef.current = "";
      setTaskActionPending("");
    }
  }

  function answerTaskTurn(taskId, clarificationId, text) {
    return actOnTaskTurn(taskId, "answer", async id => {
      try {
        return await answerTaskRun(id, clarificationId, text);
      } catch (error) {
        if (isStaleAnswerError(error)) await refreshTaskRun(id).catch(() => {});
        throw error;
      }
    });
  }

  function taskPanelFor(messageId) {
    const run = Object.values(taskRuns).find(candidate => candidate.assistantId === messageId);
    const view = run && trackedTasks.find(candidate => candidate.taskId === run.taskId);
    if (!view) return null;
    // A run that answered needs no card: the answer is on screen, and a card
    // that repeats the completion adds nothing to it. A run that has not
    // answered keeps its card, because that is where the answer can be found
    // or read again.
    if (taskRunHasAnswer(view.task) && isTerminalTaskState(view.state)) return null;
    return (
      <TaskTurnPanel
        view={view}
        pending={taskActionPending}
        error={taskActionError?.taskId === run.taskId ? taskActionError.message : ""}
        onCancel={id => actOnTaskTurn(id, "cancel", cancelTaskRun)}
        onResume={id => actOnTaskTurn(id, "resume", resumeTaskRun)}
        onRefresh={id => actOnTaskTurn(id, "refresh", refreshTaskRun)}
        onAnswer={answerTaskTurn}
      />
    );
  }

  function changeModel(row) {
    const next = selectionFromRow(row);
    if (!next) return;
    setSelection(next);
    saveStoredSelection(next);
  }

  // The selector only moves after the native layer has adopted the mode, so a
  // drawer that says "Agent (workspace)" can never sit on top of a Full access
  // policy. Saved grants survive; one-time approvals from the old mode do not.
  async function applyPermissionMode(mode) {
    if (!isPermissionMode(mode)) return false;
    if (nativeShell === NATIVE_SHELLS.windows && workspaceOwner) {
      setPermissionApplying(true);
      try {
        const status = await setDesktopToolPolicy({
          owner: workspaceOwner,
          mode,
          workspaceId: chatWorkspace?.id || null
        });
        // The reply is the policy this app really holds. A selector that says
        // Full access while the native layer runs Ask would misreport file
        // access, so the difference is surfaced instead of being assumed away.
        setNativeToolBridgeError(
          effectivePolicyProblem(status, {
            owner: workspaceOwner,
            mode,
            workspaceId: chatWorkspace?.id || ""
          })
        );
      } catch (error) {
        const message = error?.message || "Could not update the Windows filesystem permission mode.";
        setNativeToolBridgeError(message);
        setNotice(message);
        setPermissionApplying(false);
        return false;
      }
      setPermissionApplying(false);
    }
    cancelDesktopToolApprovals().catch(() => {});
    clearApprovals();
    // An explicit choice replaces the startup notice about what was refused;
    // nothing here re-grants Full access behind the user's back.
    setPermissionNotice("");
    setPermissionMode(savePermissionMode(localBrowserStorage(), workspaceOwner, mode));
    return true;
  }

  function changeWindowsPermissionMode(mode) {
    if (permissionApplying) return;
    if (mode === "full" && permissionMode !== "full") {
      setFullAccessPending(true);
      return;
    }
    applyPermissionMode(mode);
  }

  // The native tool layer pauses the file operation until this card is
  // answered, so the card can only ever say "waiting": it grants nothing itself.
  useEffect(() => {
    if (nativeShell !== NATIVE_SHELLS.windows) return undefined;
    return onDesktopToolApproval(prompt => {
      // An approval belongs to the operation that raised it. A prompt from a
      // stopped turn, a different chat, or a reloaded page has no waiting call
      // this page can resume, so it is denied in the native layer immediately
      // instead of leaving a live card that could authorize abandoned work.
      const activeOperation = streamingIdRef.current;
      // A side-task run answers its own approvals in the workspace panel.
      // Denying them here would stop work this page does not own.
      if (isSideTaskOperation(prompt.operationId)) return;
      if (!activeOperation || (prompt.operationId && prompt.operationId !== activeOperation)) {
        // Nothing on this page can answer it, so the request is withdrawn rather
        // than left open. The line says withdrawn, not declined: no user voted.
        respondDesktopToolApproval(prompt.requestId, "deny").catch(() => {});
        noteApproval(prompt, "cancelled", { paint: () => {} });
        return;
      }
      if (seenApprovalKeys.current.has(prompt.approvalKey)) return;
      seenApprovalKeys.current.add(prompt.approvalKey);
      pendingApprovals.current.set(prompt.requestId, prompt);
      setApprovalError("");
      setApprovalRequests((prev) =>
        prev.some((entry) => entry.requestId === prompt.requestId) ? prev : [...prev, prompt]
      );
      noteApproval(prompt, "waiting");
    });
  }, [nativeShell, activeConvId]);

  /**
   * One permission transition, painted into the open turn and stored against the
   * run that raised the card.
   *
   * The stored half is the point: a line that lives only in this page's state is
   * gone after a reload, and the reader then sees a task log in which a
   * permission they were really asked for never happened. The wording comes from
   * the backend's own table, so the live line and the replayed line are one line.
   */
  function noteApproval(prompt, state, { paint } = {}) {
    const targetId = streamingIdRef.current;
    return trackApprovalTransition(prompt, state, {
      runId: prompt?.operationId,
      paint:
        paint ||
        (rows => {
          if (!targetId) return;
          setMessages(prev =>
            recordTurnProgress(prev, targetId, rows, { runId: activityRunIdRef.current })
          );
        })
    });
  }

  /**
   * The native layer answers a cancel with the request ids it actually closed.
   * Those are the only cards this page may call withdrawn, which is why the ids
   * come back from the cancel instead of being read off the cards on screen.
   */
  function noteWithdrawnApprovals(ids, source = pendingApprovals.current) {
    const withdrawn = new Set();
    for (const id of Array.isArray(ids) ? ids : []) {
      const prompt = source.get(id);
      if (!prompt) continue;
      source.delete(id);
      withdrawn.add(id);
      noteApproval(prompt, "cancelled", { paint: () => {} });
    }
    // A withdrawn card can no longer be answered, so leaving it on screen would
    // offer a decision the native layer already refused.
    if (withdrawn.size > 0) {
      setApprovalRequests((prev) => prev.filter((entry) => !withdrawn.has(entry.requestId)));
    }
  }

  useEffect(() => {
    return () => {
      seenApprovalKeys.current.clear();
      pendingApprovals.current.clear();
      setApprovalRequests([]);
    };
  }, []);

  function forgetApproval(request) {
    if (!request) return;
    seenApprovalKeys.current.delete(request.approvalKey || request.requestId);
    pendingApprovals.current.delete(request.requestId);
    setApprovalRequests((prev) => prev.filter((entry) => entry.requestId !== request.requestId));
  }

  async function handleApprovalRespond(requestId, decision) {
    const request = approvalRequests.find((entry) => entry.requestId === requestId) || { requestId };
    setApprovalBusyId(requestId);
    setApprovalError("");
    try {
      await respondDesktopToolApproval(requestId, decision);
      forgetApproval(request);
      // The decision is one line the reader watched move. What became of the
      // paused operation is a second line, because the native layer's answer to
      // a grant is "the call runs" and to a denial is "nothing was read or
      // changed" - two facts, and the card only ever spoke of the first.
      // Reported in this order, and awaited, so the log numbers them in it.
      await noteApproval(request, decision === "deny" ? "denied" : "granted");
      await noteApproval(request, decision === "deny" ? "stopped" : "resumed");
    } catch (error) {
      const message = error?.message || "That permission request could not be delivered.";
      // The native request already expired or was answered elsewhere, so keeping
      // the card up would only offer a decision that can no longer be made.
      if (/already|expired|unknown|not pending/i.test(message)) {
        forgetApproval(request);
        // Nobody answered it and its own deadline has passed: that is the
        // expiry, told by the time the native layer stamped on the card. An
        // "already answered" for a request still inside its window belongs to
        // whichever surface answered it, and that one records the decision.
        const deadline = Number(request.expiresAt);
        if (/no longer pending/i.test(message) && Number.isFinite(deadline) && Date.now() > deadline) {
          noteApproval(request, "expired");
        }
      } else setApprovalError(message);
    } finally {
      setApprovalBusyId("");
    }
  }

  function clearApprovals() {
    seenApprovalKeys.current.clear();
    pendingApprovals.current.clear();
    setApprovalRequests([]);
    setApprovalBusyId("");
    setApprovalError("");
  }

  // "" means nothing is in the way of the send itself; only the model choice and
  // the account behind it can stop it. Anything else is the sentence the user
  // needs before their draft is cleared.
  function availabilityBlocker(selectedRow) {
    if (!canChat) {
      return activeRow?.combo
        ? `Vups Combo AI cannot run yet - ${activeRow.tag || "select its models first"}.`
        : unavailableModelNotice(shared, omniroute);
    }
    if (!chatReference(selectedRow).model) return "Choose a model in API settings before chatting.";
    return "";
  }

  function clearComposerDraft() {
    setDraftInsertion({ text: "", key: Date.now() });
  }

  // Choosing a repository is a chat decision, not a credential action: it only
  // records which repository the next message names, and it is remembered per
  // saved conversation so a reload shows the same chip its transcript carries.
  function scopeRepo(repo, branch) {
    const chosen = normalisedRepoScope({ ...repo, branch: branch || repo?.branch || repo?.defaultBranch || "" });
    if (!chosen) return;
    setRepoScope(chosen);
    if (activeConvId) {
      rememberRepoScope(workspaceOwner, activeConvId, chosen);
      draftRepoScopeRef.current = null;
    } else {
      draftRepoScopeRef.current = chosen;
    }
    setComposerWarning("");
    setNotice(
      `This chat works on ${repoLabel(chosen)} (${chosen.branch || chosen.defaultBranch || "its default branch"}). ` +
        "The next message you send states that scope to the assistant."
    );
  }

  function clearRepoScope() {
    setRepoScope(null);
    draftRepoScopeRef.current = null;
    if (activeConvId) forgetRepoScope(workspaceOwner, activeConvId);
    setNotice("This chat no longer works on a GitHub repository. Nothing already sent is changed.");
  }

  function closeRepoBrowser() {
    setRepoBrowserOpen(false);
    setRepoBrowserTarget(null);
  }

  // The composer's slash entries run real actions, so none of them is a message
  // to the model: the draft is cleared by hand after the action runs.
  function runSlashCommand(command, args) {
    setNotice("");
    setComposerWarning("");
    if (command.action === "help") {
      setComposerWarning(helpText());
      clearComposerDraft();
      return false;
    }
    const named = args ? ownerRepoFrom(args) : null;
    if (args && !named) {
      setComposerWarning(
        `"${args}" is not a repository. Use owner/name, for example /repo CrazyVillainFF/Vups-Router, ` +
          "or pick one with /github."
      );
      return false;
    }
    if (command.action === "repo" && named) {
      scopeRepo({ ...named, fullName: `${named.owner}/${named.repo}` }, "");
      clearComposerDraft();
      return false;
    }
    if (named && command.action === "github") setRepoBrowserTarget({ ...named, fullName: `${named.owner}/${named.repo}` });
    setRepoBrowserOpen(true);
    clearComposerDraft();
    return false;
  }

  async function persistLocalProjectFiles({ messageId, conversationId, task, files, submittedAt, workspace }) {
    if (!shouldAutoSaveProjectFiles(nativeShell, files)) return null;
    const target = workspace || chatWorkspace;
    const plan = buildProjectSavePlan({ task, files, submittedAt });
    const base = {
      taskId: messageId,
      messageId,
      conversationId,
      task,
      submittedAt,
      dateFolder: plan.dateFolder,
      projectFolder: plan.projectFolder,
      folderPath: plan.folderPath,
      workspaceId: target?.id || "",
      workspacePath: target?.path || "",
      location: target?.path ? joinProjectPath(target.path, plan.folderPath) : "",
      at: Date.now()
    };
    let record;
    try {
      if (!workspaceOwner) {
        record = {
          ...base,
          status: "failed",
          error: "Sign in to save generated files into a project folder.",
          files: plan.entries.map(entry => ({ path: entry.path, status: "failed", bytes: entry.bytes }))
        };
      } else if (!target?.id) {
        // The answer is not discarded: it stays on screen with its files until
        // the native folder picker names a project.
        record = {
          ...base,
          status: "needs-folder",
          error: "Choose a project folder to save these files.",
          files: plan.entries.map(entry => ({ path: entry.path, status: "pending", bytes: entry.bytes }))
        };
      } else {
        const result = await saveGeneratedFiles({
          bridge: { createFile: createWorkspaceFile, readText: readWorkspaceText },
          owner: workspaceOwner,
          workspaceId: target.id,
          workspacePath: target.path || "",
          task,
          files,
          submittedAt
        });
        record = { ...base, ...result, at: Date.now() };
        if (result.status !== "empty") touchWorkspace(target.id);
      }
    } catch (error) {
      record = {
        ...base,
        status: "failed",
        error: error?.message || "The files could not be saved into the project folder.",
        files: plan.entries.map(entry => ({ path: entry.path, status: "failed", bytes: entry.bytes }))
      };
    }
    saveProjectSaveRecord(record, { owner: workspaceOwner });
    setProjectSaves(previous => {
      const next = new Map(previous);
      next.set(messageId, record);
      return next;
    });
    return record;
  }

  // The retry path uses the files already in the answer. No model is asked
  // again, and an identical retry cannot create a second copy.
  async function retryProjectSave(msg, prompt, workspace) {
    const id = msg?.messageId || msg?.id;
    if (!id) return;
    const record = projectSaves.get(id) || null;
    const artifact = msg.artifact || artifactForTurn({ content: msg.content || "", status: "complete" });
    const files = Array.isArray(artifact?.files) ? artifact.files : [];
    if (!files.length) return;
    const submittedAt = record?.submittedAt || new Date(msg.completedAt || Date.now()).toISOString();
    await persistLocalProjectFiles({
      messageId: id,
      conversationId: record?.conversationId || msg.conversationId || activeConvId || "",
      task: record?.task || prompt || "",
      files,
      submittedAt,
      workspace
    });
  }

  async function chooseProjectFolderForSave(msg, prompt) {
    try {
      const workspace = await addWorkspace();
      await retryProjectSave(msg, prompt, workspace);
    } catch (error) {
      const id = msg?.messageId || msg?.id;
      const record = id ? projectSaves.get(id) : null;
      if (record) {
        const next = {
          ...record,
          status: "needs-folder",
          error: error?.message || "Could not open the folder picker."
        };
        saveProjectSaveRecord(next, { owner: workspaceOwner });
        setProjectSaves(previous => new Map(previous).set(id, next));
      } else {
        setNotice(error?.message || "Could not open the folder picker.");
      }
    }
  }

  // A project task writes into a folder the user chose. A path named in the
  // message is tried as written; otherwise the native folder picker asks. The
  // app never makes up a project folder in its own storage and adopts it.
  // Returning false means the user cancelled or the picker failed: the draft is
  // kept and nothing is sent.
  async function provisionTaskWorkspace(text) {
    if (provisionedWorkspaceRef.current) return true;
    provisionedWorkspaceRef.current = null;
    if (!nativeWorkspaces || nativeShell !== NATIVE_SHELLS.windows) return true;
    if (chatWorkspace || loading || sendingRef.current) return true;
    if (!projectTaskReason(text)) return true;
    if (workspacesLoading) {
      setNotice("Project folders are still loading. Try again in a moment.");
      return false;
    }
    setWorkspaceProvisionError("");
    try {
      const named = await openTypedFolder(text);
      // A first-run project request must use the same managed Files folder the
      // workspace provider advertises. Only an explicitly missing chat binding
      // goes to the picker; it must never silently follow another workspace.
      const workspace = named ||
        (boundChatId ? null : await ensureDefaultWorkspaceForOwner()) ||
        (await addWorkspace());
      if (!workspace?.id) {
        setNotice("No project folder was selected, so nothing was sent. Choose a project folder and try again.");
        return false;
      }
      const scopeId = currentChatScope();
      if (scopeId) bindChatWorkspace(scopeId, workspace.id);
      provisionedWorkspaceRef.current = workspace;
      return true;
    } catch (provisionError) {
      provisionedWorkspaceRef.current = null;
      setWorkspaceProvisionError(provisionError.message);
      setNotice(provisionError.message || "The project folder could not be opened.");
      return false;
    }
  }

  // A path typed into chat is tried as written, then walked back to the longest
  // prefix that is a real folder. None of them existing is not an error — that
  // is when the native picker asks the user which folder to use.
  async function openTypedFolder(text) {
    for (const candidate of pathCandidates(text)) {
      try {
        return await openFolderPath(candidate);
      } catch {
        /* the next, shorter prefix gets its turn */
      }
    }
    return null;
  }

  // A folder that vanished is replaced only by the user. The picker is the one
  // way to choose another project, and cancelling keeps the current send and
  // its draft where they are.
  async function replaceUnavailableWorkspace() {
    try {
      const picked = await addWorkspace();
      if (!picked?.path) {
        setNotice("That project folder is unavailable, and no replacement was selected. Nothing was sent.");
        return null;
      }
      provisionedWorkspaceRef.current = picked;
      const scopeId = currentChatScope();
      if (scopeId) bindChatWorkspace(scopeId, picked.id);
      return picked;
    } catch (pickError) {
      setNotice(pickError.message || "The folder picker could not be opened.");
      return null;
    }
  }

  // An explicit project change for this chat: the native picker names the
  // folder, this chat is bound to it, and the selection becomes the device's
  // active project. Other chats that chose their own folders keep theirs.
  async function changeChatProject() {
    if (loading) return;
    try {
      const picked = await addWorkspace();
      if (!picked?.id) return;
      const scopeId = currentChatScope();
      if (scopeId) bindChatWorkspace(scopeId, picked.id);
      setNotice(`Project changed to ${picked.title}.`);
    } catch (error) {
      setNotice(error?.message || "The folder picker could not be opened.");
    }
  }

  async function beforeComposerSend(text, attachments, meta) {
    if (sendingRef.current || loading) return false;
    if (!canSubmitComposer(text, attachments)) return false;
    const entry = classifySlash(text);
    if (entry.kind === "command") return runSlashCommand(entry.command, entry.args);
    // A lone slash is an unfinished command, not a message. It is never sent,
    // and the draft keeps the character the user typed so they can finish it.
    if (entry.kind === "literal" && entry.reason === "empty") {
      setComposerWarning("Type a command after the slash — /github, /repo or /help.");
      return false;
    }
    const selectedRow =
      catalog.find((row) => row.key === meta?.model?.key) || meta?.model || activeRow;
    const unavailable = availabilityBlocker(selectedRow);
    if (unavailable) {
      setNotice(unavailable);
      return false;
    }
    const images = (Array.isArray(attachments) ? attachments : []).filter(
      (item) => item && typeof item === "object" && typeof item.dataUrl === "string"
    );
    // The same isolation the send path enforces, checked before the composer
    // clears its draft: a cloud chip selected on a Local Chat is refused, and
    // the text the user typed stays where they can see it.
    if (selectedRow?.local) {
      if (selectedRow?.combined) {
        if (!localComboConfig.enabled) {
          setNotice("Local Combo AI is off. Turn it on and choose installed models on the Local AI page.");
          return false;
        }
        if (localCombo.usable.length === 0) {
          setNotice(
            localCombo.missing.length > 0
              ? `None of the selected local models is installed right now (${localCombo.missing.join(", ")}). Choose an installed model on the Local AI page.`
              : "Local Combo AI has no models selected. Choose at least one installed model on the Local AI page."
          );
          return false;
        }
        const routingText = contentWithTextAttachments(
          text,
          readyTextAttachments(Array.isArray(attachments) ? attachments : [])
        );
        const routingPreview = buildRoutingPlan({
          task: routingText,
          images: toPayloadImages(images),
          models: localComboModels
        });
        if (!routingPreview.ok) {
          setNotice(routingPreview.error);
          return false;
        }
      } else if (images.length > 0) {
        setNotice("Local chats take text for now. Remove the image to send this message to a local model.");
        return false;
      }
    } else if (isLocalChat(activeConvId) || isNativeLocalChatId(activeConvId)) {
      setNotice(
        "This is a Local Chat. Its messages stay on this device's local runtime, so a cloud model cannot answer here. Start a new chat to use a cloud model."
      );
      return false;
    }
    if (images.length > 0) {
      if (selectedRow?.combo) {
        // Combo AI carries a picture as long as one of the models the user
        // chose can read one. The models that cannot are skipped for this run
        // by the server; the user's own selection stays as it is.
        const eligible = Number(comboState?.visionCapableCount) || 0;
        if (eligible === 0) {
          setComposerWarning(
            "None of the models in Vups Combo AI can read images. Add a model that supports pictures in Combo settings, or remove the image to send text."
          );
          return false;
        }
      }
      if (selectedRow?.vision === false) {
        const label = chatReference(selectedRow).model || selectedRow?.name || "this model";
        setComposerWarning(
          `The selected model (${label}) does not accept images. Choose a vision-capable model in API settings.`
        );
        return false;
      }
    }
    // The project folder is checked before anything is sent. A deleted folder
    // is reported and replaced only through the native picker; a chat with no
    // folder at all asks the same way when the turn needs one.
    const intendedWorkspace = provisionedWorkspaceRef.current || chatWorkspace;
    if (nativeShell === NATIVE_SHELLS.windows && nativeWorkspaces && intendedWorkspace?.id) {
      try {
        const verified = await validateWorkspace(intendedWorkspace.id);
        provisionedWorkspaceRef.current = { ...intendedWorkspace, ...verified };
      } catch {
        if (!(await replaceUnavailableWorkspace())) return false;
      }
    }
    // The folder a project task writes into must come from the user, before the
    // composer clears its draft, so a send never stops to ask where the work
    // goes. A local terminal request needs a folder the user chose: with none
    // bound, the native folder picker runs before the draft is cleared, and
    // cancelling keeps the text and opens nothing.
    if (
      nativeShell === NATIVE_SHELLS.windows &&
      nativeWorkspaces &&
      !workspacesLoading &&
      selectedRow?.local &&
      !(provisionedWorkspaceRef.current || chatWorkspace)?.path &&
      desktopRequestOpensTerminal(text)
    ) {
      try {
        const picked = await addWorkspace();
        if (picked?.path) {
          provisionedWorkspaceRef.current = picked;
          const scopeId = currentChatScope();
          if (scopeId) bindChatWorkspace(scopeId, picked.id);
        } else {
          setNotice("No folder was selected, so the terminal was not opened. Nothing was sent.");
          return false;
        }
      } catch (pickError) {
        setNotice(pickError.message || "The folder picker could not be opened.");
        return false;
      }
    }
    return await provisionTaskWorkspace(text);
  }

  // Starts a fresh conversation locally with a bounded handoff. The existing
  // API creates conversations on the first chat request, so this workspace is
  // persisted together with that first message; the old chat is never touched.
  function preserveUnsyncedChat(sourceMessages) {
    if (!Array.isArray(sourceMessages) || sourceMessages.length === 0) return "";
    if (activeConvId) return "";
    const id = `local-${generateId()}`;
    const firstUser = sourceMessages.find(
      message => message.role === "user" && !message.handoff && String(message.content || "").trim()
    );
    const title =
      (firstUser?.content || "").replace(/\s+/g, " ").trim().slice(0, 60) || "Previous chat";
    const entry = { id, title, updatedAt: new Date().toISOString() };
    saveLocalChat(entry, sourceMessages);
    return id;
  }

  // Builds a bounded handoff, persists it as the first turn of a new
  // conversation, and only then switches the workspace. A failure leaves the
  // current conversation and its messages untouched so the action can retry.
  async function handleContinueInNewChat(sourceId) {
    if (sendingRef.current || loading) return;
    const sourceIndex = messages.findIndex(message => message.id === sourceId);
    if (sourceIndex === -1) return;

    const sourceMessages = messages.slice(0, sourceIndex + 1);
    const sourceError = messages[sourceIndex]?.error || null;
    const modelLabel = activeRow?.name || activeRow?.model || "";

    // The guard is set synchronously, so a double click cannot create two chats.
    await continuationGuardRef.current.run(async () => {
      setHandoffState({ status: "preparing", sourceId, error: "" });
      try {
        // Let the busy state paint before the summary is assembled.
        await new Promise(resolve => setTimeout(resolve, 120));
        const { handoff, conversation } = await prepareContinuation({
          messages: sourceMessages,
          sourceId,
          modelLabel,
          error: sourceError,
          createConversation,
          isUnavailable: isConversationCreateUnavailable
        });

        invalidateInFlight();
        preserveUnsyncedChat(sourceMessages);
        if (conversation) {
          setConversations(previous => [
            {
              id: conversation.id,
              title: conversation.title || "Continued chat",
              messageCount: conversation.messages?.length ?? 1,
              updatedAt: conversation.updatedAt || new Date().toISOString()
            },
            ...previous.filter(item => item.id !== conversation.id)
          ]);
        }
        if (conversation?.id) syncTaskParam(conversation.id);
        else loadedTaskRef.current = "";
        setMessages([
          {
            id: generateId(),
            role: "user",
            content: handoff.content,
            handoff: {
              goal: handoff.goal,
              model: handoff.model,
              files: handoff.files,
              createdAt: Date.now()
            }
          }
        ]);
        setHandoffState({ status: "idle", sourceId: null, error: "" });
        setNotice("");
        setComposerWarning("");
        setGeneratedImage(null);
        setImageError("");
        requestAnimationFrame(() => {
          document.querySelector(".vr-handoff")?.focus({ preventScroll: true });
        });
      } catch {
        setHandoffState({
          status: "error",
          sourceId,
          error: "Could not prepare the new chat. Your current conversation is unchanged."
        });
      }
    });
  }

  function requestDeleteModel(row) {
    if (!row?.configId) return;
    setDeleteModelTarget(row);
  }

  async function deleteSavedModel() {
    const row = deleteModelTarget;
    if (!row?.configId) {
      throw new Error("This saved provider is no longer available.");
    }
    try {
      await removeProvider(row.configId);
      invalidateSettingsKey('settings/providers');
      invalidateSettingsKey('settings/provider');
    } catch (error) {
      throw new Error(getApiErrorMessage(error));
    }
    const remaining = providerModels.filter(
      (model) => model.shared === true || model.configId !== row.configId
    );
    const wasActive = Boolean(activeRow && !activeRow.shared && activeRow.configId === row.configId);
    setProviderModels(remaining);
    if (wasActive) {
      const fallback = fallbackRow(buildCatalog({ models: remaining, shared, vups: true, modelType, freeCatalog }));
      const next = fallback ? selectionFromRow(fallback) : null;
      setSelection(next);
      saveStoredSelection(next);
    }
    setNotice(`Removed the saved configuration for ${row.provider}.`);
    cachedFetchProviderModels()
      .then((models) => setProviderModels(models))
      .catch(() => {});
  }

  function resetConversation() {
    invalidateInFlight();
    // A new chat is a new approval scope and a new workspace decision; the
    // previous chat's remembered answers and folder must not follow it.
    draftChatScopeRef.current = newChatScopeId();
    setChatScope(draftChatScopeRef.current);
    draftRepoScopeRef.current = null;
    setRepoScope(null);
    setMessages([]);
    // A new chat is not the owner of the tasks the previous one started, and they
    // keep running regardless; this only stops watching them from here.
    setTaskRuns({});
    setNotice("");
    setComposerWarning("");
    setGeneratedImage(null);
    setImageError("");
    const fresh = catalog.find((row) => row.vups);
    if (fresh) {
      const next = selectionFromRow(fresh);
      setSelection(next);
      saveStoredSelection(next);
    }
  }

  // Called by the composer with real Files (picker, drop, paste, or Android
  // camera). Every file that cannot be attached returns a named reason in the
  // summary instead of a generic "some files were skipped" chip.
  async function pickAttachments(files, { source, existing } = {}) {
    const declared = [...(files || [])];
    const input = declared.slice(0, 400);
    const prior = attachmentTotals(existing);
    const items = [];
    const skipped = [];
    const seen = new Set(
      (Array.isArray(existing) ? existing : [])
        .filter(item => item && item.status !== "error")
        .map(item => item.originKey)
        .filter(Boolean)
    );
    let imageCount = prior.images;
    let textCount = prior.texts;
    let imageBytes = prior.imageBytes;
    let textBytes = prior.textBytes;
    let textChars = prior.textChars;
    let folderFileCount = (Array.isArray(existing) ? existing : []).filter(
      (item) => item && item.status !== "error" && item.kind !== "image"
    ).length;
    let failed = 0;

    for (const file of input) {
      // Reading an image costs real time on the device. Handing the browser a
      // turn between the files keeps the composer alive while a selection is
      // being read, instead of one long block that looks like a frozen app.
      if (items.length) await new Promise(resolve => requestAnimationFrame(() => resolve()));
      const originKey = fileIdentity(file);
      if (originKey && seen.has(originKey)) {
        skipped.push(skipRecord(file, "Already attached to this message."));
        continue;
      }
      const fileSource = source || file.attachmentSource || (file.webkitRelativePath ? "folder" : "picker");
      if (isImageFile(file)) {
        const check = validateImageFile(file, { remaining: IMAGE_LIMITS.count - imageCount });
        if (!check.ok) {
          skipped.push(skipRecord(file, check.error));
          continue;
        }
        try {
          const item = await readImageAttachment(file);
          if (imageBytes + item.size > IMAGE_LIMITS.totalBytes) {
            skipped.push(skipRecord(file, `Images for one message must total ${formatBytes(IMAGE_LIMITS.totalBytes)} or less.`));
            continue;
          }
          item.source = fileSource;
          item.path = file.relativePath || file.webkitRelativePath || file.name;
          item.sensitive = Boolean(file.sensitive);
          item.originKey = originKey;
          items.push(item);
          if (originKey) seen.add(originKey);
          imageCount += 1;
          imageBytes += item.size;
        } catch (error) {
          failed += 1;
          items.push({
            id: generateAttachmentId(),
            kind: "image",
            name: file.name || "image",
            status: "error",
            error: error?.message || "That image could not be read.",
            retryFile: file
          });
        }
        continue;
      }

      if (isTextAttachmentFile(file)) {
        if (folderFileCount >= ATTACHMENT_LIMITS.folderFile) {
          skipped.push(
            skipRecord(file, `Attach up to ${ATTACHMENT_LIMITS.folderFile} folders and files per message.`)
          );
          continue;
        }
        const check = validateTextFile(file, { remaining: TEXT_LIMITS.count - textCount });
        if (!check.ok) {
          skipped.push(skipRecord(file, check.error));
          continue;
        }
        try {
          const item = await readTextAttachment(file, generateAttachmentId(), fileSource);
          if (textBytes + item.size > TEXT_LIMITS.totalBytes) {
            skipped.push(skipRecord(file, `Text attachments for one message must total ${formatBytes(TEXT_LIMITS.totalBytes)} or less.`));
            continue;
          }
          if (textChars + item.text.length > TEXT_LIMITS.totalChars) {
            skipped.push(skipRecord(file, `Text attachments for one message are limited to ${TEXT_LIMITS.totalChars.toLocaleString()} characters.`));
            continue;
          }
          item.originKey = originKey;
          items.push(item);
          if (originKey) seen.add(originKey);
          folderFileCount += 1;
          textCount += 1;
          textBytes += item.size;
          textChars += item.text.length;
        } catch (error) {
          failed += 1;
          items.push({
            id: generateAttachmentId(),
            kind: "text",
            name: file.name || "file",
            status: "error",
            error: error?.message || "That file could not be read as text.",
            retryFile: file
          });
        }
        continue;
      }

      skipped.push(skipRecord(file, unsupportedAttachmentReason(file)));
    }

    if (declared.length > input.length) {
      skipped.push({
        name: `${(declared.length - input.length).toLocaleString()} more files`,
        path: "",
        reason: "Only the first 400 files in one selection are examined."
      });
    }

    return {
      items,
      summary: {
        selected: declared.length,
        attached: items.filter(item => item.status !== "error").length,
        failed,
        skipped
      }
    };
  }

  async function pickFolderAttachments({ existing } = {}) {
    if (nativeShell !== NATIVE_SHELLS.windows) {
      throw new Error("Folder attachments are available in the Windows app.");
    }
    const current = (Array.isArray(existing) ? existing : []).filter(
      (item) => item && item.status !== "error" && item.kind !== "image"
    ).length;
    if (current >= ATTACHMENT_LIMITS.folderFile) {
      throw new Error(`Attach up to ${ATTACHMENT_LIMITS.folderFile} folders and files per message.`);
    }
    const report = await pickComposerFolder();
    if (!report) return null;
    const folder = folderAttachmentFromReport(report);
    if (!folder) throw new Error("That folder could not be read.");
    // The folder card owns its exclusions: it lists every entry with a reason
    // and offers opt-ins, so the global summary does not count folders as skips.
    return {
      items: [folder],
      summary: {
        selected: folder.fileCount,
        attached: 1,
        failed: 0,
        skipped: []
      }
    };
  }

  function releaseFolderAttachment(folder) {
    if (folder?.kind !== "folder" || !folder.token) return;
    releaseComposerFolder(folder.token);
  }

  // Folder contents stay on disk until send. Reading happens here, in bounded
  // batches, so a folder with tens of thousands of files costs one scan and a
  // few dozen reads rather than one File object per entry.
  async function prepareComposerAttachments(items, options = {}) {
    const list = Array.isArray(items) ? items : [];
    const folders = list.filter(item => item?.kind === "folder");
    if (folders.length === 0) return { items: list, summary: null };
    const others = list.filter(item => item?.kind !== "folder");
    let imageCount = others.filter(item => item?.dataUrl).length;
    let imageBytes = others
      .filter(item => item?.dataUrl)
      .reduce((total, item) => total + (Number(item.size) || 0), 0);
    const expanded = [];
    const foldersSummary = [];

    for (const folder of folders) {
      const result = await prepareFolderAttachment(folder, {
        readFiles: readComposerFiles,
        signal: options.signal,
        onProgress: progress => options.onProgress?.({ ...progress, folder: folder.name }),
        imageBudget: {
          count: Math.max(0, IMAGE_LIMITS.count - imageCount),
          bytes: Math.max(0, IMAGE_LIMITS.totalBytes - imageBytes)
        }
      });
      expanded.push(...result.items);
      foldersSummary.push(result.summary);
      imageCount += result.summary.includedImages;
      imageBytes += result.items
        .filter(item => item.dataUrl)
        .reduce((total, item) => total + (Number(item.size) || 0), 0);
    }

    const skipped = foldersSummary.flatMap(summary =>
      summary.skipped.map(entry => ({
        ...entry,
        name: entry.path,
        path: `${summary.folder}/${entry.path}`
      }))
    );

    return {
      items: [...others, ...expanded],
      summary: {
        selected: others.length + foldersSummary.reduce((total, summary) => total + summary.selected, 0),
        attached: others.filter(item => item.status !== "error").length + expanded.length,
        failed: others.filter(item => item.status === "error").length,
        skipped,
        folders: foldersSummary
      }
    };
  }

  async function retryComposerAttachment(item) {
    if (!item?.retryFile) return null;
    const result = await pickAttachments([item.retryFile]);
    const replacement = result.items.find(next => next.status !== "error") || result.items[0] || null;
    return { item: replacement, summary: result.summary };
  }

  async function handleGenerateImage(text) {
    const prompt = typeof text === "string" ? text.trim() : "";
    if (!prompt) {
      setImageError("Enter a prompt before generating an image.");
      return;
    }
    if (imageGenerating || loading) return;
    if (!user) {
      setImageError("Sign in to generate images.");
      return;
    }
    if (!isCloudOnline()) {
      setImageError(
        "You're offline. Image generation runs in the cloud; installed local models cannot create images here."
      );
      return;
    }
    const controller = new AbortController();
    imageAbortRef.current = controller;
    setImageGenerating(true);
    setImageError("");
    setGeneratedImage(null);
    try {
      const result = await generateImage(prompt, controller.signal);
      if (controller.signal.aborted) return;
      if (!result?.image || typeof result.image !== "string") {
        throw new Error("The backend returned no generated image.");
      }
      setGeneratedImage({
        image: result.image,
        mimeType: result.mimeType || "image/jpeg",
        prompt,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        setImageError("Image generation was stopped.");
        return;
      }
      setImageError(getApiErrorMessage(error));
    } finally {
      if (imageAbortRef.current === controller) imageAbortRef.current = null;
      setImageGenerating(false);
    }
  }

  function canSubmitComposer(text, attachments) {
    const items = Array.isArray(attachments) ? attachments : [];
    const textFiles = readyTextAttachments(items);
    const charCount = text.length + textAttachmentChars(textFiles);
    if (charCount > MAX_USER_MESSAGE_CHARS) {
      setComposerWarning(USER_MESSAGE_LIMIT_WARNING);
      return false;
    }
    if (items.some((item) => item && typeof item === "object" && item.status === "error")) {
      setComposerWarning("Remove the failed attachments (marked in red) before sending.");
      return false;
    }
    const images = items.filter(
      (item) => item && typeof item === "object" && typeof item.dataUrl === "string"
    );
    if (images.length > IMAGE_LIMITS.count) {
      setComposerWarning(`You can attach up to ${IMAGE_LIMITS.count} images per message.`);
      return false;
    }
    const totalImageBytes = images.reduce((sum, item) => sum + (Number(item.size) || 0), 0);
    if (totalImageBytes > IMAGE_LIMITS.totalBytes) {
      setComposerWarning(
        `Images are limited to ${formatBytes(IMAGE_LIMITS.totalBytes)} per message. Remove one before sending.`
      );
      return false;
    }
    return true;
  }

  // `carriedWorkspace` is set only by the resume after the folder decision: the
  // chat is already bound but this render still sees the old workspace, so the
  // turn is given the folder directly instead of reading a stale value.
  async function handleSend(text, retryHistory, meta, carriedWorkspace) {
    const rawAttachments = Array.isArray(meta?.attachments) ? meta.attachments : [];
    const retryUserMessageId = typeof meta?.retryUserMessageId === "string" ? meta.retryUserMessageId : "";
    const failedAttachments = rawAttachments.filter(
      (item) => item && typeof item === "object" && item.status === "error"
    );
    const attachmentItems = rawAttachments.filter(
      (item) => item && typeof item === "object" && item.status !== "error"
    );
    const imageItems = attachmentItems.filter((item) => item.dataUrl);
    const textFiles = readyTextAttachments(attachmentItems);
    const imagePayload = toPayloadImages(imageItems);
    const requestText = contentWithTextAttachments(text, textFiles);

    if (
      sendingRef.current ||
      loading ||
      typeof text !== "string" ||
      (!text.trim() && imagePayload.length === 0 && textFiles.length === 0)
    ) return;

    if (requestText.length > MAX_USER_MESSAGE_CHARS) {
      setComposerWarning(USER_MESSAGE_LIMIT_WARNING);
      return;
    }

    if (failedAttachments.length > 0) {
      setComposerWarning("Remove the failed attachments (marked in red) before sending.");
      return;
    }

    // A refused send must still be able to explain itself where the text is
    // visible, so the composer runs the same check before it clears the draft.
    const selectedRow = catalog.find((row) => row.key === meta?.model?.key) || meta?.model || activeRow;
    const unavailable = availabilityBlocker(selectedRow);
    if (unavailable) {
      setNotice(unavailable);
      return;
    }

    const reference = chatReference(selectedRow);
    const modelKey = reference.model;

    // Local Chat isolation: a conversation marked as local belongs to the
    // device's runtime. A cloud model may not answer in it, and a local model
    // may not take over a saved cloud conversation either — both cases start a
    // fresh conversation instead of mixing the two histories.
    if (selectedRow?.local) {
      if (selectedRow?.combined) {
        if (!localComboConfig.enabled) {
          setNotice("Local Combo AI is off. Turn it on and choose installed models on the Local AI page.");
          return;
        }
        if (localCombo.usable.length === 0) {
          setNotice(
            localCombo.missing.length > 0
              ? `None of the selected local models is installed right now (${localCombo.missing.join(", ")}). Choose an installed model on the Local AI page.`
              : "Local Combo AI has no models selected. Choose at least one installed model on the Local AI page."
          );
          return;
        }
      } else if (imagePayload.length > 0) {
        setNotice("Local chats take text for now. Remove the image to send this message to a local model.");
        return;
      }
    } else if (isLocalChat(activeConvId) || isNativeLocalChatId(activeConvId)) {
      setNotice(
        "This is a Local Chat. Its messages stay on this device's local runtime, so a cloud model cannot answer here. Start a new chat to use a cloud model."
      );
      return;
    }

    // The route is decided here, before the message is stored: a request the
    // selected installed models cannot serve (an essential image with no
    // vision model, or code with no coding model, for example) is refused
    // while the text is still in the composer. The rules are local and
    // synchronous, so this adds no wait to the send.
    const combinedRouting = selectedRow?.combined
      ? buildRoutingPlan({
          task: requestText || text,
          images: imagePayload,
          models: localComboModels
        })
      : null;
    if (combinedRouting && !combinedRouting.ok) {
      setNotice(combinedRouting.error);
      return;
    }

    if (imagePayload.length > 0 && selectedRow?.vision === false) {
      setNotice(
        `The selected model (${modelKey}) does not accept images. Choose a vision-capable model in API settings.`
      );
      return;
    }

    if (selectedRow?.combo && imagePayload.length > 0) {
      // Combo AI can carry a picture as long as one of the models the user
      // chose can read one. The models that cannot are skipped for this run
      // by the server; the user's own selection stays as it is. When none of
      // them can read a picture, the message and the picture stay in the
      // composer and the reader is told what would work.
      const eligible = Number(comboState?.visionCapableCount) || 0;
      if (eligible === 0) {
        setNotice(
          "None of the models in Vups Combo AI can read images. Add a model that supports pictures in Combo settings, or remove the image to send text."
        );
        return;
      }
    }

    // A cloud model cannot run without its backend. Refusing here, before the
    // message is stored, keeps the text in the composer and prevents a cloud
    // task that could never execute from being created offline.
    if (!selectedRow?.local && !isCloudOnline()) {
      setNotice(
        "You're offline. This model runs in the cloud, so it cannot answer right now. Switch to an installed local model or Combined Local AI to keep working on this device."
      );
      return;
    }

    if (sendingRef.current) return;
    sendingRef.current = true;
    localStopRequestedRef.current = false;
    setNotice("");
    setComposerWarning("");
    let sendWorkspace = carriedWorkspace || chatWorkspace;
    // A terminal opened for a local turn must run in a real folder. When the
    // chat has none, the Windows folder picker is shown before anything is
    // sent, so the native layer receives the folder the user chose instead of
    // a guessed path. Cancelling launches nothing and sends nothing.
    if (
      nativeShell === NATIVE_SHELLS.windows &&
      nativeWorkspaces &&
      selectedRow?.local &&
      !sendWorkspace?.path &&
      desktopRequestOpensTerminal(requestText)
    ) {
      try {
        const picked = boundChatId
          ? await addWorkspace()
          : await ensureDefaultWorkspaceForOwner();
        if (picked?.path) {
          sendWorkspace = picked;
          const scopeId = currentChatScope();
          if (scopeId) bindChatWorkspace(scopeId, picked.id);
        } else {
          setNotice("No folder was selected, so the terminal was not opened. Nothing was sent.");
          sendingRef.current = false;
          return;
        }
      } catch (pickError) {
        setNotice(pickError.message || "The folder picker could not be opened.");
        sendingRef.current = false;
        return;
      }
    }
    provisionedWorkspaceRef.current = null;
    const chosenEffort = meta?.effort || currentEffort;
    // A repository chosen for this chat is named in the next message the user
    // sends, so the scope is a real turn in the transcript — not a hidden
    // instruction, and not a decoration the assistant could never act on.
    const announcesScope = Boolean(repoScope) && !hasRepoScopeNote(messages, repoScope);
    const userMsg = {
      id: generateId(),
      role: "user",
      content: announcesScope
        ? `${repoScopeMessage(repoScope, repoScope.branch)}\n\n${text}`
        : text,
      ...(imageItems.length > 0 ? { images: imageItems } : {}),
      ...(textFiles.length > 0 ? { textFiles } : {}),
    };
    const baseMessages = retryHistory ?? [...messages, userMsg];

    const history = requestHistory(baseMessages).slice(-40);
    const assistantId = generateId();
    const assistantAt = new Date().toISOString();
    const activityRunId = generateId();

    // The submitted message is on screen and the request is queued before any
    // step that can fail slowly, so nothing between the composer and the
    // backend can swallow the text the user just typed.
    setMessages([
      ...baseMessages,
      createAssistantTurn({ id: assistantId })
    ]);
    setLoading(true);
    setStreamingId(assistantId);
    streamingIdRef.current = assistantId;
    activityRunIdRef.current = activityRunId;
    // A card left over from the previous turn can only be answered against a
    // tool call that no longer exists.
    clearApprovals();

    const { controller, seq } = beginRequest();
    const inlineRequested = wantsInlineCode(text);
    let streamedContent = "";
    let serverOwned = false;

    try {
      // The native permission bridge is the one step before dispatch that can
      // throw. It runs after the message is visible, and a failure drops local
      // tools for this turn instead of the turn itself — a policy that was
      // never applied cannot be trusted to scope filesystem access, so the
      // message goes out as a plain chat with the reason stated in the panel.
      let nativePolicyReady = true;
      if (nativeShell === NATIVE_SHELLS.windows && workspaceOwner) {
        try {
          await setDesktopToolPolicy({
            owner: workspaceOwner,
            mode: permissionMode,
            workspaceId: sendWorkspace?.id || null
          });
        } catch (error) {
          nativePolicyReady = false;
          const message = error?.message || "Could not update the Windows filesystem permission mode.";
          setNativeToolBridgeError(message);
          setComposerWarning(`${message} This message was sent without local file tools.`);
        }
      }
      // Stop or a task switch during the bridge already settled this turn, and
      // both bump the request sequence, so the guard below is the whole check.
      if (!isCurrentRequest(seq)) return;

      // A local turn runs on this PC, so its native tools do not depend on the
      // cloud tool endpoint, and a local image turn still gets them.
      const useDesktopTools =
        nativeShell === NATIVE_SHELLS.windows &&
        nativePolicyReady &&
        Boolean(workspaceOwner) &&
        (Boolean(selectedRow?.local) || (imagePayload.length === 0 && !serverLacksToolEndpoint));
      // Local tools are a bonus on a plain question but the whole point of the
      // turn once a project folder is picked, so only the second case owes the
      // user an explanation when the server cannot run them.
      const warnAboutSkippedTools = Boolean(sendWorkspace?.id);
      // "Allow Always" answers are scoped to this chat and kept in native memory.
      const chatScopeId = useDesktopTools ? currentChatScope() : "";
      const requestOptions = {
        conversationId: activeConvId,
        messages: history,
        model: modelKey,
        configId: reference.configId,
        providerId: reference.providerId,
        source: reference.source,
        vups: reference.vups,
        mode: DEFAULT_CHAT_MODE,
        temperature: EFFORT_TEMPERATURE[chosenEffort] ?? 0.7,
        signal: controller.signal,
        assistantMessageId: assistantId,
        operationId: assistantId,
        chatId: chatScopeId || undefined,
        userText: requestText || text,
        // Only this chat's folder is in scope. Another chat's workspace can
        // never be searched just because it exists in the app.
        searchRoots: sendWorkspace?.path ? [sendWorkspace.path] : [],
        // The server records the folder the turn is bound to in the task's own
        // log line, so a reload shows where the work really happened.
        workspacePath: sendWorkspace?.path || "",
        onMeta: ({ conversationId, messageId }) => {
          // The server named the conversation: it exists, it is permanent, and
          // the user's message is already stored in it. The sidebar has to show
          // that chat even if this screen is no longer the one being read.
          if (conversationId) {
            upsertConversation({
              id: conversationId,
              title:
                text.replace(/\s+/g, " ").trim().slice(0, 60) ||
                (attachmentItems.length > 0 ? "Local file attachment" : "New chat"),
              updatedAt: new Date().toISOString()
            });
          }
          if (!isCurrentRequest(seq)) return;
          if (String(activeConvId || "").startsWith("local-")) {
            removeTask(activeConvId).catch(() => {});
          }
          syncTaskParam(conversationId);
          // The first answer of a new chat names the saved conversation; bind
          // the scope id used this turn so its remembered answers survive a
          // reload and a switch back to this chat.
          if (chatScopeId && conversationId) {
            rememberChatScope(workspaceOwner, conversationId, chatScopeId);
          }
          if (repoScope && conversationId) {
            rememberRepoScope(workspaceOwner, conversationId, repoScope);
            draftRepoScopeRef.current = null;
          }
          setMessages((prev) => markTurnMeta(prev, assistantId, { messageId, conversationId }));
          // That row is this screen's own guess and carries no task state. The
          // server registered the turn before it named the conversation, so the
          // badge beside the name is read from it rather than left to whatever
          // later navigation happens to refresh the list.
          if (serverOwnedTurnRef.current) refreshConversations().catch(() => {});
        },
        onChunk: (chunk) => {
          if (!isCurrentRequest(seq)) return;
          streamedContent += chunk;
          setMessages((prev) => appendTurnChunk(prev, assistantId, chunk));
        },
        onActivity: (activity) => {
          if (!isCurrentRequest(seq)) return;
          setMessages((prev) =>
            recordTurnActivity(prev, assistantId, activity, { runId: activityRunId })
          );
        },
        // One line per real step, keyed to the operation it describes: the rows
        // the app raised for its own native calls and the rows the server wrote
        // for the same calls land on the same line instead of doubling it.
        onProgress: (events) => {
          if (!isCurrentRequest(seq)) return;
          setMessages((prev) =>
            recordTurnProgress(prev, assistantId, events, { runId: activityRunId })
          );
        },
        // A write that Windows actually performed is the only thing that makes
        // the open explorer reload; a denied or failed call changes nothing.
        onWorkspaceMutation: () => {
          if (!isCurrentRequest(seq)) return;
          touchWorkspace(sendWorkspace?.id);
        },
      };
      const prompt = announcesScope
        ? `${repoScopeMessage(repoScope, repoScope.branch)}\n\n${requestText || text}`
        : requestText || text;
      if (selectedRow?.combined) {
        // Local Combo AI: the router on this device picks the smallest set of
        // installed models the request needs. One model per necessary role,
        // one pass each, and the last stage's answer is the answer. No
        // per-model answers and no synthesis pass exist on this path.
        serverOwnedTurnRef.current = true;
        serverOwned = true;
        localRunRef.current = true;
        const localTask = requestText || text;
        const plan = comboPlan(localComboConfig, localModels);
        if (plan.missing.length > 0) {
          setNotice(
            `Not installed right now: ${plan.missing.join(", ")}. Local Combo AI will continue with the ${plan.usable.length} installed model${plan.usable.length === 1 ? "" : "s"} you selected.`
          );
        }
        const routing = combinedRouting;
        const routingSummary = planSummary(routing);
        const continuing =
          Boolean(activeConvId) &&
          (isLocalChat(activeConvId) || isNativeLocalChatId(activeConvId)) &&
          !String(activeConvId).startsWith("local-");
        const useNativeStore =
          nativeLocalChatsAvailable() &&
          Boolean(workspaceOwner) &&
          (!continuing || isNativeLocalChatId(activeConvId));
        const outboxApi = useNativeStore
          ? nativeConversationApi(workspaceOwner)
          : { createConversation, appendConversationMessage };
        if (!useNativeStore) ensureLocalChatsFolder();
        const localTitle = localTask.replace(/\s+/g, " ").trim().slice(0, 60) || "Local chat";
        let localConversationId = "";
        const retriedUser = Array.isArray(retryHistory)
          ? [...retryHistory].reverse().find(message => message?.role === "user")
          : null;
        const savedRowId = retriedUser?.id || userMsg.id;
        try {
          const saved = await saveChatMessageFirst({
            createConversation: outboxApi.createConversation,
            appendConversationMessage: outboxApi.appendConversationMessage,
            storage: localBrowserStorage(),
            userId: workspaceOwner,
            conversationId: continuing ? activeConvId : "",
            content: localTask,
            messageId: storedMessageId(retriedUser) || userMsg.id,
            title: localTitle,
            store: useNativeStore ? "local" : "cloud"
          });
          localConversationId = saved.conversationId;
          if (isCurrentRequest(seq)) syncTaskParam(localConversationId);
          upsertConversation({
            id: localConversationId,
            ...(continuing ? {} : { title: localTitle }),
            updatedAt: new Date().toISOString()
          });
          if (useNativeStore) {
            await updateNativeLocalChat(workspaceOwner, localConversationId, {
              ...(continuing ? {} : { title: localTitle }),
              model: "Local Combo AI",
              combo: true,
              state: "running",
              plan: routingSummary,
              updatedAt: assistantAt
            });
            await appendNativeLocalChatMessage(workspaceOwner, localConversationId, {
              id: assistantId,
              role: "assistant",
              content: "",
              status: "streaming",
              plan: routingSummary,
              createdAt: assistantAt
            });
          } else {
            markLocalChat({
              id: localConversationId,
              title: continuing ? "" : localTitle,
              model: "Local Combo AI",
              combo: true
            });
          }
          // The routing decision is stored with the run and with the message
          // id it will be saved under, so reopening the conversation shows the
          // same models and stages that handled the task.
          saveLocalRouting(assistantId, routingSummary, { owner: workspaceOwner });
          beginLocalRun({
            conversationId: localConversationId,
            assistantId,
            kind: "combo",
            label: routing.label || "Local Combo AI",
            plan: routingSummary,
            controller,
            ownerId: workspaceOwner
          });
          // Stop can arrive while the message is still being saved. Now that the
          // run has an identity, that answer is read once, before any model is
          // asked, so the user's press is not silently discarded.
          if (localStopRequestedRef.current) controller.abort();
          setMessages(prev => prev.map(message =>
            message.id === savedRowId ? { ...message, messageId: saved.messageId } : message
          ));
          if (String(activeConvId || "").startsWith("local-")) removeTask(activeConvId).catch(() => {});
          refreshConversations().catch(() => {});
        } catch (error) {
          submissionFailedRef.current = true;
          console.error("[local-ai] local chat handoff failed", {
            model: "Local Combo AI",
            name: error?.name || "Error",
            code: error?.code || "",
            message: error?.message || String(error || "Unknown local chat handoff error"),
            stack: error?.stack || ""
          });
          throw error;
        }
        let answer = "";
        let status = "";
        let lastNativeSnapshotAt = 0;
        const selectedLine = `Selected: ${routing.label} · ${routing.execution} model${routing.execution === 1 ? "" : "s"}`;
        const paintStream = () => {
          if (!isCurrentRequest(seq)) return;
          setMessages(prev => prev.map(message =>
            message.id === assistantId
              ? { ...message, status: TURN_STATUS.STREAMING, content: answer || status }
              : message
          ));
          // Only real model output is stored. A progress line is a UI state,
          // not a reply, and must never become the saved assistant message.
          if (useNativeStore && answer) {
            const now = Date.now();
            if (now - lastNativeSnapshotAt < 800) return;
            lastNativeSnapshotAt = now;
            appendNativeLocalChatMessage(workspaceOwner, localConversationId, {
              id: assistantId,
              role: "assistant",
              content: answer,
              status: "streaming",
              plan: routingSummary,
              createdAt: assistantAt
            }).catch(() => {});
          }
        };
        try {
          status = `_${selectedLine} · starting…_`;
          paintStream();
          // Only the final stage is the answer. Intermediate stages paint a
          // one-line status, so no model-by-model answer fills the chat.
          const outcome = await runLocalCombo({
            models: localComboModels,
            task: localTask,
            history: history.map(entry => ({ role: entry.role, content: entry.content })),
            images: imagePayload,
            plan: routing,
            callModel: (name, options) => chatLocalModel(name, options),
            callAgent: useDesktopTools
              ? (name, options) =>
                  runLocalAgent({
                    model: name,
                    messages: options.messages,
                    task: localTask,
                    signal: options.signal,
                    workspaceRoot: sendWorkspace?.path || "",
                    executeTool: (tool, args) =>
                      executeDesktopTool(tool, args, { operationId: assistantId, chatId: chatScopeId }),
                    callModel: (modelName, modelOptions) => chatLocalModelTurn(modelName, modelOptions),
                    onChunk: options.onChunk,
                    onDiscard: options.onDiscard,
                    onToolStart: ({ label }) => {
                      status = `_${selectedLine} · ${label}…_`;
                      paintStream();
                    }
                  })
              : null,
            signal: controller.signal,
            onEvent: event => {
              if (event.type === "stage-start") {
                if (event.final) answer = "";
                status = event.final
                  ? `_${selectedLine} · ${event.label} (${event.model}) is writing the answer…_`
                  : `_${selectedLine} · ${event.label} (${event.model}) is working…_`;
                paintStream();
              } else if (event.type === "stage-reset") {
                if (!event.final) return;
                answer = "";
                paintStream();
              } else if (event.type === "stage-chunk") {
                if (!event.final) return;
                answer += event.chunk;
                noteLocalRunStage(localConversationId, answer);
                paintStream();
              } else if (event.type === "stage-thought") {
                // Ollama reasoning models stream `message.thinking` for a long
                // time before their first answer token. Keep the real activity
                // visible without putting hidden reasoning into the reply.
                status = `_${selectedLine} · ${event.label} (${event.model}) is thinking…_`;
                paintStream();
              } else if (event.type === "stage-failed" && !event.final) {
                status = `_${selectedLine} · ${event.label} (${event.model}) could not finish; continuing…_`;
                paintStream();
              }
            }
          });
          const finalAnswer = outcome.finalAnswer;
          // Save into the project before this turn is reported as complete. A
          // failed save is a visible, retryable record; it never hides the answer.
          const saveArtifact = inlineRequested
            ? null
            : artifactForTurn({ content: finalAnswer, status: "complete" });
          if (saveArtifact?.files?.length) {
            await persistLocalProjectFiles({
              messageId: assistantId,
              conversationId: localConversationId,
              task: text,
              files: saveArtifact.files,
              submittedAt: assistantAt,
              workspace: sendWorkspace
            });
          }
          const savedAnswer = useNativeStore
            ? await appendNativeLocalChatMessage(workspaceOwner, localConversationId, {
                id: assistantId,
                role: "assistant",
                content: finalAnswer,
                status: "complete",
                plan: routingSummary,
                createdAt: assistantAt,
                final: true
              }).then(() => true).catch(() => false)
            : await appendConversationMessage(localConversationId, {
                role: "assistant",
                content: finalAnswer,
                messageId: assistantId
              }).then(() => true).catch(() => false);
          finishLocalRun(localConversationId, {
            status: LOCAL_RUN_STATES.DONE,
            content: finalAnswer,
            saved: savedAnswer
          });
          if (useNativeStore) {
            await updateNativeLocalChat(workspaceOwner, localConversationId, {
              state: savedAnswer ? "completed" : "failed",
              error: savedAnswer ? "" : "The answer could not be saved to this Local Chat.",
              model: outcome.usedModels.join(", "),
              combo: true,
              updatedAt: new Date().toISOString()
            }).catch(() => {});
          } else {
            updateLocalChat(localConversationId, {
              model: outcome.usedModels.join(", "),
              combo: true
            });
          }
          refreshConversations().catch(() => {});
          if (isCurrentRequest(seq)) {
            streamedContent = finalAnswer;
            setMessages(prev => {
              const reset = prev.map(message =>
                message.id === assistantId
                  ? { ...createAssistantTurn({ id: assistantId }), localPlan: routingSummary }
                  : message
              );
              return completeTurn(reset, assistantId, {
                content: finalAnswer,
                messageId: assistantId
              });
            });
            if (!savedAnswer) {
              setComposerWarning("The answer is on screen but could not be saved to this Local Chat.");
            }
            if (outcome.failures.length > 0) {
              setNotice(
                `${outcome.failures.map(failure => failure.model).join(", ")} could not finish its part. The remaining stages completed the run.`
              );
            }
          }
          return;
        } catch (error) {
          // Every completed stage and every partial draft is written to the
          // Local Chat before the error leaves this branch, so a failed or
          // stopped run never leaves a user message with no trace of the work.
          const kept = answer.trim() || (typeof error?.partial === "string" ? error.partial.trim() : "");
          if (error?.name === "AbortError") {
            const settled = kept ? `${kept}\n\n_Stopped before the run finished. Completed answers above were kept._` : "";
            const savedKept = useNativeStore
              ? await appendNativeLocalChatMessage(workspaceOwner, localConversationId, {
                  id: assistantId,
                  role: "assistant",
                  content: settled,
                  status: "stopped",
                  plan: routingSummary,
                  createdAt: assistantAt,
                  final: true
                }).then(() => true).catch(() => false)
              : settled
                ? await appendConversationMessage(localConversationId, {
                    role: "assistant",
                    content: settled,
                    messageId: assistantId
                  }).then(() => true).catch(() => false)
                : true;
            finishLocalRun(localConversationId, {
              status: LOCAL_RUN_STATES.STOPPED,
              content: settled,
              saved: savedKept
            });
            if (useNativeStore) {
              await updateNativeLocalChat(workspaceOwner, localConversationId, {
                state: "stopped",
                error: "",
                model: routing.models.join(", "),
                combo: true,
                updatedAt: new Date().toISOString()
              }).catch(() => {});
            } else {
              updateLocalChat(localConversationId, { model: routing.models.join(", "), combo: true });
            }
            refreshConversations().catch(() => {});
            throw error;
          }
          const settled = kept
            ? `${kept}\n\n_The local run stopped: ${error?.message || "unknown error"}_`
            : "";
          const savedKept = useNativeStore
            ? await appendNativeLocalChatMessage(workspaceOwner, localConversationId, {
                id: assistantId,
                role: "assistant",
                content: settled,
                status: "failed",
                plan: routingSummary,
                createdAt: assistantAt,
                final: true
              }).then(() => true).catch(() => false)
            : settled
              ? await appendConversationMessage(localConversationId, {
                  role: "assistant",
                  content: settled,
                  messageId: assistantId
                }).then(() => true).catch(() => false)
              : true;
          finishLocalRun(localConversationId, {
            status: LOCAL_RUN_STATES.FAILED,
            content: settled,
            error: error?.message || "The local run stopped.",
            saved: savedKept
          });
          if (useNativeStore) {
            await updateNativeLocalChat(workspaceOwner, localConversationId, {
              state: "failed",
              error: error?.message || "The local run stopped.",
              model: routing.models.join(", "),
              combo: true,
              updatedAt: new Date().toISOString()
            }).catch(() => {});
          } else {
            updateLocalChat(localConversationId, { model: routing.models.join(", "), combo: true });
          }
          refreshConversations().catch(() => {});
          throw error;
        }
      }
      if (selectedRow?.local) {
        // A model that runs on this device answers here, not on a server. The
        // message is stored first, exactly like a cloud turn, and the answer
        // arrives in pieces, so the chat shows it as it is written.
        serverOwnedTurnRef.current = true;
        serverOwned = true;
        localRunRef.current = true;
        const localModel = selectedRow.localModel || selectedRow.model;
        const localTask = requestText || text;
        const localTitle = localTask.replace(/\s+/g, " ").trim().slice(0, 60) || "Local chat";
        const localMessages = history.map(entry => ({ role: entry.role, content: entry.content }));
        const continuing =
          Boolean(activeConvId) &&
          (isLocalChat(activeConvId) || isNativeLocalChatId(activeConvId)) &&
          !String(activeConvId).startsWith("local-");
        const useNativeStore =
          nativeLocalChatsAvailable() &&
          Boolean(workspaceOwner) &&
          (!continuing || isNativeLocalChatId(activeConvId));
        const outboxApi = useNativeStore
          ? nativeConversationApi(workspaceOwner)
          : { createConversation, appendConversationMessage };
        if (!useNativeStore) ensureLocalChatsFolder();
        const retriedUser = Array.isArray(retryHistory)
          ? [...retryHistory].reverse().find(message => message?.role === "user")
          : null;
        const savedRowId = retriedUser?.id || userMsg.id;
        let localConversationId = "";
        try {
          const saved = await saveChatMessageFirst({
            createConversation: outboxApi.createConversation,
            appendConversationMessage: outboxApi.appendConversationMessage,
            storage: localBrowserStorage(),
            userId: workspaceOwner,
            conversationId: continuing ? activeConvId : "",
            content: localTask,
            messageId: storedMessageId(retriedUser) || userMsg.id,
            title: localTitle,
            store: useNativeStore ? "local" : "cloud"
          });
          localConversationId = saved.conversationId;
          if (isCurrentRequest(seq)) syncTaskParam(localConversationId);
          upsertConversation({
            id: localConversationId,
            ...(continuing ? {} : { title: localTitle }),
            updatedAt: new Date().toISOString()
          });
          if (useNativeStore) {
            await updateNativeLocalChat(workspaceOwner, localConversationId, {
              ...(continuing ? {} : { title: localTitle }),
              model: localModel,
              combo: false,
              state: "running",
              updatedAt: assistantAt
            });
            await appendNativeLocalChatMessage(workspaceOwner, localConversationId, {
              id: assistantId,
              role: "assistant",
              content: "",
              status: "streaming",
              createdAt: assistantAt
            });
          } else {
            markLocalChat({
              id: localConversationId,
              title: continuing ? "" : localTitle,
              model: localModel
            });
          }
          beginLocalRun({
            conversationId: localConversationId,
            assistantId,
            kind: "model",
            label: localModel,
            controller,
            ownerId: workspaceOwner
          });
          if (localStopRequestedRef.current) controller.abort();
          setMessages(prev => prev.map(message =>
            message.id === savedRowId ? { ...message, messageId: saved.messageId } : message
          ));
          if (String(activeConvId || "").startsWith("local-")) removeTask(activeConvId).catch(() => {});
          refreshConversations().catch(() => {});
        } catch (error) {
          console.error("[local-ai] local chat handoff failed", {
            model: localModel,
            name: error?.name || "Error",
            code: error?.code || "",
            message: error?.message || String(error || "Unknown local chat handoff error"),
            stack: error?.stack || ""
          });
          submissionFailedRef.current = true;
          throw error;
        }
        let localPartial = "";
        let lastNativeSnapshotAt = 0;
        const paintLocalStatus = label => {
          if (!isCurrentRequest(seq)) return;
          setMessages(prev =>
            prev.map(message =>
              message.id === assistantId
                ? { ...message, status: TURN_STATUS.STREAMING, content: `_${label}…_` }
                : message
            )
          );
        };
        try {
          const localTurn = await runLocalAgent({
            model: localModel,
            messages: localMessages,
            task: localTask,
            signal: controller.signal,
            workspaceRoot: sendWorkspace?.path || "",
            executeTool: useDesktopTools
              ? (tool, args) =>
                  executeDesktopTool(tool, args, { operationId: assistantId, chatId: chatScopeId })
              : null,
            callModel: (name, options) => chatLocalModelTurn(name, options),
            onChunk: chunk => {
              localPartial += chunk;
              noteLocalRunStage(localConversationId, localPartial);
              if (useNativeStore) {
                const now = Date.now();
                if (now - lastNativeSnapshotAt >= 800) {
                  lastNativeSnapshotAt = now;
                  appendNativeLocalChatMessage(workspaceOwner, localConversationId, {
                    id: assistantId,
                    role: "assistant",
                    content: localPartial,
                    status: "streaming",
                    createdAt: assistantAt
                  }).catch(() => {});
                }
              }
              if (!isCurrentRequest(seq)) return;
              setMessages(prev => appendTurnChunk(prev, assistantId, chunk));
            },
            onDiscard: () => {
              localPartial = "";
              if (!isCurrentRequest(seq)) return;
              setMessages(prev =>
                prev.map(message =>
                  message.id === assistantId ? { ...message, content: "" } : message
                )
              );
            },
            onToolStart: ({ label }) => paintLocalStatus(label)
          });
          const finalAnswer = String(localTurn.content || "").trim() || localPartial;
          const saveArtifact = inlineRequested
            ? null
            : artifactForTurn({ content: finalAnswer, status: "complete" });
          if (saveArtifact?.files?.length) {
            await persistLocalProjectFiles({
              messageId: assistantId,
              conversationId: localConversationId,
              task: text,
              files: saveArtifact.files,
              submittedAt: assistantAt,
              workspace: sendWorkspace
            });
          }
          const savedAnswer = useNativeStore
            ? await appendNativeLocalChatMessage(workspaceOwner, localConversationId, {
                id: assistantId,
                role: "assistant",
                content: finalAnswer,
                status: "complete",
                createdAt: assistantAt,
                final: true
              }).then(() => true).catch(() => false)
            : await appendConversationMessage(localConversationId, {
                role: "assistant",
                content: finalAnswer,
                messageId: assistantId
              }).then(() => true).catch(() => false);
          finishLocalRun(localConversationId, {
            status: LOCAL_RUN_STATES.DONE,
            content: finalAnswer,
            saved: savedAnswer
          });
          if (useNativeStore) {
            await updateNativeLocalChat(workspaceOwner, localConversationId, {
              state: savedAnswer ? "completed" : "failed",
              error: savedAnswer ? "" : "The answer could not be saved to this Local Chat.",
              model: localModel,
              updatedAt: new Date().toISOString()
            }).catch(() => {});
          } else {
            updateLocalChat(localConversationId, { model: localModel });
          }
          refreshConversations().catch(() => {});
          if (isCurrentRequest(seq)) {
            streamedContent = finalAnswer;
            setMessages(prev => completeTurn(prev, assistantId, {
              content: finalAnswer,
              messageId: assistantId
            }).map(message =>
              message.id === assistantId ? { ...message, local: true } : message
            ));
            if (!savedAnswer) {
              setComposerWarning("The answer is on screen but could not be saved to this Local Chat.");
            }
          }
          return;
        } catch (error) {
          console.error("[local-ai] local run failed", {
            model: localModel,
            name: error?.name || "Error",
            code: error?.code || "",
            message: error?.message || String(error || "Unknown local runtime error"),
            stack: error?.stack || ""
          });
          const stopped = error?.name === "AbortError";
          const settled = localPartial.trim()
            ? stopped
              ? `${localPartial}\n\n_Stopped before the answer finished. The part above was kept._`
              : `${localPartial}\n\n_The local model stopped: ${error?.message || "unknown error"}_`
            : "";
          const savedKept = useNativeStore
            ? await appendNativeLocalChatMessage(workspaceOwner, localConversationId, {
                id: assistantId,
                role: "assistant",
                content: settled,
                status: stopped ? "stopped" : "failed",
                createdAt: assistantAt,
                final: true
              }).then(() => true).catch(() => false)
            : settled
              ? await appendConversationMessage(localConversationId, {
                  role: "assistant",
                  content: settled,
                  messageId: assistantId
                }).then(() => true).catch(() => false)
              : true;
          finishLocalRun(localConversationId, {
            status: stopped ? LOCAL_RUN_STATES.STOPPED : LOCAL_RUN_STATES.FAILED,
            content: settled,
            error: error?.message || "",
            saved: savedKept
          });
          if (useNativeStore) {
            await updateNativeLocalChat(workspaceOwner, localConversationId, {
              state: stopped ? "stopped" : "failed",
              error: stopped ? "" : error?.message || "The local model stopped.",
              model: localModel,
              updatedAt: new Date().toISOString()
            }).catch(() => {});
          } else {
            updateLocalChat(localConversationId, { model: localModel });
          }
          refreshConversations().catch(() => {});
          throw error;
        }
      }
      if (durableChatRun({ prompt, images: imagePayload, nativeTools: useDesktopTools && !selectedRow?.combo })) {
        serverOwnedTurnRef.current = true;
        serverOwned = true;
        const previous = uncertainSubmissionRef.current;
        const key = retryHistory && previous?.conversationId === activeConvId && previous.prompt === prompt
          ? previous.key
          : taskRunSubmissionKey({ conversationId: activeConvId, prompt, nonce: assistantId });
        const submission = { seq, stopRequested: false };
        durableSubmitRef.current = submission;
        let task;
        try {
          // A new chat (no task in URL) or a draft chat (local-* id) has no
          // server-side conversation yet. Create one before submitting so the
          // user's message is persisted to a real conversation and survives
          // navigation or reload.
          let conversationId = activeConvId;
          if (
            !conversationId ||
            String(activeConvId).startsWith("local-") ||
            isNativeLocalChatId(activeConvId)
          ) {
            try {
              const created = await createConversation({
                handoff: requestText || text,
                title: (requestText || text).replace(/\s+/g, " ").trim().slice(0, 60) || "New chat"
              });
              if (created?.id) {
                conversationId = created.id;
                syncTaskParam(conversationId);
              }
            } catch (error) {
              setComposerWarning("Failed to create conversation: " + getApiErrorMessage(error));
              return;
            }
          }

          task = await submitTaskRun({
            ...taskRunRequest({
              prompt,
              conversationId,
              reference,
              model: modelKey,
              mode: DEFAULT_CHAT_MODE,
              temperature: EFFORT_TEMPERATURE[chosenEffort] ?? 0.7,
              workspacePath: sendWorkspace?.path || "",
              images: imagePayload,
              combo: Boolean(selectedRow?.combo),
              pluginTools: true,
              retryUserMessageId
            }),
            idempotencyKey: key
          }, { key });
          if (uncertainSubmissionRef.current?.key === key) uncertainSubmissionRef.current = null;
        } catch (error) {
          if (error.taskSubmissionUncertain) {
            // The screen may have moved on, but this key still names the one
            // attempt that may or may not have reached the server. Losing it
            // would let the next attempt write the same message twice.
            uncertainSubmissionRef.current = { key, conversationId: activeConvId, prompt };
          }
          // The submission itself failed: the message never reached the server,
          // so the composer has to be told to keep the text and the picture.
          submissionFailedRef.current = true;
          throw error;
        } finally {
          if (durableSubmitRef.current === submission) durableSubmitRef.current = null;
        }
        if (submission.stopRequested) {
          await cancelTaskRun(task.taskId).catch(error => {
            if (isCurrentRequest(seq)) setNotice(`Could not stop this message: ${getApiErrorMessage(error)}`);
          });
        }
        // The server wrote the user's message and the conversation before it
        // made the task, so the chat is real from here on. The reader may have
        // already switched to another conversation, and that must not take the
        // new chat with it: the sidebar row and the permanent id belong to the
        // conversation, not to the screen that happened to send the message.
        if (task.conversationId) {
          const named =
            !activeConvId ||
            String(activeConvId).startsWith("local-") ||
            isNativeLocalChatId(activeConvId);
          upsertConversation({
            id: task.conversationId,
            // A chat this send created is named after its first message; an
            // existing chat keeps the name the server already gave it.
            ...(named
              ? {
                  title:
                    (requestText || text).replace(/\s+/g, " ").trim().slice(0, 60) ||
                    (attachmentItems.length > 0 ? "Local file attachment" : "New chat")
                }
              : {}),
            updatedAt: new Date().toISOString()
          });
        }
        refreshConversations().catch(() => {});
        if (!isCurrentRequest(seq)) return;
        const run = taskRunFor(task.taskId, task.conversationId || activeConvId);
        setMessages(previousMessages => previousMessages
          .filter(message => message.id !== run.assistantId)
          .map(message => {
            if (message.id === assistantId) {
              return { ...message, id: run.assistantId, messageId: task.assistantMessageId, conversationId: run.conversationId };
            }
            if (message.id === userMsg.id) return { ...message, messageId: task.userMessageId };
            return message;
          }));
        setTaskRuns(previousRuns => ({ ...previousRuns, [run.taskId]: run }));
        if (String(activeConvId || "").startsWith("local-")) removeTask(activeConvId).catch(() => {});
        syncTaskParam(run.conversationId);
        if (repoScope && run.conversationId) {
          rememberRepoScope(workspaceOwner, run.conversationId, repoScope);
          draftRepoScopeRef.current = null;
        }
        return;
      }
      serverOwnedTurnRef.current = !useDesktopTools && !selectedRow?.combo;
      serverOwned = serverOwnedTurnRef.current;
      let result;
      if (selectedRow?.combo) {
        // Combo requests are text-only, so an attached file is inlined into the
        // prompt rather than quietly dropped by the orchestrator.
        const comboMessages = history.map((entry, index) => ({
          role: entry.role,
          content: index === history.length - 1 ? requestText || entry.content : entry.content
        }));
        startComboRun();
        try {
          result = await runComboTurn({ ...requestOptions, messages: comboMessages, onRunEvent: reportComboEvent });
        } finally {
          endComboRun();
        }
      } else if (useDesktopTools) {
        // Save-first: the message belongs to the conversation before the model
        // runs. Whatever happens to this screen or this request afterwards —
        // switching chats aborts it — the words are already stored, and the
        // same message id makes a retry the same message instead of a copy.
        const retriedUser = Array.isArray(retryHistory)
          ? [...retryHistory].reverse().find(message => message?.role === "user")
          : null;
        const savedRowId = retriedUser?.id || userMsg.id;
        try {
          const saved = await saveChatMessageFirst({
            createConversation,
            appendConversationMessage,
            storage: localBrowserStorage(),
            userId: workspaceOwner,
            conversationId: draftChat ? "" : activeConvId,
            content: requestText || text,
            messageId: storedMessageId(retriedUser) || userMsg.id,
            title: (requestText || text).replace(/\s+/g, " ").trim().slice(0, 60)
          });
          requestOptions.conversationId = saved.conversationId;
          requestOptions.userMessageId = saved.messageId;
          syncTaskParam(saved.conversationId);
          upsertConversation({
            id: saved.conversationId,
            ...(draftChat
              ? { title: (requestText || text).replace(/\s+/g, " ").trim().slice(0, 60) || "New chat" }
              : {}),
            updatedAt: new Date().toISOString()
          });
          refreshConversations().catch(() => {});
          if (String(activeConvId || "").startsWith("local-")) removeTask(activeConvId).catch(() => {});
          setMessages(prev => prev.map(message =>
            message.id === savedRowId ? { ...message, messageId: saved.messageId } : message
          ));
        } catch (error) {
          // Nothing was sent to the model. The device keeps the message in its
          // outbox and the composer gets the text back to try again, so a
          // failed save is a visible, retryable state rather than a lost one.
          submissionFailedRef.current = true;
          throw error;
        }
        try {
          result = await runDesktopToolChat(requestOptions);
        } catch (error) {
          const reason = DESKTOP_TOOL_FALLBACK_REASONS[error?.code];
          if (!reason) throw error;
          if (error.code === "desktop_tools_unavailable") {
            sessionBrowserStorage()?.setItem(DESKTOP_TOOLS_MISSING_KEY, "1");
            setServerLacksToolEndpoint(true);
          }
          // A tool loop can emit text before it fails, and the plain resend
          // re-emits the same answer, so clear the half-written turn first.
          streamedContent = "";
          setMessages((prev) =>
            prev.map((message) =>
              message.id === assistantId ? createAssistantTurn({ id: assistantId }) : message
            )
          );
          if (warnAboutSkippedTools) setComposerWarning(reason);
          // The resend is a plain chat turn: no native tool is left waiting on
          // this request, so the server owns it past the socket.
          serverOwnedTurnRef.current = true;
          serverOwned = true;
          result = await streamChatResponse(requestOptions);
        }
      } else {
        result = await streamChatResponse(requestOptions);
      }
      if (!isCurrentRequest(seq)) return;
      const finalContent =
        typeof result?.content === "string" && result.content.trim() ? result.content : streamedContent;
      const committedArtifact =
        result?.artifact ||
        (inlineRequested ? null : artifactForTurn({ content: finalContent, status: "complete" }));
      setMessages((prev) =>
        completeTurn(prev, assistantId, {
          content: finalContent,
          messageId: result?.messageId,
          artifact: committedArtifact,
          finishReason: result?.finishReason,
          saveWarning: result?.saveWarning ? presentSaveWarning(result.saveWarning.code) : null
        })
      );
      await refreshConversations();
    } catch (error) {
      if (!isCurrentRequest(seq)) return;
      if (error?.name === "AbortError") {
        setMessages((prev) => cancelTurn(prev, assistantId));
        await refreshConversations();
        return;
      }
      const partial = typeof error.partialContent === "string" ? error.partialContent : "";
      // The native tool already read the real data. A model that then refused,
      // went busy or failed must not take that answer down with it, so the turn
      // keeps the local results and still shows the model error honestly.
      const preservedLocal = typeof error.localSummary === "string" ? error.localSummary : "";
      const fallbackContent = partial || preservedLocal;
      if (error.conversationId) syncTaskParam(error.conversationId);
      setMessages((prev) =>
        settleTurnFromError(prev, assistantId, {
          error,
          modelLabel: selectedRow?.name || modelKey,
          content: fallbackContent,
          recoverArtifact: (status) =>
            fallbackContent && !inlineRequested ? artifactFromResponse(fallbackContent, { status }) : null
        }).messages
      );
      await refreshConversations();
      // A message that never reached the server is not a failed answer, it is a
      // message the user still has to send. The composer puts the text and the
      // pictures back so the attempt can be made again.
      if (submissionFailedRef.current) {
        submissionFailedRef.current = false;
        throw error;
      }
    } finally {
      localRunRef.current = false;
      if (isCurrentRequest(seq)) {
        sendingRef.current = false;
        serverOwnedTurnRef.current = false;
        setLoading(false);
        setStreamingId(null);
        if (streamingIdRef.current === assistantId) streamingIdRef.current = null;
        abortRef.current = null;
        refreshUsage();
      } else if (serverOwned) {
        // The screen left this turn running. This resolves when the server
        // really finishes it, which is when the sidebar badge must clear.
        refreshConversations().catch(() => {});
      }
    }
  }

  function handleStop() {
    const submission = durableSubmitRef.current;
    if (submission && isCurrentRequest(submission.seq)) {
      submission.stopRequested = true;
      setNotice("Stopping this message…");
      return;
    }
    const targetId = streamingIdRef.current;
    const run = Object.values(taskRuns).find(candidate => candidate.assistantId === targetId);
    if (run) {
      actOnTaskTurn(run.taskId, "cancel", cancelTaskRun);
      return;
    }
    // A local run is owned by the store, not by this screen: stopping it there
    // aborts the one controller the run itself is waiting on, wherever the
    // reader is now. The branch's own catch persists what was completed.
    const storeRun = getLocalRun(activeConvId);
    if (storeRun?.status === LOCAL_RUN_STATES.RUNNING) {
      const localOperationId = storeRun.assistantId || targetId;
      localStopRequestedRef.current = true;
      stopLocalRun(activeConvId);
      // A native tool waiting on a permission card belongs to this run. Stop has
      // to close that wait too, or the paused call would stay alive with no way
      // to answer it and the run's own catch would never get control back.
      if (nativeShell === NATIVE_SHELLS.windows && localOperationId) {
        cancelDesktopToolOperation(localOperationId).catch(() => {});
      }
      clearApprovals();
      requestSeqRef.current += 1;
      abortRef.current = null;
      localRunRef.current = false;
      sendingRef.current = false;
      serverOwnedTurnRef.current = false;
      streamingIdRef.current = null;
      setLoading(false);
      setStreamingId(null);
      setNotice("Stopped. Answers completed before the stop are kept in this Local Chat.");
      return;
    }
    const hadTurn = Boolean(targetId || sendingRef.current);
    const hadImage = Boolean(imageAbortRef.current);
    const serverOwned = serverOwnedTurnRef.current;
    // A local run never reached the cloud, so Stop must not name a server turn
    // it never created. Its own branch saves whatever completed after the
    // abort, and that is the whole cancellation story it owes the reader.
    const localRun = localRunRef.current;
    localRunRef.current = false;
    if (localRun) localStopRequestedRef.current = true;

    // Invalidate synchronously, before any await: a chunk or tool callback
    // already queued can then never pass the request guard and paint after
    // Stop. This is also what prevents a retry or fallback from starting a
    // second upstream request for a turn the user just cancelled.
    requestSeqRef.current += 1;
    const controller = abortRef.current;
    abortRef.current = null;
    controller?.abort();
    const imageController = imageAbortRef.current;
    imageAbortRef.current = null;
    imageController?.abort();

    if (nativeShell === NATIVE_SHELLS.windows && targetId) {
      // Scoped to this turn: denies its pending approval and signals a running
      // native tool to stop. Other conversations and tabs are untouched.
      cancelDesktopToolOperation(targetId).catch(() => {});
    }
    clearApprovals();
    sendingRef.current = false;
    serverOwnedTurnRef.current = false;
    streamingIdRef.current = null;
    setLoading(false);
    setStreamingId(null);
    setImageGenerating(false);

    if (targetId) {
      setMessages((prev) => cancelTurn(prev, targetId));
      setNotice(
        localRun
          ? "Stopped. Answers completed before the stop were kept in this Local Chat."
          : "Stopped. This turn was cancelled and nothing further will run for it."
      );
      if (serverOwned && !localRun) {
        // Closing this screen's connection is not a Stop, so the turn has to be
        // ended by name on the server or it would keep generating and save an
        // answer the user just cancelled.
        stopChatTurn(targetId).catch(() => {
          setNotice("Stopped here, but the server could not be reached. The answer may still finish and appear when this chat is reopened.");
        });
      }
    } else if (hadImage) {
      setImageError("Image generation was stopped.");
    }
    if (hadTurn) refreshConversations().catch(() => {});
    if (hadTurn || hadImage) refreshUsage();
  }

  const CONTINUE_INSTRUCTION =
    "Continue from exactly where you stopped. Do not repeat any previously generated text — output only the continuation.";

  async function handleContinue(targetId) {
    if (sendingRef.current || loading) return;
    const targetIndex = messages.findIndex((message) => message.id === targetId);
    if (targetIndex === -1) return;
    const target = messages[targetIndex];
    if (!target?.content?.trim()) return;
    if (!target.messageId) {
      setNotice("This older response cannot be continued automatically. Retry the request to generate it again.");
      return;
    }
    if (!canChat) {
      setNotice(
        activeRow?.combo
          ? `Vups Combo AI cannot run yet - ${activeRow.tag || "select its models first"}.`
          : unavailableModelNotice(shared, omniroute)
      );
      return;
    }
    const reference = chatReference(activeRow);
    const modelKey = reference.model;
    if (!modelKey) {
      setNotice("Choose a model in API settings before chatting.");
      return;
    }
    if (!isCloudOnline()) {
      setNotice(
        "You're offline. Continuing this answer needs the cloud model that wrote it, so it is unavailable right now. Local Chats keep working on this device."
      );
      return;
    }
    // Continuing writes into a saved artifact through the single-model route. A
    // Combo run has no such writer yet, so it says so instead of sending a
    // request its own orchestrator would reject.
    if (activeRow?.combo) {
      setNotice("Vups Combo AI answers each message in full. Ask a follow-up in the composer to extend this response.");
      return;
    }

    setNotice("");
    setComposerWarning("");
    const history = requestHistory(messages.slice(0, targetIndex + 1)).slice(-40);
    if (history.length === 0 || history[history.length - 1].role !== "assistant") return;
    if (sendingRef.current) return;
    sendingRef.current = true;
    const activityRunId = generateId();
    const targetArtifact = target.artifact || streamingArtifact(target.content);
    const artifactContinuation = Boolean(targetArtifact);
    const targetFile = targetArtifact?.files?.find(file => file.complete === false)?.path || "";

    setMessages((prev) => {
      const next = beginContinuation(prev, targetId);
      return targetArtifact
        ? next.map((message) =>
            message.id === targetId && !message.artifact ? { ...message, artifact: targetArtifact } : message
          )
        : next;
    });
    setLoading(true);
    setStreamingId(targetId);
    // A continuation is a turn on the same chat route, so it outlives this
    // screen too - and Stop has to be able to name it.
    streamingIdRef.current = targetId;
    serverOwnedTurnRef.current = true;

    const { controller, seq } = beginRequest();
    let continuationText = "";

    try {
      const result = await streamChatResponse({
        conversationId: activeConvId,
        messages: [...history, { role: "user", content: CONTINUE_INSTRUCTION }],
        model: modelKey,
        configId: reference.configId,
        providerId: reference.providerId,
        source: reference.source,
        vups: reference.vups,
        mode: DEFAULT_CHAT_MODE,
        temperature: EFFORT_TEMPERATURE[currentEffort] ?? 0.7,
        signal: controller.signal,
        assistantMessageId: target.messageId,
        continuation: { messageId: target.messageId, ...(targetFile ? { targetFile } : {}) },
        onChunk: (chunk) => {
          if (!isCurrentRequest(seq)) return;
          continuationText += chunk;
          if (artifactContinuation) return;
          setMessages((prev) => appendTurnChunk(prev, targetId, chunk));
        },
        onActivity: (activity) => {
          if (!isCurrentRequest(seq)) return;
          setMessages((prev) =>
            recordTurnActivity(prev, targetId, activity, { runId: activityRunId })
          );
        },
      });
      if (!isCurrentRequest(seq)) return;
      const backendContent = typeof result?.content === "string" ? result.content : "";
      const mergedContent = artifactContinuation
        ? target.content
        : backendContent
          ? backendContent.length >= target.content.length
            ? backendContent
            : mergeTextContinuation(target.content, backendContent)
          : mergeTextContinuation(target.content, continuationText);
      let committedArtifact = result?.artifact || null;
      if (!committedArtifact && artifactContinuation) {
        committedArtifact = continueArtifact(targetArtifact, continuationText || backendContent, targetFile, {
          status: "complete"
        });
      }
      if (!committedArtifact) {
        committedArtifact = artifactForTurn({ content: backendContent || continuationText, status: "complete" });
      }
      setMessages((prev) =>
        completeTurn(prev, targetId, {
          content: mergedContent,
          messageId: result?.messageId,
          artifact: committedArtifact,
          finishReason: result?.finishReason,
          saveWarning: result?.saveWarning ? presentSaveWarning(result.saveWarning.code) : null
        })
      );
      await refreshConversations();
    } catch (error) {
      if (!isCurrentRequest(seq)) return;
      if (error?.name === "AbortError") {
        setMessages((prev) => {
          const withTail =
            artifactContinuation && continuationText.trim()
              ? prev.map((message) =>
                  message.id === targetId
                    ? {
                        ...message,
                        artifact: continueArtifact(targetArtifact, continuationText, targetFile, {
                          status: "partial"
                        })
                      }
                    : message
                )
              : prev;
          return cancelTurn(withTail, targetId);
        });
        await refreshConversations();
        return;
      }
      const partial = typeof error.partialContent === "string" ? error.partialContent : "";
      if (error.conversationId) syncTaskParam(error.conversationId);
      setMessages((prev) =>
        settleTurnFromError(prev, targetId, {
          error,
          modelLabel: activeRow?.name || modelKey,
          content: artifactContinuation ? "" : mergeTextContinuation(target.content, partial || continuationText),
          artifact: error?.artifact || null,
          recoverArtifact: (status) =>
            artifactContinuation
              ? continueArtifact(targetArtifact, continuationText || partial, targetFile, { status })
              : null,
          preferArtifact: artifactContinuation
        }).messages
      );
      await refreshConversations();
    } finally {
      if (isCurrentRequest(seq)) {
        sendingRef.current = false;
        serverOwnedTurnRef.current = false;
        setLoading(false);
        setStreamingId(null);
        if (streamingIdRef.current === targetId) streamingIdRef.current = null;
        abortRef.current = null;
        refreshUsage();
      } else {
        refreshConversations().catch(() => {});
      }
    }
  }

  async function handleRetry() {
    if (sendingRef.current || loading) return;
    const lastUserIdx = messages.map((message) => message.role).lastIndexOf("user");
    if (lastUserIdx === -1) return;
    const lastUser = messages[lastUserIdx];
    const history = messages.slice(0, lastUserIdx + 1);
    const attachments = [...(lastUser.images || []), ...(lastUser.textFiles || [])];
    // The failed turn's user row already has a server id; naming it lets the
    // retry run against the same prompt row instead of storing it a second time.
    const retryUserMessageId = typeof lastUser.messageId === "string" ? lastUser.messageId : "";
    // Live attachments still carry their data URLs, so a retry resends the
    // image; attachments restored from history (metadata only) fall back to
    // a text-only retry rather than failing.
    handleSend(lastUser.content, history, { attachments, retryUserMessageId });
  }

  return (
    <>
      <main className="vr-chat-main" id="main-content">
        <header className="vr-chat-header" aria-live="polite">
          <span className="vr-chat-header__dot" aria-hidden="true" />
          <span className="vr-chat-header__label">Chatting with</span>
          <strong className="vr-chat-header__model">{activeRow?.name || "No model selected"}</strong>
          {activeRow && !activeRow.shared && !activeRow.vups ? (
            <span className="vr-chat-header__provider">{activeRow.combo ? "Apex" : activeRow.provider}</span>
          ) : null}
          {nativeWorkspaces ? (
            <div className="vr-header-project">
              {chatWorkspace ? (
                <>
                  <button
                    type="button"
                    className="vr-header-workspace"
                    onClick={() => setWorkspacePickerOpen(true)}
                    disabled={loading}
                    title={`Files in ${chatWorkspace.path}`}
                    aria-label={`Files in ${chatWorkspace.title}, ${chatWorkspace.path}`}
                  >
                    <FolderSimple size={13} aria-hidden="true" />
                    <span className="vr-header-project__name">{chatWorkspace.title}</span>
                    <span className="vr-header-project__path">{chatWorkspace.path}</span>
                  </button>
                  <button
                    type="button"
                    className="vr-header-project__change"
                    onClick={changeChatProject}
                    disabled={loading}
                    title="Change the project folder for this chat"
                  >
                    Change
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="vr-header-workspace vr-header-workspace--empty"
                  onClick={changeChatProject}
                  disabled={loading || workspacesLoading}
                  title={
                    missingBoundWorkspace
                      ? "This chat's project folder is unavailable. Choose another folder."
                      : "Choose the project folder this chat works in."
                  }
                >
                  <FolderSimple size={13} aria-hidden="true" />
                  {missingBoundWorkspace
                    ? "Project unavailable"
                    : workspacesLoading
                      ? "Loading project…"
                      : "Choose project folder"}
                </button>
              )}
            </div>
          ) : null}
          {nativeShell === NATIVE_SHELLS.windows ? (
            <button
              type="button"
              className="vr-header-tool-status"
              onClick={() => setToolAccessOpen(true)}
              aria-label="Tool access status"
              title="Tool access status"
            >
              <Wrench size={13} aria-hidden="true" />
              <span>Tools</span>
            </button>
          ) : null}
        </header>
        {messages.length === 0 ? (
          <WelcomeScreen
            configured={canChat}
            modelName={activeRow?.name || ""}
            sharedActive={activeIsShared}
            gatewayActive={activeIsGateway}
            vupsActive={activeIsVups}
            sharedLoading={shared === null && omniroute === null && !config?.configured}
            onStarter={text => setDraftInsertion({ text, key: Date.now() })}
          />
        ) : (
          <MessageList
            messages={messages}
            streamingId={streamingId}
            loading={loading}
            conversationId={activeConvId || ""}
            workspacePath={chatWorkspace?.path || ""}
            permissionLabel={localAccessLabel}
            liveTaskTurnIds={liveTaskTurnIds}
            taskPanelFor={taskPanelFor}
            projectSaves={projectSaves}
            nativeWindows={nativeShell === NATIVE_SHELLS.windows}
            onProjectSave={retryProjectSave}
            onProjectSaveChooseFolder={chooseProjectFolderForSave}
            onRetry={handleRetry}
            onContinue={handleContinue}
            onSwitchModel={() => setOpenModelSignal((value) => value + 1)}
            onOpenSettings={() => navigate("/settings")}
            onContinueNewChat={handleContinueInNewChat}
            contextHandoffState={handoffState}
          />
        )}

        {approvalRequests.length > 0 ? (
          <div className="vr-permission-slot" aria-live="polite">
            {approvalRequests.map((request) => (
              <InChatPermissionCard
                key={request.requestId}
                request={request}
                busy={approvalBusyId === request.requestId}
                error={approvalBusyId === request.requestId ? "" : approvalError}
                onRespond={(decision) => handleApprovalRespond(request.requestId, decision)}
              />
            ))}
          </div>
        ) : null}

        <footer className="vr-composer" role="region" aria-label="Chat composer">
          {(imageGenerating || generatedImage || imageError) && (
            <section className="vr-image-gen" aria-live="polite" aria-label="Image generation">
              {imageGenerating ? (
                <div className="vr-image-gen__loading">
                  <span className="vr-image-gen__spinner" aria-hidden="true" />
                  <span>Generating image with Cloudflare Workers AI...</span>
                </div>
              ) : imageError ? (
                <div className="vr-image-gen__error" role="alert">
                  <Warning size={15} weight="fill" aria-hidden="true" />
                  <span>{imageError}</span>
                  <button type="button" onClick={() => setImageError("")}>Dismiss</button>
                </div>
              ) : (
                <div className="vr-image-gen__result">
                  <img src={generatedImage.image} alt={`Generated image: ${generatedImage.prompt}`} />
                  <div className="vr-image-gen__details">
                    <span className="vr-image-gen__eyebrow">
                      <ImageIcon size={14} aria-hidden="true" /> Generated image
                    </span>
                    <p>{generatedImage.prompt}</p>
                    <div className="vr-image-gen__actions">
                      <a
                        href={generatedImage.image}
                        download={`vups-generated-${Date.now()}.${imageExtension(generatedImage.mimeType)}`}
                      >
                        Download
                      </a>
                      <button type="button" onClick={() => setGeneratedImage(null)}>Dismiss</button>
                    </div>
                  </div>
                </div>
              )}
            </section>
          )}
          {!online && !activeRow?.local && (
            <div className="vr-notice" role="status">
              <Warning size={15} weight="fill" aria-hidden="true" />
              <span>
                Offline. Installed local models and Combined Local AI still run on this device; cloud models are
                unavailable.
              </span>
              <Link to="/local-ai">Open Local AI</Link>
            </div>
          )}
          {composerWarning && (
            <div className="vr-notice" role="alert">
              <Warning size={15} weight="fill" aria-hidden="true" />
              <span>{composerWarning}</span>
            </div>
          )}
          {workspaceProvisionError ? (
            <div className="vr-notice" role="alert">
              <Warning size={15} weight="fill" aria-hidden="true" />
              <span>{workspaceProvisionError}</span>
              <Link to="/app-settings">Project folder settings</Link>
            </div>
          ) : null}
          {notice && (
            <div className="vr-notice" role="alert">
              <Warning size={15} weight="fill" aria-hidden="true" />
              <span>{notice}</span>
              <Link to="/settings">Open API settings</Link>
            </div>
          )}
          {!canChat && !notice && !composerWarning && (
            <div className="vr-notice" role="alert">
              <Warning size={15} weight="fill" aria-hidden="true" />
              <span>{unavailableModelNotice(shared, omniroute)}</span>
              <Link to="/settings">Open API settings</Link>
            </div>
          )}
          {repoScope ? (
            <div className="vr-chat-repo">
              <span className="vr-chat-repo__icon" aria-hidden="true"><GithubLogo size={16} weight="fill" /></span>
              <span className="vr-chat-repo__copy">
                <strong title={repoScope.url || ""}>{repoLabel(repoScope)}</strong>
                <span>
                  {`Branch: ${repoScope.branch || repoScope.defaultBranch || "its default branch"} · this chat's GitHub scope`}
                </span>
              </span>
              <button type="button" onClick={() => setRepoBrowserOpen(true)} disabled={loading}>
                Change
              </button>
              <button type="button" onClick={clearRepoScope} disabled={loading}>
                Remove
              </button>
            </div>
          ) : null}
          <div className="vr-prompt-bar-wrap">
            <PromptBar
              placeholder={
                !canChat
                  ? activeIsCombo
                    ? activeRow?.tag || "Vups Combo AI is not ready"
                    : shared === null && omniroute === null
                      ? "Checking for an available AI model..."
                      : "No AI model available - connect a provider in API settings..."
                  : activeIsCombo
                    ? "Message Vups Combo AI..."
                    : activeIsVups
                      ? `Ask ${activeRow?.name || "Vups v3 Galax"} anything...`
                      : activeIsShared
                        ? "Ask anything - using the shared model..."
                        : activeIsGateway
                          ? "Ask anything - using the OmniRoute gateway..."
                          : "Ask anything - your provider, your key, your model..."
              }
              models={catalog}
              commands={COMPOSER_COMMANDS}
              defaultModel={activeModelKey}
              onModelChange={changeModel}
              onDeleteModel={requestDeleteModel}
              onAddKey={() => navigate("/settings")}
              openModelSignal={openModelSignal}
              efforts={VUPS_EFFORTS}
              defaultEffort={currentEffort}
              onEffortChange={(effort) => setCurrentEffort(effort)}
              busy={loading || imageGenerating}
              generating={imageGenerating}
              onSend={(text, meta) => handleSend(text, null, meta, provisionedWorkspaceRef.current)}
              beforeSend={beforeComposerSend}
              onStop={handleStop}
              onGenerateImage={handleGenerateImage}
              onAttach={pickAttachments}
              onPickFolder={
                nativeShell === NATIVE_SHELLS.windows ? pickFolderAttachments : undefined
              }
              onReleaseFolder={releaseFolderAttachment}
              onPrepareAttachments={prepareComposerAttachments}
              onRetryAttachment={retryComposerAttachment}
              onDictate={handleDictate}
              attachmentMode={nativeShell ? "native" : "images"}
              attachmentAccept={
                nativeShell ? NATIVE_ATTACHMENT_ACCEPT_ATTR : ACCEPTED_IMAGE_ACCEPT_ATTR
              }
              showCamera={nativeShell === NATIVE_SHELLS.android}
              permissionControl={
                nativeShell === NATIVE_SHELLS.windows ? (
                  <NativeChatControls
                    mode={permissionMode}
                    disabled={loading || permissionApplying}
                    applying={permissionApplying}
                    bridgeError={nativeToolBridgeError}
                    notice={permissionNotice}
                    onChange={changeWindowsPermissionMode}
                  />
                ) : null
              }
              sendWithModifier={preferences.sendShortcut === "modifier"}
              externalFiles={workspaceAttachment?.files}
              externalFilesSignal={workspaceAttachment?.key}
              draftValue={draftInsertion?.text}
              draftSignal={draftInsertion?.key}
              background="var(--bg)"
              color="var(--text)"
              menuBackground="var(--bg)"
              sparkColor="var(--accent)"
              width="100%"
              radius={16}
              maxRows={6}
              className="vr-prompt-bar"
            />
            <p className="vr-composer-hint">
              {nativeShell === NATIVE_SHELLS.windows
                ? `${preferences.sendShortcut === "modifier" ? "Ctrl+Enter" : "Enter"} to send \u00b7 Shift+Enter for newline \u00b7 File contents stay local until you send \u00b7 / lists commands`
                : nativeShell === NATIVE_SHELLS.android
                  ? `${preferences.sendShortcut === "modifier" ? "Ctrl+Enter" : "Enter"} to send \u00b7 Shift+Enter for newline \u00b7 Camera and files open only when you tap them \u00b7 / lists commands`
                  : `${preferences.sendShortcut === "modifier" ? "Ctrl+Enter" : "Enter"} to send \u00b7 Shift+Enter for newline \u00b7 Attach images with the paperclip \u00b7 / lists commands`}
            </p>
          </div>
        </footer>
      </main>
      <GitHubRepoBrowser
        open={repoBrowserOpen}
        initialRepo={repoBrowserTarget}
        onClose={closeRepoBrowser}
        onScope={scopeRepo}
        onManage={() => {
          closeRepoBrowser();
          navigate("/plugins");
        }}
      />
      {fullAccessPending ? (
        <NativePermissionDialog
          title="Enable full access?"
          description="The assistant may read, create, edit, rename, move, copy and delete files, launch apps, open files and links, and run PowerShell or cmd commands without a card for each ordinary action. Protected and sensitive Windows locations, force-terminating an app, and administrator rights still ask or stay blocked, and every action is audited."
          confirmLabel="Enable full access"
          tone="danger"
          onCancel={() => setFullAccessPending(false)}
          onConfirm={() => {
            applyPermissionMode("full");
            setFullAccessPending(false);
          }}
        />
      ) : null}
      <WorkspaceFilesDialog
        open={workspacePickerOpen}
        workspace={chatWorkspace}
        onClose={() => setWorkspacePickerOpen(false)}
        onAttach={files => setWorkspaceAttachment({ files, key: Date.now() })}
      />
      <ToolAccessDialog
        open={toolAccessOpen}
        onClose={() => setToolAccessOpen(false)}
        status={{
          windowsShell: nativeShell === NATIVE_SHELLS.windows,
          tauriAvailable: isTauriRuntime(),
          serverToolEndpoint: !serverLacksToolEndpoint,
          model: activeRow?.name || "",
          provider: activeRow?.provider || "",
          permissionMode,
          workspace: chatWorkspace,
          bridgeError: nativeToolBridgeError,
          waitingApprovals: approvalRequests.length
        }}
      />
      <HoldToDeleteDialog
        open={Boolean(deleteModelTarget)}
        title="Delete saved provider configuration?"
        itemName={
          deleteModelTarget
            ? deleteModelTarget.apiKeyMasked
              ? `${deleteModelTarget.provider} (${deleteModelTarget.apiKeyMasked})`
              : deleteModelTarget.provider
            : ""
        }
        description="This removes the saved API key and model list for this provider. Your other saved keys are not affected."
        successMessage="Provider configuration removed."
        onCancel={() => setDeleteModelTarget(null)}
        onConfirm={deleteSavedModel}
      />
    </>
  );
}
