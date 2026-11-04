import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowsClockwise,
  ArrowUpRight,
  Check,
  CheckCircle,
  CircleNotch,
  MagnifyingGlass,
  Plus,
  X,
  XCircle
} from "@phosphor-icons/react";
import { QuantumLoader } from "../components/LoadingVisuals.jsx";
import ShinyText from "../components/reactbits/ShinyText/ShinyText.jsx";
import CountUp from "../components/reactbits/CountUp/CountUp.jsx";
import { getApiErrorMessage } from "../services/api.js";
import { comboTestTimeoutMs, fetchComboState, runComboAvailability, saveComboState, testComboModel } from "./comboApi.js";
import {
  availabilityMap,
  COMBO_MAX_SELECTED,
  filterModels,
  hasVisionModels,
  isWorkingModelsFilter,
  libraryEmptyMessage,
  mergeSelectedModels,
  providerOptions,
  selectionForSave,
  statusFor,
  statusLabel,
  summaryFor,
  toggleSelectedModel,
  withStaleSelected,
  WORKING_MODELS_FILTER
} from "./comboSelection.js";
import { currentComboRun, subscribeComboRun } from "./comboLive.js";
import ModelArtwork from "./ModelArtwork.jsx";
import ComboPowerCore from "./ComboPowerCore.jsx";
import useApexStartup from "./hooks/useApexStartup.js";
import { coreDensity } from "./comboCoreLayout.js";
import { buildProviderNetwork } from "./comboProviders.js";
import "./combo.css";

const FALLBACK_SETTINGS = {
  autoAvailability: true,
  maxWorkingModels: 4
};

function StatusGlyph({ status }) {
  if (status === "working") return <CheckCircle size={12} weight="fill" aria-hidden="true" />;
  if (status === "not_working") return <XCircle size={12} weight="fill" aria-hidden="true" />;
  return <CircleNotch size={12} aria-hidden="true" />;
}

function modelTitle(model) {
  return model?.label || model?.model || "This model";
}

function isCancelledRequest(error) {
  return (
    error?.name === "CanceledError" ||
    error?.name === "AbortError" ||
    error?.code === "ERR_CANCELED"
  );
}

// One row, two controls: the row itself still only selects, and the Test control
// beside it is the only thing that can talk to a provider. A test result is kept
// per model key, so a row that has never been tested shows no status at all
// instead of implying a check the app never ran.
const ModelRow = React.memo(function ModelRow({ model, selected, status, test, onToggle, onTest }) {
  const testing = test?.phase === "testing";
  const shown = testing ? "testing" : status;
  const showStatus = testing || selected || status !== "unknown";
  const resultLine = test && !testing && test.phase !== "idle"
    ? [
        test.status ? statusLabel(test.status) : null,
        Number.isInteger(test.httpStatus) && test.httpStatus > 0 ? `HTTP ${test.httpStatus}` : null,
        Number.isFinite(test.latencyMs) ? `${Math.round(test.latencyMs)} ms` : null
      ].filter(Boolean).join(" · ")
    : null;
  const detailLine = test?.phase === "error" || (test?.phase === "done" && test?.status === "not_working")
    ? String(test.detail || "").trim()
    : "";

  return (
    <div className="combo-row-slot">
      <div className="combo-row-line">
        <button
          type="button"
          className="combo-row"
          data-selected={selected ? "" : undefined}
          aria-pressed={selected}
          onClick={() => onToggle(model)}
        >
          <ModelArtwork model={model} size="sm" />
          <span className="combo-row__copy">
            <span className="combo-row__name">{model.label || model.model}</span>
            <span className="combo-row__meta">
              {model.provider}
              {model.model && model.model !== model.label ? <span className="combo-row__id">{model.model}</span> : null}
            </span>
          </span>
          <span className="combo-row__side">
            {showStatus ? (
              <span className="combo-row__status" data-status={shown}>
                {testing ? <CircleNotch size={12} className="combo-spin" aria-hidden="true" /> : <StatusGlyph status={status} />}
                {testing ? "Testing" : statusLabel(status)}
              </span>
            ) : null}
            <span className="combo-row__mark" aria-hidden="true">
              {selected ? <Check size={13} weight="bold" /> : <Plus size={13} />}
            </span>
          </span>
        </button>
        <button
          type="button"
          className="combo-test"
          data-phase={testing ? "testing" : "idle"}
          data-status={test?.status || "unknown"}
          onClick={() => onTest(model)}
          aria-label={testing ? `Stop the test for ${modelTitle(model)}` : `Test ${modelTitle(model)}`}
          title={testing ? "Stop this test" : "Send one small request to this model"}
        >
          {testing ? <CircleNotch size={11} className="combo-spin" aria-hidden="true" /> : null}
          <span>{testing ? "Stop" : "Test"}</span>
        </button>
      </div>
      {resultLine || detailLine ? (
        <p className="combo-test-result" data-status={test?.status || "error"}>
          {resultLine ? <span>{resultLine}</span> : null}
          {detailLine ? <span className="combo-test-result__detail">{detailLine}</span> : null}
        </p>
      ) : null}
    </div>
  );
});

export default function ComboPage() {
  const [phase, setPhase] = useState("loading");
  const [loadError, setLoadError] = useState("");
  const [loadNonce, setLoadNonce] = useState(0);
  const [config, setConfig] = useState({ enabled: true, settings: FALLBACK_SETTINGS, selected: [] });
  const [catalog, setCatalog] = useState({ models: [] });
  const [selected, setSelected] = useState([]);
  const [availability, setAvailability] = useState(() => new Map());
  const [availabilityBusy, setAvailabilityBusy] = useState(false);
  const [availabilityError, setAvailabilityError] = useState("");
  const [availabilityCheckedAt, setAvailabilityCheckedAt] = useState(null);
  const [saveState, setSaveState] = useState("idle");
  const [saveError, setSaveError] = useState("");
  const [query, setQuery] = useState("");
  const [providerFilter, setProviderFilter] = useState("");
  const [visionOnly, setVisionOnly] = useState(false);
  const [panelNotice, setPanelNotice] = useState("");
  const [tests, setTests] = useState(() => ({}));
  const [testNotice, setTestNotice] = useState("");
  const [liveRun, setLiveRun] = useState(currentComboRun);

  const selectedRef = useRef([]);
  const shellRef = useRef(null);
  const configRef = useRef(config);
  const saveSeq = useRef(0);
  const saveQueue = useRef(Promise.resolve());
  const availabilityAbort = useRef(null);
  const availabilitySeq = useRef(0);
  const autoChecked = useRef(false);
  // One live test per model key, and a per-key sequence so a late answer from a
  // stopped or superseded test can never be drawn as a current result.
  const testControllers = useRef(new Map());
  const testSeq = useRef(new Map());

  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);

  useEffect(() => {
    configRef.current = config;
  }, [config]);

  useEffect(() => () => {
    availabilityAbort.current?.abort();
    for (const controller of testControllers.current.values()) controller.abort();
    testControllers.current.clear();
  }, []);

  useEffect(() => subscribeComboRun(setLiveRun), []);

  useEffect(() => {
    let cancelled = false;
    setPhase("loading");
    setLoadError("");
    setSaveState("idle");
    setSaveError("");
    autoChecked.current = false;
    fetchComboState()
      .then(data => {
        if (cancelled) return;
        const nextConfig = data?.config || {};
        const nextCatalog = data?.catalog || { models: [] };
        const selectedList = Array.isArray(nextConfig.selected) ? nextConfig.selected : [];
        setConfig({
          enabled: nextConfig.enabled !== false,
          settings: { ...FALLBACK_SETTINGS, ...(nextConfig.settings || {}) },
          selected: selectedList,
          updatedAt: nextConfig.updatedAt ?? null
        });
        setCatalog({ models: Array.isArray(nextCatalog.models) ? nextCatalog.models : [] });
        setSelected(selectedList);
        setAvailability(
          withStaleSelected(
            mergeSelectedModels(selectedList, nextCatalog.models || []),
            availabilityMap(nextConfig.availability)
          )
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
  }, [loadNonce]);

  const catalogModels = catalog.models;
  const mergedSelected = useMemo(
    () => mergeSelectedModels(selected, catalogModels),
    [selected, catalogModels]
  );
  const displayAvailability = useMemo(
    () => withStaleSelected(mergedSelected, availability),
    [mergedSelected, availability]
  );
  const summary = useMemo(
    () => summaryFor(selected, displayAvailability),
    [selected, displayAvailability]
  );
  const providerNetwork = useMemo(() => buildProviderNetwork(mergedSelected), [mergedSelected]);
  const providers = useMemo(() => providerOptions(catalogModels), [catalogModels]);
  const showVisionFilter = useMemo(() => hasVisionModels(catalogModels), [catalogModels]);

  // One power-on for the machine. The DOM shell and the WebGL layer read the same
  // driver value, so the sequence can never drift out of step with itself.
  const { driverRef: apexStartupRef, running: apexStartupRunning } = useApexStartup(shellRef, {
    ready: providerNetwork.length > 0
  });

  const activeProviderId = useMemo(() => {
    if (!providerFilter || isWorkingModelsFilter(providerFilter)) return null;
    const match = providerNetwork.find(provider => provider.models.some(model => model.provider === providerFilter));
    return match ? match.id : null;
  }, [providerNetwork, providerFilter]);

  const workingOnly = isWorkingModelsFilter(providerFilter);
  const filtered = useMemo(() => {
    const list = filterModels(catalogModels, {
      query,
      provider: workingOnly ? "" : providerFilter,
      workingOnly,
      availability: displayAvailability
    });
    return visionOnly ? list.filter(model => model.vision === true) : list;
  }, [catalogModels, query, providerFilter, workingOnly, displayAvailability, visionOnly]);

  function focusProviderInLibrary(provider) {
    // The library filters by the catalog's own provider label, so a node has to
    // speak that vocabulary or the filter would match nothing.
    const name = (provider?.models || []).map(model => model.provider).find(Boolean) || provider?.name || "";
    if (!name) return;
    setQuery("");
    setProviderFilter(current => (current === name ? "" : name));
  }

  async function checkAvailability({ force = false, keys = null } = {}) {
    if (selectedRef.current.length === 0) return;
    availabilitySeq.current += 1;
    const seq = availabilitySeq.current;
    availabilityAbort.current?.abort();
    const controller = new AbortController();
    availabilityAbort.current = controller;
    setAvailabilityBusy(true);
    setAvailabilityError("");
    try {
      const data = await runComboAvailability({ force, keys, signal: controller.signal });
      if (seq !== availabilitySeq.current) return;
      const models = Array.isArray(data?.models) ? data.models : [];
      setAvailability(current => {
        const next = new Map(current);
        for (const entry of models) {
          if (entry?.key) next.set(entry.key, entry);
        }
        return next;
      });
      setAvailabilityCheckedAt(data?.checkedAt || new Date().toISOString());
    } catch (error) {
      if (error?.name === "CanceledError" || error?.name === "AbortError" || error?.code === "ERR_CANCELED") return;
      if (seq !== availabilitySeq.current) return;
      setAvailabilityError(getApiErrorMessage(error));
    } finally {
      if (seq === availabilitySeq.current) setAvailabilityBusy(false);
    }
  }

  // A row's Test control is a toggle while a probe is in flight: clicking it
  // again stops that probe instead of stacking a second request on the model.
  function stopModelTest(model) {
    const controller = testControllers.current.get(model.key);
    if (!controller) return false;
    testSeq.current.set(model.key, (testSeq.current.get(model.key) || 0) + 1);
    testControllers.current.delete(model.key);
    controller.abort();
    setTests(current => {
      const next = { ...current };
      delete next[model.key];
      return next;
    });
    setTestNotice(`Test for ${modelTitle(model)} stopped. No status was recorded.`);
    return true;
  }

  function testModel(model) {
    if (stopModelTest(model)) return;
    const key = model.key;
    const label = modelTitle(model);
    const seq = (testSeq.current.get(key) || 0) + 1;
    testSeq.current.set(key, seq);
    const controller = new AbortController();
    testControllers.current.set(key, controller);
    setTests(current => ({ ...current, [key]: { phase: "testing", label } }));
    setTestNotice(`Testing ${label}...`);

    testComboModel({
      key,
      timeoutMs: comboTestTimeoutMs(configRef.current.settings?.probeTimeoutMs),
      signal: controller.signal
    })
      .then(data => {
        if (seq !== testSeq.current.get(key)) return;
        testControllers.current.delete(key);
        const result = data?.model;
        if (result?.status !== "working" && result?.status !== "not_working") {
          // A response that names no status proves nothing about the model, so the
          // row keeps its old state and says the test did not report, rather than
          // inventing a verdict.
          setTests(current => ({
            ...current,
            [key]: { phase: "error", label, detail: "The test finished without reporting a model status." }
          }));
          setTestNotice(`${label} could not be tested. The model status is unchanged.`);
          return;
        }
        setTests(current => ({
          ...current,
          [key]: {
            phase: "done",
            label,
            status: result.status,
            latencyMs: result.latencyMs,
            httpStatus: result.httpStatus,
            detail: result.detail
          }
        }));
        setAvailability(current => {
          const next = new Map(current);
          next.set(key, {
            key,
            status: result.status,
            checkedAt: result.checkedAt || new Date().toISOString()
          });
          return next;
        });
        setTestNotice(
          result.status === "working"
            ? `${label} is Working.`
            : `${label} is Not Working - ${String(result.detail || result.reason || "the provider did not answer").slice(0, 150)}.`
        );
      })
      .catch(error => {
        if (isCancelledRequest(error) || seq !== testSeq.current.get(key)) return;
        testControllers.current.delete(key);
        const message = getApiErrorMessage(error);
        setTests(current => ({ ...current, [key]: { phase: "error", label, detail: message } }));
        setTestNotice(`${label}: the test did not complete. ${message}`);
      });
  }

  useEffect(() => {
    if (phase !== "ready" || autoChecked.current) return;
    autoChecked.current = true;
    if (configRef.current.settings?.autoAvailability !== false && selectedRef.current.length > 0) {
      checkAvailability();
    }
    // Auto-check runs once per page load; the server caches results by health TTL.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  function persistSelection(next) {
    const seq = ++saveSeq.current;
    const payload = selectionForSave(next, catalogModels);
    setSelected(next);
    setSaveState("saving");
    setSaveError("");
    const keys = next.map(entry => entry.key);
    saveQueue.current = saveQueue.current
      .catch(() => {})
      .then(async () => {
        if (seq !== saveSeq.current) return;
        const data = await saveComboState({ selected: payload });
        if (seq !== saveSeq.current) return;
        if (Array.isArray(data?.config?.selected)) setSelected(data.config.selected);
        if (data?.config) {
          setConfig(current => ({
            ...current,
            enabled: data.config.enabled !== false,
            settings: { ...FALLBACK_SETTINGS, ...(data.config.settings || {}) },
            selected: Array.isArray(data.config.selected) ? data.config.selected : current.selected,
            updatedAt: data.config.updatedAt ?? current.updatedAt
          }));
        }
        setSaveState("saved");
        if (configRef.current.settings?.autoAvailability !== false && keys.length > 0) {
          checkAvailability({ keys });
        }
      })
      .catch(error => {
        if (seq !== saveSeq.current) return;
        setSaveState("error");
        setSaveError(getApiErrorMessage(error));
      });
  }

  function toggleModel(model) {
    const next = toggleSelectedModel(selectedRef.current, model);
    if (next === selectedRef.current) {
      setPanelNotice(`Vups Combo AI supports up to ${COMBO_MAX_SELECTED} selected models.`);
      return;
    }
    setPanelNotice("");
    persistSelection(next);
  }

  function retrySave() {
    persistSelection(selectedRef.current);
  }

  function onListKeyDown(event) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const rows = [...event.currentTarget.querySelectorAll(".combo-list__item")];
    // Navigation is per model, not per control, so the arrow keys step between
    // rows whether the focus is on the row itself or on its Test button.
    const slot = event.target.closest?.(".combo-list__item");
    const index = rows.indexOf(slot);
    if (index < 0) return;
    event.preventDefault();
    const offset = event.key === "ArrowDown" ? 1 : -1;
    rows[(index + offset + rows.length) % rows.length]?.querySelector(".combo-row")?.focus();
  }

  if (phase === "loading") {
    return (
      <div className="combo-page combo-page--center">
        <QuantumLoader label="Loading Vups Combo AI" />
      </div>
    );
  }

  if (phase === "error") {
    return (
      <div className="combo-page combo-page--center">
        <div className="combo-load-error" role="alert">
          <span className="combo-kicker">VUPS COMBO AI</span>
          <h1>Combo could not load</h1>
          <p>{loadError}</p>
          <div className="combo-load-error__actions">
            <button type="button" className="combo-btn combo-btn--primary" onClick={() => setLoadNonce(n => n + 1)}>
              Try again
            </button>
            <Link to="/chat" className="combo-btn combo-btn--ghost">Back to chat</Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="combo-page">
      <div className="combo-page__shell" ref={shellRef}>
        <header className="combo-head">
          <div className="combo-head__copy">
            <span className="combo-kicker">MULTI-MODEL ORCHESTRATION</span>
            <h1>Vups Combo AI</h1>
            <p>
              Choose which models Combo may use. Pick <strong>Vups Combo AI</strong> in the chat model selector and
              one request goes to the working ones, then comes back as a single answer.
            </p>
          </div>
          <div className="combo-head__identity">
            <span className="combo-apex">
              <ShinyText
                text="APEX"
                color="var(--muted)"
                shineColor="var(--text)"
                speed={3.4}
                shineWidth={56}
                glow={0.2}
                trigger="loop"
              />
            </span>
            <span className="combo-apex__sub">VUPS COMBO AI</span>
            <span className="combo-head__links">
              <Link to="/chat" className="combo-head__settings">
                Run it in chat <ArrowUpRight size={12} />
              </Link>
              <Link to="/combo/settings" className="combo-head__settings">
                Combo settings <ArrowUpRight size={12} />
              </Link>
            </span>
          </div>
        </header>

        <div className="combo-layout">
          <section className="combo-stage" aria-label="Vups Combo AI workspace">
            <div className={`combo-stage__core combo-stage__core--${coreDensity(providerNetwork.length)}`}>
              <ComboPowerCore
                models={mergedSelected}
                availability={displayAvailability}
                activity={liveRun.activity}
                activeProviderId={activeProviderId}
                startupRef={apexStartupRef}
                startupRunning={apexStartupRunning}
                onProviderSelect={focusProviderInLibrary}
              />
            </div>
            <p className="combo-stage__note" role="status">
              {liveRun.running
                ? `Running in your chat - ${liveRun.stage?.message || "working"}`
                : "Not running. Nodes light up when a chat turn uses them."}
              <span className="combo-stage__note-visual">
                {" "}Visual participation, not a CPU/GPU power measurement.
              </span>
            </p>

            {config.enabled === false ? (
              <div className="combo-alert" role="status">
                Vups Combo AI is disabled. Turn it on in <Link to="/combo/settings">Combo settings</Link>.
              </div>
            ) : null}
          </section>

          <aside className="combo-panel" aria-label="Model library">
            <div className="combo-panel__head">
              <div>
                <span className="combo-kicker">MODEL LIBRARY</span>
                <h2>
                  <CountUp to={summary.selected} duration={0.6} trigger="load" />
                  <span> selected</span>
                </h2>
              </div>
              <button
                type="button"
                className="combo-icon-btn"
                onClick={() => checkAvailability({ force: true })}
                disabled={availabilityBusy || selected.length === 0}
                aria-label="Recheck model availability"
                title="Recheck availability"
              >
                <ArrowsClockwise size={15} />
              </button>
            </div>

            <div className="combo-summary" aria-label="Selection status">
              <span data-state="working"><CheckCircle size={12} weight="fill" aria-hidden="true" /> {summary.working} working</span>
              <span data-state="not_working"><XCircle size={12} weight="fill" aria-hidden="true" /> {summary.notWorking} Not Working</span>
              {summary.unknown ? <span data-state="unknown">{summary.unknown} not checked</span> : null}
            </div>

            <p className="combo-panel__desc">
              Selected models stay saved even when unavailable. Only working models receive requests.
            </p>

            <div className="combo-search">
              <MagnifyingGlass size={14} aria-hidden="true" />
              <input
                type="search"
                value={query}
                onChange={event => setQuery(event.target.value)}
                placeholder="Search model or provider"
                aria-label="Search models by name or provider"
                spellCheck={false}
              />
              {query ? (
                <button type="button" onClick={() => setQuery("")} aria-label="Clear search">
                  <X size={12} />
                </button>
              ) : null}
            </div>

            <div className="combo-filters">
              <select
                className="combo-filter-select"
                value={providerFilter}
                onChange={event => setProviderFilter(event.target.value)}
                aria-label="Filter models by provider or status"
              >
                <option value="">All providers</option>
                <option value={WORKING_MODELS_FILTER}>Working Models</option>
                {providers.map(option => (
                  <option key={option.provider} value={option.provider}>
                    {option.provider} ({option.count})
                  </option>
                ))}
              </select>
              {showVisionFilter ? (
                <label className="combo-filter-check">
                  <input
                    type="checkbox"
                    checked={visionOnly}
                    onChange={event => setVisionOnly(event.target.checked)}
                  />
                  Vision only
                </label>
              ) : null}
            </div>

            <div className="combo-panel__state" role="status" aria-live="polite">
              {availabilityBusy ? "Checking selected models..." : null}
              {!availabilityBusy && availabilityError ? (
                <span className="combo-panel__state-error">{availabilityError}</span>
              ) : null}
              {!availabilityBusy && !availabilityError && saveState === "saving" ? "Saving selection..." : null}
              {!availabilityBusy && !availabilityError && saveState === "error" ? (
                <span className="combo-panel__state-error">
                  {saveError || "Selection was not saved."}{" "}
                  <button type="button" onClick={retrySave}>Retry</button>
                </span>
              ) : null}
              {!availabilityBusy && !availabilityError && saveState === "saved"
                ? "Selection saved"
                : null}
              {!availabilityBusy && !availabilityError && saveState === "idle" && availabilityCheckedAt
                ? "Status updated"
                : null}
              {panelNotice ? <span className="combo-panel__state-error">{panelNotice}</span> : null}
              {testNotice ? <span className="combo-test-notice">{testNotice}</span> : null}
            </div>

            {catalogModels.length === 0 ? (
              <div className="combo-panel__empty">
                <p>No models are available yet.</p>
                <p>Connect a provider in <Link to="/settings">API settings</Link> or wait for the shared catalog.</p>
              </div>
            ) : filtered.length === 0 ? (
              <p className="combo-panel__empty">{libraryEmptyMessage({ query, workingOnly })}</p>
            ) : (
              <ul className="combo-list" role="list" aria-label="Available models" onKeyDown={onListKeyDown}>
                {filtered.map(model => {
                  const isSelected = selected.some(entry => entry.key === model.key);
                  return (
                    <li key={model.key} className="combo-list__item">
                      <ModelRow
                        model={model}
                        selected={isSelected}
                        status={statusFor(displayAvailability, model.key)}
                        test={tests[model.key]}
                        onToggle={toggleModel}
                        onTest={testModel}
                      />
                    </li>
                  );
                })}
              </ul>
            )}
          </aside>
        </div>
      </div>
    </div>
  );
}
