import React, {
  useState,
  useRef,
  useEffect,
  useCallback,
  useMemo,
  useId,
} from "react";
import { Link, useNavigate } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import {
  Plus,
  Sidebar as SidebarIcon,
  House,
  ChatCircle,
  SignIn,
  UserPlus,
  ArrowClockwise,
  Warning,
  Copy,
  Check,
  DownloadSimple,
  Trash,
  Gear,
  SignOut,
  ThumbsUp,
  ThumbsDown,
  ShareNetwork,
  Image as ImageIcon,
  CaretDown,
  CaretUp,
} from "@phosphor-icons/react";
import PromptBar from "./components/reactbits/PromptBar.jsx";
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
  IMAGE_LIMITS,
  formatBytes,
  generateAttachmentId,
  isImageFile,
  readImageAttachment,
  toPayloadImages,
  validateImageFile,
} from "./chat/attachments.js";
import { streamChatResponse } from "./services/chat.js";
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
  deleteConversation,
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
  listConversations,
  removeProvider,
  saveMessageFeedback,
} from "./services/api.js";
import {
  createContinuationGuard,
  prepareContinuation
} from "./chat/continuation.js";
import { useAuth } from "./context/AuthContext.jsx";
import "./chat.css";

// â”€â”€â”€ Chat configuration â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const VUPS_EFFORTS = ["Precise", "Balanced", "Creative"];
const EFFORT_TEMPERATURE = { Precise: 0.3, Balanced: 0.7, Creative: 1.0 };
const MAX_USER_MESSAGE_CHARS = 32000;
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

// Only the final message may carry images â€” the backend rejects attachments
// on earlier messages, so trimmed history stays text-only.
function requestHistory(messages) {
  const filtered = sanitizeHistoryMessages(messages);
  return filtered.map((message, index) => {
    const entry = { role: message.role, content: message.content };
    if (index === filtered.length - 1 && Array.isArray(message.images) && message.images.length > 0) {
      entry.images = message.images;
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
  pinned = false,
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
    try {
      downloadBlob(
        new Blob([message.content], { type: "text/plain;charset=utf-8" }),
        "vups-answer.txt"
      );
      markRecovery("downloaded");
    } catch {
      markRecovery("download-failed");
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
                pinned={pinned}
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

function WelcomeScreen({ configured, modelName, sharedActive, gatewayActive, vupsActive, sharedLoading }) {
  return (
    <div className="vr-welcome">
      <div className="vr-welcome-art" aria-hidden="true">
        <div className="vr-welcome-ring ring-outer" />
        <div className="vr-welcome-ring ring-inner" />
        <div className="vr-welcome-icon">
          <VupsLogo />
        </div>
      </div>
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
    </div>
  );
}

// â”€â”€â”€ Sidebar â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function Sidebar({
  conversations,
  activeId,
  onNew,
  onSelect,
  onDelete,
  collapsed,
  onToggle,
  mobileOpen,
  onMobileClose,
  user,
  onSignOut,
}) {
  return (
    <>
      {mobileOpen && (
        <div
          className="vr-sidebar-backdrop"
          onClick={onMobileClose}
          aria-hidden="true"
        />
      )}
      <aside
        id="vr-sidebar"
        className={`vr-sidebar${collapsed ? " vr-sidebar--collapsed" : ""}${
          mobileOpen ? " vr-sidebar--mobile-open" : ""
        }`}
        aria-label="Chat sidebar"
      >
        <div className="vr-sidebar-top">
          <Link to="/" className="vr-brand" aria-label="VupsRouter home">
            <span className="vr-brand-mark" aria-hidden="true">
              <VupsLogo />
            </span>
            {!collapsed && (
              <span className="vr-brand-name">
                vups<span>router</span>
              </span>
            )}
          </Link>
          <button
            className="vr-sidebar-toggle"
            onClick={onToggle}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            <SidebarIcon size={18} />
          </button>
        </div>

        <button className="vr-new-chat-btn" onClick={onNew} aria-label="New chat">
          <Plus size={16} weight="bold" />
          {!collapsed && <span>New chat</span>}
        </button>

        {!collapsed && conversations.length > 0 && (
          <div className="vr-sidebar-section">
            <span className="vr-sidebar-label">Recent</span>
            <ul className="vr-conv-list" role="list">
              {conversations.slice(0, 15).map((conv) => (
                <li key={conv.id} className="vr-conv-row">
                  <button
                    className={`vr-conv-item${
                      conv.id === activeId ? " vr-conv-item--active" : ""
                    }`}
                    onClick={() => onSelect(conv.id)}
                    title={conv.title}
                  >
                    <ChatCircle size={14} aria-hidden="true" className="vr-conv-icon" />
                    <span className="vr-conv-title">{conv.title}</span>
                  </button>
                  <button
                    className="vr-conv-delete"
                    onClick={(event) => {
                      event.stopPropagation();
                      onDelete(conv.id);
                    }}
                    aria-label={`Delete conversation ${conv.title}`}
                    title="Delete conversation"
                  >
                    <Trash size={13} />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        <nav className="vr-sidebar-nav" aria-label="App navigation">
          <Link to="/" className="vr-nav-item" title="Home" onClick={onMobileClose}>
            <House size={16} aria-hidden="true" />
            {!collapsed && <span>Home</span>}
          </Link>
          <Link
            to="/settings"
            className="vr-nav-item"
            title="API settings"
            onClick={onMobileClose}
          >
            <Gear size={16} aria-hidden="true" />
            {!collapsed && <span>API settings</span>}
          </Link>
          {user ? (
            <button
              className="vr-nav-item"
              title={user.email}
              onClick={() => {
                onMobileClose();
                onSignOut();
              }}
            >
              <SignOut size={16} aria-hidden="true" />
              {!collapsed && <span>Sign out</span>}
            </button>
          ) : (
            <>
              <Link to="/signin" className="vr-nav-item" title="Sign in" onClick={onMobileClose}>
                <SignIn size={16} aria-hidden="true" />
                {!collapsed && <span>Sign in</span>}
              </Link>
              <Link to="/signup" className="vr-nav-item" title="Get started" onClick={onMobileClose}>
                <UserPlus size={16} aria-hidden="true" />
                {!collapsed && <span>Get started</span>}
              </Link>
            </>
          )}
        </nav>
      </aside>
    </>
  );
}

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
            pinned={isLatestTurn}
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
  const { user, signOut } = useAuth();
  const navigate = useNavigate();

  const [conversations, setConversations] = useState([]);
  const [activeConvId, setActiveConvId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(false);
  const [streamingId, setStreamingId] = useState(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
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
  const [composerWarning, setComposerWarning] = useState("");
  const [imageGenerating, setImageGenerating] = useState(false);
  const [generatedImage, setGeneratedImage] = useState(null);
  const [imageError, setImageError] = useState("");
  const [currentEffort, setCurrentEffort] = useState("Balanced");
  const [chatMode, setChatMode] = useState(loadChatMode);
  const abortRef = useRef(null);
  const sendingRef = useRef(false);
  const initializedRef = useRef(false);
  const requestSeqRef = useRef(0);
  const menuButtonRef = useRef(null);
  const continuationGuardRef = useRef(null);
  if (!continuationGuardRef.current) continuationGuardRef.current = createContinuationGuard();
  const [handoffState, setHandoffState] = useState({
    status: "idle",
    sourceId: null,
    error: ""
  });
  // A failed turn that never reached the server has no conversation document.
  // Keep its transcript reachable from the sidebar before switching away.
  const localChatsRef = useRef(new Map());
  const [localChats, setLocalChats] = useState([]);
  const sidebarConversations = useMemo(() => {
    const known = new Set(conversations.map(conversation => conversation.id));
    const local = localChats.filter(conversation => !known.has(conversation.id));
    return local.length > 0 ? [...local, ...conversations] : conversations;
  }, [conversations, localChats]);

  useEffect(() => {
    if (!mobileSidebarOpen) return undefined;
    const onKeyDown = (event) => {
      if (event.key === "Escape") setMobileSidebarOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    const frame = requestAnimationFrame(() => {
      document
        .querySelector("#vr-sidebar a, #vr-sidebar button")
        ?.focus({ preventScroll: true });
    });
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      cancelAnimationFrame(frame);
      const button = menuButtonRef.current;
      if (button && document.contains(button)) button.focus({ preventScroll: true });
    };
  }, [mobileSidebarOpen]);

  useEffect(() => {
    const query = window.matchMedia("(min-width: 651px)");
    const onChange = (event) => {
      if (event.matches) setMobileSidebarOpen(false);
    };
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

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
    sendingRef.current = false;
    setLoading(false);
    setStreamingId(null);
  }

  const refreshConversations = useCallback(async () => {
    try {
      const list = await listConversations();
      setConversations(list);
    } catch {
      /* list stays as-is; individual operations surface their own errors */
    }
  }, []);

  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;
    refreshConversations();
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
        setModelType(
          stored?.modelType === FREE_MODEL_TYPE ? FREE_MODEL_TYPE : CUSTOM_MODEL_TYPE
        );
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
    localChatsRef.current.set(id, { entry, messages: sourceMessages });
    setLocalChats(previous => [entry, ...previous.filter(chat => chat.id !== id)]);
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
        setActiveConvId(conversation?.id ?? null);
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
        setMobileSidebarOpen(false);
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

  async function handleDeleteModel(row) {    if (!row?.configId) return;
    const label = row.apiKeyMasked ? `${row.provider} (${row.apiKeyMasked})` : row.provider;
    if (!window.confirm(`Delete the saved configuration for ${label}? Its key and saved models are removed. Your other saved keys are not affected.`)) {
      return;
    }
    try {
      await removeProvider(row.configId);
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
    } catch (error) {
      setNotice(getApiErrorMessage(error));
    }
  }

  function startNewConversation() {
    invalidateInFlight();
    setActiveConvId(null);
    setMessages([]);
    setNotice("");
    setComposerWarning("");
    setGeneratedImage(null);
    setImageError("");
    setMobileSidebarOpen(false);
    const fresh = catalog.find((row) => row.vups);
    if (fresh) {
      const next = selectionFromRow(fresh);
      setSelection(next);
      saveStoredSelection(next);
    }
  }

  async function selectConversation(id) {
    if (id === activeConvId) {
      setMobileSidebarOpen(false);
      return;
    }
    invalidateInFlight();
    setMobileSidebarOpen(false);
    setNotice("");
    setComposerWarning("");
    setGeneratedImage(null);
    setImageError("");
    if (String(id).startsWith("local-")) {
      const local = localChatsRef.current.get(id);
      setActiveConvId(id);
      setMessages(local ? local.messages : []);
      return;
    }
    setActiveConvId(id);
    setMessages([]);
    try {
      const [conversation, artifacts] = await Promise.all([
        getConversation(id),
        fetchConversationArtifacts(id).catch(() => [])
      ]);
      const artifactMap = new Map(
        artifacts
          .filter(artifact => artifact?.messageId)
          .map(artifact => [artifact.messageId, artifact])
      );
      setMessages(
        conversation.messages
          .filter(
            (message) =>
              message.role !== "assistant" ||
              String(message.content || "").trim() ||
              artifactMap.has(message.messageId)
          )
          .map(message => toLocalMessage(message, artifactMap))
      );
    } catch (error) {
      setNotice(getApiErrorMessage(error));
    }
  }

  async function removeConversation(id) {
    const title =
      conversations.find((conversation) => conversation.id === id)?.title ||
      localChats.find((conversation) => conversation.id === id)?.title;
    if (!window.confirm(`Delete \u201c${title || "this conversation"}\u201d? This cannot be undone.`)) return;
    if (String(id).startsWith("local-")) {
      localChatsRef.current.delete(id);
      setLocalChats((prev) => prev.filter((conversation) => conversation.id !== id));
      if (id === activeConvId) startNewConversation();
      return;
    }
    try {
      await deleteConversation(id);
      setConversations((prev) => prev.filter((conversation) => conversation.id !== id));
      if (id === activeConvId) startNewConversation();
    } catch (error) {
      setNotice(getApiErrorMessage(error));
    }
  }

  // Called by the composer with real image Files (picker, drop, or paste).
  // Validation problems become error chips instead of blocking the whole pick.
  async function pickAttachments(files) {
    const list = [...files].filter(isImageFile).slice(0, IMAGE_LIMITS.count);
    return Promise.all(
      list.map(async (file) => {
        const check = validateImageFile(file);
        if (!check.ok) {
          return {
            id: generateAttachmentId(),
            name: file.name || "image",
            status: "error",
            error: check.error,
          };
        }
        try {
          return await readImageAttachment(file);
        } catch {
          return {
            id: generateAttachmentId(),
            name: file.name || "image",
            status: "error",
            error: "That image could not be read.",
          };
        }
      })
    );
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
    setImageGenerating(true);
    setImageError("");
    setGeneratedImage(null);
    try {
      const result = await generateImage(prompt);
      if (!result?.image || typeof result.image !== "string") {
        throw new Error("The backend returned no generated image.");
      }
      setGeneratedImage({
        image: result.image,
        mimeType: result.mimeType || "image/jpeg",
        prompt,
      });
    } catch (error) {
      setImageError(getApiErrorMessage(error));
    } finally {
      setImageGenerating(false);
    }
  }

  function canSubmitComposer(text, attachments) {
    const items = Array.isArray(attachments) ? attachments : [];
    if (text.length > MAX_USER_MESSAGE_CHARS) {
      setComposerWarning("That message is too long. Keep it under 32,000 characters.");
      return false;
    }
    if (items.some((item) => item && typeof item === "object" && item.status === "error")) {
      setComposerWarning("Remove the failed attachments (marked in red) before sending.");
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
      (item) => item && typeof item === "object" && item.status !== "error" && item.dataUrl
    );
    const imagePayload = toPayloadImages(attachmentItems);

    if (sendingRef.current || loading || typeof text !== "string" || (!text.trim() && imagePayload.length === 0)) return;

    if (text.length > MAX_USER_MESSAGE_CHARS) {
      setComposerWarning("That message is too long. Keep it under 32,000 characters.");
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
      const visionModels = catalog
        .filter((row) => row.vision === true)
        .map((row) => row.name);
      setNotice(
        visionModels.length > 0
          ? `The selected model (${modelKey}) does not accept image inputs. Try a vision-capable model instead: ${visionModels.join(", ")}.`
          : `The selected model (${modelKey}) does not accept image inputs. Connect a vision-capable provider in API settings.`
      );
      return;
    }

    if (sendingRef.current) return;
    sendingRef.current = true;
    setNotice("");
    setComposerWarning("");
    const chosenEffort = meta?.effort || currentEffort;
    const userMsg = {
      id: generateId(),
      role: "user",
      content: text,
      ...(attachmentItems.length > 0 ? { images: attachmentItems } : {}),
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

    const { controller, seq } = beginRequest();
    const inlineRequested = wantsInlineCode(text);
    let streamedContent = "";

    try {
      const result = await streamChatResponse({
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
        onMeta: ({ conversationId, messageId }) => {
          if (!isCurrentRequest(seq)) return;
          if (String(activeConvId || "").startsWith("local-")) {
            localChatsRef.current.delete(activeConvId);
            setLocalChats((prev) => prev.filter((chat) => chat.id !== activeConvId));
          }
          setActiveConvId(conversationId);
          setMessages((prev) => markTurnMeta(prev, assistantId, { messageId, conversationId }));
          setConversations((prev) =>
            prev.some((conversation) => conversation.id === conversationId)
              ? prev
              : [
                  {
                    id: conversationId,
                    title:
                      text.replace(/\s+/g, " ").trim().slice(0, 60) ||
                      (attachmentItems.length > 0 ? "Image attachment" : "New chat"),
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
      });
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
      if (error.conversationId) setActiveConvId(error.conversationId);
      setMessages((prev) =>
        settleTurnFromError(prev, assistantId, {
          error,
          modelLabel: selectedRow?.name || modelKey,
          content: partial,
          recoverArtifact: (status) =>
            partial && !inlineRequested ? artifactFromResponse(partial, { status }) : null
        }).messages
      );
      await refreshConversations();
    } finally {
      if (isCurrentRequest(seq)) {
        sendingRef.current = false;
        setLoading(false);
        setStreamingId(null);
        abortRef.current = null;
      }
    }
  }

  function handleStop() {
    abortRef.current?.abort();
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
      if (error.conversationId) setActiveConvId(error.conversationId);
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
      }
    }
  }

  function handleRetry() {
    if (sendingRef.current || loading) return;
    const lastUserIdx = messages.map((message) => message.role).lastIndexOf("user");
    if (lastUserIdx === -1) return;
    const lastUser = messages[lastUserIdx];
    const history = messages.slice(0, lastUserIdx + 1);
    // Live attachments still carry their data URLs, so a retry resends the
    // image; attachments restored from history (metadata only) fall back to
    // a text-only retry rather than failing.
    handleSend(lastUser.content, history, { attachments: lastUser.images });
  }

  async function handleSignOut() {
    await signOut();
    navigate("/");
  }

  return (
    <div className="vr-chat-layout">
      <button
        ref={menuButtonRef}
        className="vr-mobile-menu-btn"
        onClick={() => {
          setSidebarCollapsed(false);
          setMobileSidebarOpen(true);
        }}
        aria-label="Open sidebar"
        aria-controls="vr-sidebar"
        aria-expanded={mobileSidebarOpen}
      >
        <SidebarIcon size={20} />
      </button>

      <Sidebar
        conversations={sidebarConversations}
        activeId={activeConvId}
        onNew={startNewConversation}
        onSelect={selectConversation}
        onDelete={removeConversation}
        collapsed={sidebarCollapsed}
        onToggle={() => {
          if (window.matchMedia("(max-width: 650px)").matches) {
            setMobileSidebarOpen(false);
            return;
          }
          setSidebarCollapsed((v) => !v);
        }}
        mobileOpen={mobileSidebarOpen}
        onMobileClose={() => setMobileSidebarOpen(false)}
        user={user}
        onSignOut={handleSignOut}
      />

      <main className="vr-chat-main" id="main-content" inert={mobileSidebarOpen || undefined}>
        <header className="vr-chat-header" aria-live="polite">
          <span className="vr-chat-header__dot" aria-hidden="true" />
          <span className="vr-chat-header__label">Chatting with</span>
          <strong className="vr-chat-header__model">{activeRow?.name || "No model selected"}</strong>
          {activeRow && !activeRow.shared && !activeRow.vups ? (
            <span className="vr-chat-header__provider">{activeRow.provider}</span>
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
              onDeleteModel={handleDeleteModel}
              onAddKey={() => navigate("/settings")}
              openModelSignal={openModelSignal}
              efforts={VUPS_EFFORTS}
              defaultEffort={currentEffort}
              onEffortChange={(effort) => setCurrentEffort(effort)}
              busy={loading}
              generating={imageGenerating}
              onSend={(text, meta) => handleSend(text, null, meta)}
              beforeSend={(text, attachments) => canSubmitComposer(text, attachments)}
              onStop={handleStop}
              onGenerateImage={handleGenerateImage}
              onAttach={pickAttachments}
              onDictate={handleDictate}
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
              Enter to send {"\u00b7"} Shift+Enter for newline {"\u00b7"} Attach images with the paperclip
            </p>
          </div>
        </footer>
      </main>
    </div>
  );
}
