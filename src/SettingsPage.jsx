import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  Alert,
  Button,
  CircularProgress,
  IconButton,
  InputAdornment,
  TextField,
  Typography
} from "@mui/material";
import AddRoundedIcon from "@mui/icons-material/AddRounded";
import BoltRoundedIcon from "@mui/icons-material/BoltRounded";
import CheckCircleRoundedIcon from "@mui/icons-material/CheckCircleRounded";
import DeleteOutlineRoundedIcon from "@mui/icons-material/DeleteOutlineRounded";
import KeyRoundedIcon from "@mui/icons-material/KeyRounded";
import OpenInNewRoundedIcon from "@mui/icons-material/OpenInNewRounded";
import SaveRoundedIcon from "@mui/icons-material/SaveRounded";
import VisibilityOffRoundedIcon from "@mui/icons-material/VisibilityOffRounded";
import VisibilityRoundedIcon from "@mui/icons-material/VisibilityRounded";
import SiteHeader from "./components/SiteHeader.jsx";
import { PROVIDERS, PROVIDER_CATEGORIES, providerById } from "./providers/registry.js";
import {
  activateProvider,
  createManagedProvider,
  fetchProviderModelsDetailed,
  getApiErrorMessage,
  listProviders,
  removeProvider,
  saveManagedProvider,
  saveProviderModels,
  testManagedProvider,
  testProviderConnection
} from "./services/api.js";
import "./settings.css";

const EMPTY_FORM = {
  configId: "",
  providerId: "",
  provider: "",
  baseUrl: "",
  apiKey: "",
  model: "",
  providerType: "openai_compatible",
  compatibility: "openai",
  status: "supported",
  registryId: ""
};

function slugify(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "provider";
}

function statusLabel(provider) {
  const last = provider.lastTest;
  if (last) {
    if (last.status === "connected") return { label: "Connected", tone: "ok" };
    if (last.status === "invalid_key") return { label: "Last test: invalid key", tone: "error" };
    if (last.status === "insufficient_balance") return { label: "Last test: insufficient balance", tone: "warn" };
    if (last.status === "unreachable") return { label: "Last test: unreachable", tone: "error" };
    if (last.status === "timeout") return { label: "Last test: timed out", tone: "error" };
    return { label: "Last test failed", tone: "error" };
  }
  return { label: "Saved — run a test to verify", tone: "neutral" };
}

function formFromProvider(provider, registryEntry) {
  return {
    configId: provider?.configId || "",
    providerId: provider?.providerId || registryEntry?.id || "",
    provider: provider?.provider || registryEntry?.name || "",
    baseUrl: provider?.baseUrl ?? registryEntry?.baseUrl ?? "",
    apiKey: "",
    model: provider?.model || provider?.defaultModel || "",
    providerType: provider?.providerType || (registryEntry?.compatibility === "anthropic" ? "anthropic_compatible" : "openai_compatible"),
    compatibility: registryEntry?.compatibility || "openai",
    status: registryEntry?.status || (provider ? "supported" : "listed"),
    registryId: registryEntry?.id || ""
  };
}

function GuideLinks({ entry }) {
  const links = [
    entry?.keysUrl && { href: entry.keysUrl, label: "Create a key" },
    entry?.docsUrl && { href: entry.docsUrl, label: "API docs" },
    entry?.pricingUrl && { href: entry.pricingUrl, label: "Pricing" },
    entry?.website && { href: entry.website, label: "Website" }
  ].filter(Boolean);
  if (links.length === 0) return null;
  return (
    <div className="settings-guides-links">
      {links.map(link => (
        <a key={link.href} href={link.href} target="_blank" rel="noopener noreferrer">
          {link.label} <OpenInNewRoundedIcon fontSize="inherit" />
        </a>
      ))}
    </div>
  );
}

export default function SettingsPage() {
  const [providers, setProviders] = useState([]);
  const [activeConfigId, setActiveConfigId] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [alert, setAlert] = useState(null);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const [form, setForm] = useState(null);
  const [showKey, setShowKey] = useState(false);
  const [models, setModels] = useState([]);
  const [modelsWarning, setModelsWarning] = useState("");
  const [selectedModels, setSelectedModels] = useState([]);
  const [defaultModel, setDefaultModel] = useState("");
  const [manualModel, setManualModel] = useState("");

  const refresh = useCallback(async () => {
    const data = await listProviders();
    setProviders(data.providers || []);
    setActiveConfigId(data.activeConfigId ?? data.activeProviderId ?? "");
    return data.providers || [];
  }, []);

  useEffect(() => {
    let cancelled = false;
    listProviders()
      .then(data => {
        if (cancelled) return;
        setProviders(data.providers || []);
        setActiveConfigId(data.activeConfigId ?? data.activeProviderId ?? "");
      })
      .catch(error => {
        if (!cancelled) setAlert({ severity: "error", message: getApiErrorMessage(error) });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const savedProvider = form && form.configId
    ? providers.find(provider => provider.configId === form.configId) || null
    : null;

  const registryEntry = useMemo(() => {
    if (!form) return null;
    return providerById(form.registryId) || null;
  }, [form]);

  const visibleProviders = useMemo(() => {
    const query = search.trim().toLowerCase();
    return PROVIDERS.filter(entry => {
      if (category !== "all" && entry.category !== category) return false;
      if (!query) return true;
      return `${entry.name} ${entry.note} ${entry.category}`.toLowerCase().includes(query);
    });
  }, [search, category]);

  function startConfigure(entry, existingProvider) {
    const nextForm = formFromProvider(existingProvider, entry);
    setForm(nextForm);
    setShowKey(false);
    setManualModel("");
    setModelsWarning("");
    if (existingProvider) {
      setSelectedModels(existingProvider.models || []);
      setDefaultModel(existingProvider.defaultModel || "");
    } else {
      setSelectedModels([]);
      setDefaultModel("");
    }
    setModels([]);
    setAlert({ severity: "info", message: existingProvider ? `Editing ${existingProvider.provider}.` : `Configuring ${entry.name}. Paste your key, then Save and Test.` });
    window.requestAnimationFrame(() => {
      const reduced = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      document.getElementById("provider-form")?.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
    });
  }

  function startCustom() {
    startConfigure(providerById("custom-openai"), null);
    setForm(current => ({ ...current, provider: "", baseUrl: "" }));
  }

  function startAnotherKey(provider) {
    setForm({ ...formFromProvider(provider, providerById(provider.providerId)), configId: "", apiKey: "" });
    setShowKey(false);
    setManualModel("");
    setModelsWarning("");
    setModels([]);
    setSelectedModels([]);
    setDefaultModel(provider.defaultModel || provider.model || "");
    setAlert({
      severity: "info",
      message: `Adding another key for ${provider.provider}. It is saved as a separate configuration, so both keys stay available in chat.`
    });
    window.requestAnimationFrame(() => {
      const reduced = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      document.getElementById("provider-form")?.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
    });
  }

  async function handleSave(event) {
    event?.preventDefault?.();
    if (!form) return;
    setAlert(null);
    if (form.compatibility !== "openai") {
      setAlert({ severity: "warning", message: "This endpoint speaks a different API shape and cannot chat through VupsRouter yet, so it cannot be saved as a working provider." });
      return;
    }
    const providerId = savedProvider ? form.providerId : slugify(form.providerId || form.provider);
    if (!/^[a-z0-9][a-z0-9-]{0,59}$/.test(providerId)) {
      setAlert({ severity: "error", message: "Provider name must contain letters or digits." });
      return;
    }
    if (form.provider.trim().length < 2) {
      setAlert({ severity: "error", message: "Provider name must be at least 2 characters." });
      return;
    }
    if (!form.baseUrl.trim()) {
      setAlert({ severity: "error", message: "Enter the API base URL (for example https://api.example.com/v1)." });
      return;
    }
    if (!savedProvider?.hasApiKey && form.apiKey.trim().length < 4) {
      setAlert({ severity: "error", message: "Paste the API key from your provider." });
      return;
    }
    setBusy("save");
    try {
      const payload = {
        provider: form.provider.trim(),
        baseUrl: form.baseUrl.trim(),
        apiKey: form.apiKey.trim(),
        model: form.model.trim(),
        providerType: form.providerType
      };
      const result = savedProvider
        ? await saveManagedProvider(savedProvider.configId, payload)
        : await createManagedProvider({ ...payload, providerId });
      await refresh();
      setForm(current => ({
        ...current,
        configId: result.config.configId || current.configId,
        providerId: result.config.providerId || current.providerId,
        apiKey: ""
      }));
      setAlert({ severity: "success", message: `${result.message} Key: ${result.config.apiKeyMasked || "saved"}.` });
    } catch (error) {
      setAlert({ severity: "error", message: getApiErrorMessage(error) });
    } finally {
      setBusy("");
    }
  }

  async function handleTest() {
    if (!form) return;
    setAlert(null);
    if (!form.baseUrl.trim()) {
      setAlert({ severity: "error", message: "Enter an API base URL first." });
      return;
    }
    setBusy("test");
    try {
      const payload = {
        baseUrl: form.baseUrl.trim(),
        apiKey: form.apiKey.trim() || undefined,
        model: form.model.trim() || undefined
      };
      const result = savedProvider
        ? await testManagedProvider(savedProvider.configId, payload)
        : await testProviderConnection({ provider: form.provider.trim() || "Custom", ...payload });
      if (Array.isArray(result.availableModels) && result.availableModels.length > 0) {
        setModels(result.availableModels);
        setSelectedModels(current => (current.length > 0 ? current : result.availableModels.map(model => model.id)));
      }
      setAlert({ severity: "success", message: result.message });
      await refresh();
    } catch (error) {
      setAlert({ severity: "error", message: getApiErrorMessage(error) });
    } finally {
      setBusy("");
    }
  }

  async function handleLoadModels() {
    if (!savedProvider) return;
    setBusy("models");
    setModelsWarning("");
    try {
      const data = await fetchProviderModelsDetailed(savedProvider.configId);
      const list = Array.isArray(data.models) ? data.models : [];
      setModels(list);
      setSelectedModels(current => (current.length > 0 ? current : list.map(model => model.id)));
      if (data.warning) {
        setModelsWarning(data.warning.message);
      } else {
        setAlert({ severity: list.length > 0 ? "success" : "info", message: list.length > 0 ? `Loaded ${list.length} models.` : "The provider returned no models. Add model IDs manually." });
      }
    } catch (error) {
      setAlert({ severity: "error", message: `${getApiErrorMessage(error)} Saved models were not changed.` });
    } finally {
      setBusy("");
    }
  }

  function toggleModel(id) {
    setSelectedModels(current => (current.includes(id) ? current.filter(entry => entry !== id) : [...current, id]));
    setDefaultModel(current => (current === id ? "" : current));
  }

  function addManualModel() {
    const id = manualModel.trim();
    if (!id) return;
    if (id.length > 200) {
      setAlert({ severity: "error", message: "Model IDs must be 200 characters or fewer." });
      return;
    }
    setSelectedModels(current => (current.includes(id) ? current : [...current, id]));
    setManualModel("");
  }

  async function handleSaveModels() {
    if (!savedProvider) return;
    setBusy("models-save");
    try {
      const result = await saveProviderModels(savedProvider.configId, { models: selectedModels, defaultModel });
      await refresh();
      setAlert({ severity: "success", message: `${result.message} Default model: ${result.config.defaultModel || "none"}.` });
    } catch (error) {
      setAlert({ severity: "error", message: getApiErrorMessage(error) });
    } finally {
      setBusy("");
    }
  }

  async function handleActivate(configId) {
    setBusy(`activate-${configId}`);
    try {
      await activateProvider(configId);
      await refresh();
      setAlert({ severity: "success", message: "Selected configuration updated. Chat now uses it." });
    } catch (error) {
      setAlert({ severity: "error", message: getApiErrorMessage(error) });
    } finally {
      setBusy("");
    }
  }

  async function handleDelete(provider) {
    const label = provider.apiKeyMasked ? `${provider.provider} (${provider.apiKeyMasked})` : provider.provider;
    if (!window.confirm(`Remove the saved configuration for ${label}? Its key and model list will be deleted. Other saved keys are not affected.`)) {
      return;
    }
    setBusy(`delete-${provider.configId}`);
    try {
      await removeProvider(provider.configId);
      await refresh();
      if (form?.configId === provider.configId) setForm(null);
      setAlert({ severity: "success", message: `${label} removed.` });
    } catch (error) {
      setAlert({ severity: "error", message: getApiErrorMessage(error) });
    } finally {
      setBusy("");
    }
  }

  if (loading) {
    return (
      <>
        <SiteHeader />
        <div className="auth-loading" role="status" aria-label="Loading settings">
          <CircularProgress size={30} />
        </div>
      </>
    );
  }

  return (
    <>
      <SiteHeader />
      <main className="settings-page">
        <div className="settings-shell">
          <div className="settings-heading">
            <span className="auth-kicker">PROVIDERS &amp; MODELS</span>
            <Typography component="h1">Provider settings</Typography>
            <p>
              Save as many providers as you like — each keeps its own key, base URL, and models.
              Keys are encrypted on the server with AES-256-GCM, never stored in your browser, and never shown in full again.
            </p>
          </div>

          {alert && (
            <Alert severity={alert.severity} sx={{ mb: 3 }} onClose={() => setAlert(null)}>
              {alert.message}
            </Alert>
          )}

          {/* ─── Saved providers ─────────────────────────────────────────── */}
          <section className="settings-card" aria-labelledby="saved-providers-heading">
            <div className="settings-presets">
              <span className="settings-models-label" id="saved-providers-heading">YOUR SAVED PROVIDERS ({providers.length})</span>
              <Button size="small" variant="outlined" startIcon={<AddRoundedIcon />} onClick={startCustom}>
                Add provider
              </Button>
            </div>
            {providers.length === 0 && (
              <p className="settings-empty">No providers saved yet. Pick one from the directory below to get started.</p>
            )}
            <div className="settings-saved-list">
              {providers.map(provider => {
                const status = statusLabel(provider);
                const isActive = provider.configId === activeConfigId;
                return (
                  <div key={provider.configId || provider.providerId} className={`settings-saved-card${isActive ? " is-active" : ""}`}>
                    <div className="settings-saved-card-main">
                      <div className="settings-provider-name">
                        {provider.provider}
                        {isActive && <span className="settings-badge settings-badge--ok">ACTIVE</span>}
                        <span className={`settings-badge settings-badge--${status.tone}`}>{status.label}</span>
                      </div>
                      <div className="settings-provider-meta">
                        <span>{provider.baseUrl}</span>
                        <span><KeyRoundedIcon fontSize="inherit" /> {provider.apiKeyMasked || "saved"}</span>
                        <span>{provider.models?.length || 0} saved model{provider.models?.length === 1 ? "" : "s"}</span>
                        <span>Default: {provider.defaultModel || provider.model || "none"}</span>
                      </div>
                    </div>
                    <div className="settings-saved-actions">
                      {!isActive && (
                        <Button size="small" variant="contained" disabled={Boolean(busy)} onClick={() => handleActivate(provider.configId)}>
                          {busy === `activate-${provider.configId}` ? "Switching…" : "Use for chat"}
                        </Button>
                      )}
                      <Button size="small" variant="outlined" startIcon={<AddRoundedIcon />} onClick={() => startAnotherKey(provider)}>
                        Add another key
                      </Button>
                      <Button size="small" variant="outlined" onClick={() => startConfigure(providerById(provider.providerId), provider)}>
                        Edit
                      </Button>
                      <Button
                        size="small"
                        variant="outlined"
                        disabled={Boolean(busy)}
                        startIcon={busy === `test-${provider.configId}` ? <CircularProgress size={14} color="inherit" /> : <BoltRoundedIcon />}
                        onClick={async () => {
                          setBusy(`test-${provider.configId}`);
                          try {
                            const result = await testManagedProvider(provider.configId, {});
                            setAlert({ severity: "success", message: `${provider.provider}: ${result.message}` });
                            await refresh();
                          } catch (error) {
                            setAlert({ severity: "error", message: `${provider.provider}: ${getApiErrorMessage(error)}` });
                            await refresh();
                          } finally {
                            setBusy("");
                          }
                        }}
                      >
                        Test
                      </Button>
                      <Button size="small" color="error" variant="text" disabled={Boolean(busy)} startIcon={<DeleteOutlineRoundedIcon />} onClick={() => handleDelete(provider)}>
                        Remove
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          {/* ─── Provider directory ──────────────────────────────────────── */}
          <section className="settings-card" aria-labelledby="provider-directory-heading">
            <div className="settings-presets">
              <span className="settings-models-label" id="provider-directory-heading">PROVIDER DIRECTORY</span>
            </div>
            <div className="settings-filter-row">
              <TextField
                size="small"
                label="Search providers"
                value={search}
                onChange={event => setSearch(event.target.value)}
                inputProps={{ "aria-label": "Search providers" }}
              />
              <div className="settings-cat-row" role="group" aria-label="Provider category filter">
                <button type="button" className={`settings-cat-chip${category === "all" ? " is-active" : ""}`} aria-pressed={category === "all"} onClick={() => setCategory("all")}>All</button>
                {PROVIDER_CATEGORIES.map(entry => (
                  <button
                    key={entry.id}
                    type="button"
                    className={`settings-cat-chip${category === entry.id ? " is-active" : ""}`}
                    aria-pressed={category === entry.id}
                    onClick={() => setCategory(entry.id)}
                  >
                    {entry.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="settings-provider-grid">
              {visibleProviders.map(entry => {
                const savedConfigs = providers.filter(provider => provider.providerId === entry.id);
                const saved = savedConfigs[0];
                return (
                  <article key={entry.id} className="settings-provider-card">
                    <div className="settings-provider-name">
                      {entry.name}
                      {saved && (
                        <span className="settings-badge settings-badge--ok">
                          SAVED{savedConfigs.length > 1 ? ` ×${savedConfigs.length}` : ""}
                        </span>
                      )}
                      <span className={`settings-badge settings-badge--${entry.status === "supported" ? "neutral" : "warn"}`}>
                        {entry.status === "supported" ? (entry.deployment === "local" ? "LOCAL GATEWAY" : "OPENAI-COMPATIBLE") : "ADAPTER PENDING"}
                      </span>
                    </div>
                    <p className="settings-provider-note">{entry.note}</p>
                    <p className="settings-provider-cost">{entry.cost}</p>
                    <GuideLinks entry={entry} />
                    <div className="settings-provider-actions">
                      <Button size="small" variant="outlined" onClick={() => startConfigure(entry, saved)}>
                        {saved ? "Edit configuration" : "Configure"}
                      </Button>
                    </div>
                  </article>
                );
              })}
              {visibleProviders.length === 0 && <p className="settings-empty">No providers match this search.</p>}
            </div>
          </section>

          {/* ─── Setup form ──────────────────────────────────────────────── */}
          {form && (
            <form className="settings-card" id="provider-form" onSubmit={handleSave} aria-labelledby="provider-form-heading">
              <div className="settings-presets">
                <span className="settings-models-label" id="provider-form-heading">
                  {savedProvider ? `EDIT ${savedProvider.provider.toUpperCase()}` : "NEW PROVIDER"}
                </span>
              </div>
              {form.compatibility !== "openai" && (
                <Alert severity="warning" sx={{ mb: 2 }}>
                  {form.provider} speaks a different API shape than the OpenAI chat format, so VupsRouter cannot use it for chat yet.
                  This entry is documented here so you know why it cannot be saved — a dedicated adapter is future work.
                </Alert>
              )}
              <div className="settings-form-grid">
                <TextField
                  label="Provider name"
                  value={form.provider}
                  onChange={event => setForm(current => ({ ...current, provider: event.target.value }))}
                  helperText="A label for you, e.g. FlagshipRouter or DeepSeek"
                  inputProps={{ maxLength: 80 }}
                  required
                />
                <TextField
                  label="API base URL"
                  value={form.baseUrl}
                  onChange={event => setForm(current => ({ ...current, baseUrl: event.target.value }))}
                  placeholder="https://gateway.example.com/v1"
                  helperText="OpenAI-compatible base URL. Extra /chat/completions suffixes are stripped automatically. Localhost only works when the backend runs on the same machine — the deployed backend rejects it with an explanation."
                  inputProps={{ maxLength: 500 }}
                  required
                />
                <TextField
                  label="API key"
                  type={showKey ? "text" : "password"}
                  value={form.apiKey}
                  onChange={event => setForm(current => ({ ...current, apiKey: event.target.value }))}
                  placeholder={savedProvider?.hasApiKey ? "Leave blank to keep your saved key" : "sk-…"}
                  helperText={savedProvider?.hasApiKey ? `A key is saved (${savedProvider.apiKeyMasked}). Type a new one only to replace it.` : "Stored encrypted on the server (AES-256-GCM). Never saved in your browser."}
                  inputProps={{ maxLength: 4096, autoComplete: "off" }}
                  InputProps={{
                    endAdornment: (
                      <InputAdornment position="end">
                        <IconButton type="button" edge="end" aria-label={showKey ? "Hide API key" : "Show API key"} onClick={() => setShowKey(value => !value)}>
                          {showKey ? <VisibilityOffRoundedIcon /> : <VisibilityRoundedIcon />}
                        </IconButton>
                      </InputAdornment>
                    )
                  }}
                />
                <TextField
                  label="Model ID"
                  value={form.model}
                  onChange={event => setForm(current => ({ ...current, model: event.target.value }))}
                  placeholder="e.g. deepseek-chat"
                  helperText="The exact model ID from your provider. Save models below to pick one from a list."
                  inputProps={{ maxLength: 200 }}
                />
              </div>
              <div className="settings-actions">
                <Button
                  type="submit"
                  variant="contained"
                  startIcon={busy === "save" ? <CircularProgress size={17} color="inherit" /> : <SaveRoundedIcon />}
                  disabled={Boolean(busy) || form.compatibility !== "openai"}
                >
                  {busy === "save" ? "Saving…" : "Save provider"}
                </Button>
                <Button
                  type="button"
                  variant="outlined"
                  startIcon={busy === "test" ? <CircularProgress size={17} color="inherit" /> : <BoltRoundedIcon />}
                  onClick={handleTest}
                  disabled={Boolean(busy)}
                >
                  {busy === "test" ? "Testing…" : "Test connection"}
                </Button>
                <Button type="button" variant="text" onClick={() => setForm(null)} disabled={Boolean(busy)}>
                  Close
                </Button>
              </div>
            </form>
          )}

          {/* ─── Models management ───────────────────────────────────────── */}
          {savedProvider && (
            <section className="settings-card" aria-labelledby="models-heading">
              <div className="settings-presets">
                <span className="settings-models-label" id="models-heading">MODELS — {savedProvider.provider.toUpperCase()}</span>
                <Button size="small" variant="outlined" onClick={handleLoadModels} disabled={Boolean(busy)}>
                  {busy === "models" ? "Loading…" : "Load models"}
                </Button>
              </div>
              {modelsWarning && (
                <Alert severity="info" sx={{ mb: 2 }}>
                  Live discovery failed ({modelsWarning}). Your saved model list is unchanged — fix the connection and press Load models to refresh.
                </Alert>
              )}
              {models.length > 0 && (
                <div className="settings-models">
                  <span className="settings-models-label">DISCOVERED THIS SESSION — CLICK TO ADD OR REMOVE</span>
                  <div className="settings-models-list">
                    {models.map(model => (
                      <button
                        key={model.id}
                        type="button"
                        className={`settings-model-chip${selectedModels.includes(model.id) ? " is-active" : ""}`}
                        aria-pressed={selectedModels.includes(model.id)}
                        onClick={() => toggleModel(model.id)}
                      >
                        {model.id}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <div className="settings-models">
                <span className="settings-models-label">SAVED MODELS ({selectedModels.length}) — CLICK TO REMOVE</span>
                <div className="settings-models-list">
                  {selectedModels.map(id => (
                    <button
                      key={id}
                      type="button"
                      className="settings-model-chip is-active"
                      aria-pressed="true"
                      title="Click to remove"
                      onClick={() => toggleModel(id)}
                    >
                      {id}
                    </button>
                  ))}
                  {selectedModels.length === 0 && <span className="settings-empty">No saved models yet — discover or add one below.</span>}
                </div>
              </div>
              <div className="settings-filter-row">
                <TextField
                  size="small"
                  label="Add model ID manually"
                  value={manualModel}
                  onChange={event => setManualModel(event.target.value)}
                  onKeyDown={event => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      addManualModel();
                    }
                  }}
                />
                <Button size="small" variant="outlined" startIcon={<AddRoundedIcon />} onClick={addManualModel}>
                  Add model
                </Button>
                <TextField
                  size="small"
                  select
                  label="Default model"
                  value={defaultModel}
                  onChange={event => setDefaultModel(event.target.value)}
                  SelectProps={{ native: true }}
                  sx={{ minWidth: 220 }}
                >
                  <option value="">No default</option>
                  {selectedModels.map(id => (
                    <option key={id} value={id}>{id}</option>
                  ))}
                </TextField>
                <Button
                  size="small"
                  variant="contained"
                  startIcon={busy === "models-save" ? <CircularProgress size={14} color="inherit" /> : <CheckCircleRoundedIcon />}
                  onClick={handleSaveModels}
                  disabled={Boolean(busy)}
                >
                  {busy === "models-save" ? "Saving…" : "Save models & default"}
                </Button>
              </div>
            </section>
          )}

          {/* ─── Guides ──────────────────────────────────────────────────── */}
          {(registryEntry || savedProvider) && (
            <section className="settings-help">
              <h2>How to configure {registryEntry?.name || savedProvider?.provider}</h2>
              <ol className="settings-guide-steps">
                <li>Create an API key on the provider's official page {registryEntry?.keysUrl ? "" : "(paste your key below)"} and keep it private — never share API keys.</li>
                <li>Enter the provider's OpenAI-compatible base URL (use <code>Load models</code> or manual entry to confirm the model ID).</li>
                <li>Save the provider, then press <b>Test connection</b> — it lists models and sends one tiny request when a model is set.</li>
                <li>Local gateways (Ollama, FlagshipRouter, vLLM, LM Studio) only work when the backend can reach them. A deployed backend cannot reach <code>localhost</code> — use a public HTTPS tunnel or run VupsRouter locally.</li>
                <li>Switch chat between providers any time with <b>Use for chat</b> — every provider keeps its own key and models.</li>
              </ol>
              {registryEntry && <GuideLinks entry={registryEntry} />}
              <Link to="/chat" className="settings-chat-link">Go to chat →</Link>
            </section>
          )}

          <section className="settings-help">
            <h2>Security</h2>
            <ul>
              <li>Keys are encrypted with AES-256-GCM using a server-side secret and are never returned to the browser — only a masked preview.</li>
              <li>Localhost and private-network base URLs are rejected on production servers with an explanation, so a local gateway failure is never misreported as an invalid key.</li>
              <li>Deleting a provider removes only that provider's configuration; all others stay untouched.</li>
            </ul>
          </section>
        </div>
      </main>
    </>
  );
}


