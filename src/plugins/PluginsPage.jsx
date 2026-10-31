import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  BookOpen,
  Briefcase,
  ChartBar,
  ChatCircle,
  CircleNotch,
  Code,
  Database,
  Globe,
  Image,
  Lightning,
  MagnifyingGlass,
  PuzzlePiece,
  ShieldCheck,
  Sparkle,
  Wrench,
  X
} from "@phosphor-icons/react";
import HoldToDeleteDialog from "../components/HoldToDeleteDialog.jsx";
import ExternalAnchor from "../components/ExternalLink.jsx";
import { QuantumLoader } from "../components/LoadingVisuals.jsx";
import {
  executePluginTool,
  fetchPluginActivity,
  getApiErrorMessage,
  installPlugin,
  listPlugins,
  testPlugin,
  uninstallPlugin,
  updatePlugin
} from "../services/api.js";
import PluginActionDialog from "./PluginActionDialog.jsx";
import PluginDetailView from "./PluginDetailView.jsx";
import { connectionStatus, redactSecrets, setupGuidance } from "./pluginDetails.js";
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
function statusMeta(plugin) {
  if (plugin.installed) {
    const status = connectionStatus(plugin);
    return { label: status.label, tone: status.tone };
  }
  return STATUS_META[plugin.availability] || STATUS_META.in_development;
}

function canConnect(plugin) {
  return plugin.availability === "available" || plugin.availability === "requires_setup";
}

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

  function openDetail(id) {
    setDetailError("");
    setDetailId(id);
  }

  const categories = useMemo(
    () => [...new Set(plugins.map(plugin => plugin.category))].sort((a, b) => (CATEGORY_LABELS[a] || a).localeCompare(CATEGORY_LABELS[b] || b)),
    [plugins]
  );

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return plugins.filter(plugin => {
      if (category !== "all" && plugin.category !== category) return false;
      if (statusFilter === "installed" && !plugin.installed) return false;
      if (statusFilter === "ready" && (plugin.installed || plugin.availability !== "available")) return false;
      if (statusFilter === "setup" && (plugin.installed || plugin.availability !== "requires_setup")) return false;
      if (statusFilter === "development" && plugin.availability !== "in_development") return false;
      if (!needle) return true;
      return `${plugin.name} ${plugin.description} ${plugin.category}`.toLowerCase().includes(needle);
    });
  }, [plugins, query, category, statusFilter]);

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

  async function handleTest(plugin) {
    setActionBusy(plugin.id);
    setError("");
    if (detailId === plugin.id) setDetailError("");
    try {
      const result = await testPlugin(plugin.id);
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
    try {
      const response = await executePluginTool(detail.id, tool.name, args, confirm);
      await load();
      return response;
    } catch (runError) {
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
              const installed = plugin.installed;
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
                        <button type="button" className="vr-secondary-small" onClick={() => handleTest(plugin)} disabled={actionBusy === plugin.id}>
                          {actionBusy === plugin.id ? "Testing…" : "Test"}
                        </button>
                        <button type="button" className="vr-primary-small" onClick={() => openDetail(plugin.id)}>
                          Manage
                        </button>
                      </>
                    ) : canConnect(plugin) ? (
                      <button type="button" className="vr-primary-small" onClick={() => openConnect(plugin)}>
                        {plugin.auth.type === "none" ? "Turn on" : "Connect"}
                      </button>
                    ) : (
                      <button type="button" className="vr-secondary-small" disabled>
                        {plugin.availability === "in_development" ? "Adapter in development" : "OAuth not configured"}
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
            testing={actionBusy === detail.id}
            runDebug={runPluginTool}
            onTest={() => handleTest(detail)}
            onConnect={() => openConnect(detail)}
            onDisconnect={() => setDeleteTarget(detail)}
            onRunAction={name => setActionTool({ pluginId: detail.id, name })}
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
