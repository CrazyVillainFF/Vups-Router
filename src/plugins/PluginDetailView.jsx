import React, { useMemo, useState } from "react";
import { ArrowSquareOut, CircleNotch, Key, Plugs, ShieldCheck, Trash, WarningCircle } from "@phosphor-icons/react";
import ExternalAnchor from "../components/ExternalLink.jsx";
import {
  capabilityGroups,
  connectionStatus,
  exampleDebugArgs,
  formatPluginDate,
  redactSecrets,
  setupGuidance
} from "./pluginDetails.js";

function Badge({ tone = "muted", children }) {
  return <span className="vr-status-pill" data-tone={tone}>{children}</span>;
}

function ActionItem({ action, installed, turnOn, onRun }) {
  return (
    <li className="vr-plugin-action" data-tool={action.name}>
      <details>
        <summary>
          <span className="vr-plugin-action-label">{action.label}</span>
          {action.changes ? <Badge tone="warn">Asks you first</Badge> : null}
          {action.needsToken ? <Badge tone="muted">Needs a token</Badge> : null}
        </summary>
        <div className="vr-plugin-action-body">
          <p>{action.what}</p>
          <dl>
            <div>
              <dt>What it touches</dt>
              <dd>{action.effectLine}</dd>
            </div>
            <div>
              <dt>Changes anything?</dt>
              <dd>{action.changes ? "Yes — only after you approve it." : "No. It only reads."}</dd>
            </div>
          </dl>
          {installed ? (
            <button type="button" className="vr-secondary-small" onClick={() => onRun(action.name)}>
              Try it
            </button>
          ) : (
            <span className="vr-plugin-muted">
              {turnOn ? "Turn on this plugin" : "Connect this plugin"} to use the action.
            </span>
          )}
        </div>
      </details>
    </li>
  );
}

function StatusPanel({ plugin, status, testing, onTest }) {
  return (
    <section className="vr-plugin-status-panel" aria-label="Connection status">
      <div className="vr-plugin-status-row">
        <Badge tone={status.tone}>{status.label}</Badge>
        <p>{status.sentence}</p>
      </div>
      <div className="vr-plugin-status-meta">
        {status.lastSuccessAt ? (
          <span>Last successful check: {formatPluginDate(status.lastSuccessAt)}</span>
        ) : status.lastAttempt ? (
          <span>Last check attempt: {formatPluginDate(status.lastAttempt)}</span>
        ) : (
          <span>No connection check has run yet.</span>
        )}
        {plugin.installed ? (
          <button
            type="button"
            className="vr-secondary-small"
            onClick={onTest}
            disabled={testing}
            aria-busy={testing ? "true" : undefined}
          >
            {testing ? <CircleNotch size={14} className="vr-spin" /> : <Plugs size={14} />}
            {testing ? "Testing…" : "Test connection"}
          </button>
        ) : null}
      </div>
    </section>
  );
}

function SetupPanel({ guidance }) {
  return (
    <section className="vr-plugin-setup" aria-label="Connection setup">
      <header>
        <Key size={16} />
        <div>
          <h3>{guidance.headline}</h3>
          <p>{guidance.sentence}</p>
        </div>
      </header>

      {guidance.worksWithout?.length ? (
        <div className="vr-plugin-setup-group">
          <span className="vr-plugin-setup-label">Works without signing in</span>
          <ul>{guidance.worksWithout.map(item => <li key={item}>{item}</li>)}</ul>
        </div>
      ) : guidance.requiresCredentials ? (
        <div className="vr-plugin-setup-group">
          <span className="vr-plugin-setup-label">Nothing works without a key</span>
          <p className="vr-plugin-muted">
            The actions below stay unavailable until a key is saved, so nothing is attempted and no data is sent.
          </p>
        </div>
      ) : null}

      {guidance.needsTokenFor?.length ? (
        <div className="vr-plugin-setup-group">
          <span className="vr-plugin-setup-label">
            {guidance.requiresCredentials ? "Needs the key" : "Needs your access token"}
          </span>
          <ul>{guidance.needsTokenFor.map(item => <li key={item}>{item}</li>)}</ul>
        </div>
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
                  {guidance.guidanceLabel || "Open provider site"} <ArrowSquareOut size={12} />
                </ExternalAnchor>
              </>
            ) : null}
          </span>
        </p>
      ) : null}

      {guidance.fields?.length ? (
        <p className="vr-plugin-muted">This plugin asks for: {guidance.fields.join(", ")}.</p>
      ) : null}

      <p className="vr-plugin-muted vr-plugin-setup-note">
        Credentials are encrypted on the server and never shown again. Paste them in the connect form, never into a chat
        message.
      </p>
    </section>
  );
}

function AdvancedPanel({ plugin, status, runDebug }) {
  const tools = plugin.tools || [];
  const [toolName, setToolName] = useState(tools[0]?.name || "");
  const [argsText, setArgsText] = useState(() => (tools[0] ? JSON.stringify(exampleDebugArgs(tools[0]), null, 2) : "{}"));
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState("");
  const selected = tools.find(tool => tool.name === toolName) || null;

  function chooseTool(name) {
    const tool = tools.find(item => item.name === name) || null;
    setToolName(name);
    setArgsText(tool ? JSON.stringify(exampleDebugArgs(tool), null, 2) : "{}");
    setConfirm(false);
    setError("");
    setResult("");
  }

  async function run() {
    if (!selected || busy) return;
    let args;
    try {
      args = JSON.parse(argsText || "{}");
      if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("not an object");
    } catch {
      setError("Arguments must be a JSON object.");
      return;
    }
    if (selected.sensitive && !confirm) {
      setError("Tick the confirmation box before running an action that changes data.");
      return;
    }
    setBusy(true);
    setError("");
    setResult("");
    try {
      const response = await runDebug(selected, args, confirm);
      setResult(JSON.stringify(response?.result ?? response ?? {}, null, 2));
    } catch (runError) {
      setError(redactSecrets(runError?.message || "That action did not run."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="vr-plugin-advanced">
      <summary>Advanced details</summary>
      <div className="vr-plugin-advanced-body">
        <dl className="vr-plugin-facts">
          <div>
            <dt>Plugin ID</dt>
            <dd><code>{plugin.id}</code></dd>
          </div>
          <div>
            <dt>Connection state</dt>
            <dd>{plugin.connection || "not installed"}{plugin.lastTestStatus ? ` · last check ${plugin.lastTestStatus}` : ""}</dd>
          </div>
          <div>
            <dt>Stored credentials</dt>
            <dd>
              {Object.keys(plugin.credentialsConfigured || {}).length
                ? `${Object.keys(plugin.credentialsConfigured).length} saved (encrypted, never returned)`
                : "None required"}
            </dd>
          </div>
          <div>
            <dt>Last provider message</dt>
            <dd>{redactSecrets(plugin.lastTestMessage || plugin.lastError || "None")}</dd>
          </div>
          <div>
            <dt>Declared permissions</dt>
            <dd>{(plugin.permissions || []).map(permission => <span key={permission}>{permission}</span>)}</dd>
          </div>
          <div>
            <dt>Tool names</dt>
            <dd className="vr-plugin-tool-names">
              {tools.length ? tools.map(tool => <code key={tool.name}>{tool.name}</code>) : <span>None</span>}
            </dd>
          </div>
        </dl>

        {plugin.installed && tools.length ? (
          <section className="vr-plugin-console" aria-label="Raw tool console">
            <div className="vr-plugin-section-head">
              <div>
                <span className="vr-page-kicker">DEBUG CONSOLE</span>
                <h3>Call a tool with JSON</h3>
              </div>
              <span className="vr-plugin-muted">Results are not stored in chat history.</span>
            </div>
            <label>
              <span>Tool name</span>
              <select className="vr-select" value={toolName} onChange={event => chooseTool(event.target.value)}>
                {tools.map(tool => <option key={tool.name} value={tool.name}>{tool.name}</option>)}
              </select>
            </label>
            <label>
              <span>Arguments (JSON)</span>
              <textarea value={argsText} onChange={event => setArgsText(event.target.value)} rows={6} spellCheck={false} />
            </label>
            {selected?.sensitive ? (
              <label className="vr-plugin-confirm">
                <input type="checkbox" checked={confirm} onChange={event => setConfirm(event.target.checked)} />
                I understand this changes data on {plugin.name}.
              </label>
            ) : null}
            {error ? <div className="vr-inline-error" role="alert">{error}</div> : null}
            <div className="vr-plugin-console-actions">
              <button type="button" className="vr-primary-small" onClick={run} disabled={busy}>
                {busy ? <><CircleNotch size={14} className="vr-spin" /> Running…</> : "Run tool"}
              </button>
            </div>
            {result ? <pre className="vr-plugin-result" aria-label="Tool result">{result}</pre> : null}
          </section>
        ) : null}
        <p className="vr-plugin-muted">
          Status is {status.label.toLowerCase()}. Tool names and raw schemas are debugging information; the assistant
          only sees actions after you connect the plugin.
        </p>
      </div>
    </details>
  );
}

export default function PluginDetailView({ plugin, testing, runDebug, onTest, onConnect, onDisconnect, onRunAction }) {
  const status = useMemo(() => connectionStatus(plugin), [plugin]);
  const guidance = useMemo(() => setupGuidance(plugin), [plugin]);
  const groups = useMemo(() => capabilityGroups(plugin), [plugin]);
  const unavailable = plugin.availability === "in_development" || plugin.availability === "oauth_required";
  const connectable =
    plugin.installed || plugin.availability === "available" || plugin.availability === "requires_setup";
  const turnsOn = (plugin.auth?.type || "none") === "none";

  return (
    <div className="vr-plugin-detail">
      <StatusPanel plugin={plugin} status={status} testing={testing} onTest={onTest} />

      {connectable ? (
        <div className="vr-plugin-detail-actions">
          <button type="button" className="vr-secondary-small" onClick={onConnect}>
            {plugin.installed ? "Update credentials" : turnsOn ? "Turn on" : "Connect"}
          </button>
          {plugin.installed ? (
            <button type="button" className="vr-danger-small" onClick={onDisconnect}>
              <Trash size={14} /> Disconnect
            </button>
          ) : null}
        </div>
      ) : null}

      {!unavailable && guidance.key !== "unavailable" ? <SetupPanel guidance={guidance} /> : null}

      {unavailable ? (
        <div className="vr-callout vr-callout--warning">
          <WarningCircle size={18} />
          <div>
            <strong>No working adapter in this build</strong>
            <span>
              This entry is listed so the catalog is honest about what is planned. There are no actions to run and no
              permission is requested.
            </span>
          </div>
        </div>
      ) : null}

      <section className="vr-plugin-capabilities" aria-labelledby="vr-plugin-capabilities-title">
        <header className="vr-plugin-section-head">
          <div>
            <span className="vr-page-kicker">PERMISSIONS</span>
            <h3 id="vr-plugin-capabilities-title">What VupsRouter can do</h3>
          </div>
          <span className="vr-plugin-muted">Built from the actions this plugin actually exposes.</span>
        </header>

        {groups.reads.length ? (
          <div className="vr-plugin-capability-group" data-kind="read">
            <h4>
              <Badge tone="ok">Read access</Badge>
              <span>Looks at information and changes nothing.</span>
            </h4>
            <ul>
              {groups.reads.map(action => (
                <ActionItem key={action.name} action={action} installed={plugin.installed} turnOn={turnsOn} onRun={onRunAction} />
              ))}
            </ul>
          </div>
        ) : null}

        {groups.changes.length ? (
          <div className="vr-plugin-capability-group" data-kind="change">
            <h4>
              <Badge tone="warn">Write access</Badge>
              <span>Changes your {plugin.name} data, only after you approve the exact request.</span>
            </h4>
            <ul>
              {groups.changes.map(action => (
                <ActionItem key={action.name} action={action} installed={plugin.installed} turnOn={turnsOn} onRun={onRunAction} />
              ))}
            </ul>
          </div>
        ) : null}

        {!groups.actions.length ? (
          <p className="vr-plugin-muted">This plugin exposes no actions in this version.</p>
        ) : null}

        {groups.changes.length ? (
          <p className="vr-plugin-permission-note">
            <ShieldCheck size={14} /> The assistant can call read actions after you connect. Actions that change data are
            never offered to the assistant; you run them yourself and approve them first.
          </p>
        ) : null}
      </section>

      <AdvancedPanel plugin={plugin} status={status} runDebug={runDebug} />
    </div>
  );
}
