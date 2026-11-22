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
import { comboAvailabilityTimeoutMs, comboTestTimeoutMs, fetchComboState, runComboAvailability, saveComboState, testComboModel } from "./comboApi.js";
import { MODEL_CHECK_CONCURRENCY, createModelCheckQueue } from "./modelCheckQueue.js";
import {
  availabilityMap,
  filterModels,
  isWorkingModelsFilter,
  libraryEmptyMessage,
  mergeSelectedModels,
  providerOptions,
  selectAllModels,
  selectionForSave,
  statusFor,
  statusLabel,
  summaryFor,
  toggleSelectedModel,
  unselectNotWorkingModels,
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

// How many models one availability request carries. A sweep over the whole
// library is split into batches of this size so each request can finish, and
// each finished batch is already saved when the next one starts.

// How many model rows the library draws at once. The library itself may hold
// thousands of models; the page only ever holds one page of them.
const LIBRARY_PAGE_SIZE = 100;

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
// per model key. Every row states where its model stands - Working, Not Working,
// Not Checked, or Checking - so a model nobody has checked is never hidden and
// never mistaken for one that failed.
const ModelRow = React.memo(function ModelRow({ model, selected, status, test, checking, onToggle, onTest }) {
  const testing = test?.phase === "testing";
  const shown = testing || checking ? "checking" : status;
  const showStatus = true;
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
                {shown === "checking" ? (
                  <CircleNotch size={12} className="combo-spin" aria-hidden="true" />
                ) : (
                  <StatusGlyph status={status} />
                )}
                {shown === "checking" ? "Checking" : statusLabel(status)}
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
  const [catalog, setCatalog] = useState({ models: [], total: 0, keys: [], providers: [] });
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState("");
  const [selected, setSelected] = useState([]);
  const [availability, setAvailability] = useState(() => new Map());
  const [availabilityBusy, setAvailabilityBusy] = useState(false);
  const [checkProgress, setCheckProgress] = useState(null);
  const [checkingKeys, setCheckingKeys] = useState(() => new Set());
  const [availabilityError, setAvailabilityError] = useState("");
  const [availabilityCheckedAt, setAvailabilityCheckedAt] = useState(null);
  const [saveState, setSaveState] = useState("idle");
  const [saveError, setSaveError] = useState("");
  const [query, setQuery] = useState("");
  const [providerFilter, setProviderFilter] = useState("");
  const [listPage, setListPage] = useState(0);
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
  // Every availability check on this page goes through one queue, so the number
  // of probes in flight is a single number however the check was started.
  const checkQueueRef = useRef(null);
  if (!checkQueueRef.current) {
    checkQueueRef.current = createModelCheckQueue({
      concurrency: MODEL_CHECK_CONCURRENCY,
      run: async (job, { signal }) =>
        testComboModel({
          key: job.key,
          timeoutMs: comboTestTimeoutMs(configRef.current.settings?.probeTimeoutMs),
          signal
        }),
      isRetryable: error => {
        const status = Number(error?.status || error?.response?.status || 0);
        // A rate limit or a provider that is briefly unwell is worth another
        // try. A refused credential or an unknown model is not.
        return status === 429 || status >= 500;
      },
      onStart: job => {
        setCheckingKeys(current => new Set([...current, job.key]));
        setTests(current => ({ ...current, [job.key]: { phase: "testing", label: job.label } }));
      },
      onResult: (job, data) => {
        setCheckingKeys(current => {
          const next = new Set(current);
          next.delete(job.key);
          return next;
        });
        const result = data?.model;
        if (result?.status !== "working" && result?.status !== "not_working") {
          // A response that names no status proves nothing about the model, so
          // the row keeps its old state and says the test did not report,
          // rather than inventing a verdict.
          setTests(current => ({
            ...current,
            [job.key]: { phase: "error", label: job.label, detail: "The test finished without reporting a model status." }
          }));
          return;
        }
        setTests(current => ({
          ...current,
          [job.key]: {
            phase: "done",
            label: job.label,
            status: result.status,
            latencyMs: result.latencyMs,
            httpStatus: result.httpStatus,
            detail: result.detail
          }
        }));
        setAvailability(current => {
          const next = new Map(current);
          next.set(job.key, {
            key: job.key,
            status: result.status,
            checkedAt: result.checkedAt || new Date().toISOString()
          });
          return next;
        });
        if (!job.silent) {
          setTestNotice(
            result.status === "working"
              ? `${job.label} is Working.`
              : `${job.label} is Not Working - ${String(result.detail || result.reason || "the provider did not answer").slice(0, 150)}.`
          );
        }
      },
      onFailure: (job, error) => {
        setCheckingKeys(current => {
          const next = new Set(current);
          next.delete(job.key);
          return next;
        });
        setTests(current => ({
          ...current,
          [job.key]: { phase: "error", label: job.label, detail: getApiErrorMessage(error) }
        }));
      },
      onProgress: snapshot => setCheckProgress(snapshot)
    });
  }

  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);

  useEffect(() => {
    configRef.current = config;
  }, [config]);

  useEffect(() => () => {
    availabilityAbort.current?.abort();
    // Leaving the page stops the checks it started. A model that was not
    // checked keeps whatever status it had.
    checkQueueRef.current?.cancel();
  }, []);

  useEffect(() => subscribeComboRun(setLiveRun), []);

  useEffect(() => {
    let cancelled = false;
    setPhase("loading");
    setLoadError("");
    setSaveState("idle");
    setSaveError("");
    autoChecked.current = false;
    // Only the first page is asked for. The rest of the catalogue is fetched
    // when a reader asks for it, so the library is on screen long before every
    // provider's models have arrived.
    requestCatalogue({ offset: 0, limit: LIBRARY_PAGE_SIZE }, `0||`)
      .then(data => {        if (cancelled) return;
        const nextConfig = data?.config || {};
        const nextCatalog = data?.catalog || { models: [] };
        const selectedList = Array.isArray(nextConfig.selected) ? nextConfig.selected : [];
        setConfig({
          enabled: nextConfig.enabled !== false,
          settings: { ...FALLBACK_SETTINGS, ...(nextConfig.settings || {}) },
          selected: selectedList,
          updatedAt: nextConfig.updatedAt ?? null
        });
        setCatalog({
          models: Array.isArray(nextCatalog.models) ? nextCatalog.models : [],
          total: Number(nextCatalog.total) || 0,
          keys: Array.isArray(nextCatalog.keys) ? nextCatalog.keys : [],
          providers: Array.isArray(nextCatalog.providers) ? nextCatalog.providers : []
        });
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
  // The sweep covers the whole library, so it counts the library rather than
  // the selection.
  const librarySummary = useMemo(
    () => summaryFor(catalogModels, displayAvailability),
    [catalogModels, displayAvailability]
  );
  const providerNetwork = useMemo(() => buildProviderNetwork(mergedSelected), [mergedSelected]);
  // The provider list and the totals come from the server, which knows about
  // every model rather than only the page on screen.
  const providers = catalog.providers.length > 0 ? catalog.providers : providerOptions(catalogModels);

  // One page of the catalogue at a time. The same page is never asked for
  // twice while a request for it is in flight.
  const catalogueRequest = useRef("");
  const cataloguePending = useRef(new Map());
  function requestCatalogue(options, key) {
    const existing = cataloguePending.current.get(key);
    if (existing) return existing;
    const promise = fetchComboState(options);
    cataloguePending.current.set(key, promise);
    const clear = () => {
      if (cataloguePending.current.get(key) === promise) cataloguePending.current.delete(key);
    };
    promise.then(clear, clear);
    return promise;
  }
  async function loadCataloguePage({ page = 0, query: search = "", provider: only = "" } = {}) {
    const requestKey = `${page}|${search}|${only}`;
    if (catalogueRequest.current === requestKey) return null;
    catalogueRequest.current = requestKey;
    setCatalogLoading(true);
    setCatalogError("");
    try {
      const data = await requestCatalogue(
        { offset: page * LIBRARY_PAGE_SIZE, limit: LIBRARY_PAGE_SIZE, query: search, provider: only },
        requestKey
      );
      const nextCatalog = data?.catalog || { models: [] };
      setCatalog({
        models: Array.isArray(nextCatalog.models) ? nextCatalog.models : [],
        total: Number(nextCatalog.total) || 0,
        keys: Array.isArray(nextCatalog.keys) ? nextCatalog.keys : [],
        providers: Array.isArray(nextCatalog.providers) ? nextCatalog.providers : []
      });
      setListPage(page);
      return nextCatalog;
    } catch (error) {
      setCatalogError(getApiErrorMessage(error));
      return null;
    } finally {
      if (catalogueRequest.current === requestKey) catalogueRequest.current = "";
      setCatalogLoading(false);
    }
  }

  // A search or a provider filter is answered by the server, which knows every
  // model the account holds and not only the page on screen. The first page of
  // the catalogue is already loaded, so the first run is skipped, and a filter
  // that has not changed is never asked for twice.
  const catalogueFilter = useRef(`${query}|${providerFilter}`);
  useEffect(() => {
    const key = `${query}|${providerFilter}`;
    if (catalogueFilter.current === key) return undefined;
    catalogueFilter.current = key;
    const handle = setTimeout(() => {
      loadCataloguePage({ page: 0, query, provider: workingOnly ? "" : providerFilter });
    }, 220);
    return () => clearTimeout(handle);
  }, [query, providerFilter]);

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
  // The server has already searched and filtered the catalogue, so the page on
  // screen is the answer. The one filter it cannot answer is the status view,
  // which is applied to what is loaded.
  const filtered = useMemo(() => {
    const list = filterModels(catalogModels, {
      query: "",
      provider: "",
      workingOnly,
      availability: displayAvailability
    });
    return list;
  }, [catalogModels, workingOnly, displayAvailability]);

  // A library can hold thousands of models, and the page draws one page of them
  // at a time. Select All and Test All still work on the whole library: the
  // server names every model it holds, and the page is a view of it, never its
  // limit.
  const pageCount = Math.max(1, Math.ceil((catalog.total || filtered.length) / LIBRARY_PAGE_SIZE));
  const page = Math.min(listPage, pageCount - 1);
  const pageStart = page * LIBRARY_PAGE_SIZE;
  const visibleModels = filtered.slice(0, LIBRARY_PAGE_SIZE);
  useEffect(() => {
    setListPage(0);
  }, [query, providerFilter]);

  function focusProviderInLibrary(provider) {
    // The library filters by the catalog's own provider label, so a node has to
    // speak that vocabulary or the filter would match nothing.
    const name = (provider?.models || []).map(model => model.provider).find(Boolean) || provider?.name || "";
    if (!name) return;
    setQuery("");
    setProviderFilter(current => (current === name ? "" : name));
  }

  // The whole library, checked through the one queue. The server names every
  // model it holds, so a check covers models that are not on screen. A model
  // that already has a current result is left alone: asking a provider about it
  // again would cost a request and tell nobody anything new.
  function testAll() {
    const queue = checkQueueRef.current;
    const keys = catalog.keys.length > 0 ? catalog.keys : catalogModels.map(model => model.key);
    const unchecked = keys.filter(key => statusFor(displayAvailability, key) === "unknown");
    if (!unchecked.length) {
      setTestNotice("Every model in the library already has a result.");
      return;
    }
    queue.enqueue(unchecked.map(key => ({ key, label: modelTitle({ key, model: key }), silent: true })));
    setTestNotice(`Checking ${unchecked.length.toLocaleString()} models...`);
  }

  // A deliberate re-check of the selection, so every selected model is asked
  // about again even when its last result is still on the page.
  function recheckSelected() {
    const queue = checkQueueRef.current;
    const models = selectedRef.current;
    if (!models.length) return;
    queue.enqueue(models.map(model => ({ key: model.key, label: modelTitle(model), silent: true })));
    setTestNotice(`Re-checking ${models.length.toLocaleString()} models...`);
  }

  async function checkAvailability({ force = false, keys = null, scope = "selected" } = {}) {
    const targets = Array.isArray(keys) && keys.length > 0
      ? [...new Set(keys.map(key => String(key)).filter(Boolean))]
      : selectedRef.current.map(model => model.key);
    if (!targets.length) return;
    // While the queue is checking models, nothing else may put a probe on a
    // provider: the ceiling on probes in flight is one number for the page.
    if (checkQueueRef.current.isRunning()) return;
    availabilitySeq.current += 1;
    const seq = availabilitySeq.current;
    availabilityAbort.current?.abort();
    const controller = new AbortController();
    availabilityAbort.current = controller;
    setAvailabilityBusy(true);
    setAvailabilityError("");
    try {
      // One request for the whole selection. The server answers from its cache
      // what it already knows and probes only what is missing.
      const data = await runComboAvailability({
        force,
        keys: targets,
        signal: controller.signal,
        timeoutMs: comboAvailabilityTimeoutMs(targets.length, configRef.current.settings?.probeTimeoutMs)
      });
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
    const key = model.key;
    const stopped = checkQueueRef.current.cancelKey(key);
    if (!stopped) return false;
    setTests(current => {
      const next = { ...current };
      delete next[key];
      return next;
    });
    setCheckingKeys(current => {
      const next = new Set(current);
      next.delete(key);
      return next;
    });
    setTestNotice(`Test for ${modelTitle(model)} stopped. No status was recorded.`);
    return true;
  }

  function testModel(model) {
    if (stopModelTest(model)) return;
    const key = model.key;
    const label = modelTitle(model);
    // A model checked by hand joins the same queue as the library sweep, so it
    // can never push more probes in flight than the ceiling allows.
    checkQueueRef.current.enqueue([{ key, label }]);
    setTestNotice(`Checking ${label}...`);
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

  function persistSelection(next, { refreshAvailability = true } = {}) {
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
        if (refreshAvailability && configRef.current.settings?.autoAvailability !== false && keys.length > 0) {
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
      setPanelNotice("That model could not be selected. Reload the model list and try again.");
      return;
    }
    setPanelNotice("");
    persistSelection(next);
  }

  // Select the whole library. The models already selected keep their stored
  // identity, and the availability of a model is not a condition: an
  // unavailable model is still part of the library. No model is contacted on
  // account of being selected.
  async function selectAll() {
    // Selecting every model needs every model, not only the page on screen,
    // so the whole matching catalogue is fetched once if it is not already
    // here.
    let models = catalogModels;
    const total = catalog.total || catalogModels.length;
    if (catalogModels.length < total) {
      try {
        const data = await fetchComboState({
          offset: 0,
          limit: 0,
          query,
          provider: workingOnly ? "" : providerFilter
        });
        models = Array.isArray(data?.catalog?.models) ? data.catalog.models : models;
      } catch (error) {
        setPanelNotice(getApiErrorMessage(error));
        return;
      }
    }
    const next = selectAllModels(selectedRef.current, models);
    if (next.length === selectedRef.current.length) {
      setPanelNotice("");
      return;
    }
    setPanelNotice("");
    persistSelection(next, { refreshAvailability: false });
  }

  // Keep only the models a real check proved are working. The decision reads
  // the availability the server already published; it never asks a model.
  function unselectNotWorking() {
    const next = unselectNotWorkingModels(selectedRef.current, displayAvailability);
    setPanelNotice("");
    persistSelection(next, { refreshAvailability: false });
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
                onClick={() => recheckSelected()}
                disabled={availabilityBusy || selected.length === 0}
                aria-label="Recheck model availability"
                title="Recheck availability"
              >
                <ArrowsClockwise size={15} />
              </button>
            </div>

            <div className="combo-summary" aria-label="Selection status">
              <span data-state="total">{catalogModels.length.toLocaleString()} models</span>
              <span data-state="selected">{summary.selected.toLocaleString()} selected</span>
              <span data-state="working"><CheckCircle size={12} weight="fill" aria-hidden="true" /> {summary.working} working</span>
              <span data-state="not_working"><XCircle size={12} weight="fill" aria-hidden="true" /> {summary.notWorking} Not Working</span>
              {summary.unknown ? <span data-state="unknown">{summary.unknown} Not Checked</span> : null}
            </div>

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
            </div>

            <div className="combo-selection-actions">
              <button
                type="button"
                className="combo-selection-btn"
                onClick={selectAll}
                disabled={catalogModels.length === 0}
              >
                Select All
              </button>
              <button
                type="button"
                className="combo-selection-btn"
                onClick={unselectNotWorking}
                disabled={selected.length === 0}
              >
                Unselect Not Working
              </button>
              <button
                type="button"
                className="combo-selection-btn"
                onClick={testAll}
                disabled={availabilityBusy || catalogModels.length === 0}
              >
                Test All
              </button>
            </div>

            {checkProgress && (checkProgress.active > 0 || checkProgress.pending > 0) ? (
              <div className="combo-sweep" role="status" aria-live="polite">
                <p className="combo-sweep__title">
                  {`Checked ${checkProgress.completed.toLocaleString()} of ${(
                    checkProgress.completed + checkProgress.failed + checkProgress.active + checkProgress.pending
                  ).toLocaleString()} models`}
                </p>
                <ul className="combo-sweep__counts">
                  <li data-state="working">Working: {librarySummary.working.toLocaleString()}</li>
                  <li data-state="not_working">Not Working: {librarySummary.notWorking.toLocaleString()}</li>
                  <li data-state="checking">Checking: {checkProgress.active.toLocaleString()}</li>
                  <li data-state="unknown">Not Checked: {librarySummary.unknown.toLocaleString()}</li>
                </ul>
              </div>
            ) : null}

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
              <>
                <ul className="combo-list" role="list" aria-label="Available models" onKeyDown={onListKeyDown}>
                  {visibleModels.map(model => {
                    const isSelected = selected.some(entry => entry.key === model.key);
                    return (
                      <li key={model.key} className="combo-list__item">
                        <ModelRow
                          model={model}
                          selected={isSelected}
                          status={statusFor(displayAvailability, model.key)}
                          test={tests[model.key]}
                          checking={checkingKeys.has(model.key)}
                          onToggle={toggleModel}
                          onTest={testModel}
                        />
                      </li>
                    );
                  })}
                </ul>
                {pageCount > 1 || catalogLoading ? (
                  <nav className="combo-pager" aria-label="Model library pages">
                    <button
                      type="button"
                      className="combo-pager-btn"
                      onClick={() => loadCataloguePage({ page: Math.max(0, page - 1), query, provider: workingOnly ? "" : providerFilter })}
                      disabled={page === 0 || catalogLoading}
                    >
                      Previous
                    </button>
                    <span className="combo-pager__count">
                      {catalogLoading
                        ? "Loading models…"
                        : `Showing ${(pageStart + 1).toLocaleString()}-${Math.min(pageStart + LIBRARY_PAGE_SIZE, catalog.total || filtered.length).toLocaleString()} of ${(catalog.total || filtered.length).toLocaleString()}`}
                    </span>
                    <button
                      type="button"
                      className="combo-pager-btn"
                      onClick={() => loadCataloguePage({ page: Math.min(pageCount - 1, page + 1), query, provider: workingOnly ? "" : providerFilter })}
                      disabled={page >= pageCount - 1 || catalogLoading}
                    >
                      Next
                    </button>
                  </nav>
                ) : null}
              </>
            )}
          </aside>
        </div>
      </div>
    </div>
  );
}
