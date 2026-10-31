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
  loadPermissionMode,
  savePermissionMode,
} from "./native/permissions.js";
import AgentActivity from "./components/AgentActivity.jsx";
import GeneratedFiles from "./components/GeneratedFiles.jsx";
import ContextLimitNotice, {
  ApiKeyNotice,
  ContextHandoffCard,
  RequestBlockedNotice
} from "./components/ContextLimitNotice.jsx";
import VupsLogo from "./components/VupsLogo.jsx";
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
import { downloadBlob } from "./chat/downloads.js";
import { collapseMessageText } from "./chat/messageText.js";
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
import { streamChatResponse } from "./services/chat.js";
import { runDesktopToolChat } from "./services/desktopChat.js";
import {
  cancelDesktopToolApprovals,
  cancelDesktopToolOperation,
  onDesktopToolApproval,
  respondDesktopToolApproval,
  setDesktopToolPolicy
} from "./native/desktopTools.js";
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
  hasRecoverableOutput,
  markTurnMeta,
  recordTurnActivity,
  sanitizeHistoryMessages,
  TURN_STATUS
} from "./chat/turnLifecycle.js";
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
  createConversation,
  fetchFreeModels,
  fetchProviderConfig,
  fetchOmniRouteStatus,
  fetchProviderModels,
  fetchSharedModelStatus,
  fetchConversationArtifacts,
  generateImage,
  getApiErrorMessage,
  getConversation,
  isConversationCreateUnavailable,
  removeProvider,
  saveMessageFeedback,
} from "./services/api.js";
import {
  createContinuationGuard,
  prepareContinuation
} from "./chat/continuation.js";
import { usePreferences } from "./desktop/PreferencesContext.jsx";
import { useTasks } from "./desktop/TaskContext.jsx";
import { useWorkspaces } from "./desktop/WorkspaceContext.jsx";
import WorkspaceFilesDialog from "./desktop/WorkspaceFilesDialog.jsx";
import "./chat.css";

// â”€â”€â”€ Chat configuration â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const VUPS_EFFORTS = ["Precise", "Balanced", "Creative"];
const EFFORT_TEMPERATURE = { Precise: 0.3, Balanced: 0.7, Creative: 1.0 };
// Mirrors the server's per-message cap so folder text is not rejected earlier
// on the client than the backend that accepts it.
const MAX_USER_MESSAGE_CHARS = 2_000_000;
const USER_MESSAGE_LIMIT_WARNING = `That message and its attached text are too long. Keep the total under ${MAX_USER_MESSAGE_CHARS.toLocaleString("en-US")} characters.`;
const CHAT_MODE_STORAGE_KEY = "vupsrouter.chat.mode";
const VUPS_MODES = [
  { key: "general", name: "General", description: "Everyday answers, research, and coding help" },
  { key: "motion", name: "Motion Design", description: "Animation engineering, GSAP, and visual implementation" }
];

function loadChatMode() {
  if (typeof window === "undefined") return "general";
  try {
    const stored = window.localStorage.getItem(CHAT_MODE_STORAGE_KEY);
    return stored === "motion" ? "motion" : "general";
  } catch {
    return "general";
  }
}

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
// permission by itself, so losing or clearing it can only cause a re-ask.
const CHAT_SCOPE_STORAGE_PREFIX = "vupsrouter.desktop.chat-scope.v1";
const CHAT_SCOPE_LIMIT = 200;

function newChatScopeId() {
  return `chat_scope_${generateId()}${generateId()}`;
}

function chatScopeStorageKey(owner) {
  return `${CHAT_SCOPE_STORAGE_PREFIX}.${owner || "guest"}`;
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

function toLocalMessage(message, artifactMap = null) {
  const images = Array.isArray(message.attachments)
    ? message.attachments.map((attachment) => ({
        id: generateAttachmentId(),
        name: attachment.name || "image",
        mimeType: attachment.mimeType,
        bytes: attachment.bytes,
      }))
    : [];
  const storedArtifact = artifactMap?.get(message.messageId) || null;
  const artifact =
    storedArtifact ||
    (message.role === "assistant" && message.content ? artifactFromResponse(message.content) : null);
  const handoff =
    message.role === "user" && isContextHandoffContent(message.content)
      ? { goal: contextHandoffGoal(message.content) }
      : null;
  return {
    id: generateId(),
    role: message.role,
    content: message.content,
    status: artifact && artifact.status !== "complete" ? TURN_STATUS.INTERRUPTED : TURN_STATUS.COMPLETED,
    error: null,
    saveWarning: null,
    truncated: null,
    ...(message.messageId ? { messageId: message.messageId } : {}),
    ...(message.feedback === "like" || message.feedback === "dislike"
      ? { feedback: message.feedback }
      : {}),
    ...(artifact ? { artifact } : {}),
    ...(handoff ? { handoff } : {}),
    ...(images.length > 0 ? { images } : {}),
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

// Only the final message may carry images — the backend rejects attachments
// on earlier messages, so trimmed history stays text-only.
function requestHistory(messages) {
  const filtered = sanitizeHistoryMessages(messages);
  return filtered.map((message, index) => {
    const entry = { role: message.role, content: message.content };
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
  onRetry,
  onContinue,
  onSwitchModel,
  onOpenSettings,
  onContinueNewChat,
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
      {!isUser && (
        <div className="vr-msg-avatar" aria-hidden="true">
          <VupsLogo />
        </div>
      )}
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
            {artifact && !isStreaming ? <GeneratedFiles artifact={artifact} /> : null}
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
        <div className="vr-welcome-art" aria-hidden="true">
          <div className="vr-welcome-ring ring-outer" />
          <div className="vr-welcome-ring ring-inner" />
          <div className="vr-welcome-icon">
            <VupsLogo />
          </div>
        </div>
        <p className="vr-welcome-eyebrow">VupsRouter workspace</p>
        <h1 className="vr-welcome-title">
          VupsRouter <span>AI</span>
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
        {configured && onStarter ? (
          <section className="vr-welcome-start" aria-label="Starting points">
            <p className="vr-welcome-start-label">
              Start with a prompt. It fills the message box, and nothing is sent until you press Enter.
            </p>
            <div className="vr-welcome-starters">
              {STARTER_PROMPTS.map(item => (
                <button
                  key={item.title}
                  type="button"
                  className="vr-welcome-starter"
                  onClick={() => onStarter(item.prompt)}
                >
                  <span className="vr-welcome-starter-title">{item.title}</span>
                  <span className="vr-welcome-starter-hint">{item.hint}</span>
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
  onRetry,
  onContinue,
  onSwitchModel,
  onOpenSettings,
  onContinueNewChat,
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
            isStreaming={msg.id === streamingId}
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
    saveLocalChat,
    getLocalChat,
    removeTask,
    draftRequest,
    refreshUsage
  } = useTasks();
  const { preferences } = usePreferences();
  const { activeWorkspace, workspaces, owner: workspaceOwner, workspaceForChat, bindChatWorkspace } = useWorkspaces();
  const activeConvId = searchParams.get("task") || "";
  // A local task has not reached the server yet, so it still counts as a draft
  // for choosing an initial folder; a saved chat keeps only its own binding.
  const draftChat = !activeConvId || String(activeConvId).startsWith("local-");
  const [chatScope, setChatScope] = useState("");
  // A chat owns its folder. Only a draft may start from the folder selected in
  // the app; a saved chat never borrows another chat's workspace.
  const boundChatWorkspace = chatScope ? workspaceForChat(chatScope) : null;
  const chatWorkspace = boundChatWorkspace || (draftChat ? activeWorkspace : null);

  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(false);
  const [streamingId, setStreamingId] = useState(null);
  const [config, setConfig] = useState(null);
  const [providerModels, setProviderModels] = useState([]);
  const [shared, setShared] = useState(null);
  const [omniroute, setOmniroute] = useState(null);
  const [selection, setSelection] = useState(null);
  const [catalogReady, setCatalogReady] = useState(false);
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
  const [chatMode, setChatMode] = useState(loadChatMode);
  const [nativeShell] = useState(() => detectNativeShell());
  const [permissionMode, setPermissionMode] = useState(
    () => loadPermissionMode(localBrowserStorage()) || DEFAULT_PERMISSION_MODE
  );
  const [approvalRequests, setApprovalRequests] = useState([]);
  const [approvalBusyId, setApprovalBusyId] = useState("");
  const [approvalError, setApprovalError] = useState("");
  const seenApprovalKeys = useRef(new Set());
  const streamingIdRef = useRef(null);
  const activityRunIdRef = useRef("run");
  const [nativeToolBridgeError, setNativeToolBridgeError] = useState("");
  const [fullAccessPending, setFullAccessPending] = useState(false);
  const [permissionApplying, setPermissionApplying] = useState(false);
  const policySyncRef = useRef("");
  const [workspacePickerOpen, setWorkspacePickerOpen] = useState(false);
  const [toolAccessOpen, setToolAccessOpen] = useState(false);
  const [workspaceAttachment, setWorkspaceAttachment] = useState(null);
  const [draftInsertion, setDraftInsertion] = useState(null);
  const abortRef = useRef(null);
  const imageAbortRef = useRef(null);
  const sendingRef = useRef(false);
  const initializedRef = useRef(false);
  const requestSeqRef = useRef(0);
  const loadedTaskRef = useRef("");
  // A brand-new chat has no id yet; this scope id is remapped to the server's
  // conversation id as soon as the first answer reports it.
  const draftChatScopeRef = useRef("");
  const continuationGuardRef = useRef(null);
  if (!continuationGuardRef.current) continuationGuardRef.current = createContinuationGuard();
  const [handoffState, setHandoffState] = useState({
    status: "idle",
    sourceId: null,
    error: ""
  });

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
    if (!draftRequest) return;
    setDraftInsertion({ text: draftRequest.text, key: draftRequest.key });
  }, [draftRequest]);

  useEffect(() => {
    if (nativeShell !== NATIVE_SHELLS.windows || !workspaceOwner) return;
    let cancelled = false;
    const signature = `${workspaceOwner}|${permissionMode}|${
      permissionMode === "workspace" ? chatWorkspace?.id || "" : ""
    }`;
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
      workspaceId: permissionMode === "workspace" ? chatWorkspace?.id || null : null
    }).then(() => {
      if (!cancelled) setNativeToolBridgeError("");
    }).catch(error => {
      // The mode lives in localStorage, so the selector would otherwise keep
      // showing "Full access" while the native bridge silently refuses it.
      if (!cancelled) setNativeToolBridgeError(error?.message || "The Windows desktop tool bridge is unavailable.");
    });
    return () => {
      cancelled = true;
    };
  }, [nativeShell, workspaceOwner, permissionMode, chatWorkspace?.id]);

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
    controller?.abort();
    const operationId = streamingIdRef.current;
    if (operationId && nativeShell === NATIVE_SHELLS.windows) {
      cancelDesktopToolOperation(operationId).catch(() => {});
    }
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
      cancelDesktopToolApprovals().catch(() => {});
      clearApprovals();
    }
    setNotice("");
    setComposerWarning("");
    setGeneratedImage(null);
    setImageError("");
    if (String(id).startsWith("local-")) {
      const local = getLocalChat(id);
      setMessages(local ? local.messages : []);
      if (!local) setNotice("This local task is no longer available.");
      return;
    }
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
      setMessages(
        conversation.messages
          .filter(
            message =>
              message.role !== "assistant" ||
              String(message.content || "").trim() ||
              artifactMap.has(message.messageId)
          )
          .map(message => toLocalMessage(message, artifactMap))
      );
    } catch (error) {
      if (loadedTaskRef.current !== id) return;
      setNotice(getApiErrorMessage(error));
    }
  }

  useEffect(() => {
    if (loadedTaskRef.current === activeConvId) return;
    loadedTaskRef.current = activeConvId;
    if (activeConvId) loadTask(activeConvId);
    else resetConversation();
  }, [activeConvId]);

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
    if (initializedRef.current) return;
    initializedRef.current = true;
    fetchFreeModels()
      .then((freeData) => {
        setFreeCatalog(freeData?.catalog || null);
        if (freeData?.modelType === FREE_MODEL_TYPE || freeData?.modelType === CUSTOM_MODEL_TYPE) {
          setModelType(freeData.modelType);
        }
      })
      .catch(() => {})
      .finally(() => setFreeCatalogSettled(true));
    Promise.all([
      fetchProviderConfig(),
      fetchSharedModelStatus().catch(() => null),
      fetchOmniRouteStatus().catch(() => null),
    ])
      .then(([stored, sharedStatus, gatewayStatus]) => {
        setConfig(stored);
        setShared(sharedStatus);
        setOmniroute(gatewayStatus);
        // fetchProviderConfig() resolves to data.config, which carries no
        // modelType; the preference comes from fetchFreeModels() above.
        return fetchProviderModels()
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
  }, [refreshConversations]);

  const catalog = useMemo(
    () => buildCatalog({ models: providerModels, shared, omniroute, vups: true, modelType, freeCatalog }),
    [providerModels, shared, omniroute, modelType, freeCatalog]
  );

  useEffect(() => {
    if (!catalogReady || catalog.length === 0) return;
    if (modelType === FREE_MODEL_TYPE && !freeCatalogSettled) return;
    const restored = resolveSelection(catalog, loadStoredSelection()) || fallbackRow(catalog);
    if (!restored) return;
    const next = selectionFromRow(restored);
    setSelection((current) => {
      const currentKey = resolveSelection(catalog, current)?.key || "";
      if (currentKey === restored.key) return current;
      saveStoredSelection(next);
      return next;
    });
  }, [catalog, catalogReady, modelType, freeCatalogSettled]);

  const activeRow = resolveSelection(catalog, selection) || fallbackRow(catalog);
  const activeModelKey = activeRow?.key || "";
  const canChat = Boolean(activeRow && !activeRow.disabled);
  const activeIsShared = Boolean(activeRow?.shared);
  const activeIsGateway = Boolean(activeRow?.gateway);
  const activeIsVups = Boolean(activeRow?.vups);

  function changeModel(row) {
    const next = selectionFromRow(row);
    if (!next) return;
    setSelection(next);
    saveStoredSelection(next);
  }

  function changeChatMode(mode) {
    if (mode !== "general" && mode !== "motion") return;
    setChatMode(mode);
    try {
      window.localStorage.setItem(CHAT_MODE_STORAGE_KEY, mode);
    } catch {
      /* storage is best-effort */
    }
  }

  // The selector only moves after the native layer has adopted the mode, so a
  // drawer that says "Agent (workspace)" can never sit on top of a Full access
  // policy. Saved grants survive; one-time approvals from the old mode do not.
  async function applyPermissionMode(mode) {
    if (!isPermissionMode(mode)) return false;
    if (nativeShell === NATIVE_SHELLS.windows && workspaceOwner) {
      setPermissionApplying(true);
      try {
        await setDesktopToolPolicy({
          owner: workspaceOwner,
          mode,
          workspaceId: mode === "workspace" ? chatWorkspace?.id || null : null
        });
        setNativeToolBridgeError("");
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
    setPermissionMode(savePermissionMode(localBrowserStorage(), mode));
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
      if (!activeOperation || (prompt.operationId && prompt.operationId !== activeOperation)) {
        respondDesktopToolApproval(prompt.requestId, "deny").catch(() => {});
        return;
      }
      if (seenApprovalKeys.current.has(prompt.approvalKey)) return;
      seenApprovalKeys.current.add(prompt.approvalKey);
      setApprovalError("");
      setApprovalRequests((prev) =>
        prev.some((entry) => entry.requestId === prompt.requestId) ? prev : [...prev, prompt]
      );
      const targetId = streamingIdRef.current;
      if (targetId) {
        setMessages((prev) =>
          recordTurnActivity(
            prev,
            targetId,
            {
              phase: "desktop_tool",
              message: `Waiting for approval to read ${prompt.scopeName || "a folder"}`
            },
            { runId: activityRunIdRef.current }
          )
        );
      }
    });
  }, [nativeShell]);

  useEffect(() => {
    return () => {
      seenApprovalKeys.current.clear();
      setApprovalRequests([]);
    };
  }, []);

  function forgetApproval(request) {
    if (!request) return;
    seenApprovalKeys.current.delete(request.approvalKey || request.requestId);
    setApprovalRequests((prev) => prev.filter((entry) => entry.requestId !== request.requestId));
  }

  async function handleApprovalRespond(requestId, decision) {
    const request = approvalRequests.find((entry) => entry.requestId === requestId) || { requestId };
    setApprovalBusyId(requestId);
    setApprovalError("");
    try {
      await respondDesktopToolApproval(requestId, decision);
      forgetApproval(request);
      const targetId = streamingIdRef.current;
      if (targetId) {
        setMessages((prev) =>
          recordTurnActivity(
            prev,
            targetId,
            {
              phase: "desktop_tool",
              message:
                decision === "deny"
                  ? "Denied — the blocked file operation was cancelled"
                  : `Access granted — ${request.summary || "resuming the local operation"}`
            },
            { runId: activityRunIdRef.current }
          )
        );
      }
    } catch (error) {
      const message = error?.message || "That permission request could not be delivered.";
      // The native request already expired or was answered elsewhere, so keeping
      // the card up would only offer a decision that can no longer be made.
      if (/already|expired|unknown|not pending/i.test(message)) forgetApproval(request);
      else setApprovalError(message);
    } finally {
      setApprovalBusyId("");
    }
  }

  function clearApprovals() {
    seenApprovalKeys.current.clear();
    setApprovalRequests([]);
    setApprovalBusyId("");
    setApprovalError("");
  }

  async function beforeComposerSend(text, attachments, meta) {
    if (!canSubmitComposer(text, attachments)) return false;
    const images = (Array.isArray(attachments) ? attachments : []).filter(
      (item) => item && typeof item === "object" && typeof item.dataUrl === "string"
    );
    if (images.length === 0) return true;
    const selectedRow =
      catalog.find((row) => row.key === meta?.model?.key) || meta?.model || activeRow;
    if (selectedRow?.vision !== false) return true;
    const label = chatReference(selectedRow).model || selectedRow?.name || "this model";
    setComposerWarning(
      `The selected model (${label}) does not accept images. Choose a vision-capable model in API settings.`
    );
    return false;
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
    fetchProviderModels()
      .then((models) => setProviderModels(models))
      .catch(() => {});
  }

  function resetConversation() {
    invalidateInFlight();
    // A new chat is a new approval scope and a new workspace decision; the
    // previous chat's remembered answers and folder must not follow it.
    draftChatScopeRef.current = newChatScopeId();
    setChatScope(draftChatScopeRef.current);
    setMessages([]);
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

  async function handleSend(text, retryHistory, meta) {
    const rawAttachments = Array.isArray(meta?.attachments) ? meta.attachments : [];
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

    if (!canChat) {
      setNotice(unavailableModelNotice(shared, omniroute));
      return;
    }

    const selectedRow = catalog.find((row) => row.key === meta?.model?.key) || meta?.model || activeRow;
    const reference = chatReference(selectedRow);
    const modelKey = reference.model;
    if (!modelKey) {
      setNotice("Choose a model in API settings before chatting.");
      return;
    }

    if (imagePayload.length > 0 && selectedRow?.vision === false) {
      setNotice(
        `The selected model (${modelKey}) does not accept images. Choose a vision-capable model in API settings.`
      );
      return;
    }

    if (sendingRef.current) return;
    sendingRef.current = true;
    if (nativeShell === NATIVE_SHELLS.windows && workspaceOwner) {
      try {
        await setDesktopToolPolicy({
          owner: workspaceOwner,
          mode: permissionMode,
          workspaceId: permissionMode === "workspace" ? chatWorkspace?.id || null : null
        });
      } catch (error) {
        sendingRef.current = false;
        const message = error?.message || "Could not update the Windows filesystem permission mode.";
        setNativeToolBridgeError(message);
        setNotice(message);
        return;
      }
    }
    setNotice("");
    setComposerWarning("");
    const chosenEffort = meta?.effort || currentEffort;
    const userMsg = {
      id: generateId(),
      role: "user",
      content: text,
      ...(imageItems.length > 0 ? { images: imageItems } : {}),
      ...(textFiles.length > 0 ? { textFiles } : {}),
    };
    const baseMessages = retryHistory ?? [...messages, userMsg];
    const history = requestHistory(baseMessages).slice(-40);
    const assistantId = generateId();
    const activityRunId = generateId();

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

    const useDesktopTools =
      nativeShell === NATIVE_SHELLS.windows &&
      Boolean(workspaceOwner) &&
      imagePayload.length === 0 &&
      !serverLacksToolEndpoint;
    // Local tools are a bonus on a plain question but the whole point of the
    // turn once a project folder is picked, so only the second case owes the
    // user an explanation when the server cannot run them.
    const warnAboutSkippedTools = Boolean(chatWorkspace?.id);
    // "Allow Always" answers are scoped to this chat and kept in native memory.
    const chatScopeId = useDesktopTools ? currentChatScope() : "";
    // A draft chat inherits the folder selected in the app; that choice becomes
    // this chat's own before the first local tool call, and the saved chat
    // restores it on reload instead of following the global selection.
    if (draftChat && chatWorkspace?.id && chatScopeId) {
      bindChatWorkspace(chatScopeId, chatWorkspace.id);
    }
    try {
      const requestOptions = {
        conversationId: activeConvId,
        messages: history,
        model: modelKey,
        configId: reference.configId,
        providerId: reference.providerId,
        source: reference.source,
        vups: reference.vups,
        mode: chatMode,
        temperature: EFFORT_TEMPERATURE[chosenEffort] ?? 0.7,
        signal: controller.signal,
        assistantMessageId: assistantId,
        operationId: assistantId,
        chatId: chatScopeId || undefined,
        userText: requestText || text,
        // Only this chat's folder is in scope. Another chat's workspace can
        // never be searched just because it exists in the app.
        searchRoots: chatWorkspace?.path ? [chatWorkspace.path] : [],
        onMeta: ({ conversationId, messageId }) => {
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
          setMessages((prev) => markTurnMeta(prev, assistantId, { messageId, conversationId }));
          setConversations((prev) =>
            prev.some((conversation) => conversation.id === conversationId)
              ? prev
              : [
                  {
                    id: conversationId,
                    title:
                      text.replace(/\s+/g, " ").trim().slice(0, 60) ||
                      (attachmentItems.length > 0 ? "Local file attachment" : "New chat"),
                    updatedAt: new Date().toISOString(),
                  },
                  ...prev,
                ]
          );
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
      };
      let result;
      if (useDesktopTools) {
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
    } finally {
      if (isCurrentRequest(seq)) {
        sendingRef.current = false;
        setLoading(false);
        setStreamingId(null);
        if (streamingIdRef.current === assistantId) streamingIdRef.current = null;
        abortRef.current = null;
        refreshUsage();
      }
    }
  }

  function handleStop() {
    const targetId = streamingIdRef.current;
    const hadTurn = Boolean(targetId || sendingRef.current);
    const hadImage = Boolean(imageAbortRef.current);

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
    streamingIdRef.current = null;
    setLoading(false);
    setStreamingId(null);
    setImageGenerating(false);

    if (targetId) {
      setMessages((prev) => cancelTurn(prev, targetId));
      setNotice("Stopped. This turn was cancelled and nothing further will run for it.");
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
      setNotice(unavailableModelNotice(shared, omniroute));
      return;
    }
    const reference = chatReference(activeRow);
    const modelKey = reference.model;
    if (!modelKey) {
      setNotice("Choose a model in API settings before chatting.");
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
        mode: chatMode,
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
        setLoading(false);
        setStreamingId(null);
        abortRef.current = null;
        refreshUsage();
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
    // Live attachments still carry their data URLs, so a retry resends the
    // image; attachments restored from history (metadata only) fall back to
    // a text-only retry rather than failing.
    handleSend(lastUser.content, history, { attachments });
  }

  return (
    <>
      <main className="vr-chat-main" id="main-content">
        <header className="vr-chat-header" aria-live="polite">
          <span className="vr-chat-header__dot" aria-hidden="true" />
          <span className="vr-chat-header__label">Chatting with</span>
          <strong className="vr-chat-header__model">{activeRow?.name || "No model selected"}</strong>
          {activeRow && !activeRow.shared && !activeRow.vups ? (
            <span className="vr-chat-header__provider">{activeRow.provider}</span>
          ) : null}
          {chatWorkspace ? (
            <span className="vr-header-workspace" title={chatWorkspace.path}>
              <FolderSimple size={13} aria-hidden="true" />
              {chatWorkspace.title}
            </span>
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
          {composerWarning && (
            <div className="vr-notice" role="alert">
              <Warning size={15} weight="fill" aria-hidden="true" />
              <span>{composerWarning}</span>
            </div>
          )}
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
          {nativeShell === NATIVE_SHELLS.windows && (chatWorkspace || workspaces.length > 0) ? (
            <div className="vr-workspace-bar">
              <span className="vr-workspace-bar__icon" aria-hidden="true"><FolderSimple size={16} /></span>
              <span className="vr-workspace-bar__copy">
                <strong>{chatWorkspace ? chatWorkspace.title : "No folder for this chat"}</strong>
                <span title={chatWorkspace?.path || ""}>
                  {chatWorkspace
                    ? chatWorkspace.path
                    : "Choose one of your folders to give this chat a real project workspace."}
                </span>
              </span>
              <select
                className="vr-workspace-select"
                aria-label="Folder for this chat"
                value={chatWorkspace?.id || ""}
                onChange={event => bindChatWorkspace(chatScope, event.target.value)}
                disabled={loading || !chatScope}
              >
                <option value="">No folder</option>
                {workspaces.map(workspace => (
                  <option key={workspace.id} value={workspace.id}>{workspace.title}</option>
                ))}
              </select>
              {chatWorkspace ? (
                <button type="button" onClick={() => setWorkspacePickerOpen(true)} disabled={loading}>
                  Attach workspace files
                </button>
              ) : null}
            </div>
          ) : null}
          <div className="vr-mode-switch" role="group" aria-label="Assistant mode">
            <span className="vr-mode-switch__label">Mode</span>
            {VUPS_MODES.map((mode) => (
              <button
                key={mode.key}
                type="button"
                className="vr-mode-switch__button"
                data-active={chatMode === mode.key}
                aria-pressed={chatMode === mode.key}
                title={mode.description}
                onClick={() => changeChatMode(mode.key)}
                disabled={loading}
              >
                {mode.name}
              </button>
            ))}
            {chatMode === "motion" ? (
              <span className="vr-mode-switch__hint">GSAP, React motion, CSS, cleanup & reduced motion</span>
            ) : null}
          </div>
          <div className="vr-prompt-bar-wrap">
            <PromptBar
              placeholder={
                !canChat
                  ? shared === null && omniroute === null
                    ? "Checking for an available AI model..."
                    : "No AI model available - connect a provider in API settings..."
                  : activeIsVups
                    ? `Ask ${activeRow?.name || "Vups v3 Galax"} anything...`
                    : activeIsShared
                      ? "Ask anything - using the shared model..."
                      : activeIsGateway
                        ? "Ask anything - using the OmniRoute gateway..."
                        : "Ask anything - your provider, your key, your model..."
              }
              models={catalog}
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
              onSend={(text, meta) => handleSend(text, null, meta)}
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
                    onChange={changeWindowsPermissionMode}
                  />
                ) : null
              }
              sendWithModifier={preferences.sendShortcut === "modifier"}
              externalFiles={workspaceAttachment?.files}
              externalFilesSignal={workspaceAttachment?.key}
              draftValue={draftInsertion?.text}
              draftSignal={draftInsertion?.key}
              background="#0d1524"
              color="#e9eef7"
              menuBackground="#111c2e"
              sparkColor="#6c9bff"
              width="100%"
              radius={16}
              maxRows={6}
              className="vr-prompt-bar"
            />
            <p className="vr-composer-hint">
              {nativeShell === NATIVE_SHELLS.windows
                ? `${preferences.sendShortcut === "modifier" ? "Ctrl+Enter" : "Enter"} to send \u00b7 Shift+Enter for newline \u00b7 File contents stay local until you send`
                : nativeShell === NATIVE_SHELLS.android
                  ? `${preferences.sendShortcut === "modifier" ? "Ctrl+Enter" : "Enter"} to send \u00b7 Shift+Enter for newline \u00b7 Camera and files open only when you tap them`
                  : `${preferences.sendShortcut === "modifier" ? "Ctrl+Enter" : "Enter"} to send \u00b7 Shift+Enter for newline \u00b7 Attach images with the paperclip`}
            </p>
          </div>
        </footer>
      </main>
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
