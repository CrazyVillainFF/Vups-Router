import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
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
import ExternalLink from "./components/ExternalLink.jsx";
import HoldToDeleteDialog from "./components/HoldToDeleteDialog.jsx";
import { Alert as LwAlert } from "./components/lightswind/alert";
import { Badge as LwBadge } from "./components/lightswind/badge";
import { Skeleton } from "./components/lightswind/skeleton";
import AnimatedContent from "./components/reactbits/AnimatedContent/AnimatedContent.jsx";
import SpotlightCard from "./components/reactbits/SpotlightCard/SpotlightCard.jsx";
import { capabilityLabels } from "./chat/modelCatalog.js";
import { PROVIDER_CATEGORIES, PROVIDERS, filterProviders, providerById } from "./providers/registry.js";
import { QODER_AUTH_MODES, QODER_REGIONS, formDiffersFromSaved, qoderRegionFor } from "./settings/qoderForm.js";
import { buildProviderSavePayload, modelIdentity, savedModelIds } from "./settings/modelForm.js";
import {
  activateProvider,
  createManagedProvider,
  fetchFreeModels,
  fetchProviderModelsDetailed,
  getApiErrorMessage,
  listProviders,
  removeProvider,
  saveManagedProvider,
  saveModelType,
  saveProviderModels,
  testManagedProvider,
  testManagedProviderModel,
  testProviderConnection,
  testProviderModel
} from "./services/api.js";
import { RecommendedBadge } from "./settings/RecommendedBadge.jsx";
import "./settings.css";

function capabilityTitle(model) {
  const labels = capabilityLabels(model?.capabilities);
  return labels.length > 0 ? `Supported: ${labels.join(", ")}` : "Capabilities not reported by this provider";
}

/** MUI severities used across this page mapped onto the Lightwind Alert variants. */
const ALERT_VARIANTS = { error: "destructive", warning: "warning", info: "info", success: "success" };

function StatusBadge({ tone = "neutral", dot = false, children }) {
  return (
    <LwBadge
      variant="unstyled"
      size="unstyled"
      shape="unstyled"
      withDot={dot}
      className={`settings-badge settings-badge--${tone}`}
    >
      {children}
    </LwBadge>
  );
}

const EMPTY_FORM = {
  configId: "",
  providerId: "",
  provider: "",
  baseUrl: "",
  apiKey: "",
  model: "",
  providerType: "openai_compatible",
  compatibility: "openai",
  authMode: "pat",
  openapiBaseUrl: "",
  status: "supported",
  registryId: ""
};

const PROTOCOL_OPTIONS = [
  { value: "openai_compatible", label: "OpenAI-compatible — Chat Completions" },
  { value: "openai_responses", label: "OpenAI — Responses API" },
  { value: "anthropic_compatible", label: "Anthropic — Messages API" },
  { value: "azure_openai", label: "Azure OpenAI — api-key header" },
  { value: "watsonx", label: "IBM watsonx — IAM token exchange" },
  { value: "qoder_cloud_agents", label: "Qoder Cloud Agents — session/event API" },
  { value: "local_gateway", label: "Local gateway — OpenAI-compatible" },
  { value: "native", label: "Other native API (unsupported)" }
];

const SAVEABLE_COMPATIBILITY = new Set(["openai", "anthropic", "azure", "watsonx", "qoder"]);

const COMPATIBILITY_PROTOCOL = {
  openai: "openai_compatible",
  anthropic: "anthropic_compatible",
  azure: "azure_openai",
  watsonx: "watsonx",
  qoder: "qoder_cloud_agents",
  other: "native"
};

function protocolHelp(type) {
  if (type === "anthropic_compatible") return "Anthropic Messages API. Use https://api.anthropic.com or a compatible proxy; /v1 is added when needed.";
  if (type === "openai_responses") return "OpenAI Responses API. Use the base URL before /responses, e.g. https://api.openai.com/v1.";
  if (type === "azure_openai") return "Azure OpenAI v1 endpoint, e.g. https://{resource}.openai.azure.com/openai/v1. The key is sent in the api-key header and the model ID is your deployment name.";
  if (type === "watsonx") return "IBM watsonx: use your regional cluster URL plus ?project_id=YOUR_PROJECT_ID. The IBM Cloud API key is exchanged for an IAM token automatically.";
  if (type === "qoder_cloud_agents") return "Qoder Cloud Agents. Choose your region — Global (api.qoder.com / openapi.qoder.sh) or China mainland (api.qoder.com.cn / api.qoder.com.cn) — then use either a Personal Access Token, or a service account key which the backend exchanges at the region's OpenAPI host for a short-lived access token (about an hour, renewed automatically). The connection check lists models and falls back to a read-only agents probe; it never creates a session. One chat conversation keeps one Qoder session, so Qoder holds the earlier turns itself; stopping a reply cancels that turn and a busy session is reported instead of queued.";
  if (type === "local_gateway") return "Ollama, LM Studio, vLLM, or another local OpenAI-compatible gateway. The deployed backend cannot reach localhost.";
  if (type === "native") return "A provider-specific API that is not one of the implemented adapters. Saving and chat are disabled for this option.";
  return "OpenAI Chat Completions API. Use the base URL before /chat/completions, e.g. https://api.example.com/v1.";
}

function slugify(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "provider";
}

// Saved configs sometimes carry a name-derived providerId ("qoder-cloud-agents")
// instead of the registry id, so fall back to the exact display name.
function registryEntryForSavedProvider(provider) {
  if (!provider) return null;
  const direct = providerById(provider.providerId);
  if (direct) return direct;
  const name = String(provider.provider || "").trim().toLowerCase();
  if (!name) return null;
  return PROVIDERS.find(entry =>
    entry.name.toLowerCase() === name
    || entry.id === name
    || (Array.isArray(entry.aliases) && entry.aliases.some(alias => String(alias).toLowerCase() === name))
  ) || null;
}

function statusLabel(provider) {
  const last = provider.lastTest;
  if (last) {
    if (last.status === "connected") return { label: "Connection verified", tone: "ok" };
    if (last.status === "reachable") return { label: "Endpoint reachable — test a model", tone: "warn" };
    if (last.status === "invalid_key") return { label: "Last test: authentication failed", tone: "error" };
    if (last.status === "insufficient_scope") return { label: "Last test: permission or scope insufficient", tone: "error" };
    if (last.status === "incorrect_region") return { label: "Last test: endpoint and region do not match", tone: "error" };
    if (last.status === "not_found") return { label: "Last test: endpoint not found — check region and base URL", tone: "error" };
    if (last.status === "invalid_response") return { label: "Last test: invalid response from Qoder", tone: "error" };
    if (last.status === "rate_limited") return { label: "Last test: rate limited — try again shortly", tone: "warn" };
    if (last.status === "provider_unavailable") return { label: "Last test: Qoder service unavailable", tone: "error" };
    if (last.status === "bad_request") return { label: "Last test: endpoint rejected the request", tone: "error" };
    if (last.status === "insufficient_balance") return { label: "Last test: insufficient balance", tone: "warn" };
    if (last.status === "restricted") return { label: "Last test: restricted to official client", tone: "warn" };
    if (last.status === "unsupported") return { label: "Last test: protocol not supported", tone: "warn" };
    if (last.status === "model_unavailable") return { label: "Last test: model unavailable", tone: "warn" };
    if (last.status === "quota_exhausted") return { label: "Last test: free quota exhausted — wait for reset", tone: "warn" };
    if (last.status === "region_restricted") return { label: "Last test: region not eligible for free tier", tone: "warn" };
    if (last.status === "unreachable") return { label: "Last test: network or DNS error", tone: "error" };
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
    providerType: provider?.providerType || COMPATIBILITY_PROTOCOL[registryEntry?.compatibility] || "openai_compatible",
    compatibility: registryEntry?.compatibility || "openai",
    authMode: provider?.authMode || "pat",
    openapiBaseUrl: provider?.openapiBaseUrl || "",
    status: registryEntry?.status || (provider ? "supported" : "listed"),
    registryId: registryEntry?.id || ""
  };
}

function GuideLinks({ entry }) {
  const links = [
    entry?.keysUrl && { href: entry.keysUrl, label: entry.keysLabel || "Create a key" },
    entry?.docsUrl && { href: entry.docsUrl, label: "API docs" },
    entry?.pricingUrl && { href: entry.pricingUrl, label: "Pricing" },
    entry?.website && { href: entry.website, label: "Website" }
  ].filter(Boolean);
  if (links.length === 0) return null;
  return (
    <div className="settings-guides-links">
      {links.map(link => (
        <ExternalLink key={`${link.label}:${link.href}`} href={link.href}>
          {link.label} <OpenInNewRoundedIcon fontSize="inherit" />
        </ExternalLink>
      ))}
    </div>
  );
}

export default function SettingsPage({ embedded = false }) {
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
  const [modelType, setModelType] = useState("custom");
  const [freeCatalog, setFreeCatalog] = useState(null);
  const [freeCatalogLoading, setFreeCatalogLoading] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);

  const refresh = useCallback(async () => {
    const data = await listProviders();
    setProviders(data.providers || []);
    setActiveConfigId(data.activeConfigId ?? data.activeProviderId ?? "");
    if (data.modelType === "free" || data.modelType === "custom") setModelType(data.modelType);
    return data.providers || [];
  }, []);

  useEffect(() => {
    let cancelled = false;
    listProviders()
      .then(data => {
        if (cancelled) return;
        setProviders(data.providers || []);
        setActiveConfigId(data.activeConfigId ?? data.activeProviderId ?? "");
        if (data.modelType === "free" || data.modelType === "custom") setModelType(data.modelType);
      })
      .catch(error => {
        if (!cancelled) setAlert({ severity: "error", message: getApiErrorMessage(error) });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    fetchFreeModels()
      .then(data => {
        if (cancelled) return;
        setFreeCatalog(data.catalog || null);
        if (data.modelType === "free" || data.modelType === "custom") setModelType(data.modelType);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleModelTypeChange(next) {
    if (next === modelType || busy) return;
    setBusy("model-type");
    try {
      const data = await saveModelType(next);
      setModelType(data.modelType || next);
      setAlert({
        severity: "success",
        message: data.message || `Using ${next === "free" ? "All Free Models" : "Custom Models"} in chat.`
      });
    } catch (error) {
      setAlert({ severity: "error", message: getApiErrorMessage(error) });
    } finally {
      setBusy("");
    }
  }

  async function handleRefreshFreeCatalog() {
    if (freeCatalogLoading) return;
    setFreeCatalogLoading(true);
    try {
      const data = await fetchFreeModels({ refresh: true });
      setFreeCatalog(data.catalog || null);
      const count = data.catalog?.counts?.models ?? 0;
      setAlert({
        severity: data.catalog?.partial ? "warning" : "success",
        message: data.catalog?.partial
          ? `Verified ${count} free models. Some providers could not be checked.`
          : `Verified ${count} free models across ${data.catalog?.counts?.providers ?? 0} providers.`
      });
    } catch (error) {
      setAlert({ severity: "error", message: getApiErrorMessage(error) });
    } finally {
      setFreeCatalogLoading(false);
    }
  }

  const savedProvider = form && form.configId
    ? providers.find(provider => provider.configId === form.configId) || null
    : null;

  const formDirty = formDiffersFromSaved(form, savedProvider);
  const isQoderForm = form?.providerType === "qoder_cloud_agents";
  const qoderRegion = isQoderForm ? qoderRegionFor(form.baseUrl) : "global";

  function applyQoderRegion(regionId) {
    const region = QODER_REGIONS.find(item => item.id === regionId);
    if (!region) return;
    setForm(current => ({
      ...current,
      baseUrl: region.businessUrl,
      openapiBaseUrl: region.openapiUrl
    }));
  }

  function setQoderAuthMode(authMode) {
    setForm(current => ({
      ...current,
      authMode,
      openapiBaseUrl: current.openapiBaseUrl || (qoderRegionFor(current.baseUrl) === "cn" ? "https://openapi.qoder.com.cn" : "https://openapi.qoder.sh")
    }));
  }

  const registryEntry = useMemo(() => {
    if (!form) return null;
    return providerById(form.registryId) || null;
  }, [form]);

  const visibleProviders = useMemo(
    () => filterProviders({ search, category }),
    [search, category]
  );

  function startConfigure(entry, existingProvider) {
    const nextForm = formFromProvider(existingProvider, entry);
    setForm(nextForm);
    setShowKey(false);
    setManualModel("");
    setModelsWarning("");
    if (existingProvider) {
      setSelectedModels(savedModelIds(existingProvider));
      setDefaultModel(existingProvider.defaultModel || "");
    } else {
      setSelectedModels([]);
      setDefaultModel("");
    }
    setModels([]);
    if (existingProvider) {
      setAlert({ severity: "info", message: `Editing ${existingProvider.provider}.` });
    } else if (entry.status === "listed") {
      setAlert({ severity: "warning", message: `${entry.name} speaks an API that VupsRouter has no adapter for yet. Its official request shape is quoted in the form below, and saving stays disabled until an adapter exists.` });
    } else {
      setAlert({ severity: "info", message: `Configuring ${entry.name}. Paste your key, then Save and Test.` });
    }
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
    if (!SAVEABLE_COMPATIBILITY.has(form.compatibility) || form.providerType === "native") {
      setAlert({ severity: "warning", message: "This endpoint needs a dedicated adapter before VupsRouter can use it. OpenAI Chat Completions, OpenAI Responses, and Anthropic Messages are implemented." });
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
      const payload = buildProviderSavePayload({ form, providerId, selectedModels, defaultModel });
      const result = savedProvider
        ? await saveManagedProvider(savedProvider.configId, payload)
        : await createManagedProvider(payload);
      await refresh();
      const savedConfig = result.config || {};
      setForm(current => ({
        ...current,
        configId: savedConfig.configId || current.configId,
        providerId: savedConfig.providerId || current.providerId,
        baseUrl: savedConfig.baseUrl || current.baseUrl,
        model: savedConfig.model || current.model,
        authMode: savedConfig.authMode || current.authMode,
        openapiBaseUrl: savedConfig.openapiBaseUrl ?? current.openapiBaseUrl,
        apiKey: ""
      }));
      // The saved row is the source of truth for the catalogue: models merged
      // in by discovery show up here instead of vanishing until a reload.
      if (Array.isArray(savedConfig.models)) {
        setSelectedModels(savedConfig.models);
        setDefaultModel(savedConfig.defaultModel || "");
      }
      setAlert({ severity: "success", message: `${result.message} Key: ${savedConfig.apiKeyMasked || "saved"}.` });
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
    if (!savedProvider && form.apiKey.trim().length < 4) {
      setAlert({ severity: "error", message: "Paste the API key before checking this new provider." });
      return;
    }
    setBusy("test");
    try {
      const payload = {
        baseUrl: form.baseUrl.trim(),
        apiKey: form.apiKey.trim() || undefined,
        providerType: form.providerType,
        ...(form.providerType === "qoder_cloud_agents"
          ? {
              authMode: form.authMode || "pat",
              openapiBaseUrl: form.openapiBaseUrl.trim()
            }
          : {})
      };
      const result = savedProvider
        ? await testManagedProvider(savedProvider.configId, payload)
        : await testProviderConnection({ provider: form.provider.trim() || "Custom", ...payload });
      if (Array.isArray(result.availableModels) && result.availableModels.length > 0) {
        setModels(result.availableModels);
        setSelectedModels(current => (current.length > 0 ? current : result.availableModels.map(model => model.id)));
      }
      setAlert({ severity: result.warning ? "warning" : "success", message: result.message });
      await refresh();
    } catch (error) {
      setAlert({ severity: "error", message: getApiErrorMessage(error) });
    } finally {
      setBusy("");
    }
  }

  async function handleTestModel() {
    if (!form) return;
    setAlert(null);
    const model = form.model.trim();
    if (!form.baseUrl.trim()) {
      setAlert({ severity: "error", message: "Enter an API base URL first." });
      return;
    }
    if (!savedProvider && form.apiKey.trim().length < 4) {
      setAlert({ severity: "error", message: "Paste the API key before testing this new provider." });
      return;
    }
    if (!model) {
      setAlert({ severity: "error", message: "Enter the exact model ID before testing a model." });
      return;
    }
    const confirmed = window.confirm(
      `Send a small test prompt to ${model}? This may consume provider tokens or credits. Connection checks never send inference.`
    );
    if (!confirmed) return;
    setBusy("test-model");
    try {
      const payload = {
        baseUrl: form.baseUrl.trim(),
        apiKey: form.apiKey.trim() || undefined,
        providerType: form.providerType,
        model,
        ...(form.providerType === "qoder_cloud_agents"
          ? {
              authMode: form.authMode || "pat",
              openapiBaseUrl: form.openapiBaseUrl.trim()
            }
          : {})
      };
      const result = savedProvider
        ? await testManagedProviderModel(savedProvider.configId, payload)
        : await testProviderModel({ provider: form.provider.trim() || "Custom", ...payload });
      setAlert({ severity: "success", message: result.message });
      await refresh();
    } catch (error) {
      setAlert({ severity: "error", message: getApiErrorMessage(error) });
      await refresh();
    } finally {
      setBusy("");
    }
  }

  async function handleSavedModelTest(provider) {
    const model = provider.defaultModel || provider.model || "";
    if (!model) {
      setAlert({ severity: "error", message: `${provider.provider}: save a default model before testing a model.` });
      return;
    }
    const confirmed = window.confirm(
      `Send a small test prompt to ${model} through ${provider.provider}? This may consume provider tokens or credits.`
    );
    if (!confirmed) return;
    setBusy(`test-model-${provider.configId}`);
    try {
      const result = await testManagedProviderModel(provider.configId, { model });
      setAlert({ severity: "success", message: `${provider.provider}: ${result.message}` });
      await refresh();
    } catch (error) {
      setAlert({ severity: "error", message: `${provider.provider}: ${getApiErrorMessage(error)}` });
      await refresh();
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
    if (defaultModel && !selectedModels.includes(defaultModel)) {
      setAlert({ severity: "error", message: `${defaultModel} is not in the saved model list. Choose a default from the saved models first.` });
      return;
    }
    setBusy("models-save");
    try {
      const result = await saveProviderModels(savedProvider.configId, { models: selectedModels, defaultModel });
      await refresh();
      const savedConfig = result.config || {};
      if (Array.isArray(savedConfig.models)) {
        setSelectedModels(savedConfig.models);
        setDefaultModel(savedConfig.defaultModel || "");
      }
      setAlert({ severity: "success", message: `${result.message} Default model: ${savedConfig.defaultModel || "none"}.` });
    } catch (error) {
      setAlert({ severity: "error", message: `${getApiErrorMessage(error)} Saved models were not changed.` });
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

  function requestDelete(provider) {
    if (!provider?.configId) return;
    setDeleteTarget(provider);
  }

  async function deleteProviderConfig() {
    const provider = deleteTarget;
    if (!provider?.configId) {
      throw new Error("This saved provider is no longer available.");
    }
    const label = provider.apiKeyMasked ? `${provider.provider} (${provider.apiKeyMasked})` : provider.provider;
    setBusy(`delete-${provider.configId}`);
    try {
      await removeProvider(provider.configId);
    } catch (error) {
      setBusy("");
      throw new Error(getApiErrorMessage(error));
    }
    setProviders(current => current.filter(item => item.configId !== provider.configId));
    if (form?.configId === provider.configId) setForm(null);
    setAlert({ severity: "success", message: `${label} removed.` });
    setBusy("");
    refresh().catch(() => {});
  }

  if (loading) {
    return (
      <>
        {embedded ? null : <SiteHeader />}
        <main id={embedded ? "main-content" : undefined} className={`settings-page${embedded ? " settings-page--embedded" : ""}`}>
          <div className="settings-shell">
            <div className="settings-heading">
              <span className="auth-kicker">PROVIDERS &amp; MODELS</span>
              <Typography component="h1">Provider settings</Typography>
            </div>
            <div className="settings-skeleton-list" role="status" aria-label="Loading settings">
              {[0, 1, 2].map(key => (
                <div key={key} className="settings-skeleton-card">
                  <Skeleton animation="pulse" height={16} width="45%" />
                  <Skeleton animation="pulse" height={12} width="70%" />
                  <div className="settings-skeleton-row">
                    <Skeleton animation="pulse" height={34} width={132} />
                    <Skeleton animation="pulse" height={34} width={104} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </main>
      </>
    );
  }

  const freeCounts = freeCatalog?.counts || null;
  const freeUpdatedLabel = freeCatalog?.updatedAt
    ? new Date(freeCatalog.updatedAt).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit"
      })
    : "";

  return (
    <>
      {embedded ? null : <SiteHeader />}
      <main id={embedded ? "main-content" : undefined} className={`settings-page${embedded ? " settings-page--embedded" : ""}`}>
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
            <LwAlert
              variant={ALERT_VARIANTS[alert.severity] || "info"}
              size="sm"
              withIcon
              dismissible
              onDismiss={() => setAlert(null)}
              className={`settings-alert settings-alert--${ALERT_VARIANTS[alert.severity] || "info"}`}
            >
              <p>{alert.message}</p>
            </LwAlert>
          )}

          <section className="settings-card" aria-labelledby="model-type-heading">
            <div className="settings-presets">
              <span className="settings-models-label" id="model-type-heading">MODEL TYPE</span>
              {modelType === "free" && (
                <Button
                  size="small"
                  variant="outlined"
                  disabled={freeCatalogLoading}
                  startIcon={freeCatalogLoading ? <CircularProgress size={14} color="inherit" /> : <BoltRoundedIcon />}
                  onClick={handleRefreshFreeCatalog}
                >
                  {freeCatalogLoading ? "Checking…" : "Refresh free models"}
                </Button>
              )}
            </div>
            <p className="settings-empty">
              This changes which models appear in the chat picker. Saved provider keys and models are never deleted.
            </p>
            <div className="settings-model-types" role="radiogroup" aria-label="Model type">
              <button
                type="button"
                role="radio"
                aria-checked={modelType === "custom"}
                className={`settings-model-type${modelType === "custom" ? " is-active" : ""}`}
                disabled={Boolean(busy)}
                onClick={() => handleModelTypeChange("custom")}
              >
                <span className="settings-model-type-title">
                  <KeyRoundedIcon fontSize="small" /> Custom Models
                </span>
                <span className="settings-model-type-copy">
                  Use Vups, your saved providers, and any server gateway. Full control over keys and models.
                </span>
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={modelType === "free"}
                className={`settings-model-type${modelType === "free" ? " is-active" : ""}`}
                disabled={Boolean(busy)}
                onClick={() => handleModelTypeChange("free")}
              >
                <span className="settings-model-type-title">
                  <BoltRoundedIcon fontSize="small" /> All Free Models
                </span>
                <span className="settings-model-type-copy">
                  Show Vups plus only models verified as free by shared or saved providers. No approximate matches.
                </span>
              </button>
            </div>
            <div className="settings-free-catalog" aria-live="polite">
              <div>
                <strong>
                  {freeCounts ? `${freeCounts.models} verified free model${freeCounts.models === 1 ? "" : "s"}` : "Free catalogue not loaded"}
                </strong>
                {freeCounts ? (
                  <span>
                    {" "}— {freeCounts.sharedModels} shared, {freeCounts.personalModels} from your providers
                  </span>
                ) : null}
              </div>
              {freeUpdatedLabel && <span className="settings-provider-url">Updated {freeUpdatedLabel}</span>}
              {freeCatalog?.stale && (
                <StatusBadge tone="warn" dot>STALE — showing the last verified list</StatusBadge>
              )}
              {freeCatalog?.partial && (
                <StatusBadge tone="warn" dot>Some providers could not be checked</StatusBadge>
              )}
            </div>
          </section>

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
                const status = form && form.configId === provider.configId && formDirty
                  ? { label: "Unsaved changes — retest needed", tone: "warn" }
                  : statusLabel(provider);
                const isActive = provider.configId === activeConfigId;
                const registryEntry = registryEntryForSavedProvider(provider);
                return (
                  <div key={provider.configId || provider.providerId} className={`settings-saved-card${isActive ? " is-active" : ""}`}>
                    <div className="settings-saved-card-main">
                      <div className="settings-provider-name">
                        {provider.provider}
                        <RecommendedBadge show={Boolean(registryEntry?.recommended)} />
                        {isActive && <StatusBadge tone="ok">ACTIVE</StatusBadge>}
                        <StatusBadge tone={status.tone} dot>{status.label}</StatusBadge>
                      </div>
                      <div className="settings-provider-meta">
                        <span className="settings-provider-url">{provider.baseUrl}</span>
                        <span>{provider.providerType || "openai_compatible"}</span>
                        {provider.providerType === "qoder_cloud_agents" && (
                          <span>{provider.authMode === "service_account" ? "service account key" : "personal access token"}</span>
                        )}
                        <span><KeyRoundedIcon fontSize="inherit" /> {provider.apiKeyMasked || "saved"}</span>
                        <span>{savedModelIds(provider).length} saved model{savedModelIds(provider).length === 1 ? "" : "s"}</span>
                        <span>Default: {provider.defaultModel || provider.model || "none"}</span>
                      </div>
                      {provider.lastTest && provider.lastTest.status !== "connected" && provider.lastTest.message && (
                        <p className="settings-provider-issue">{provider.lastTest.message}</p>
                      )}
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
                      <Button size="small" variant="outlined" onClick={() => startConfigure(registryEntry, provider)}>
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
                        Check
                      </Button>
                      <Button
                        size="small"
                        variant="outlined"
                        disabled={Boolean(busy)}
                        startIcon={busy === `test-model-${provider.configId}` ? <CircularProgress size={14} color="inherit" /> : <CheckCircleRoundedIcon />}
                        onClick={() => handleSavedModelTest(provider)}
                      >
                        Test model
                      </Button>
                      <Button
                        size="small"
                        color="error"
                        variant="text"
                        className="settings-remove-action"
                        disabled={Boolean(busy)}
                        startIcon={<DeleteOutlineRoundedIcon />}
                        onClick={() => requestDelete(provider)}
                      >
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
                // A saved card can carry a name-derived providerId, so match the
                // registry entry the same way the saved list does. Editing must
                // open one specific configuration — preferring the active row
                // keeps "Edit configuration" from silently targeting another key.
                const savedConfigs = providers.filter(provider => registryEntryForSavedProvider(provider)?.id === entry.id);
                const saved = savedConfigs.find(provider => provider.active) || savedConfigs[0];
                return (
                  <SpotlightCard
                    key={entry.id}
                    className="settings-provider-spot"
                    spotlightColor="rgba(108,155,255,.28)"
                    intensity={0.16}
                    spotlightSize={220}
                    proximity={0}
                    borderGlow={0.4}
                    flare={false}
                    style={{ "--spotlight-card-border": "#243247", display: "block" }}
                  >
                    <article className="settings-provider-card settings-provider-card--bare">
                      <div className="settings-provider-name">
                        {entry.name}
                        <RecommendedBadge show={Boolean(entry.recommended)} />
                        {saved && (
                          <StatusBadge tone="ok">
                            SAVED{savedConfigs.length > 1 ? ` ×${savedConfigs.length}` : ""}
                          </StatusBadge>
                        )}
                        <StatusBadge tone={entry.status === "supported" ? "neutral" : "warn"}>
                          {entry.status !== "supported"
                            ? "ADAPTER PENDING"
                            : entry.compatibility === "anthropic"
                              ? "ANTHROPIC MESSAGES"
                              : entry.compatibility === "azure"
                                ? "AZURE OPENAI"
                                : entry.compatibility === "watsonx"
                                  ? "IBM WATSONX"
                                  : entry.compatibility === "qoder"
                                    ? "QODER SESSIONS"
                                    : entry.deployment === "local" ? "LOCAL GATEWAY" : "OPENAI-COMPATIBLE"}
                        </StatusBadge>
                      </div>
                      <p className="settings-provider-note">{entry.note}</p>
                      {entry.recommended && entry.recommendation && (
                        <p className="settings-provider-recommendation">{entry.recommendation}</p>
                      )}
                      <p className="settings-provider-cost">{entry.cost}</p>
                      <GuideLinks entry={entry} />
                      <div className="settings-provider-actions">
                        <Button size="small" variant="outlined" onClick={() => startConfigure(entry, saved)}>
                          {saved ? "Edit configuration" : "Configure"}
                        </Button>
                      </div>
                    </article>
                  </SpotlightCard>
                );
              })}
              {visibleProviders.length === 0 && <p className="settings-empty">No providers match this search.</p>}
            </div>
          </section>

          {/* ─── Setup form ──────────────────────────────────────────────── */}
          {form && (
            <AnimatedContent trigger="mount" distance={14} duration={0.45} ease="power2.out" once>
            <form className="settings-card" id="provider-form" onSubmit={handleSave} aria-labelledby="provider-form-heading">
              <div className="settings-presets">
                <span className="settings-models-label" id="provider-form-heading">
                  {savedProvider ? `EDIT ${savedProvider.provider.toUpperCase()}` : "NEW PROVIDER"}
                </span>
              </div>
              {(!SAVEABLE_COMPATIBILITY.has(form.compatibility) || form.providerType === "native") && (
                <LwAlert variant="warning" size="sm" withIcon className="settings-alert settings-alert--warning">
                  <p>
                    {form.provider} uses an API shape that does not have a dedicated adapter yet. Choose OpenAI-compatible,
                    OpenAI Responses, Anthropic Messages, Azure OpenAI, or IBM watsonx, or add an adapter before saving.
                  </p>
                  {registryEntry?.status === "listed" && registryEntry.note && (
                    <p className="settings-alert-note">{registryEntry.note}</p>
                  )}
                </LwAlert>
              )}
              {formDirty && savedProvider?.lastTest && (
                <LwAlert variant="warning" size="sm" withIcon className="settings-alert settings-alert--warning">
                  <p>
                    Unsaved changes to the endpoint or authentication mode. The saved result (“{statusLabel(savedProvider).label}”) no longer describes this
                    configuration — save, then run the connection check again.
                  </p>
                </LwAlert>
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
                  helperText={
                    form.providerType === "qoder_cloud_agents"
                      ? "Regional business endpoint. Global: https://api.qoder.com/api/v1/cloud — China mainland: https://api.qoder.com.cn/api/v1/cloud. Duplicate /api/v1 or /cloud segments are normalized, never silently switched to another region."
                      : form.providerType === "watsonx"
                        ? "Regional watsonx cluster URL plus ?project_id=YOUR_PROJECT_ID, e.g. https://us-south.ml.cloud.ibm.com?project_id=…"
                        : form.providerType === "azure_openai"
                          ? "Azure OpenAI v1 endpoint, e.g. https://{resource}.openai.azure.com/openai/v1. Enter it manually."
                          : "OpenAI-compatible base URL. Extra /chat/completions suffixes are stripped automatically. Localhost only works when the backend runs on the same machine — the deployed backend rejects it with an explanation."
                  }
                  inputProps={{ maxLength: 500 }}
                  required
                />
                <TextField
                  select
                  label="API protocol"
                  value={form.providerType}
                  onChange={event => {
                    const providerType = event.target.value;
                    setForm(current => {
                      if (providerType !== "qoder_cloud_agents") return { ...current, providerType };
                      const region = QODER_REGIONS.find(item => item.id === qoderRegionFor(current.baseUrl)) || QODER_REGIONS[0];
                      return {
                        ...current,
                        providerType,
                        baseUrl: String(current.baseUrl || "").trim() ? current.baseUrl : region.businessUrl,
                        openapiBaseUrl: current.openapiBaseUrl || region.openapiUrl
                      };
                    });
                  }}
                  helperText={protocolHelp(form.providerType)}
                  SelectProps={{ native: true }}
                >
                  {PROTOCOL_OPTIONS.map(option => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </TextField>
                {isQoderForm && (
                  <TextField
                    select
                    label="Qoder region"
                    value={qoderRegion}
                    onChange={event => applyQoderRegion(event.target.value)}
                    helperText="Sets both the business endpoint and the OpenAPI host. VupsRouter never swaps regions silently."
                    SelectProps={{ native: true }}
                  >
                    {QODER_REGIONS.map(region => (
                      <option key={region.id} value={region.id}>{region.label}</option>
                    ))}
                    {qoderRegion === "custom" && <option value="custom">Custom endpoint</option>}
                  </TextField>
                )}
                {isQoderForm && (
                  <TextField
                    select
                    label="Qoder authentication"
                    value={form.authMode || "pat"}
                    onChange={event => setQoderAuthMode(event.target.value)}
                    helperText={
                      form.authMode === "service_account"
                        ? "The service account key stays on the server and is exchanged for a short-lived token; it is never sent to the business API directly."
                        : "A Personal Access Token is sent as a bearer token to the business API."
                    }
                    SelectProps={{ native: true }}
                  >
                    {QODER_AUTH_MODES.map(mode => (
                      <option key={mode.value} value={mode.value}>{mode.label}</option>
                    ))}
                  </TextField>
                )}
                {isQoderForm && form.authMode === "service_account" && (
                  <TextField
                    label="Qoder OpenAPI base URL"
                    value={form.openapiBaseUrl}
                    onChange={event => setForm(current => ({ ...current, openapiBaseUrl: event.target.value }))}
                    placeholder="https://openapi.qoder.sh"
                    helperText="Host used only for the service-token exchange. Must be the same region as the business endpoint — Global: https://openapi.qoder.sh · China mainland: https://openapi.qoder.com.cn."
                    inputProps={{ maxLength: 500 }}
                  />
                )}
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
                  disabled={Boolean(busy) || !SAVEABLE_COMPATIBILITY.has(form.compatibility) || form.providerType === "native"}
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
                  {busy === "test" ? "Checking…" : "Check connection (no tokens)"}
                </Button>
                <Button
                  type="button"
                  variant="outlined"
                  color="warning"
                  startIcon={busy === "test-model" ? <CircularProgress size={17} color="inherit" /> : <CheckCircleRoundedIcon />}
                  onClick={handleTestModel}
                  disabled={Boolean(busy)}
                >
                  {busy === "test-model" ? "Testing model…" : "Test model (uses tokens)"}
                </Button>
                <Button type="button" variant="text" onClick={() => setForm(null)} disabled={Boolean(busy)}>
                  Close
                </Button>
              </div>
            </form>
            </AnimatedContent>
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
                <LwAlert variant="info" size="sm" withIcon className="settings-alert settings-alert--info">
                  <p>
                    Live discovery failed ({modelsWarning}). Your saved model list is unchanged — fix the connection and press Load models to refresh.
                  </p>
                </LwAlert>
              )}
              {Array.isArray(registryEntry?.suggestedModels) && registryEntry.suggestedModels.length > 0 && (
                <div className="settings-models">
                  <span className="settings-models-label">SUGGESTED MODEL IDS — NOT VERIFIED ON YOUR KEY YET</span>
                  <div className="settings-models-list">
                    {registryEntry.suggestedModels.map(model => (
                      <button
                        key={model.id}
                        type="button"
                        className={`settings-model-chip${selectedModels.includes(model.id) ? " is-active" : ""}`}
                        aria-pressed={selectedModels.includes(model.id)}
                        title={`${model.id} — click to add or remove, then use Test model`}
                        onClick={() => toggleModel(model.id)}
                      >
                        {model.name}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {models.length > 0 && (
                <div className="settings-models">
                  <span className="settings-models-label">DISCOVERED THIS SESSION — CLICK TO ADD OR REMOVE</span>
                  <div className="settings-models-list">
                    {models.map(model => (
                      <button
                        key={modelIdentity(savedProvider, model.id)}
                        type="button"
                        className={`settings-model-chip${selectedModels.includes(model.id) ? " is-active" : ""}`}
                        aria-pressed={selectedModels.includes(model.id)}
                        title={capabilityTitle(model)}
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
                <p className="settings-empty">
                  Capability badges come from provider metadata. This app currently routes chat and image inputs; image
                  generation, audio, video, embeddings, reranking, and realtime are not exposed yet.
                </p>
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
                <li>Choose the API protocol and enter the provider's base URL (use <code>Load models</code> or manual entry to confirm the model ID).</li>
                <li>Save the provider, then press <b>Check connection</b> — it only reads the model list and never sends inference. Use <b>Test model</b> separately; it sends a tiny prompt and may consume provider tokens.</li>
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
              <li><b>Check connection</b> never runs inference. Only the explicit <b>Test model</b> action sends a small prompt, and it always asks for confirmation first.</li>
              <li>Deleting a provider removes only that provider's configuration; all others stay untouched.</li>
            </ul>
          </section>
        </div>
      </main>
      <HoldToDeleteDialog
        open={Boolean(deleteTarget)}
        title="Remove saved provider configuration?"
        itemName={
          deleteTarget
            ? deleteTarget.apiKeyMasked
              ? `${deleteTarget.provider} (${deleteTarget.apiKeyMasked})`
              : deleteTarget.provider
            : ""
        }
        description="This removes the saved API key and model list for this provider. Your other saved keys are not affected."
        successMessage="Provider configuration removed."
        onCancel={() => setDeleteTarget(null)}
        onConfirm={deleteProviderConfig}
      />
    </>
  );
}


