import React, {
  useState,
  useRef,
  useEffect,
  useCallback,
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
  Compass,
  ArrowClockwise,
  Warning,
  Copy,
  Check,
  Trash,
  Gear,
  SignOut,
} from "@phosphor-icons/react";
import { SparklesIcon, Globe02Icon, File02Icon } from "@hugeicons/core-free-icons";
import PromptBar from "./components/reactbits/PromptBar.jsx";
import ThoughtLine from "./components/reactbits/ThoughtLine.jsx";
import { streamChatResponse, ChatConfigError, ChatNetworkError } from "./services/chat.js";
import {
  deleteConversation,
  fetchProviderConfig,
  fetchProviderModels,
  fetchSharedModelStatus,
  getApiErrorMessage,
  getConversation,
  listConversations,
} from "./services/api.js";
import { useAuth } from "./context/AuthContext.jsx";
import "./chat.css";

// ─── Chat configuration ─────────────────────────────────────────────────────

const VUPS_EFFORTS = ["Low", "Medium", "High"];
const EFFORT_TEMPERATURE = { Low: 0.3, Medium: 0.7, High: 1.0 };

const VUPS_SOURCES = [
  {
    key: "free-models",
    name: "Free Models Guide",
    description: "Explore zero-cost hosted & open-weight tiers",
    icon: SparklesIcon,
  },
  {
    key: "local-models",
    name: "Local Models (Ollama)",
    description: "Setup Gemma, Llama & Qwen offline",
    icon: Globe02Icon,
  },
  {
    key: "rate-limits",
    name: "Rate Limits & Quotas",
    description: "Free tier limits on AI Studio & OpenRouter",
    icon: File02Icon,
  },
];

const VUPS_COMMANDS = [
  { key: "compare", name: "/compare", description: "Compare free models side by side" },
  { key: "explain", name: "/explain", description: "Step-by-step technical explanation" },
  { key: "code", name: "/code", description: "Generate code with free coding models" },
  { key: "summarize", name: "/summarize", description: "Summarize the discussion" },
  { key: "limits", name: "/limits", description: "Check rate limits and free tier quotas" },
];

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

// ─── Utilities ──────────────────────────────────────────────────────────────

function generateId() {
  return Math.random().toString(36).slice(2, 11);
}

function toLocalMessage(message) {
  return { id: generateId(), role: message.role, content: message.content };
}

function requestHistory(messages) {
  return messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => ({ role: message.role, content: message.content }));
}

function errorMessageFor(error) {
  if (error instanceof ChatConfigError || error instanceof ChatNetworkError) return error.message;
  return getApiErrorMessage(error);
}

function sharedModelNotice(shared) {
  if (!shared) return "Checking the shared model — try again in a moment.";
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

const SHARED_TAG = "Shared · Free · No API key needed";
const SHARED_GROUP = "Shared · Free";
const PERSONAL_GROUP = "Your keys";

// ─── Code Block with Copy ───────────────────────────────────────────────────

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

// ─── Markdown Components ────────────────────────────────────────────────────

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

// ─── Message Bubble ─────────────────────────────────────────────────────────

function Message({ message, isStreaming, currentSteps, onRetry }) {
  const isUser = message.role === "user";
  const isError = message.role === "error";

  if (isError) {
    return (
      <div className="vr-msg vr-msg--error" role="alert">
        <Warning size={16} weight="fill" aria-hidden="true" />
        <span>{message.content}</span>
        {onRetry && (
          <button className="vr-retry-btn" onClick={onRetry}>
            <ArrowClockwise size={14} />
            Retry
          </button>
        )}
      </div>
    );
  }

  const stepsToUse = isStreaming ? currentSteps : message.steps;
  const showThoughtLine = !isUser && (isStreaming || (stepsToUse && stepsToUse.length > 0));

  return (
    <div className={`vr-msg ${isUser ? "vr-msg--user" : "vr-msg--assistant"}`}>
      {!isUser && (
        <div className="vr-msg-avatar" aria-hidden="true">
          <Compass size={14} weight="bold" />
        </div>
      )}
      <div className="vr-msg-body">
        {isUser ? (
          <p className="vr-msg-text">{message.content}</p>
        ) : (
          <>
            {showThoughtLine && (
              <div className="vr-thoughtline-container">
                <ThoughtLine
                  working={isStreaming}
                  steps={stepsToUse || []}
                  label="Thinking…"
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
            {message.content ? (
              <div className={`vr-msg-md ${isStreaming ? "vr-streaming" : ""}`}>
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  rehypePlugins={[rehypeHighlight]}
                  components={MARKDOWN_COMPONENTS}
                >
                  {message.content}
                </ReactMarkdown>
                {isStreaming && <span className="vr-cursor" aria-hidden="true" />}
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

// ─── Welcome Screen ─────────────────────────────────────────────────────────

const SUGGESTIONS = [
  {
    id: "s1",
    title: "Compare free models",
    text: "Which free AI models are best for coding tasks?",
  },
  {
    id: "s2",
    title: "Run locally",
    text: "How do I run Gemma or Llama locally with Ollama?",
  },
  {
    id: "s3",
    title: "Rate limits",
    text: "What are the rate limits on Google AI Studio's free tier?",
  },
  {
    id: "s4",
    title: "OpenRouter models",
    text: "What free models are currently available on OpenRouter?",
  },
];

function WelcomeScreen({ onSuggestion, configured, modelName, sharedActive, sharedLoading }) {
  return (
    <div className="vr-welcome">
      <div className="vr-welcome-art" aria-hidden="true">
        <div className="vr-welcome-ring ring-outer" />
        <div className="vr-welcome-ring ring-inner" />
        <div className="vr-welcome-icon">
          <Compass size={30} weight="bold" />
        </div>
      </div>
      <h1 className="vr-welcome-title">
        VupsRouter <span>AI</span>
      </h1>
      <p className="vr-welcome-desc">
        {configured
          ? sharedActive
            ? `Chatting with ${modelName || "the shared model"} — no API key needed.`
            : `Chatting with ${modelName || "your configured model"} through your own provider.`
          : sharedLoading
            ? "Checking for an available AI model…"
            : "Connect your own AI provider in API settings, then ask anything about free AI models, hosted APIs, open-weight options, and local deployment."}
      </p>
      <ul className="vr-suggestions" role="list" aria-label="Suggested prompts">
        {SUGGESTIONS.map((s) => (
          <li key={s.id}>
            <button
              className="vr-suggestion-card"
              onClick={() => onSuggestion(s.text)}
            >
              <span className="vr-suggestion-title">{s.title}</span>
              <span className="vr-suggestion-text">{s.text}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ─── Sidebar ─────────────────────────────────────────────────────────────────

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
              <Compass size={18} weight="bold" />
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

// ─── Message List ────────────────────────────────────────────────────────────

function MessageList({ messages, streamingId, loading, onRetry, currentSteps }) {
  const bottomRef = useRef(null);
  const listRef = useRef(null);
  const isNearBottom = useRef(true);

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
          onRetry={msg.role === "error" && i === messages.length - 1 ? onRetry : undefined}
        />
      ))}
      <div ref={bottomRef} aria-hidden="true" />
    </div>
  );
}

// ─── ChatPage (Root) ─────────────────────────────────────────────────────────

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
  const [notice, setNotice] = useState("");
  const [currentEffort, setCurrentEffort] = useState("Medium");
  const abortRef = useRef(null);
  const initializedRef = useRef(false);

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
    Promise.all([
      fetchProviderConfig(),
      fetchSharedModelStatus().catch(() => null),
    ])
      .then(([stored, sharedStatus]) => {
        setConfig(stored);
        setShared(sharedStatus);
        if (stored?.configured || sharedStatus?.available) {
          fetchProviderModels()
            .then((models) => setProviderModels(models))
            .catch(() => setProviderModels([]));
        }
      })
      .catch((error) => setNotice(getApiErrorMessage(error)));
  }, [refreshConversations]);

  const modelChoices = providerModels.length > 0
    ? providerModels.map((model) => ({
        key: model.id,
        name: model.id,
        tag: model.shared ? SHARED_TAG : model.ownedBy || "Your provider",
        group: model.shared ? SHARED_GROUP : PERSONAL_GROUP,
      }))
    : config?.model
      ? [{ key: config.model, name: config.model, tag: "Saved model", group: PERSONAL_GROUP }]
      : shared?.available
        ? [{
            key: shared.model,
            name: shared.model,
            tag: SHARED_TAG,
            group: SHARED_GROUP,
          }]
        : [];
  const activeModelKey = config?.model && modelChoices.some((choice) => choice.key === config.model)
    ? config.model
    : modelChoices[0]?.key || config?.model || shared?.model || "";
  const canChat = Boolean(config?.configured || shared?.available);
  const activeIsShared = Boolean(
    providerModels.find((model) => model.id === activeModelKey)?.shared ||
      (!config?.configured && shared?.available)
  );

  function startNewConversation() {
    abortRef.current?.abort();
    setActiveConvId(null);
    setMessages([]);
    setNotice("");
    setMobileSidebarOpen(false);
  }

  async function selectConversation(id) {
    if (id === activeConvId) {
      setMobileSidebarOpen(false);
      return;
    }
    abortRef.current?.abort();
    setMobileSidebarOpen(false);
    setNotice("");
    setLoading(false);
    setStreamingId(null);
    setActiveConvId(id);
    setMessages([]);
    try {
      const conversation = await getConversation(id);
      setMessages(conversation.messages.map(toLocalMessage));
    } catch (error) {
      setNotice(getApiErrorMessage(error));
    }
  }

  async function removeConversation(id) {
    try {
      await deleteConversation(id);
      setConversations((prev) => prev.filter((conversation) => conversation.id !== id));
      if (id === activeConvId) startNewConversation();
    } catch (error) {
      setNotice(getApiErrorMessage(error));
    }
  }

  async function handleSend(text, retryHistory, meta) {
    if (loading || typeof text !== "string" || !text.trim()) return;

    if (!canChat) {
      setNotice(sharedModelNotice(shared));
      return;
    }

    const modelKey = meta?.model?.key || activeModelKey;
    if (!modelKey) {
      setNotice("Choose a model in API settings before chatting.");
      return;
    }

    setNotice("");
    const chosenEffort = meta?.effort || currentEffort;
    const userMsg = { id: generateId(), role: "user", content: text };
    const baseMessages = retryHistory ?? [...messages, userMsg];
    const history = requestHistory(baseMessages).slice(-40);
    const assistantId = generateId();
    const initialSteps = ["Sending request"];

    setMessages([...baseMessages, { id: assistantId, role: "assistant", content: "", steps: initialSteps }]);
    setLoading(true);
    setStreamingId(assistantId);
    setCurrentSteps(initialSteps);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      await streamChatResponse({
        conversationId: activeConvId,
        messages: history,
        model: modelKey,
        temperature: EFFORT_TEMPERATURE[chosenEffort] ?? 0.7,
        signal: controller.signal,
        onMeta: ({ conversationId }) => {
          setActiveConvId(conversationId);
          setConversations((prev) =>
            prev.some((conversation) => conversation.id === conversationId)
              ? prev
              : [
                  {
                    id: conversationId,
                    title: text.replace(/\s+/g, " ").trim().slice(0, 60) || "New chat",
                    updatedAt: new Date().toISOString(),
                  },
                  ...prev,
                ]
          );
        },
        onChunk: (chunk) => {
          setMessages((prev) =>
            prev.map((message) =>
              message.id === assistantId ? { ...message, content: message.content + chunk } : message
            )
          );
        },
        onStep: (step) => {
          setCurrentSteps((prev) => {
            const next = prev.includes(step) ? prev : [...prev, step];
            setMessages((messages) =>
              messages.map((message) => (message.id === assistantId ? { ...message, steps: next } : message))
            );
            return next;
          });
        },
      });
      await refreshConversations();
    } catch (error) {
      if (error.name !== "AbortError") {
        setMessages((prev) => [
          ...prev.filter((message) => message.id !== assistantId),
          { id: generateId(), role: "error", content: errorMessageFor(error) },
        ]);
      } else {
        await refreshConversations();
      }
    } finally {
      setLoading(false);
      setStreamingId(null);
      abortRef.current = null;
    }
  }

  function handleStop() {
    abortRef.current?.abort();
  }

  function handleRetry() {
    const lastUserIdx = messages.map((message) => message.role).lastIndexOf("user");
    if (lastUserIdx === -1) return;
    const history = messages.slice(0, lastUserIdx + 1);
    handleSend(messages[lastUserIdx].content, history, undefined);
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
        {messages.length === 0 ? (
          <WelcomeScreen
            onSuggestion={(text) => handleSend(text)}
            configured={canChat}
            modelName={activeModelKey}
            sharedActive={activeIsShared}
            sharedLoading={shared === null && !config?.configured}
          />
        ) : (
          <MessageList
            messages={messages}
            streamingId={streamingId}
            loading={loading}
            onRetry={handleRetry}
            currentSteps={currentSteps}
          />
        )}

        <footer className="vr-composer" role="region" aria-label="Chat composer">
          {notice && (
            <div className="vr-notice" role="alert">
              <Warning size={15} weight="fill" aria-hidden="true" />
              <span>{notice}</span>
              <Link to="/settings">Open API settings</Link>
            </div>
          )}
          {!canChat && !notice && (
            <div className="vr-notice" role="alert">
              <Warning size={15} weight="fill" aria-hidden="true" />
              <span>{sharedModelNotice(shared)}</span>
              <Link to="/settings">Open API settings</Link>
            </div>
          )}
          <div className="vr-prompt-bar-wrap">
            <PromptBar
              placeholder={
                !canChat
                  ? shared === null
                    ? "Checking for an available AI model…"
                    : "No AI model available — connect a provider in API settings…"
                  : activeIsShared
                    ? "Ask anything — using the shared model, no API key needed…"
                    : "Ask anything — your provider, your key, your model…"
              }
              sources={VUPS_SOURCES}
              commands={VUPS_COMMANDS}
              models={modelChoices}
              defaultModel={activeModelKey}
              efforts={VUPS_EFFORTS}
              defaultEffort={currentEffort}
              onEffortChange={(effort) => setCurrentEffort(effort)}
              busy={loading}
              onSend={(text, meta) => handleSend(text, null, meta)}
              onStop={handleStop}
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
              Enter to send · Shift+Enter for newline · Type / for commands or @ for guides
            </p>
          </div>
        </footer>
      </main>
    </div>
  );
}
