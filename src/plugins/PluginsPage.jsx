import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowSquareOut,
  BookOpen,
  Briefcase,
  ChartBar,
  ChatCircle,
  CheckCircle,
  CircleNotch,
  Code,
  Database,
  Globe,
  Image,
  Lightning,
  MagnifyingGlass,
  Plugs,
  PuzzlePiece,
  ShieldCheck,
  Sparkle,
  Trash,
  WarningCircle,
  Wrench,
  X
} from "@phosphor-icons/react";
import HoldToDeleteDialog from "../components/HoldToDeleteDialog.jsx";
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
  in_development: { label: "In development", tone: "muted" },
  connected: { label: "Connected", tone: "ok" },
  needs_reconnection: { label: "Reconnect", tone: "warn" },
  error: { label: "Error", tone: "danger" },
  disabled: { label: "Disabled", tone: "muted" },
  disconnected: { label: "Not installed", tone: "muted" }
};

function pluginStatus(plugin) {
  return plugin.installed ? plugin.connection : plugin.availability;
}

function statusMeta(plugin) {
  return STATUS_META[pluginStatus(plugin)] || STATUS_META.in_development;
}

function canConnect(plugin) {
  return plugin.availability === "available" || plugin.availability === "requires_setup";
}

function exampleArgs(schema) {
  const properties = schema?.properties || {};
  const values = {};
  for (const [key, field] of Object.entries(properties)) {
    if (field.default !== undefined) values[key] = field.default;
    else if (field.type === "integer") values[key] = field.minimum ?? 1;
    else if (field.type === "number") values[key] = field.minimum ?? 0;
    else if (field.type === "boolean") values[key] = false;
    else if (field.type === "array") values[key] = [];
    else if (field.type === "object") values[key] = {};
    else values[key] = "";
  }
  return values;
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
  const [toolName, setToolName] = useState("");
  const [toolArgs, setToolArgs] = useState("{}");
  const [toolConfirm, setToolConfirm] = useState(false);
  const [toolBusy, setToolBusy] = useState(false);
  const [toolResult, setToolResult] = useState("");
  const [toolError, setToolError] = useState("");

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

  useEffect(() => {
    if (!detail) return;
    const firstTool = detail.tools?.[0];
    setToolName(firstTool?.name || "");
    setToolArgs(firstTool ? JSON.stringify(exampleArgs(firstTool.inputSchema), null, 2) : "{}");
    setToolResult("");
    setToolError("");
    setToolConfirm(false);
  }, [detail?.id]);

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
    setDetailId("");
    setConnectId(plugin.id);
    setConnectError("");
    setConnectValues(Object.fromEntries((plugin.auth.fields || []).map(field => [
      field.key,
      field.type === "select" ? field.options?.[0]?.value || "" : ""
    ])));
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
      setNotice(result.message || `${connectTarget.name} is connected.`);
      const id = connectTarget.id;
      setConnectId("");
      await load();
      setDetailId(id);
    } catch (connectFailure) {
      setConnectError(getApiErrorMessage(connectFailure));
    } finally {
      setConnectBusy(false);
    }
  }

  async function handleTest(plugin) {
    setActionBusy(plugin.id);
    setError("");
    try {
      const result = await testPlugin(plugin.id);
      setNotice(result.message || `${plugin.name} is connected.`);
      await load();
    } catch (testError) {
      setError(getApiErrorMessage(testError));
    } finally {
      setActionBusy("");
    }
  }

  async function removePlugin() {
    if (!deleteTarget) return;
    const plugin = deleteTarget;
    await uninstallPlugin(plugin.id);
    setNotice(`${plugin.name} disconnected.`);
    if (detailId === plugin.id) setDetailId("");
    setDeleteTarget(null);
    await load();
  }

  function chooseTool(name) {
    const tool = detail?.tools?.find(item => item.name === name);
    setToolName(name);
    setToolArgs(tool ? JSON.stringify(exampleArgs(tool.inputSchema), null, 2) : "{}");
    setToolResult("");
    setToolError("");
    setToolConfirm(false);
  }

  async function runTool() {
    if (!detail || !toolName || toolBusy) return;
    let args;
    try {
      args = JSON.parse(toolArgs || "{}");
      if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("not an object");
    } catch {
      setToolError("Tool arguments must be a JSON object.");
      return;
    }
    const tool = detail.tools?.find(item => item.name === toolName);
    if (tool?.sensitive && !toolConfirm) {
      setToolError("Confirm this action before running the tool.");
      return;
    }
    setToolBusy(true);
    setToolError("");
    setToolResult("");
    try {
      const result = await executePluginTool(detail.id, toolName, args, toolConfirm);
      setToolResult(JSON.stringify(result.result, null, 2));
      await load();
    } catch (runError) {
      setToolError(getApiErrorMessage(runError));
    } finally {
      setToolBusy(false);
    }
  }

  const detailStatus = detail ? statusMeta(detail) : null;

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
          <div className="vr-plugin-loading" role="status"><CircleNotch size={20} className="vr-spin" /> Loading plugin catalog…</div>
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
                    <button type="button" className="vr-secondary-small" onClick={() => setDetailId(plugin.id)}>
                      Details
                    </button>
                    {installed ? (
                      <>
                        <button type="button" className="vr-secondary-small" onClick={() => handleTest(plugin)} disabled={actionBusy === plugin.id}>
                          {actionBusy === plugin.id ? "Testing…" : "Test"}
                        </button>
                        <button type="button" className="vr-primary-small" onClick={() => setDetailId(plugin.id)}>
                          Manage
                        </button>
                      </>
                    ) : canConnect(plugin) ? (
                      <button type="button" className="vr-primary-small" onClick={() => openConnect(plugin)}>
                        {plugin.auth.type === "none" ? "Install" : "Connect"}
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

      {detail ? (
        <Modal
          title={detail.name}
          subtitle={`${CATEGORY_LABELS[detail.category] || detail.category} · ${detail.auth.label}`}
          onClose={() => setDetailId("")}
          wide
          footer={
            <div className="vr-plugin-modal-actions">
              <button type="button" className="vr-secondary-small" onClick={() => setDetailId("")}>Close</button>
              {detail.installed ? (
                <>
                  <button type="button" className="vr-secondary-small" onClick={() => openConnect(detail)}>Update credentials</button>
                  <button type="button" className="vr-primary-small" onClick={() => handleTest(detail)} disabled={actionBusy === detail.id}>
                    {actionBusy === detail.id ? "Testing…" : "Test connection"}
                  </button>
                  <button type="button" className="vr-danger-small" onClick={() => setDeleteTarget(detail)}>
                    <Trash size={14} /> Uninstall
                  </button>
                </>
              ) : canConnect(detail) ? (
                <button type="button" className="vr-primary-small" onClick={() => openConnect(detail)}>
                  {detail.auth.type === "none" ? "Install plugin" : "Connect plugin"}
                </button>
              ) : null}
            </div>
          }
        >
          <div className="vr-plugin-detail-status">
            <span className="vr-status-pill" data-tone={detailStatus?.tone}>{detailStatus?.label}</span>
            <span>{detail.tools.length} tool{detail.tools.length === 1 ? "" : "s"}</span>
            {detail.website ? (
              <a href={detail.website} target="_blank" rel="noreferrer">
                Official site <ArrowSquareOut size={13} />
              </a>
            ) : null}
          </div>
          <p className="vr-plugin-detail-description">{detail.description}</p>

          {detail.installed ? (
            <div className="vr-plugin-installed-panel">
              <div>
                <span>Connection</span>
                <strong>{detailStatus?.label}</strong>
              </div>
              <div>
                <span>Last tested</span>
                <strong>{formatDate(detail.lastTestAt)}</strong>
              </div>
              <div>
                <span>Credentials</span>
                <strong>{Object.keys(detail.credentialsConfigured || {}).length ? "Saved securely" : "Not required"}</strong>
              </div>
              {detail.lastTestMessage ? <p>{detail.lastTestMessage}</p> : null}
            </div>
          ) : detail.availability === "in_development" ? (
            <div className="vr-callout vr-callout--warning">
              <WarningCircle size={18} />
              <div>
                <strong>Adapter in development</strong>
                <span>This integration is listed so the catalog is honest about what is planned. It has no executable adapter yet and cannot be installed.</span>
              </div>
            </div>
          ) : null}

          <section className="vr-plugin-permissions">
            <ShieldCheck size={17} />
            <div>
              <h3>Permissions</h3>
              <ul>{detail.permissions.map(permission => <li key={permission}>{permission}</li>)}</ul>
            </div>
          </section>

          {detail.tools.length > 0 ? (
            <section className="vr-plugin-tools">
              <h3>Tools</h3>
              <div className="vr-plugin-tool-list">
                {detail.tools.map(tool => (
                  <div className="vr-plugin-tool" key={tool.name}>
                    <div>
                      <strong>{tool.name}</strong>
                      <span>{tool.description}</span>
                    </div>
                    <div className="vr-plugin-tool-actions">
                      {tool.sensitive ? <span className="vr-status-pill" data-tone="warn">Confirmation required</span> : null}
                      {detail.installed ? (
                        <button type="button" className="vr-link-button" onClick={() => chooseTool(tool.name)}>Use tool</button>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          {detail.installed && detail.tools.length > 0 ? (
            <section className="vr-plugin-console">
              <div className="vr-plugin-section-head">
                <div>
                  <span className="vr-page-kicker">TOOL CONSOLE</span>
                  <h3>Run a tool</h3>
                </div>
                <span className="vr-plugin-muted">Results are not stored in chat history.</span>
              </div>
              <label>
                <span>Tool</span>
                <select className="vr-select" value={toolName} onChange={event => chooseTool(event.target.value)}>
                  {detail.tools.map(tool => <option key={tool.name} value={tool.name}>{tool.name}</option>)}
                </select>
              </label>
              <label>
                <span>Arguments (JSON)</span>
                <textarea value={toolArgs} onChange={event => setToolArgs(event.target.value)} rows={7} spellCheck={false} />
              </label>
              {detail.tools.find(tool => tool.name === toolName)?.sensitive ? (
                <label className="vr-plugin-confirm">
                  <input type="checkbox" checked={toolConfirm} onChange={event => setToolConfirm(event.target.checked)} />
                  I confirm this action changes data or sends a message.
                </label>
              ) : null}
              {toolError ? <div className="vr-inline-error" role="alert">{toolError}</div> : null}
              <div className="vr-plugin-console-actions">
                <button type="button" className="vr-primary-small" onClick={runTool} disabled={toolBusy}>
                  {toolBusy ? <><CircleNotch size={14} className="vr-spin" /> Running…</> : "Run tool"}
                </button>
              </div>
              {toolResult ? (
                <pre className="vr-plugin-result" aria-label="Tool result">{toolResult}</pre>
              ) : null}
            </section>
          ) : null}
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
                {connectBusy ? <><CircleNotch size={14} className="vr-spin" /> Testing…</> : connectTarget.installed ? "Save connection" : "Connect"}
              </button>
            </div>
          }
        >
          <form id="vr-plugin-connect-form" className="vr-plugin-connect-form" onSubmit={submitConnect}>
            <p>
              {connectTarget.auth.type === "none"
                ? "This integration uses public data and does not need an account or key."
                : "Credentials are sent over HTTPS, encrypted on the server, and never returned to this app."}
            </p>
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
            {connectError ? <div className="vr-inline-error" role="alert">{connectError}</div> : null}
          </form>
        </Modal>
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
