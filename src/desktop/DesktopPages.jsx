import React, { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  ArrowRight,
  Check,
  PencilSimple,
  Plus,
  ShieldCheck,
  Sparkle,
  Trash,
  WarningCircle
} from "@phosphor-icons/react";
import HoldToDeleteDialog from "../components/HoldToDeleteDialog.jsx";
import ApplicationUpdates from "../components/ApplicationUpdates.jsx";
import {
  clearDesktopToolGrants,
  listDesktopToolGrants,
  revokeDesktopToolGrant
} from "../native/desktopTools.js";
import { isTauriRuntime } from "../native/shell.js";
import { useAuth } from "../context/AuthContext.jsx";
import {
  AUTOMATION_SCHEDULES,
  automationError,
  createAutomationId,
  loadAutomations,
  normalizeAutomation,
  saveAutomations
} from "./automations.js";
import { usePreferences } from "./PreferencesContext.jsx";
import { useTasks } from "./TaskContext.jsx";

function storage() {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function DesktopPage({ kicker, title, description, actions, children }) {
  return (
    <main className="vr-page" id="main-content">
      <div className="vr-page-shell">
        <header className="vr-page-head">
          <div>
            <span className="vr-page-kicker">{kicker}</span>
            <h1>{title}</h1>
            {description ? <p>{description}</p> : null}
          </div>
          {actions ? <div className="vr-page-actions">{actions}</div> : null}
        </header>
        {children}
      </div>
    </main>
  );
}

function ToggleRow({ title, description, checked, onChange, disabled = false }) {
  return (
    <label className="vr-setting-row" data-disabled={disabled ? "" : undefined}>
      <span className="vr-setting-copy">
        <strong>{title}</strong>
        {description ? <span>{description}</span> : null}
      </span>
      <input
        type="checkbox"
        className="vr-toggle"
        checked={checked}
        onChange={event => onChange(event.target.checked)}
        disabled={disabled}
      />
    </label>
  );
}

function FolderAccessSection() {
  const [grants, setGrants] = useState([]);
  const [status, setStatus] = useState("loading");
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState("");

  const load = useCallback(async () => {
    setStatus("loading");
    setError("");
    if (!isTauriRuntime()) {
      setStatus("web");
      return;
    }
    try {
      setGrants(await listDesktopToolGrants());
      setStatus("ready");
    } catch (cause) {
      setError(cause?.message || "Could not read the saved file permissions.");
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function revoke(id) {
    setBusyId(id);
    setError("");
    try {
      await revokeDesktopToolGrant(id);
      setGrants(prev => prev.filter(grant => grant.id !== id));
    } catch (cause) {
      setError(cause?.message || "That file permission could not be revoked.");
    } finally {
      setBusyId("");
    }
  }

  async function clearAll() {
    setBusyId("clear");
    setError("");
    try {
      await clearDesktopToolGrants();
      setGrants([]);
    } catch (cause) {
      setError(cause?.message || "The saved file permissions could not be cleared.");
    } finally {
      setBusyId("");
    }
  }

  return (
    <section className="vr-settings-group">
      <h2>Local file access</h2>
      <p className="vr-page-note">
        Files and apps you approved with &quot;Allow Always (Only for This File)&quot; &mdash; one exact file or
        executable, never its folder. Entries store only a path and permission type &mdash; no keys, no file contents,
        and no permission to modify or delete &mdash; and revoking one makes the next access ask again.
      </p>
      {status === "web" ? (
        <p className="vr-setting-hint">
          File permissions are managed by the Windows desktop app; the web app has no local file access.
        </p>
      ) : null}
      {status === "error" ? (
        <p className="vr-msg-error" role="alert">
          <WarningCircle size={16} aria-hidden="true" />
          <span>{error}</span>
        </p>
      ) : null}
      {status !== "web" ? (
        grants.length === 0 ? (
          <p className="vr-setting-hint">
            {status === "loading" ? "Checking this device…" : "No files or apps are remembered — every access asks first."}
          </p>
        ) : (
          <ul className="vr-grant-list">
            {grants.map(grant => (
              <li key={grant.id} className="vr-setting-row">
                <span className="vr-setting-copy">
                  <strong>{grant.name || grant.path}</strong>
                  <span title={grant.path}>{grant.path}</span>
                  <span>
                    {grant.kind === "contents"
                      ? "Can read this exact file"
                      : grant.kind === "launch"
                        ? "Can launch this exact app"
                        : "Exact item"}
                    {grant.createdAt ? ` · since ${new Date(grant.createdAt).toLocaleDateString()}` : ""}
                  </span>
                </span>
                <button
                  type="button"
                  className="vr-secondary-small"
                  disabled={busyId === grant.id || busyId === "clear"}
                  onClick={() => revoke(grant.id)}
                >
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        )
      ) : null}
      {status === "ready" && grants.length > 0 ? (
        <button
          type="button"
          className="vr-secondary-small"
          disabled={busyId !== ""}
          onClick={clearAll}
        >
          {busyId === "clear" ? "Clearing…" : "Revoke all files"}
        </button>
      ) : null}
    </section>
  );
}

export function AppSettingsPage() {
  const { preferences, update, reset } = usePreferences();
  return (
    <DesktopPage
      kicker="APPLICATION"
      title="Application settings"
      description="Preferences are stored on this device and applied to the workspace immediately."
      actions={
        <button type="button" className="vr-secondary-small" onClick={reset}>
          Reset defaults
        </button>
      }
    >
      <section className="vr-settings-group">
        <h2>Appearance</h2>
        <div className="vr-setting-row">
          <span className="vr-setting-copy">
            <strong>Dark workspace</strong>
            <span>The product uses a single dark theme. A light theme is not available in this build.</span>
          </span>
          <span className="vr-setting-badge">Active</span>
        </div>
        <ToggleRow
          title="Reduce motion"
          description="Stops decorative transitions and animations across the app."
          checked={preferences.reducedMotion}
          onChange={value => update("reducedMotion", value)}
        />
      </section>

      <section className="vr-settings-group">
        <h2>Behavior</h2>
        <label className="vr-setting-row">
          <span className="vr-setting-copy">
            <strong>Send messages with</strong>
            <span>Shift+Enter always inserts a newline. Ctrl+Enter remains available as a modifier shortcut.</span>
          </span>
          <select
            className="vr-select"
            value={preferences.sendShortcut}
            onChange={event => update("sendShortcut", event.target.value)}
          >
            <option value="enter">Enter</option>
            <option value="modifier">Ctrl+Enter</option>
          </select>
        </label>
        <ToggleRow
          title="Show task timestamps"
          description="Displays the last update time beside recent tasks."
          checked={preferences.showTaskTimestamps}
          onChange={value => update("showTaskTimestamps", value)}
        />
        <ToggleRow
          title="Start with the sidebar collapsed"
          description="Applies when the desktop workspace opens."
          checked={preferences.startSidebarCollapsed}
          onChange={value => update("startSidebarCollapsed", value)}
        />
      </section>

      <FolderAccessSection />

      <ApplicationUpdates />

      <section className="vr-settings-group">
        <h2>Shortcuts</h2>
        <div className="vr-shortcut-grid">
          <span><kbd>Ctrl</kbd><kbd>K</kbd></span><span>Focus task search</span>
          <span><kbd>Ctrl</kbd><kbd>N</kbd></span><span>Start a new task</span>
          <span><kbd>Esc</kbd></span><span>Close menus and dialogs</span>
          <span><kbd>Shift</kbd><kbd>Enter</kbd></span><span>Insert a newline</span>
        </div>
        <p className="vr-page-note">
          Ctrl+K and Ctrl+N are registered inside the desktop shell. Native folder dialogs are handled by Windows.
        </p>
      </section>
    </DesktopPage>
  );
}

export function AutomationsPage() {
  const { user } = useAuth();
  const { requestDraft } = useTasks();
  const navigate = useNavigate();
  const owner = user?.id || "guest";
  const [automations, setAutomations] = useState(() => loadAutomations(storage(), owner));
  const [editingId, setEditingId] = useState("");
  const [form, setForm] = useState({ name: "", prompt: "", schedule: "manual", time: "09:00" });
  const [error, setError] = useState("");
  const [deleteTarget, setDeleteTarget] = useState(null);

  useEffect(() => {
    setAutomations(loadAutomations(storage(), owner));
  }, [owner]);

  const persist = next => {
    setAutomations(saveAutomations(storage(), owner, next));
  };

  const resetForm = () => {
    setEditingId("");
    setForm({ name: "", prompt: "", schedule: "manual", time: "09:00" });
    setError("");
  };

  const submit = event => {
    event.preventDefault();
    const validation = automationError(form);
    if (validation) {
      setError(validation);
      return;
    }
    const now = new Date().toISOString();
    if (editingId) {
      persist(
        automations.map(item =>
          item.id === editingId
            ? normalizeAutomation({ ...item, ...form, updatedAt: now })
            : item
        )
      );
    } else {
      persist([
        normalizeAutomation({ ...form, id: createAutomationId(), createdAt: now, updatedAt: now }),
        ...automations
      ]);
    }
    resetForm();
  };

  const edit = automation => {
    setEditingId(automation.id);
    setForm({
      name: automation.name,
      prompt: automation.prompt,
      schedule: automation.schedule,
      time: automation.time
    });
    setError("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const requestRemove = automation => {
    setDeleteTarget(automation);
  };

  const remove = () => {
    const automation = deleteTarget;
    if (!automation?.id) {
      throw new Error("This automation is no longer available.");
    }
    persist(automations.filter(item => item.id !== automation.id));
    if (editingId === automation.id) resetForm();
  };

  const openAsTask = automation => {
    requestDraft(automation.prompt);
    navigate("/chat", { state: { newTask: Date.now() } });
  };

  return (
    <DesktopPage
      kicker="AUTOMATIONS"
      title="Automations"
      description="Save repeatable task briefs on this device. Background scheduling is not available in this build, so saved automations never run on their own."
    >
      <div className="vr-callout vr-callout--warning">
        <WarningCircle size={18} />
        <div>
          <strong>Draft automations only</strong>
          <span>
            There is no background scheduler or unattended execution yet. “Open as task” copies the brief into a new
            chat so you stay in control of every request.
          </span>
        </div>
      </div>

      <div className="vr-automation-grid">
        <form className="vr-card vr-automation-form" onSubmit={submit}>
          <h2>{editingId ? "Edit automation" : "New automation"}</h2>
          <label>
            <span>Name</span>
            <input
              value={form.name}
              onChange={event => setForm(current => ({ ...current, name: event.target.value }))}
              maxLength={80}
              placeholder="Weekly release review"
            />
          </label>
          <label>
            <span>Task brief</span>
            <textarea
              value={form.prompt}
              onChange={event => setForm(current => ({ ...current, prompt: event.target.value }))}
              maxLength={4000}
              rows={7}
              placeholder="Review open release blockers, summarize risks, and propose the next three actions."
            />
            <small>{form.prompt.length} / 4000 characters</small>
          </label>
          <div className="vr-automation-form-row">
            <label>
              <span>Intended cadence</span>
              <select
                className="vr-select"
                value={form.schedule}
                onChange={event => setForm(current => ({ ...current, schedule: event.target.value }))}
              >
                {AUTOMATION_SCHEDULES.map(option => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
            <label>
              <span>Time</span>
              <input
                type="time"
                value={form.time}
                onChange={event => setForm(current => ({ ...current, time: event.target.value }))}
                disabled={form.schedule === "manual"}
              />
            </label>
          </div>
          {error ? <div className="vr-inline-error">{error}</div> : null}
          <div className="vr-form-actions">
            <button type="submit" className="vr-primary-small">
              <Check size={15} /> {editingId ? "Save changes" : "Save draft"}
            </button>
            {editingId ? <button type="button" className="vr-secondary-small" onClick={resetForm}>Cancel</button> : null}
          </div>
        </form>

        <div className="vr-automation-list">
          {automations.length === 0 ? (
            <div className="vr-card vr-empty-card">
              <Sparkle size={20} />
              <strong>No saved automations yet</strong>
              <span>Saved briefs appear here, ready to open as a task.</span>
              <ol className="vr-empty-steps">
                <li>Write the brief in the form.</li>
                <li>Save it with a name you will recognise.</li>
                <li>Open it as a task when you need it — it never sends itself.</li>
              </ol>
            </div>
          ) : (
            automations.map(automation => (
              <article key={automation.id} className="vr-card vr-automation-card">
                <div className="vr-automation-card-head">
                  <div>
                    <span className="vr-page-kicker">DRAFT</span>
                    <h3>{automation.name}</h3>
                  </div>
                  <div className="vr-card-actions">
                    <button type="button" className="vr-icon-btn" onClick={() => edit(automation)} aria-label={`Edit ${automation.name}`} title="Edit">
                      <PencilSimple size={15} />
                    </button>
                    <button type="button" className="vr-icon-btn vr-icon-btn--danger" onClick={() => requestRemove(automation)} aria-label={`Delete ${automation.name}`} title="Delete">
                      <Trash size={15} />
                    </button>
                  </div>
                </div>
                <p>{automation.prompt}</p>
                <div className="vr-automation-meta">
                  <span>{AUTOMATION_SCHEDULES.find(item => item.value === automation.schedule)?.label}</span>
                  {automation.schedule !== "manual" ? <span>{automation.time}</span> : null}
                  <span>Not scheduled</span>
                </div>
                <button type="button" className="vr-link-button" onClick={() => openAsTask(automation)}>
                  Open as task <ArrowRight size={14} />
                </button>
              </article>
            ))
          )}
        </div>
      </div>
      <HoldToDeleteDialog
        open={Boolean(deleteTarget)}
        title="Delete this automation?"
        itemName={deleteTarget?.name || "Saved automation"}
        description="This removes the saved automation from this device. Tasks already created from it are not affected."
        successMessage="Automation deleted."
        onCancel={() => setDeleteTarget(null)}
        onConfirm={remove}
      />
    </DesktopPage>
  );
}

export function HelpPage() {
  return (
    <DesktopPage
      kicker="HELP"
      title="Workspace guide"
      description="A quick reference for tasks, attachments, permissions, and the boundaries of this build."
    >
      <section className="vr-help-grid">
        <article className="vr-card">
          <h2>Start a task</h2>
          <p>Choose New task in the sidebar, describe the outcome, and attach only the files needed for that request. Tasks are saved when the first request succeeds.</p>
        </article>
        <article className="vr-card">
          <h2>Use workspaces</h2>
          <p>Add a project folder from the sidebar, select it, then use Attach workspace files above the composer. Files are read on demand and sent only after a permission check.</p>
        </article>
        <article className="vr-card">
          <h2>Permission modes</h2>
          <p>Ask me every time prompts before each local operation, Agent allows reads inside the selected workspace and asks outside it, and Full access allows broad filesystem tools but still asks for protected system locations and never bypasses Windows permissions. Switching modes cancels any waiting card, and switching to a stricter mode clears saved file permissions for good.</p>
        </article>
        <article className="vr-card">
          <h2>Search and organize</h2>
          <p>Search matches task titles and conversation text. Rename tasks inline, delete them permanently, and inspect daily request usage in the sidebar.</p>
        </article>
        <article className="vr-card">
          <h2>What is not included</h2>
          <p>AI shell commands, file writes, administrator actions, and unattended execution are not implemented. Local tools are read-only and always require the selected permission policy.</p>
        </article>
        <article className="vr-card">
          <h2>Privacy and safety</h2>
          <p>Workspace paths stay on this PC, and secrets, environment files, private keys, dependencies, and build output are excluded from scans. API keys are encrypted on the server and never shown again in full.</p>
        </article>
      </section>

      <section className="vr-settings-group">
        <h2>Shortcuts</h2>
        <div className="vr-shortcut-grid">
          <span><kbd>Ctrl</kbd><kbd>K</kbd></span><span>Focus task search</span>
          <span><kbd>Ctrl</kbd><kbd>N</kbd></span><span>Start a new task</span>
          <span><kbd>Enter</kbd></span><span>Send with the configured shortcut</span>
          <span><kbd>Shift</kbd><kbd>Enter</kbd></span><span>Insert a newline</span>
        </div>
      </section>

      <p className="vr-page-note">
        Support: report problems through the project repository. This desktop build is unsigned and intended for
        controlled testing.
      </p>
    </DesktopPage>
  );
}

export function AccountPage() {
  const { user, signOut } = useAuth();
  const { usage, usageError } = useTasks();
  const navigate = useNavigate();
  const percent = usage?.dailyQuota ? Math.min(100, Math.round((usage.dailyUsed / usage.dailyQuota) * 100)) : 0;
  const initials = String(user?.name || user?.email || "U")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(part => part[0])
    .join("")
    .toUpperCase();

  return (
    <DesktopPage
      kicker="ACCOUNT"
      title="Account"
      description="Your signed-in identity, daily request allowance, and session controls."
      actions={
        <button
          type="button"
          className="vr-secondary-small"
          onClick={async () => {
            await signOut();
            navigate("/signin");
          }}
        >
          Sign out
        </button>
      }
    >
      <section className="vr-card vr-account-card">
        <span className="vr-account-avatar vr-account-avatar--large" aria-hidden="true">{initials}</span>
        <div>
          <h2>{user?.name || "VupsRouter account"}</h2>
          <p>{user?.email || ""}</p>
        </div>
      </section>

      <section className="vr-settings-group">
        <h2>Daily usage</h2>
        {usage ? (
          <>
            <div className="vr-usage-large">
              <span>{usage.dailyUsed} of {usage.dailyQuota} requests used</span>
              <strong>{usage.remaining} remaining</strong>
            </div>
            <span className="vr-usage-bar vr-usage-bar--large" aria-hidden="true">
              <span style={{ width: `${percent}%` }} />
            </span>
            <p className="vr-page-note">
              Quota resets at {new Date(usage.resetAt).toLocaleString()}. The server enforces this allowance for every
              signed-in account.
            </p>
          </>
        ) : (
          <p className="vr-page-note">{usageError || "Usage is not available right now."}</p>
        )}
      </section>

      <section className="vr-settings-group">
        <h2>Account controls</h2>
        <div className="vr-link-list">
          <Link to="/settings">Provider and API settings <ArrowRight size={14} /></Link>
          <Link to="/app-settings">Application preferences <ArrowRight size={14} /></Link>
          <Link to="/forgot-password">Reset account password <ArrowRight size={14} /></Link>
        </div>
      </section>

      <div className="vr-callout">
        <ShieldCheck size={18} />
        <div>
          <strong>Session security</strong>
          <span>Sessions use HTTP-only cookies. Signing out clears the session on this device.</span>
        </div>
      </div>
    </DesktopPage>
  );
}
