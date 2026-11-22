import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowClockwise,
  Check,
  ChatCircle,
  Cpu,
  DownloadSimple,
  HardDrive,
  MagnifyingGlass,
  Sparkle,
  Trash,
  X
} from "@phosphor-icons/react";
import { Link } from "react-router-dom";

import { detectNativeShell } from "../native/shell.js";
import { useConnectivity } from "../connectivity/connectivity.js";
import { saveStoredSelection } from "../chat/modelCatalog.js";
import { useTasks } from "../desktop/TaskContext.jsx";
import {
  LOCAL_AI_STATES,
  detectLocalRuntime,
  pullLocalModel,
  removeLocalModel
} from "./localRuntime.js";
import {
  LOCAL_MODEL_LIBRARY,
  buildLibraryRows,
  estimatedWeightsBytes,
  fetchRegistrySizeBytes,
  libraryEntry
} from "./localModelCatalog.js";
import {
  classifyModelFit,
  detectHardware,
  hardwareSummary,
  modelFootprintBytes,
  UNKNOWN_HARDWARE
} from "./localHardware.js";
import { nativeHardwareInfo } from "./hardwareBridge.js";
import { capabilityLabels, recommendModels } from "./localRecommendations.js";
import {
  comboPlan,
  updateLocalComboConfig,
  useLocalComboConfig
} from "./localCombo.js";
import { ensureLocalChatsFolder, useLocalChatsFolder } from "./localChats.js";
import { formatModelSize } from "./localRuntime.js";
import "./localAi.css";

const REFRESH_INTERVAL_MS = 15000;
const SIZE_CACHE_KEY = "vupsrouter.localai.sizes.v2";
const SIZE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SIZE_FETCH_CONCURRENCY = 4;

function progressLine(event) {
  if (!event || typeof event !== "object") return "";
  const status = String(event.status || "").replace(/\.\.\.$/, "").trim();
  const total = Number(event.total) || 0;
  const completed = Number(event.completed) || 0;
  if (total > 0 && completed > 0) {
    const percent = Math.min(99, Math.round((completed / total) * 100));
    return `${status ? `${status} ` : ""}${percent}%`;
  }
  return status;
}

function readSizeCache() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SIZE_CACHE_KEY) || "{}");
    const now = Date.now();
    const cache = {};
    for (const [key, value] of Object.entries(parsed || {})) {
      if (!value || typeof value !== "object") continue;
      if (now - Number(value.at || 0) > SIZE_CACHE_TTL_MS) continue;
      cache[key] = Number(value.bytes) || 0;
    }
    return cache;
  } catch {
    return {};
  }
}

function writeSizeCache(cache) {
  try {
    const at = Date.now();
    const payload = {};
    for (const [key, bytes] of Object.entries(cache)) payload[key] = { bytes, at };
    localStorage.setItem(SIZE_CACHE_KEY, JSON.stringify(payload));
  } catch {
    /* Sizes are informative only. */
  }
}

function tierClass(fit) {
  if (fit.level === "gpu" || fit.level === "high") return "high";
  if (fit.level === "mid") return "mid";
  if (fit.level === "low") return "low";
  if (fit.level === "insufficient") return "too-large";
  return "unknown";
}

function fitLabel(fit) {
  if (fit.level === "gpu") return "High-end · GPU";
  if (fit.level === "insufficient") return "Too large";
  if (fit.level === "unknown") return "Unknown";
  return fit.label;
}

function modelSizeLine(row) {
  const parts = [];
  if (row.installedBytes > 0) parts.push(`On disk ${formatModelSize(row.installedBytes)}`);
  if (row.downloadBytes > 0) parts.push(`Download ${formatModelSize(row.downloadBytes)}`);
  return parts.join(" · ");
}

function CapabilityPills({ row }) {
  return (
    <span className="local-ai-caps">
      {capabilityLabels(row).map(label => (
        <span key={label} className="local-ai-pill">
          {label}
        </span>
      ))}
      <span className="local-ai-pill local-ai-pill--quiet" title={row.capabilitySource === "runtime" ? "Reported by the local runtime" : "From the verified catalogue"}>
        {row.capabilitySource === "runtime" ? "Runtime" : "Catalogue"}
      </span>
    </span>
  );
}

function ModelRow({ row, fit, onInstall, onRemove, progress, onCancel, busy, disabled }) {
  const [expanded, setExpanded] = useState(false);
  const sizeLine = modelSizeLine(row);
  return (
    <li className="local-ai-row" data-installed={row.installed ? "" : undefined}>
      <div className="local-ai-row__main">
        <button
          type="button"
          className="local-ai-row__name"
          onClick={() => setExpanded(value => !value)}
          aria-expanded={expanded}
          title="Show compatibility details"
        >
          {row.name}
        </button>
        <span className="local-ai-row__meta">
          <span className={`local-ai-tier local-ai-tier--${tierClass(fit)}`}>{fitLabel(fit)}</span>
          <CapabilityPills row={row} />
          <span className="local-ai-row__size" title={sizeLine || "Size unavailable"}>
            {sizeLine || "Size unavailable"}
          </span>
        </span>
        {expanded ? <span className="local-ai-row__detail">{fit.detail}</span> : null}
      </div>
      <div className="local-ai-row__action">
        {progress ? (
          <>
            <span className="local-ai-row__progress" role="status">
              {progressLine(progress.event) || "Downloading…"}
            </span>
            <button type="button" className="local-ai-btn local-ai-btn--quiet" onClick={onCancel}>
              <X size={13} aria-hidden="true" />
              Cancel
            </button>
          </>
        ) : row.installed ? (
          <>
            <span className="local-ai-row__installed">
              <Check size={14} aria-hidden="true" />
              Installed
            </span>
            <button
              type="button"
              className="local-ai-btn local-ai-btn--quiet"
              onClick={() => onRemove(row)}
              disabled={busy}
              aria-label={`Remove ${row.name}`}
              title={`Remove ${row.name} from the runtime`}
            >
              <Trash size={13} aria-hidden="true" />
            </button>
          </>
        ) : (
          <button
            type="button"
            className="local-ai-btn"
            onClick={() => onInstall(row)}
            disabled={busy || disabled}
            title={disabled ? "The runtime is not available" : `Install ${row.name}`}
          >
            <DownloadSimple size={13} aria-hidden="true" />
            Install
          </button>
        )}
      </div>
    </li>
  );
}

function RecommendationCard({ category, onInstall, busy, runtimeReady }) {
  return (
    <article className="local-ai-rec" aria-label={`${category.label} recommendations`}>
      <header className="local-ai-rec__head">
        <span className="local-ai-rec__title">{category.label}</span>
        <span className="local-ai-rec__hint">{category.hint}</span>
      </header>
      {category.empty ? (
        <p className="local-ai-rec__empty">{category.empty}</p>
      ) : (
        <ul className="local-ai-rec__list">
          {category.picks.map(pick => (
            <li key={pick.row.name} className="local-ai-rec__pick">
              <div className="local-ai-rec__copy">
                <span className="local-ai-rec__name">{pick.row.name}</span>
                <span className="local-ai-rec__meta">
                  <span className={`local-ai-tier local-ai-tier--${tierClass(pick.fit)}`}>{fitLabel(pick.fit)}</span>
                  <span>{pick.row.installedBytes > 0 ? formatModelSize(pick.row.installedBytes) : pick.row.downloadSize || "Size unavailable"}</span>
                </span>
                <span className="local-ai-rec__reason">{pick.reason}</span>
              </div>
              <span className="local-ai-rec__action">
                <span className="local-ai-rec__badge">{pick.role}</span>
                {pick.row.installed ? (
                  <span className="local-ai-row__installed">
                    <Check size={13} aria-hidden="true" />
                    Ready
                  </span>
                ) : (
                  <button
                    type="button"
                    className="local-ai-btn local-ai-btn--quiet"
                    onClick={() => onInstall(pick.row)}
                    disabled={busy || !runtimeReady}
                  >
                    Install
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

export default function LocalAiPage() {
  const shell = useMemo(() => detectNativeShell(), []);
  const { online } = useConnectivity();
  const { tasks } = useTasks();
  const folder = useLocalChatsFolder();
  const comboConfig = useLocalComboConfig();
  const [runtime, setRuntime] = useState({ state: LOCAL_AI_STATES.unavailable, models: [], reason: "" });
  const [hardware, setHardware] = useState(UNKNOWN_HARDWARE);
  const [sizes, setSizes] = useState(() => readSizeCache());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [progress, setProgress] = useState(null);
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState("");
  const abortRef = useRef(null);
  const sizeRequests = useRef(new Set());

  const refreshRuntime = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) setLoading(true);
    try {
      const next = await detectLocalRuntime(shell);
      setRuntime(next);
      setError("");
      if (next.state === LOCAL_AI_STATES.ready && next.models.length > 0) {
        ensureLocalChatsFolder();
      }
    } catch (failure) {
      setError(failure?.message || "The local AI runtime could not be read.");
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [shell]);

  const refreshHardware = useCallback(async ({ force = false } = {}) => {
    const next = await detectHardware({
      nativeInfo: shell === "windows" ? nativeHardwareInfo : null,
      force
    });
    setHardware(next);
  }, [shell]);

  const refresh = useCallback(async () => {
    setNotice("");
    await Promise.all([refreshRuntime(), refreshHardware({ force: true })]);
  }, [refreshRuntime, refreshHardware]);

  useEffect(() => {
    refreshRuntime();
    refreshHardware();
  }, [refreshRuntime, refreshHardware]);

  // The page keeps itself current: a model installed from a terminal has to
  // appear without the reader having to reopen the app.
  useEffect(() => {
    if (runtime.state !== LOCAL_AI_STATES.ready) return undefined;
    const timer = window.setInterval(() => {
      detectLocalRuntime(shell)
        .then(next => setRuntime(next))
        .catch(() => {});
    }, REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [runtime.state, shell]);

  // Download sizes come from the runtime's registry, are cached for a week and
  // are read a few at a time so opening the page stays responsive.
  useEffect(() => {
    // Registry sizes are the only part of this page that needs the internet.
    // Offline, the library keeps showing real local metadata and the download
    // size is filled in when the connection returns.
    if (!online) return undefined;
    let cancelled = false;
    const queue = LOCAL_MODEL_LIBRARY
      .map(entry => entry.name)
      .filter(name => !Object.prototype.hasOwnProperty.call(sizes, name.toLowerCase()))
      .filter(name => !sizeRequests.current.has(name));
    if (queue.length === 0) return undefined;
    let index = 0;
    const worker = async () => {
      while (!cancelled && index < queue.length) {
        const name = queue[index];
        index += 1;
        sizeRequests.current.add(name);
        let bytes = 0;
        try {
          bytes = await fetchRegistrySizeBytes(name, { signal: AbortSignal.timeout(15000) });
        } catch {
          bytes = 0;
        }
        sizeRequests.current.delete(name);
        if (cancelled) return;
        setSizes(current => {
          if (Object.prototype.hasOwnProperty.call(current, name.toLowerCase())) return current;
          const next = { ...current, [name.toLowerCase()]: bytes };
          writeSizeCache(next);
          return next;
        });
      }
    };
    Promise.all(Array.from({ length: Math.min(SIZE_FETCH_CONCURRENCY, queue.length) }, worker));
    return () => {
      cancelled = true;
    };
    // Only the presence of new runtime models changes what still needs a size.
  }, [online, runtime.models, sizes]);

  const installed = runtime.models || [];
  const rows = useMemo(
    () => buildLibraryRows({ installed, sizes }),
    [installed, sizes]
  );
  const rowByName = useMemo(
    () => new Map(rows.map(row => [row.name.toLowerCase(), row])),
    [rows]
  );
  const plan = useMemo(() => comboPlan(comboConfig, installed), [comboConfig, installed]);
  const recommendations = useMemo(() => recommendModels(rows, hardware), [rows, hardware]);
  const summary = useMemo(() => hardwareSummary(hardware), [hardware]);

  const localTasks = useMemo(() => {
    const marked = new Set(Object.keys(folder.chats || {}));
    return (tasks || [])
      .filter(task => marked.has(String(task.id)))
      .map(task => {
        const record = folder.chats[task.id];
        return {
          id: task.id,
          title: task.title || record?.title || "Local chat",
          updatedAt: task.updatedAt || record?.updatedAt || "",
          model: record?.model || "",
          combo: Boolean(record?.combo),
          draft: String(task.id).startsWith("local-")
        };
      });
  }, [tasks, folder]);

  const installedRows = useMemo(() => rows.filter(row => row.installed), [rows]);
  const filteredRows = useMemo(() => {
    const term = search.trim().toLowerCase();
    const list = [...rows].sort((a, b) => {
      if (a.installed !== b.installed) return a.installed ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    if (!term) return list;
    return list.filter(row =>
      [row.name, row.family, ...(row.capabilities || []), ...capabilityLabels(row)]
        .join(" ")
        .toLowerCase()
        .includes(term)
    );
  }, [rows, search]);

  const install = useCallback(
    async row => {
      if (busy) return;
      setBusy(true);
      setError("");
      setNotice("");
      const knownSize = row.downloadBytes || estimatedWeightsBytes(libraryEntry(row.name));
      if (hardware.storageFreeBytes > 0 && knownSize > hardware.storageFreeBytes) {
        setError(
          `This download needs about ${formatModelSize(knownSize)}, but only ${formatModelSize(hardware.storageFreeBytes)} is free.`
        );
        setBusy(false);
        return;
      }
      setProgress({ name: row.name, event: null });
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        await pullLocalModel(row.name, {
          signal: controller.signal,
          onProgress: event => setProgress(current => (current ? { ...current, event } : current))
        });
        const next = await detectLocalRuntime(shell);
        setRuntime(next);
        const confirmed = (next.models || []).some(model => String(model.name).toLowerCase() === row.name.toLowerCase());
        if (confirmed) {
          ensureLocalChatsFolder();
          setNotice(`${row.name} is installed and ready.`);
        } else {
          setError(`The download finished, but the runtime does not list ${row.name} yet. Try Refresh.`);
        }
      } catch (failure) {
        if (failure?.name !== "AbortError") {
          setError(failure?.message || "The model could not be downloaded.");
        }
      } finally {
        abortRef.current = null;
        setProgress(null);
        setBusy(false);
      }
    },
    [busy, hardware.storageFreeBytes, shell]
  );

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setProgress(null);
    setBusy(false);
  }, []);

  const remove = useCallback(
    async row => {
      if (busy) return;
      setBusy(true);
      setError("");
      setNotice("");
      try {
        await removeLocalModel(row.name);
        const next = await detectLocalRuntime(shell);
        setRuntime(next);
      } catch (failure) {
        setError(failure?.message || "The model could not be removed.");
      } finally {
        setBusy(false);
      }
    },
    [busy, shell]
  );

  const toggleCombo = useCallback(() => {
    updateLocalComboConfig(current => ({ ...current, enabled: !current.enabled }));
  }, []);

  const toggleComboModel = useCallback(name => {
    updateLocalComboConfig(current => {
      const exists = current.models.some(value => value.toLowerCase() === name.toLowerCase());
      const models = exists
        ? current.models.filter(value => value.toLowerCase() !== name.toLowerCase())
        : [...current.models, name];
      return { ...current, models };
    });
  }, []);

  const clearMissingComboModels = useCallback(() => {
    updateLocalComboConfig(current => ({ ...current, models: plan.usable }));
  }, [plan.usable]);

  const unavailable = runtime.state === LOCAL_AI_STATES.unavailable;
  const unsupported = runtime.state === LOCAL_AI_STATES.unsupported;
  const runtimeReady = runtime.state === LOCAL_AI_STATES.ready;
  const comboRunnable = comboConfig.enabled && plan.usable.length > 0;
  // Which roles the selected installed models can cover. The router binds one
  // model per role and request; this preview says what is possible here.
  const comboRoles = useMemo(() => {
    const selected = new Set(plan.usable.map(name => String(name).toLowerCase()));
    const covered = new Set();
    for (const model of installed) {
      if (!selected.has(String(model.name || "").toLowerCase())) continue;
      const capabilities = Array.isArray(model.capabilities)
        ? model.capabilities.map(capability => String(capability).toLowerCase())
        : [];
      if (capabilities.includes("vision")) covered.add("Vision");
      if (capabilities.includes("thinking") || capabilities.includes("reasoning")) covered.add("Reasoning");
      if (capabilities.includes("coding")) covered.add("Code");
    }
    if (plan.usable.length > 0) covered.add("Chat");
    return ["Chat", "Reasoning", "Code", "Vision"].filter(role => covered.has(role));
  }, [installed, plan.usable]);

  return (
    <div className="local-ai-page">
      <div className="local-ai-page__shell">
        <header className="local-ai-head">
          <div className="local-ai-head__copy">
            <span className="local-ai-kicker">ON-DEVICE MODELS</span>
            <h1>Local AI</h1>
            <p>Everything here runs on this device.</p>
          </div>
          <div className="local-ai-head__actions">
            <button type="button" className="local-ai-btn local-ai-btn--quiet" onClick={refresh} disabled={loading}>
              <ArrowClockwise size={13} aria-hidden="true" />
              Refresh
            </button>
            <Link to="/chat" className="local-ai-btn local-ai-btn--quiet">
              <Cpu size={13} aria-hidden="true" />
              Chat
            </Link>
          </div>
        </header>

        {unavailable ? (
          <div className="local-ai-state" data-state="unavailable">
            <strong>Runtime unavailable</strong>
            <span>{runtime.reason || "The local AI runtime is not running on this computer."}</span>
          </div>
        ) : null}
        {unsupported ? (
          <div className="local-ai-state" data-state="unsupported">
            <strong>Not available here</strong>
            <span>{runtime.reason}</span>
          </div>
        ) : null}
        {error ? (
          <div className="local-ai-state" data-state="error" role="alert">
            <strong>Something went wrong</strong>
            <span>{error}</span>
          </div>
        ) : null}
        {notice ? (
          <div className="local-ai-state" data-state="notice" role="status">
            <strong>{notice}</strong>
          </div>
        ) : null}

        <section className="local-ai-section local-ai-combo" aria-label="Local Combo AI">
          <div className="local-ai-combo__head">
            <div className="local-ai-combo__copy">
              <span className="local-ai-section__title">
                <Sparkle size={14} aria-hidden="true" />
                Local Combo AI
              </span>
              <span className="local-ai-section__hint">
                Automatically selects the right installed local model for each task. Uses multiple models only when necessary.
              </span>
            </div>
            <button
              type="button"
              className={`local-ai-switch${comboConfig.enabled ? " is-on" : ""}`}
              role="switch"
              aria-checked={comboConfig.enabled}
              onClick={toggleCombo}
            >
              <span className="local-ai-switch__track" aria-hidden="true">
                <span className="local-ai-switch__thumb" />
              </span>
              {comboConfig.enabled ? "Enabled" : "Disabled"}
            </button>
          </div>

          {installed.length === 0 ? (
            <p className="local-ai-combo__empty">
              Install at least one local model below. It will appear here for combo selection.
            </p>
          ) : (
            <ul className="local-ai-combo__models">
              {installed.map(model => {
                const selectedIndex = plan.selected.findIndex(name => name.toLowerCase() === model.name.toLowerCase());
                const checked = selectedIndex !== -1;
                return (
                  <li key={model.name}>
                    <button
                      type="button"
                      className={`local-ai-combo__model${checked ? " is-selected" : ""}`}
                      aria-pressed={checked}
                      onClick={() => toggleComboModel(model.name)}
                    >
                      <span className="local-ai-combo__order">{checked ? selectedIndex + 1 : ""}</span>
                      <span className="local-ai-combo__name">{model.name}</span>
                      <span className="local-ai-combo__meta">
                        {model.size || "Size unavailable"} · {model.capability || "Chat"}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          {comboRoles.length > 0 ? (
            <div className="local-ai-combo__roles" aria-label="Roles these models can cover">
              <span>Roles available here</span>
              {comboRoles.map(role => (
                <span key={role} className="local-ai-combo__role-chip">{role}</span>
              ))}
            </div>
          ) : null}

          {plan.missing.length > 0 ? (
            <div className="local-ai-combo__missing">
              <span>
                Not installed right now: {plan.missing.join(", ")}. The run will continue with the other selected models.
              </span>
              <button type="button" className="local-ai-btn local-ai-btn--quiet" onClick={clearMissingComboModels}>
                Remove missing
              </button>
            </div>
          ) : null}

          <div className="local-ai-combo__footer">
            <span className="local-ai-combo__summary">
              {plan.usable.length === 0
                ? "No models selected."
                : `${plan.usable.length} selected · runs sequentially · stays on this device`}
            </span>
            <Link
              to="/chat"
              className={`local-ai-btn${comboRunnable ? "" : " is-disabled"}`}
              aria-disabled={!comboRunnable}
              onClick={event => {
                if (!comboRunnable) {
                  event.preventDefault();
                  return;
                }
                saveStoredSelection({ kind: "saved", model: "combined-local" });
              }}
              title={comboRunnable ? "Opens a chat with the Combined Local AI model selected" : "Enable the combo and select at least one installed model"}
            >
              <ChatCircle size={13} aria-hidden="true" />
              Open chat
            </Link>
          </div>
        </section>

        <section className="local-ai-section local-ai-hardware" aria-label="Hardware">
          <div className="local-ai-hardware__head">
            <span className="local-ai-section__title">
              <HardDrive size={14} aria-hidden="true" />
              This device
            </span>
            <span className={`local-ai-tier local-ai-tier--${summary.tier?.id || "unknown"}`}>
              {summary.tier?.label || "Unknown"}
            </span>
          </div>
          <dl className="local-ai-hardware__grid">
            <div>
              <dt>Memory</dt>
              <dd>{summary.ram}</dd>
            </div>
            <div>
              <dt>CPU</dt>
              <dd>{summary.cpu}</dd>
            </div>
            <div>
              <dt>GPU</dt>
              <dd>{summary.gpu}</dd>
            </div>
            <div>
              <dt>Storage</dt>
              <dd>{summary.storage}</dd>
            </div>
          </dl>
          {hardware.estimated ? (
            <p className="local-ai-hardware__note">
              Estimated: this build cannot read exact hardware. Compatibility labels use these estimates, and system RAM is never treated as GPU memory.
            </p>
          ) : null}
        </section>

        <section className="local-ai-section" aria-label="Recommendations">
          <div className="local-ai-section__head">
            <span className="local-ai-section__title">Recommended for this device</span>
            <span className="local-ai-section__hint">Only models that fit the detected memory are recommended.</span>
          </div>
          <div className="local-ai-rec-grid">
            {recommendations.map(category => (
              <RecommendationCard
                key={category.id}
                category={category}
                onInstall={install}
                busy={busy}
                runtimeReady={runtimeReady}
              />
            ))}
          </div>
        </section>

        <section className="local-ai-section" aria-label="All local models">
          <div className="local-ai-section__head">
            <span className="local-ai-section__title">All local models</span>
            <span className="local-ai-section__hint">{rows.length} verified Ollama models</span>
          </div>
          <label className="local-ai-search">
            <MagnifyingGlass size={14} aria-hidden="true" />
            <input
              type="search"
              value={search}
              onChange={event => setSearch(event.target.value)}
              placeholder="Search models, families or capabilities"
              aria-label="Search local models"
            />
          </label>
          {filteredRows.length === 0 ? (
            <p className="local-ai-empty">No model matches this search.</p>
          ) : (
            <ul className="local-ai-list">
              {filteredRows.map(row => (
                <ModelRow
                  key={row.name}
                  row={row}
                  fit={classifyModelFit(row, hardware)}
                  busy={busy}
                  disabled={!runtimeReady}
                  progress={progress?.name === row.name ? progress : null}
                  onInstall={install}
                  onRemove={remove}
                  onCancel={cancel}
                />
              ))}
            </ul>
          )}
        </section>

        <section className="local-ai-section" aria-label="Installed models">
          <div className="local-ai-section__head">
            <span className="local-ai-section__title">Installed models</span>
            <span className="local-ai-section__hint">{installedRows.length} on this device</span>
          </div>
          {installedRows.length === 0 ? (
            <p className="local-ai-empty">No local model is installed yet.</p>
          ) : (
            <ul className="local-ai-installed">
              {installedRows.map(row => (
                <li key={row.name} className="local-ai-installed__row">
                  <span className="local-ai-installed__name">{row.name}</span>
                  <span className="local-ai-installed__meta">
                    {row.installedSize || "Size unavailable"} · {capabilityLabels(row).join(", ")}
                  </span>
                  <span className={`local-ai-tier local-ai-tier--${tierClass(classifyModelFit(row, hardware))}`}>
                    {fitLabel(classifyModelFit(row, hardware))}
                  </span>
                  <button
                    type="button"
                    className="local-ai-btn local-ai-btn--quiet"
                    onClick={() => remove(row)}
                    disabled={busy}
                    aria-label={`Remove ${row.name}`}
                  >
                    <Trash size={13} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="local-ai-section" aria-label="Local Chats">
          <div className="local-ai-section__head">
            <span className="local-ai-section__title">Local Chats</span>
            <span className="local-ai-section__hint">Stored on this device by the app · never sent to a cloud model</span>
          </div>
          {localTasks.length === 0 ? (
            <p className="local-ai-empty">
              Local chats appear here after you send a message to a local model.
            </p>
          ) : (
            <ul className="local-ai-chats">
              {localTasks.map(task => (
                <li key={task.id} className="local-ai-chats__row">
                  <Link to={`/chat?task=${encodeURIComponent(task.id)}`} className="local-ai-chats__link">
                    <ChatCircle size={14} aria-hidden="true" />
                    <span className="local-ai-chats__copy">
                      <span className="local-ai-chats__title">{task.title}</span>
                      <span className="local-ai-chats__meta">
                        {task.combo ? "Local Combo" : task.model || "Local model"}
                        {task.draft ? " · draft on this device" : ""}
                      </span>
                    </span>
                    <span className="local-ai-chats__time">
                      {task.updatedAt ? new Date(task.updatedAt).toLocaleDateString([], { month: "short", day: "numeric" }) : ""}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
