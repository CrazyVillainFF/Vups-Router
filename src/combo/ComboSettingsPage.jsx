import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowDown,
  ArrowsClockwise,
  ArrowUp,
  CheckCircle,
  CircleNotch,
  Trash,
  XCircle
} from "@phosphor-icons/react";
import { QuantumLoader } from "../components/LoadingVisuals.jsx";
import { getApiErrorMessage } from "../services/api.js";
import {
  availabilityMap,
  formatCheckedAt,
  mergeSelectedModels,
  moveSelectedModel,
  removeSelectedModel,
  selectionForSave,
  statusFor,
  statusLabel,
  summaryFor,
  withStaleSelected
} from "./comboSelection.js";
import { fetchComboState, runComboAvailability, saveComboState } from "./comboApi.js";
import ModelArtwork from "./ModelArtwork.jsx";
import "./combo.css";

const DEFAULTS = {
  strategy: "parallel",
  review: true,
  synthesizer: "auto",
  minWorkingModels: 1,
  maxWorkingModels: 4,
  allowSingleFallback: true,
  autoAvailability: true,
  healthTtlMs: 120000,
  timeoutMs: 60000,
  retries: 0,
  maxConcurrent: 3,
  probeTimeoutMs: 20000
};

const HEALTH_OPTIONS = [
  [60000, "1 minute"],
  [120000, "2 minutes"],
  [300000, "5 minutes"],
  [900000, "15 minutes"]
];

const TIMEOUT_OPTIONS = [
  [30000, "30 seconds"],
  [60000, "60 seconds"],
  [90000, "90 seconds"],
  [120000, "120 seconds"],
  [180000, "180 seconds"]
];

function StatusGlyph({ status }) {
  if (status === "working") return <CheckCircle size={12} weight="fill" aria-hidden="true" />;
  if (status === "not_working") return <XCircle size={12} weight="fill" aria-hidden="true" />;
  return <CircleNotch size={12} aria-hidden="true" />;
}

function settingsEqual(a, b) {
  return Object.keys(DEFAULTS).every(key => String(a?.[key]) === String(b?.[key]));
}

function selectionKeys(list) {
  return (Array.isArray(list) ? list : []).map(entry => entry.key).join("|");
}

function SelectRow({ title, description, value, onChange, children }) {
  return (
    <label className="vr-setting-row">
      <span className="vr-setting-copy">
        <strong>{title}</strong>
        {description ? <span>{description}</span> : null}
      </span>
      <select className="vr-select" value={value} onChange={event => onChange(event.target.value)}>
        {children}
      </select>
    </label>
  );
}

function ToggleRow({ title, description, checked, onChange }) {
  return (
    <label className="vr-setting-row">
      <span className="vr-setting-copy">
        <strong>{title}</strong>
        {description ? <span>{description}</span> : null}
      </span>
      <input
        type="checkbox"
        className="vr-toggle"
        checked={checked}
        onChange={event => onChange(event.target.checked)}
      />
    </label>
  );
}

export default function ComboSettingsPage() {
  const [phase, setPhase] = useState("loading");
  const [loadError, setLoadError] = useState("");
  const [catalog, setCatalog] = useState({ models: [] });
  const [enabled, setEnabled] = useState(true);
  const [selected, setSelected] = useState([]);
  const [settings, setSettings] = useState(DEFAULTS);
  const [baseline, setBaseline] = useState({ enabled: true, selected: [], settings: DEFAULTS });
  const [availability, setAvailability] = useState(() => new Map());
  const [checkedAt, setCheckedAt] = useState(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [saved, setSaved] = useState(false);
  const abortRef = useRef(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setPhase("loading");
    setLoadError("");
    fetchComboState()
      .then(data => {
        if (cancelled) return;
        const nextCatalog = data?.catalog || { models: [] };
        const config = data?.config || {};
        const selectedList = Array.isArray(config.selected) ? config.selected : [];
        const nextSettings = { ...DEFAULTS, ...(config.settings || {}) };
        setCatalog({ models: Array.isArray(nextCatalog.models) ? nextCatalog.models : [] });
        setEnabled(config.enabled !== false);
        setSelected(selectedList);
        setSettings(nextSettings);
        setBaseline({
          enabled: config.enabled !== false,
          selected: selectedList,
          settings: nextSettings
        });
        setAvailability(
          withStaleSelected(
            mergeSelectedModels(selectedList, nextCatalog.models || []),
            availabilityMap(config.availability)
          )
        );
        setCheckedAt(
          (Array.isArray(config.availability) ? config.availability : [])
            .map(entry => entry?.checkedAt)
            .filter(Boolean)
            .sort()
            .pop() || null
        );
        setPhase("ready");
      })
      .catch(error => {
        if (cancelled) return;
        setLoadError(getApiErrorMessage(error));
        setPhase("error");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const mergedSelected = useMemo(
    () => mergeSelectedModels(selected, catalog.models),
    [selected, catalog.models]
  );
  const displayAvailability = useMemo(
    () => withStaleSelected(mergedSelected, availability),
    [mergedSelected, availability]
  );
  const summary = useMemo(
    () => summaryFor(selected, displayAvailability),
    [selected, displayAvailability]
  );
  const dirty = useMemo(() => (
    enabled !== baseline.enabled ||
    selectionKeys(selected) !== selectionKeys(baseline.selected) ||
    !settingsEqual(settings, baseline.settings)
  ), [enabled, selected, settings, baseline]);

  function updateSetting(key, value) {
    setSaved(false);
    setSettings(current => {
      const next = { ...current, [key]: value };
      if (key === "minWorkingModels" && next.maxWorkingModels < next.minWorkingModels) {
        next.maxWorkingModels = next.minWorkingModels;
      }
      if (key === "maxWorkingModels" && next.minWorkingModels > next.maxWorkingModels) {
        next.minWorkingModels = next.maxWorkingModels;
      }
      return next;
    });
  }

  function removeModel(key) {
    setSaved(false);
    setSelected(current => removeSelectedModel(current, key));
  }

  function moveModel(key, offset) {
    setSaved(false);
    setSelected(current => moveSelectedModel(current, key, offset));
  }

  async function save() {
    if (saving) return;
    setSaving(true);
    setSaveError("");
    setSaved(false);
    try {
      const synthesizer = selected.some(entry => entry.key === settings.synthesizer)
        ? settings.synthesizer
        : "auto";
      const data = await saveComboState({
        enabled,
        selected: selectionForSave(selected, catalog.models),
        settings: { ...settings, synthesizer }
      });
      if (!mountedRef.current) return;
      const config = data?.config || {};
      const nextSelected = Array.isArray(config.selected) ? config.selected : [];
      const nextSettings = { ...DEFAULTS, ...(config.settings || {}) };
      setEnabled(config.enabled !== false);
      setSelected(nextSelected);
      setSettings(nextSettings);
      setBaseline({
        enabled: config.enabled !== false,
        selected: nextSelected,
        settings: nextSettings
      });
      setAvailability(current => {
        const next = new Map(current);
        for (const entry of Array.isArray(config.availability) ? config.availability : []) {
          if (entry?.key) next.set(entry.key, entry);
        }
        return next;
      });
      setCheckedAt(
        (Array.isArray(config.availability) ? config.availability : [])
          .map(entry => entry?.checkedAt)
          .filter(Boolean)
          .sort()
          .pop() || checkedAt
      );
      setSaved(true);
    } catch (error) {
      if (!mountedRef.current) return;
      setSaveError(getApiErrorMessage(error));
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  }

  function discard() {
    setEnabled(baseline.enabled);
    setSelected(baseline.selected);
    setSettings(baseline.settings);
    setSaveError("");
    setSaved(false);
  }

  async function recheck() {
    if (checking || selected.length === 0 || dirty) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setChecking(true);
    setCheckError("");
    try {
      const data = await runComboAvailability({ force: true, signal: controller.signal });
      if (!mountedRef.current) return;
      const models = Array.isArray(data?.models) ? data.models : [];
      setAvailability(current => {
        const next = new Map(current);
        for (const entry of models) {
          if (entry?.key) next.set(entry.key, entry);
        }
        return next;
      });
      setCheckedAt(data?.checkedAt || new Date().toISOString());
    } catch (error) {
      if (error?.name === "CanceledError" || error?.name === "AbortError" || error?.code === "ERR_CANCELED") return;
      if (!mountedRef.current) return;
      setCheckError(getApiErrorMessage(error));
    } finally {
      if (mountedRef.current) setChecking(false);
    }
  }

  if (phase === "loading") {
    return (
      <main className="vr-page" id="main-content">
        <div className="combo-settings-loading">
          <QuantumLoader label="Loading Combo settings" />
        </div>
      </main>
    );
  }

  if (phase === "error") {
    return (
      <main className="vr-page" id="main-content">
        <div className="vr-page-shell">
          <header className="vr-page-head">
            <div>
              <span className="vr-page-kicker">VUPS COMBO AI</span>
              <h1>Combo settings</h1>
              <p>{loadError}</p>
            </div>
            <div className="vr-page-actions">
              <Link className="vr-secondary-small" to="/combo">Back to Combo</Link>
            </div>
          </header>
        </div>
      </main>
    );
  }

  const synthesizerValue = selected.some(entry => entry.key === settings.synthesizer)
    ? settings.synthesizer
    : "auto";
  const healthOptions = HEALTH_OPTIONS.some(([value]) => value === settings.healthTtlMs)
    ? HEALTH_OPTIONS
    : [...HEALTH_OPTIONS, [settings.healthTtlMs, `${Math.round(settings.healthTtlMs / 60000)} minutes`]];
  const timeoutOptions = TIMEOUT_OPTIONS.some(([value]) => value === settings.timeoutMs)
    ? TIMEOUT_OPTIONS
    : [...TIMEOUT_OPTIONS, [settings.timeoutMs, `${Number(settings.timeoutMs) / 1000} seconds`]];

  return (
    <main className="vr-page" id="main-content">
      <div className="vr-page-shell combo-settings-shell">
        <header className="vr-page-head">
          <div>
            <span className="vr-page-kicker">VUPS COMBO AI · APEX</span>
            <h1>Combo settings</h1>
            <p>
              These preferences belong to Vups Combo AI only. Ordinary model selection and provider settings are not
              changed here.
            </p>
          </div>
          <div className="vr-page-actions combo-settings-actions">
            <Link className="vr-secondary-small" to="/combo">Open Combo</Link>
            <button type="button" className="vr-secondary-small" onClick={discard} disabled={!dirty || saving}>
              Discard
            </button>
            <button type="button" className="vr-primary-small" onClick={save} disabled={!dirty || saving}>
              {saving ? "Saving..." : "Save changes"}
            </button>
          </div>
        </header>

        <div className="combo-settings-feedback" role="status" aria-live="polite">
          {saveError ? <span className="combo-settings-feedback__error">{saveError}</span> : null}
          {!saveError && saved && !dirty ? "Combo settings saved." : null}
          {!saveError && dirty ? "Unsaved changes." : null}
        </div>

        <section className="vr-settings-group">
          <h2>Combo AI</h2>
          <ToggleRow
            title="Enable Vups Combo AI"
            description="Turns the Combo page and Combo runs on or off. The ordinary chat model picker is unaffected."
            checked={enabled}
            onChange={value => {
              setSaved(false);
              setEnabled(value);
            }}
          />
          <div className="vr-setting-row">
            <span className="vr-setting-copy">
              <strong>Working-model routing</strong>
              <span>Always on. Combo sends requests only to selected models that passed the latest availability check.</span>
            </span>
            <span className="vr-setting-badge">Always on</span>
          </div>
          <ToggleRow
            title="Automatic availability detection"
            description="Checks selected models on the Combo page and caches the result for the health-check window."
            checked={settings.autoAvailability}
            onChange={value => updateSetting("autoAvailability", value)}
          />
          <ToggleRow
            title="Allow single-model fallback"
            description="When only one selected model works, let it answer alone instead of refusing the run."
            checked={settings.allowSingleFallback}
            onChange={value => updateSetting("allowSingleFallback", value)}
          />
        </section>

        <section className="vr-settings-group">
          <div className="combo-settings-heading">
            <h2>Selected models</h2>
            <button
              type="button"
              className="vr-secondary-small"
              onClick={recheck}
              disabled={checking || selected.length === 0 || dirty}
            >
              <ArrowsClockwise size={13} />
              {checking ? "Checking..." : "Recheck availability"}
            </button>
          </div>
          <p className="vr-page-note combo-settings-note">
            Order sets priority: earlier models are kept first when the active limit applies.
            {" "}
            {checkedAt ? formatCheckedAt(checkedAt) : "Status comes from server-side probes."}
          </p>
          <div className="combo-settings-summary" aria-label="Selected model status">
            <span data-state="working"><CheckCircle size={12} weight="fill" aria-hidden="true" /> {summary.working} working</span>
            <span data-state="not_working"><XCircle size={12} weight="fill" aria-hidden="true" /> {summary.notWorking} Not Working</span>
            {summary.unknown ? <span data-state="unknown">{summary.unknown} not checked</span> : null}
          </div>
          {checkError ? (
            <div className="combo-alert combo-alert--error" role="alert">
              <span>{checkError}</span>
            </div>
          ) : null}
          {dirty ? (
            <p className="vr-page-note combo-settings-note">
              Save changes before rechecking availability.
            </p>
          ) : null}

          {selected.length === 0 ? (
            <div className="combo-settings-empty">
              <p>No models selected.</p>
              <Link to="/combo">Choose models on the Combo page</Link>
            </div>
          ) : (
            <ul className="combo-selected-list" role="list" aria-label="Selected models in priority order">
              {mergedSelected.map((entry, index) => {
                const status = statusFor(displayAvailability, entry.key);
                const label = entry.label || entry.model;
                return (
                  <li key={entry.key} className="combo-selected-row">
                    <span className="combo-selected-row__order" aria-hidden="true">{index + 1}</span>
                    <ModelArtwork model={entry} size="sm" />
                    <span className="combo-selected-row__copy">
                      <strong>{label}</strong>
                      <span>{entry.provider}</span>
                    </span>
                    <span className="combo-selected-row__status" data-status={status}>
                      <StatusGlyph status={status} />
                      {statusLabel(status)}
                    </span>
                    <span className="combo-selected-row__actions">
                      <button
                        type="button"
                        onClick={() => moveModel(entry.key, -1)}
                        disabled={index === 0}
                        aria-label={`Move ${label} up in priority`}
                        title="Move up"
                      >
                        <ArrowUp size={13} />
                      </button>
                      <button
                        type="button"
                        onClick={() => moveModel(entry.key, 1)}
                        disabled={index === mergedSelected.length - 1}
                        aria-label={`Move ${label} down in priority`}
                        title="Move down"
                      >
                        <ArrowDown size={13} />
                      </button>
                      <button
                        type="button"
                        className="is-danger"
                        onClick={() => removeModel(entry.key)}
                        aria-label={`Remove ${label} from Combo`}
                        title="Remove from Combo"
                      >
                        <Trash size={13} />
                      </button>
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="vr-settings-group">
          <h2>Collaboration</h2>
          <SelectRow
            title="Execution strategy"
            description="Parallel asks working models independently. Sequential feeds each working draft to the next model."
            value={settings.strategy}
            onChange={value => updateSetting("strategy", value)}
          >
            <option value="parallel">Parallel</option>
            <option value="sequential">Sequential</option>
          </SelectRow>
          <ToggleRow
            title="Review and synthesize"
            description="Compares independent answers, flags conflicts, and asks one working model to synthesize the final answer."
            checked={settings.review}
            onChange={value => updateSetting("review", value)}
          />
          <SelectRow
            title="Synthesizer model"
            description="The working model that reviews answers and writes the final response. Auto uses the first successful model."
            value={synthesizerValue}
            onChange={value => updateSetting("synthesizer", value)}
          >
            <option value="auto">Auto</option>
            {mergedSelected.map(entry => (
              <option key={entry.key} value={entry.key}>{entry.label || entry.model}</option>
            ))}
          </SelectRow>
          <SelectRow
            title="Minimum working models"
            description="Combo refuses to run when fewer than this many selected models work. 0 accepts any positive count."
            value={settings.minWorkingModels}
            onChange={value => updateSetting("minWorkingModels", Number(value))}
          >
            {[0, 1, 2, 3, 4, 5, 6, 7, 8].map(value => (
              <option key={value} value={value}>{value}</option>
            ))}
          </SelectRow>
          <SelectRow
            title="Maximum models per run"
            description="Caps how many working models join one run. Extra working models stay selected and are reported as ready but unused."
            value={settings.maxWorkingModels}
            onChange={value => updateSetting("maxWorkingModels", Number(value))}
          >
            {[1, 2, 3, 4, 5, 6, 7, 8].map(value => (
              <option key={value} value={value}>{value}</option>
            ))}
          </SelectRow>
          <SelectRow
            title="Maximum concurrent requests"
            description="Limits simultaneous provider calls during availability checks and parallel drafting."
            value={settings.maxConcurrent}
            onChange={value => updateSetting("maxConcurrent", Number(value))}
          >
            {[1, 2, 3, 4, 5, 6, 7, 8].map(value => (
              <option key={value} value={value}>{value}</option>
            ))}
          </SelectRow>
        </section>

        <section className="vr-settings-group">
          <h2>Reliability</h2>
          <SelectRow
            title="Availability health window"
            description="How long a successful or failed model check stays valid before Combo probes it again."
            value={settings.healthTtlMs}
            onChange={value => updateSetting("healthTtlMs", Number(value))}
          >
            {healthOptions.map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </SelectRow>
          <SelectRow
            title="Per-model timeout"
            description="Maximum time Combo waits for one model request before counting it as failed."
            value={settings.timeoutMs}
            onChange={value => updateSetting("timeoutMs", Number(value))}
          >
            {timeoutOptions.map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </SelectRow>
          <SelectRow
            title="Retries for transient failures"
            description="Retries only timeouts and connection failures. Credential and entitlement errors are never retried."
            value={settings.retries}
            onChange={value => updateSetting("retries", Number(value))}
          >
            <option value={0}>None</option>
            <option value={1}>1 retry</option>
            <option value={2}>2 retries</option>
          </SelectRow>
        </section>
      </div>
    </main>
  );
}
