import React, { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  BookOpen,
  Briefcase,
  ChartBar,
  ChatCircle,
  CircleNotch,
  Code,
  Database,
  GithubLogo,
  Globe,
  Image,
  Key,
  Lightning,
  MagnifyingGlass,
  PuzzlePiece,
  ShieldCheck,
  Sparkle,
  WarningCircle,
  Wrench,
  X
} from "@phosphor-icons/react";
import HoldToDeleteDialog from "../components/HoldToDeleteDialog.jsx";
import ExternalAnchor from "../components/ExternalLink.jsx";
import { QuantumLoader } from "../components/LoadingVisuals.jsx";
import {
  executePluginTool,
  fetchPluginActivity,
  fetchPluginOAuthStatus,
  getApiErrorCode,
  getApiErrorMessage,
  installPlugin,
  listPlugins,
  startPluginOAuth,
  testPlugin,
  uninstallPlugin,
  updatePlugin
} from "../services/api.js";
import PluginActionDialog from "./PluginActionDialog.jsx";
import PluginDetailView from "./PluginDetailView.jsx";
import { openExternalUrl } from "../native/externalLinks.js";
import {
  accountLabel,
  connectionStatus,
  oauthOutcomeNotice,
  oauthStartFailureText,
  redactSecrets,
  setupGuidance,
  signInTarget
} from "./pluginDetails.js";
import "./plugins.css";

const CATEGORY_LABELS = {
  productivity: "Productivity",
  communication: "Communication",
  developer: "Developer",
  data: "Data & infrastructure",
  automation: "Automation",
  research: "Research",
  media: "Media",
  business: "Business",
  analytics: "Analytics",
  utilities: "Utilities"
};

const CATEGORY_ICONS = {
  productivity: Globe,
  communication: ChatCircle,
  developer: Code,
  data: Database,
  automation: Lightning,
  research: BookOpen,
  media: Image,
  business: Briefcase,
  analytics: ChartBar,
  utilities: Wrench
};

const STATUS_META = {
  available: { label: "Ready", tone: "ok" },
  requires_setup: { label: "Needs setup", tone: "setup" },
  oauth_required: { label: "OAuth required", tone: "setup" },
  in_development: { label: "In development", tone: "muted" }
};

// The card badge uses the same derivation as the detail screen, so a plugin
// whose last real check failed never reads as "Connected" in the grid either.
// A live provider sign-in on the companion row is a real connection too, even
// while this row's own token field is empty.
function statusMeta(plugin) {
  if (plugin.installed || plugin.oauth?.installed) {
    const status = connectionStatus(plugin);
    return { label: status.label, tone: status.tone };
  }
  return STATUS_META[plugin.availability] || STATUS_META.in_development;
}

function canConnect(plugin) {
  return plugin.availability === "available" || plugin.availability === "requires_setup";
}

const TOKEN_BUTTON_LABELS = { github: "Connect with Personal Access Token" };

function tokenButtonLabel(plugin) {
  return TOKEN_BUTTON_LABELS[plugin.id] || "Connect with a token";
}

function signInButtonLabel(plugin) {
  return `Connect with ${plugin.name}`;
}

// How long the app waits for the browser hand-off to land before it says the
// sign-in did not come back. The server state itself expires in ten minutes.
const SIGN_IN_POLL_MS = 2000;
const SIGN_IN_WAIT_MS = 3 * 60 * 1000;

function formatDate(value) {
  if (!value) return "Never";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return "Unknown";
  }
}

function Modal({ title, subtitle, onClose, children, footer, wide = false }) {
  const dialogRef = useRef(null);

  useEffect(() => {
    const onKeyDown = event => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  return (
    <div
      className="vr-plugin-modal-backdrop"
      role="presentation"
      onMouseDown={event => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className={`vr-plugin-modal${wide ? " vr-plugin-modal--wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="vr-plugin-modal-title"
        tabIndex={-1}
        ref={dialogRef}
      >
        <header className="vr-plugin-modal-head">
          <div>
            <span className="vr-page-kicker">PLUGIN</span>
            <h2 id="vr-plugin-modal-title">{title}</h2>
            {subtitle ? <p>{subtitle}</p> : null}
          </div>
          <button type="button" className="vr-icon-btn" onClick={onClose} aria-label="Close dialog">
            <X size={17} />
          </button>
        </header>
        <div className="vr-plugin-modal-body">{children}</div>
        {footer ? <footer className="vr-plugin-modal-foot">{footer}</footer> : null}
      </div>
    </div>
  );
}

export default function PluginsPage() {
  const [plugins, setPlugins] = useState([]);
  const [summary, setSummary] = useState(null);
  const [activity, setActivity] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [detailId, setDetailId] = useState("");
  const [connectId, setConnectId] = useState("");
  const [connectValues, setConnectValues] = useState({});
  const [connectError, setConnectError] = useState("");
  const [connectBusy, setConnectBusy] = useState(false);
  const [actionBusy, setActionBusy] = useState("");
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [actionTool, setActionTool] = useState(null);
  const [detailError, setDetailError] = useState("");
  // phase: opening (asking the backend) → waiting (browser has the provider) →
  // expired (no answer came back) or an inline error. Never a fake success.
  const [signIn, setSignIn] = useState(null);
  const [searchParams, setSearchParams] = useSearchParams();

  const detail = plugins.find(plugin => plugin.id === detailId) || null;
  const connectTarget = plugins.find(plugin => plugin.id === connectId) || null;

  async function load() {
    try {
      const [data, recent] = await Promise.all([
        listPlugins(),
        fetchPluginActivity(10).catch(() => [])
      ]);
      setPlugins(Array.isArray(data.plugins) ? data.plugins : []);
      setSummary(data.summary || null);
      setActivity(recent);
      setError("");
    } catch (loadError) {
      setError(getApiErrorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  // A sign-in that the browser finished on the server's callback URL lands here
  // with an outcome and a reason code, never with a code, token, or provider text.
  useEffect(() => {
    const outcome = oauthOutcomeNotice(searchParams.toString());
    if (!outcome) return;
    if (outcome.tone === "ok") setNotice(outcome.message);
    else setError(outcome.message);
    const next = new URLSearchParams(searchParams);
    next.delete("plugin");
    next.delete("oauth");
    next.delete("reason");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  // Windows and Android open the provider in the system browser, so this window
  // never sees the redirect. Polling the status endpoint is the only honest way
  // to learn that the sign-in landed.
  const waitingPluginId = signIn?.phase === "waiting" ? signIn.pluginId : "";
  const waitingOfferId = signIn?.phase === "waiting" ? signIn.offerId : "";
  useEffect(() => {
    if (!waitingOfferId) return undefined;
    let cancelled = false;
    const deadline = Date.now() + SIGN_IN_WAIT_MS;
    const timer = setInterval(async () => {
      if (Date.now() > deadline) {
        clearInterval(timer);
        if (!cancelled) {
          setSignIn(current => (current?.pluginId === waitingPluginId ? { ...current, phase: "expired" } : current));
        }
        return;
      }
      try {
        const status = await fetchPluginOAuthStatus(waitingOfferId);
        if (cancelled || status.connection !== "connected") return;
        clearInterval(timer);
        await load();
        if (cancelled) return;
        const who = accountLabel(status.account);
        setSignIn(null);
        setNotice(who ? `Signed in with GitHub as ${who}.` : "Signed in with GitHub.");
        setDetailId(waitingPluginId);
      } catch {
        // One failed poll is not a failed sign-in; the next tick asks again.
      }
    }, SIGN_IN_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [waitingOfferId, waitingPluginId]);

  async function startSignIn(plugin) {
    const offerId = signInTarget(plugin);
    if (!offerId || signIn) return;
    setError("");
    setSignIn({ pluginId: plugin.id, offerId, name: plugin.name, phase: "opening", message: "" });
    try {
      const { url } = await startPluginOAuth(offerId);
      await openExternalUrl(url);
      setSignIn(current => (current?.pluginId === plugin.id ? { ...current, phase: "waiting", message: "" } : current));
    } catch (startFailure) {
      setSignIn(current => (
        current?.pluginId === plugin.id
          ? { ...current, phase: "error", message: oauthStartFailureText(getApiErrorCode(startFailure), getApiErrorMessage(startFailure)) }
          : current
      ));
    }
  }

  function dismissSignIn() {
    setSignIn(null);
  }

  function openDetail(id) {
    setDetailError("");
    setDetailId(id);
  }

  // The sign-in companion is the same integration under a different credential,
  // so it is offered from the primary card instead of as a duplicate entry.
  const catalog = useMemo(() => plugins.filter(plugin => plugin.marketplaceEntry !== false), [plugins]);

  const categories = useMemo(
    () => [...new Set(catalog.map(plugin => plugin.category))].sort((a, b) => (CATEGORY_LABELS[a] || a).localeCompare(CATEGORY_LABELS[b] || b)),
    [catalog]
  );

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return catalog.filter(plugin => {
      const connected = plugin.installed || Boolean(plugin.oauth?.installed);
      if (category !== "all" && plugin.category !== category) return false;
      if (statusFilter === "installed" && !connected) return false;
      if (statusFilter === "ready" && (connected || plugin.availability !== "available")) return false;
      if (statusFilter === "setup" && (connected || plugin.availability !== "requires_setup")) return false;
      if (statusFilter === "development" && plugin.availability !== "in_development") return false;
      if (!needle) return true;
      return `${plugin.name} ${plugin.description} ${plugin.category}`.toLowerCase().includes(needle);
    });
  }, [catalog, query, category, statusFilter]);

  function openConnect(plugin) {
    setConnectId(plugin.id);
    setConnectError("");
    setConnectValues(Object.fromEntries((plugin.auth.fields || []).map(field => [
      field.key,
      field.type === "select" ? field.options?.[0]?.value || "" : ""
    ])));
  }

  // Whatever the server or a provider sends back passes through the redactor
  // before it can reach the screen, the notice line, or a thrown error message.
  function safeMessage(value, fallback) {
    return redactSecrets(value || fallback);
  }

  async function submitConnect(event) {
    event.preventDefault();
    if (!connectTarget || connectBusy) return;
    setConnectBusy(true);
    setConnectError("");
    try {
      const payload = {};
      for (const field of connectTarget.auth.fields || []) {
        const value = connectValues[field.key];
        if (value !== undefined && value !== "") payload[field.key] = value;
      }
      const result = connectTarget.installed
        ? await updatePlugin(connectTarget.id, payload)
        : await installPlugin(connectTarget.id, payload);
      setNotice(safeMessage(result.message, `${connectTarget.name} is connected.`));
      const id = connectTarget.id;
      setConnectId("");
      await load();
      setDetailId(id);
      setDetailError("");
    } catch (connectFailure) {
      setConnectError(safeMessage(getApiErrorMessage(connectFailure), "Could not save this connection."));
    } finally {
      setConnectBusy(false);
    }
  }

  async function handleTest(plugin, id = plugin.id) {
    setActionBusy(id);
    setError("");
    if (detailId === plugin.id) setDetailError("");
    try {
      const result = await testPlugin(id);
      setNotice(safeMessage(result.message, `${plugin.name} answered its connection check.`));
      await load();
    } catch (testError) {
      const message = safeMessage(getApiErrorMessage(testError), "The connection check did not succeed.");
      if (detailId === plugin.id) setDetailError(message);
      else setError(message);
    } finally {
      setActionBusy("");
    }
  }

  async function removePlugin() {
    if (!deleteTarget) return;
    const plugin = deleteTarget;
    try {
      await uninstallPlugin(plugin.id);
    } catch (removeError) {
      throw new Error(safeMessage(getApiErrorMessage(removeError), `Could not disconnect ${plugin.name}.`));
    }
    setNotice(`${plugin.name} disconnected.`);
    if (detailId === plugin.id) setDetailId("");
    setDeleteTarget(null);
    await load();
  }

  async function runPluginTool(tool, args, confirm) {
    if (!detail) throw new Error("Open the plugin before running an action.");
    // The token row of a card can be empty while its sign-in row holds the live
    // credential, so the call goes to whichever installation exists.
    const connectionId = detail.installed ? detail.id : detail.oauth?.pluginId || detail.id;
    try {
      const response = await executePluginTool(connectionId, tool.name, args, confirm);
      await load();
      return response;
    } catch (runError) {
      // A provider rejection also changes the stored connection status, so the
      // card and the open panel are refreshed before the error reaches the form.
      await load().catch(() => {});
      throw new Error(safeMessage(getApiErrorMessage(runError), "That action did not run."));
    }
  }

  return (
    <main className="vr-page" id="main-content">
      <div className="vr-page-shell vr-plugins-shell">
        <header className="vr-page-head">
          <div>
            <span className="vr-page-kicker">PLUGIN MARKETPLACE</span>
            <h1>Connect the tools you already use.</h1>
            <p>
              Browse a transparent catalog, connect only the integrations with a real adapter, and let the assistant use
              the tools you have approved. Catalog-only entries are labeled and cannot be installed.
            </p>
          </div>
          <div className="vr-page-actions">
            <span className="vr-plugin-count">
              <PuzzlePiece size={15} /> {summary ? `${summary.catalog} integrations` : "Loading catalog"}
            </span>
          </div>
        </header>

        {error ? <div className="vr-inline-error" role="alert">{error}</div> : null}
        {notice ? <div className="vr-inline-success" role="status">{notice}</div> : null}

        {signIn ? (
          <div className="vr-plugin-signin" data-phase={signIn.phase} role="status" aria-live="polite">
            {signIn.phase === "opening" || signIn.phase === "waiting" ? (
              <CircleNotch size={16} className="vr-spin" />
            ) : (
              <WarningCircle size={16} />
            )}
            <div>
              <strong>
                {signIn.phase === "waiting"
                  ? `Waiting for ${signIn.name}`
                  : signIn.phase === "expired"
                    ? "The sign-in did not come back"
                    : signIn.phase === "error"
                      ? `${signIn.name} sign-in could not start`
                      : `Opening the ${signIn.name} sign-in…`}
              </strong>
              <span>
                {signIn.message
                  || (signIn.phase === "waiting"
                    ? `Approve the request in the browser tab that just opened. This page updates on its own as soon as the server confirms the connection — you can keep working here.`
                    : signIn.phase === "expired"
                      ? "The approval tab may have been closed, or the attempt timed out. Nothing was connected, and no access was granted."
                      : "Asking the server for a single-use sign-in link.")}
              </span>
            </div>
            <button
              type="button"
              className="vr-secondary-small"
              onClick={() => {
                if (signIn.phase === "error" || signIn.phase === "expired") {
                  const plugin = plugins.find(item => item.id === signIn.pluginId);
                  if (plugin) startSignIn(plugin);
                  return;
                }
                dismissSignIn();
              }}
            >
              {signIn.phase === "error" || signIn.phase === "expired" ? "Try again" : "Cancel"}
            </button>
          </div>
        ) : null}

        <section className="vr-plugin-stats" aria-label="Plugin catalog summary">
          <article className="vr-plugin-stat">
            <span>Catalog</span>
            <strong>{summary?.catalog ?? "—"}</strong>
            <small>{summary ? `${summary.implemented} adapters implemented` : "Loading"}</small>
          </article>
          <article className="vr-plugin-stat">
            <span>Ready now</span>
            <strong>{summary?.available ?? "—"}</strong>
            <small>No credentials required</small>
          </article>
          <article className="vr-plugin-stat">
            <span>Needs credentials</span>
            <strong>{summary?.requiresSetup ?? "—"}</strong>
            <small>API key required</small>
          </article>
          <article className="vr-plugin-stat">
            <span>Installed</span>
            <strong>{summary?.installed ?? "—"}</strong>
            <small>{summary ? `${summary.connected} connected` : "Loading"}</small>
          </article>
        </section>

        <section className="vr-plugin-toolbar" aria-label="Filter plugins">
          <label className="vr-plugin-search">
            <MagnifyingGlass size={16} aria-hidden="true" />
            <input
              value={query}
              onChange={event => setQuery(event.target.value)}
              placeholder="Search integrations"
              aria-label="Search integrations"
            />
          </label>
          <select className="vr-select" value={statusFilter} onChange={event => setStatusFilter(event.target.value)} aria-label="Filter by status">
            <option value="all">All statuses</option>
            <option value="ready">Ready now</option>
            <option value="setup">Needs credentials</option>
            <option value="installed">Installed</option>
            <option value="development">In development</option>
          </select>
        </section>

        <div className="vr-plugin-categories" role="tablist" aria-label="Plugin categories">
          <button type="button" className="vr-plugin-category" data-active={category === "all" ? "" : undefined} onClick={() => setCategory("all")}>
            All
          </button>
          {categories.map(item => (
            <button
              key={item}
              type="button"
              className="vr-plugin-category"
              data-active={category === item ? "" : undefined}
              onClick={() => setCategory(item)}
            >
              {CATEGORY_LABELS[item] || item}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="vr-plugin-loading" role="status">
            <QuantumLoader decorative />
            <span>Loading plugin catalog…</span>
          </div>
        ) : filtered.length === 0 ? (
          <div className="vr-card vr-empty-card">
            <Sparkle size={20} />
            <strong>No integrations match</strong>
            <span>Try a different search, category, or status filter.</span>
          </div>
        ) : (
          <section className="vr-plugin-grid" aria-label="Plugins">
            {filtered.map(plugin => {
              const status = statusMeta(plugin);
              const CategoryIcon = CATEGORY_ICONS[plugin.category] || PuzzlePiece;
              const installed = plugin.installed || Boolean(plugin.oauth?.installed);
              // A card connected only through its sign-in row still has to be
              // tested and managed through that row's id, not the empty token row.
              const connectionId = plugin.installed ? plugin.id : plugin.oauth?.pluginId || plugin.id;
              const offerId = plugin.oauth?.installed ? "" : signInTarget(plugin);
              const signInBusy = Boolean(signIn) && signIn.pluginId === plugin.id;
              return (
                <article className="vr-card vr-plugin-card" key={plugin.id} data-installed={installed ? "" : undefined}>
                  <div className="vr-plugin-card-head">
                    <span className="vr-plugin-icon"><CategoryIcon size={18} /></span>
                    <div>
                      <h2>{plugin.name}</h2>
                      <span className="vr-plugin-category-label">{CATEGORY_LABELS[plugin.category] || plugin.category}</span>
                    </div>
                    <span className="vr-status-pill" data-tone={status.tone}>{status.label}</span>
                  </div>
                  <p>{plugin.description}</p>
                  <div className="vr-plugin-meta">
                    <span>{plugin.auth.label}</span>
                    <span>{plugin.tools.length} tool{plugin.tools.length === 1 ? "" : "s"}</span>
                  </div>
                  <div className="vr-plugin-card-actions">
                    <button type="button" className="vr-secondary-small" onClick={() => openDetail(plugin.id)}>
                      Details
                    </button>
                    {installed ? (
                      <>
                        <button type="button" className="vr-secondary-small" onClick={() => handleTest(plugin, connectionId)} disabled={actionBusy === connectionId}>
                          {actionBusy === connectionId ? "Testing…" : "Test"}
                        </button>
                        <button type="button" className="vr-primary-small" onClick={() => openDetail(plugin.id)}>
                          Manage
                        </button>
                      </>
                    ) : offerId && canConnect(plugin) ? (
                      <>
                        <button
                          type="button"
                          className="vr-secondary-small"
                          onClick={() => openConnect(plugin)}
                          disabled={signInBusy}
                        >
                          <Key size={13} /> {tokenButtonLabel(plugin)}
                        </button>
                        <button
                          type="button"
                          className="vr-primary-small"
                          onClick={() => startSignIn(plugin)}
                          disabled={signInBusy}
                        >
                          {signInBusy
                            ? <><CircleNotch size={14} className="vr-spin" /> Connecting…</>
                            : <><GithubLogo size={14} /> {signInButtonLabel(plugin)}</>}
                        </button>
                      </>
                    ) : offerId ? (
                      <button type="button" className="vr-primary-small" onClick={() => startSignIn(plugin)} disabled={signInBusy}>
                        {signInBusy
                          ? <><CircleNotch size={14} className="vr-spin" /> Connecting…</>
                          : <><GithubLogo size={14} /> {signInButtonLabel(plugin)}</>}
                      </button>
                    ) : canConnect(plugin) ? (
                      <button type="button" className="vr-primary-small" onClick={() => openConnect(plugin)}>
                        {plugin.auth.type === "none" ? "Turn on" : "Connect"}
                      </button>
                    ) : (
                      <button type="button" className="vr-secondary-small" disabled>
                        Adapter in development
                      </button>
                    )}
                  </div>
                </article>
              );
            })}
          </section>
        )}

        {activity.length > 0 ? (
          <section className="vr-plugin-activity">
            <div className="vr-plugin-section-head">
              <div>
                <span className="vr-page-kicker">AUDIT LOG</span>
                <h2>Recent plugin activity</h2>
              </div>
              <span className="vr-plugin-muted">Credentials and tool arguments are never logged.</span>
            </div>
            <div className="vr-plugin-activity-list">
              {activity.map((entry, index) => {
                const plugin = plugins.find(item => item.id === entry.pluginId);
                return (
                  <div className="vr-plugin-activity-row" key={`${entry.createdAt}-${index}`}>
                    <span className="vr-plugin-activity-dot" data-status={entry.status} />
                    <div>
                      <strong>{plugin?.name || entry.pluginId}</strong>
                      <span>{entry.action}{entry.toolName ? ` · ${entry.toolName}` : ""}{entry.source === "ai" ? " · AI" : ""}</span>
                    </div>
                    <span className="vr-plugin-activity-time">{formatDate(entry.createdAt)}</span>
                  </div>
                );
              })}
            </div>
          </section>
        ) : null}

        <p className="vr-page-note">
          <ShieldCheck size={13} /> Credentials are encrypted on the server and never returned to the app. Catalog-only
          integrations are listed for transparency and cannot be installed until a real adapter exists.
        </p>
      </div>

      {detail && !connectTarget ? (
        <Modal
          title={detail.name}
          subtitle={`${CATEGORY_LABELS[detail.category] || detail.category} · ${detail.auth.label}`}
          onClose={() => setDetailId("")}
          wide
          footer={
            <div className="vr-plugin-modal-actions">
              <button type="button" className="vr-secondary-small" onClick={() => setDetailId("")}>Close</button>
            </div>
          }
        >
          {detailError ? <div className="vr-inline-error" role="alert">{detailError}</div> : null}
          <PluginDetailView
            key={detail.id}
            plugin={detail}
            testing={actionBusy === detail.id || actionBusy === detail.oauth?.pluginId}
            runDebug={runPluginTool}
            onTest={() => handleTest(detail, detail.installed ? detail.id : detail.oauth?.pluginId || detail.id)}
            onConnect={() => openConnect(detail)}
            onDisconnect={() => setDeleteTarget(detail)}
            onRunAction={name => setActionTool({ pluginId: detail.id, name })}
            onSignIn={() => startSignIn(detail)}
            signInPhase={signIn?.pluginId === detail.id ? signIn.phase : ""}
            signInMessage={signIn?.pluginId === detail.id ? signIn.message : ""}
            onDisconnectSignIn={() => setDeleteTarget({
              id: detail.oauth.pluginId,
              name: `${detail.name} sign-in`
            })}
          />
        </Modal>
      ) : null}

      {connectTarget ? (
        <Modal
          title={connectTarget.installed ? `Update ${connectTarget.name}` : `Connect ${connectTarget.name}`}
          subtitle={connectTarget.auth.label}
          onClose={() => { if (!connectBusy) setConnectId(""); }}
          footer={
            <div className="vr-plugin-modal-actions">
              <button type="button" className="vr-secondary-small" onClick={() => setConnectId("")} disabled={connectBusy}>Cancel</button>
              <button type="submit" form="vr-plugin-connect-form" className="vr-primary-small" disabled={connectBusy}>
                {connectBusy ? (
                  <><CircleNotch size={14} className="vr-spin" /> Testing…</>
                ) : connectTarget.installed
                  ? "Save and test"
                  : connectTarget.auth.type === "none"
                    ? "Turn on"
                    : "Connect and test"}
              </button>
            </div>
          }
        >
          <form id="vr-plugin-connect-form" className="vr-plugin-connect-form" onSubmit={submitConnect}>
            {(() => {
              const guidance = setupGuidance(connectTarget);
              return (
                <>
                  <div className="vr-plugin-connect-intro">
                    <strong>{guidance.headline}</strong>
                    <p>{guidance.sentence}</p>
                  </div>
                  {guidance.worksWithout?.length ? (
                    <p className="vr-plugin-muted">
                      Keeps working without a token: {guidance.worksWithout.join(", ").toLowerCase()}.
                    </p>
                  ) : null}
                  {guidance.needsTokenFor?.length ? (
                    <p className="vr-plugin-muted">
                      {guidance.requiresCredentials ? "Needs the key" : "Needs the token"}:{" "}
                      {guidance.needsTokenFor.join(", ").toLowerCase()}.
                    </p>
                  ) : null}
                  {guidance.minimumAccess ? (
                    <p className="vr-plugin-setup-note">
                      <ShieldCheck size={14} />
                      <span>
                        <strong>Narrowest access that works:</strong> {guidance.minimumAccess}
                        {guidance.guidanceUrl ? (
                          <>
                            {" "}
                            <ExternalAnchor href={guidance.guidanceUrl}>
                              {guidance.guidanceLabel || "Open the provider site"}
                            </ExternalAnchor>
                          </>
                        ) : null}
                      </span>
                    </p>
                  ) : null}
                </>
              );
            })()}
            {(connectTarget.auth.fields || []).map(field => (
              <label key={field.key}>
                <span>{field.label}{field.required ? "" : " (optional)"}</span>
                {field.type === "select" ? (
                  <select
                    className="vr-select"
                    value={connectValues[field.key] || ""}
                    onChange={event => setConnectValues(current => ({ ...current, [field.key]: event.target.value }))}
                  >
                    {(field.options || []).map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                ) : (
                  <input
                    type={field.type === "password" ? "password" : field.type === "url" ? "url" : "text"}
                    value={connectValues[field.key] || ""}
                    onChange={event => setConnectValues(current => ({ ...current, [field.key]: event.target.value }))}
                    placeholder={connectTarget.installed && field.secret ? "Leave blank to keep the saved value" : field.placeholder || ""}
                    autoComplete="off"
                    required={field.required && !connectTarget.installed}
                  />
                )}
              </label>
            ))}
            <p className="vr-plugin-setup-note">
              <ShieldCheck size={14} />
              <span>
                Paste credentials here, never into a chat message. They are sent over HTTPS, encrypted on the server, and
                never shown again — leaving a secret field blank keeps the saved value.
              </span>
            </p>
            {connectError ? <div className="vr-inline-error" role="alert">{connectError}</div> : null}
          </form>
        </Modal>
      ) : null}

      {detail && actionTool ? (
        (() => {
          const tool = detail.tools.find(item => item.name === actionTool.name);
          if (!tool || actionTool.pluginId !== detail.id) return null;
          return (
            <PluginActionDialog
              key={`${detail.id}:${tool.name}`}
              plugin={detail}
              tool={tool}
              onClose={() => setActionTool(null)}
              onRun={runPluginTool}
            />
          );
        })()
      ) : null}

      <HoldToDeleteDialog
        open={Boolean(deleteTarget)}
        title="Disconnect this plugin?"
        itemName={deleteTarget?.name || "Plugin"}
        description="This removes the saved credentials and disables its tools for your account. You can connect it again later."
        successMessage="Plugin disconnected."
        onCancel={() => setDeleteTarget(null)}
        onConfirm={removePlugin}
      />
    </main>
  );
}
