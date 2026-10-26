import React, {
  useState,
  useRef,
  useEffect,
  useCallback,
  useMemo,
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
  Image as ImageIcon,
} from "@phosphor-icons/react";
import PromptBar from "./components/reactbits/PromptBar.jsx";
import MessageDownloads from "./components/MessageDownloads.jsx";
import CodeArtifact from "./components/CodeArtifact.jsx";
import VupsLogo from "./components/VupsLogo.jsx";
import { artifactFromResponse, responseSummary, streamingArtifact } from "./chat/artifacts.js";
import { copyText } from "./chat/clipboard.js";
import { downloadBlob } from "./chat/downloads.js";
import {
  IMAGE_LIMITS,
  formatBytes,
  generateAttachmentId,
  isImageFile,
  readImageAttachment,
  toPayloadImages,
  validateImageFile,
} from "./chat/attachments.js";
import ThoughtLine from "./components/reactbits/ThoughtLine.jsx";
import { streamChatResponse } from "./services/chat.js";
import { presentSaveWarning, settleTurnFromError } from "./chat/turnOutcome.js";
import { resolveTurnNotice, TURN_NOTICE } from "./chat/turnPresentation.js";
import {
  appendTurnChunk,
  appendTurnStep,
  beginContinuation,
  cancelTurn,
  completeTurn,
  createAssistantTurn,
  hasRecoverableOutput,
  markTurnMeta,
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
  listConversations,
  removeProvider,
} from "./services/api.js";
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
  const artifact = artifactMap?.get(message.messageId) || null;
  return {
    id: generateId(),
    role: message.role,
    content: message.content,
    status: artifact && artifact.status !== "complete" ? TURN_STATUS.INTERRUPTED : TURN_STATUS.COMPLETED,
    error: null,
    saveWarning: null,
    truncated: null,
    ...(message.messageId ? { messageId: message.messageId } : {}),
    ...(artifact ? { artifact } : {}),
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
  if (!shared) return "Checking the shared model â€” try again in a moment.";
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
  if (!omniroute) return "Checking the OmniRoute gateway â€” try again in a moment.";
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

function CodeBlock({ children, className }) {
  const [copied, setCopied] = useState(false);
  const codeRef = useRef(null);

  const handleCopy = useCallback(async () => {
    const text = codeRef.current?.textContent ?? "";
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  }, []);

  const lang = /language-(\w+)/.exec(className || "")?.[1] ?? "";

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
      <pre>
        <code ref={codeRef} className={className}>
          {children}
        </code>
      </pre>
    </div>
  );
}

// â”€â”€â”€ Markdown Components â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const MARKDOWN_COMPONENTS = {
  code({ node, inline, className, children, ...props }) {
    if (inline) {
      return (
        <code className="vr-inline-code" {...props}>
          {children}
        </code>
      );
    }
    return <CodeBlock className={className}>{children}</CodeBlock>;
  },
};

// â”€â”€â”€ Message Bubble â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function Message({ message, isStreaming, currentSteps, onRetry, onContinue, onSwitchModel }) {
  const isUser = message.role === "user";
  const status = message.status || (isStreaming ? TURN_STATUS.STREAMING : TURN_STATUS.COMPLETED);
  const streamedArtifact = useMemo(
    () => (!isUser && isStreaming ? streamingArtifact(message.content) : null),
    [isUser, isStreaming, message.content]
  );
  const artifact = message.artifact || streamedArtifact;
  const displayContent = useMemo(
    () => (artifact ? responseSummary(message.content, artifact.files) : message.content),
    [artifact, message.content]
  );
  const notice = resolveTurnNotice(message, isStreaming);
  const presentation = notice === TURN_NOTICE.ERROR ? message.error : null;
  const saveWarning = notice === TURN_NOTICE.SAVE_WARNING ? message.saveWarning : null;
  const canContinue = Boolean(onContinue && !isStreaming && hasRecoverableOutput(message));
  const [recovery, setRecovery] = useState("");
  const recoveryTimer = useRef(null);

  useEffect(() => () => clearTimeout(recoveryTimer.current), []);

  const markRecovery = useCallback((value) => {
    setRecovery(value);
    clearTimeout(recoveryTimer.current);
    recoveryTimer.current = setTimeout(() => setRecovery(""), 3000);
  }, []);

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

  const stepsToUse = isStreaming ? currentSteps : message.steps;
  const showThoughtLine = !isUser && (isStreaming || (stepsToUse && stepsToUse.length > 0));

  return (
    <div className={`vr-msg ${isUser ? "vr-msg--user" : `vr-msg--assistant vr-msg--${status}`}`}>
      {!isUser && (
        <div className="vr-msg-avatar" aria-hidden="true">
          <VupsLogo />
        </div>
      )}
      <div className="vr-msg-body">
        {isUser ? (
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
            {message.content ? <p className="vr-msg-text">{message.content}</p> : null}
          </>
        ) : (
          <>
            {showThoughtLine && (
              <div className="vr-thoughtline-container">
                <ThoughtLine
                  working={isStreaming}
                  steps={stepsToUse || []}
                  label="Thinkingâ€¦"
                  doneLabel="Thought for"
                  glyph="sparkle"
                  glyphColor="#d4ff3f"
                  color="#9ca39c"
                  fontSize={13}
                  breathPeriod={1.6}
                  collapsible
                  collapseOnSettle
                  showTimer
                  className="vr-thought-line"
                  renderLabel={(text, working) =>
                    working ? (
                      <>
                        {text}
                        <span className="vr-thinking vr-thinking--inline" aria-hidden="true">
                          <span /><span /><span />
                        </span>
                      </>
                    ) : (
                      text
                    )
                  }
                />
              </div>
            )}
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
            {artifact ? (
              <CodeArtifact
                artifact={artifact}
                streaming={isStreaming}
              />
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
            {notice === TURN_NOTICE.ERROR && presentation ? (
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
            {!isStreaming && !artifact && message.content ? (
              <MessageDownloads content={message.content} />
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

function MessageList({ messages, streamingId, loading, onRetry, onContinue, onSwitchModel, currentSteps }) {
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
      aria-live="polite"
      aria-label="Conversation"
    >
      {messages.map((msg, i) => (
        <Message
          key={msg.id}
          message={msg}
          isStreaming={msg.id === streamingId}
          currentSteps={msg.id === streamingId ? currentSteps : msg.steps || []}
          onRetry={msg.status === TURN_STATUS.FAILED && i === messages.length - 1 ? onRetry : undefined}
          onSwitchModel={msg.status === TURN_STATUS.FAILED && i === messages.length - 1 ? onSwitchModel : undefined}
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
      ))}
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
  const [currentSteps, setCurrentSteps] = useState([]);
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

  async function handleDeleteModel(row) {
    if (!row?.configId) return;
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
    setActiveConvId(id);
    setMessages([]);
    setGeneratedImage(null);
    setImageError("");
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
    const title = conversations.find((conversation) => conversation.id === id)?.title;
    if (!window.confirm(`Delete â€œ${title || "this conversation"}â€? This cannot be undone.`)) return;
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
    const initialSteps = ["Sending request"];

    setMessages([
      ...baseMessages,
      createAssistantTurn({ id: assistantId, steps: initialSteps })
    ]);
    setLoading(true);
    setStreamingId(assistantId);
    setCurrentSteps(initialSteps);

    const { controller, seq } = beginRequest();

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
          setMessages((prev) => appendTurnChunk(prev, assistantId, chunk));
        },
        onStep: (step) => {
          if (!isCurrentRequest(seq)) return;
          setCurrentSteps((prev) => (prev.includes(step) ? prev : [...prev, step]));
          setMessages((prev) => appendTurnStep(prev, assistantId, step));
        },
      });
      if (!isCurrentRequest(seq)) return;
      setMessages((prev) =>
        completeTurn(prev, assistantId, {
          content: typeof result?.content === "string" ? result.content : "",
          messageId: result?.messageId,
          artifact: result?.artifact || null,
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
          recoverArtifact: (status) => (partial ? artifactFromResponse(partial, { status }) : null)
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
    "Continue from exactly where you stopped. Do not repeat any previously generated text â€” output only the continuation.";

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
    const initialSteps = ["Continuing response"];
    const targetArtifact = target.artifact || streamingArtifact(target.content);
    const artifactContinuation = Boolean(targetArtifact);
    const targetFile = targetArtifact?.files?.find(file => file.complete === false)?.path || "";

    setMessages((prev) => {
      const next = beginContinuation(prev, targetId, initialSteps);
      return targetArtifact
        ? next.map((message) =>
            message.id === targetId && !message.artifact ? { ...message, artifact: targetArtifact } : message
          )
        : next;
    });
    setLoading(true);
    setStreamingId(targetId);
    setCurrentSteps(initialSteps);

    const { controller, seq } = beginRequest();

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
          if (!isCurrentRequest(seq) || artifactContinuation) return;
          setMessages((prev) => appendTurnChunk(prev, targetId, chunk));
        },
        onStep: (step) => {
          if (!isCurrentRequest(seq)) return;
          setCurrentSteps((prev) => (prev.includes(step) ? prev : [...prev, step]));
          setMessages((prev) => appendTurnStep(prev, targetId, step));
        },
      });
      if (!isCurrentRequest(seq)) return;
      setMessages((prev) =>
        completeTurn(prev, targetId, {
          content: result?.artifact ? "" : typeof result?.content === "string" ? result.content : "",
          messageId: result?.messageId,
          artifact: result?.artifact || null,
          finishReason: result?.finishReason,
          saveWarning: result?.saveWarning ? presentSaveWarning(result.saveWarning.code) : null
        })
      );
      await refreshConversations();
    } catch (error) {
      if (!isCurrentRequest(seq)) return;
      if (error?.name === "AbortError") {
        setMessages((prev) => cancelTurn(prev, targetId));
        await refreshConversations();
        return;
      }
      const partial = typeof error.partialContent === "string" ? error.partialContent : "";
      if (error.conversationId) setActiveConvId(error.conversationId);
      setMessages((prev) =>
        settleTurnFromError(prev, targetId, {
          error,
          modelLabel: activeRow?.name || modelKey,
          content: partial,
          artifact: targetArtifact,
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
        className="vr-mobile-menu-btn"
        onClick={() => setMobileSidebarOpen(true)}
        aria-label="Open sidebar"
        aria-expanded={mobileSidebarOpen}
      >
        <SidebarIcon size={20} />
      </button>

      <Sidebar
        conversations={conversations}
        activeId={activeConvId}
        onNew={startNewConversation}
        onSelect={selectConversation}
        onDelete={removeConversation}
        collapsed={sidebarCollapsed}
        onToggle={() => setSidebarCollapsed((v) => !v)}
        mobileOpen={mobileSidebarOpen}
        onMobileClose={() => setMobileSidebarOpen(false)}
        user={user}
        onSignOut={handleSignOut}
      />

      <main className="vr-chat-main" id="main-content">
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
            onRetry={handleRetry}
            onContinue={handleContinue}
            onSwitchModel={() => setOpenModelSignal((value) => value + 1)}
            currentSteps={currentSteps}
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
              background="#111416"
              color="#f2f4ef"
              menuBackground="#181c20"
              sparkColor="#d4ff3f"
              width="100%"
              radius={16}
              maxRows={6}
              className="vr-prompt-bar"
            />
            <p className="vr-composer-hint">
              Enter to send Â· Shift+Enter for newline Â· Attach images with the paperclip
            </p>
          </div>
        </footer>
      </main>
    </div>
  );
}
