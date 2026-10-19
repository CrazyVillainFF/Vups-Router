import React, { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  Alert,
  Button,
  CircularProgress,
  TextField,
  Typography
} from "@mui/material";
import AutoAwesomeRoundedIcon from "@mui/icons-material/AutoAwesomeRounded";
import BoltRoundedIcon from "@mui/icons-material/BoltRounded";
import DeleteOutlineRoundedIcon from "@mui/icons-material/DeleteOutlineRounded";
import KeyRoundedIcon from "@mui/icons-material/KeyRounded";
import SaveRoundedIcon from "@mui/icons-material/SaveRounded";
import SiteHeader from "./components/SiteHeader.jsx";
import {
  deleteProviderConfig,
  fetchProviderConfig,
  fetchProviderModels,
  getApiErrorMessage,
  saveProviderConfig,
  testProviderConnection
} from "./services/api.js";
import "./settings.css";

const EMPTY_FORM = { provider: "OpenAI-compatible", baseUrl: "", apiKey: "", model: "" };

const PROVIDER_PRESETS = [
  {
    id: "deepseek",
    label: "DeepSeek",
    values: { provider: "DeepSeek", baseUrl: "https://api.deepseek.com", model: "deepseek-chat" },
    note: "DeepSeek's official OpenAI-compatible API. Default model deepseek-chat; use Load models to confirm it is still available."
  }
];

function providerStatus(config, testResult) {
  if (!config?.configured) {
    return { label: "Configuration Required — save a provider and key", tone: "warn" };
  }
  const last = testResult || config.lastTest;
  if (!last) return { label: "Saved — run Test connection to verify", tone: "neutral" };
  if (last.status === "connected") return { label: "Connected", tone: "ok" };
  if (last.status === "insufficient_balance") return { label: "Insufficient Balance — top up your provider account", tone: "warn" };
  if (last.status === "model_unavailable") return { label: "Model Unavailable — pick a model from the list", tone: "warn" };
  if (last.status === "invalid_key") return { label: "Connection Failed — invalid API key", tone: "error" };
  if (last.status === "timeout") return { label: "Connection Failed — provider timed out", tone: "error" };
  if (last.status === "unreachable") return { label: "Connection Failed — provider unreachable", tone: "error" };
  return { label: "Connection Failed", tone: "error" };
}

function testStatusFromError(error) {
  const code = error?.response?.data?.code;
  if (code === "invalid_api_key") return "invalid_key";
  if (code === "insufficient_credits") return "insufficient_balance";
  if (code === "model_unavailable") return "model_unavailable";
  if (code === "timeout") return "timeout";
  if (code === "network_error") return "unreachable";
  return "failed";
}

function validateForm(form, hasStoredKey) {
  if (form.provider.trim().length < 2 || form.provider.trim().length > 80) {
    return "Provider name must be between 2 and 80 characters.";
  }
  const rawUrl = form.baseUrl.trim();
  if (!rawUrl) return "API base URL is required.";
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return "Enter a valid API base URL such as https://api.example.com/v1.";
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return "API base URL must start with http:// or https://.";
  }
  if (!hasStoredKey && form.apiKey.trim().length < 4) return "Enter the API key from your provider.";
  if (form.apiKey.length > 4096) return "That API key is too long.";
  if (form.model.length > 200) return "Model ID must be 200 characters or fewer.";
  return null;
}

export default function SettingsPage() {
  const [config, setConfig] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [models, setModels] = useState([]);
  const [alert, setAlert] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [testResult, setTestResult] = useState(null);

  const loadModels = useCallback(async ({ silent = false } = {}) => {
    setBusy(current => (current ? current : "models"));
    try {
      const list = await fetchProviderModels();
      setModels(list);
      if (!silent) {
        setAlert(
          list.length > 0
            ? { severity: "success", message: `Loaded ${list.length} models from your provider.` }
            : { severity: "info", message: "The provider returned no models. Enter the model ID manually." }
        );
      }
    } catch (error) {
      if (!silent) {
        setAlert({
          severity: "info",
          message: `${getApiErrorMessage(error)} You can still enter the model ID manually.`
        });
      }
    } finally {
      setBusy(current => (current === "models" ? "" : current));
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchProviderConfig()
      .then(stored => {
        if (cancelled) return;
        setConfig(stored);
        setForm({
          provider: stored.provider || EMPTY_FORM.provider,
          baseUrl: stored.baseUrl || "",
          apiKey: "",
          model: stored.model || ""
        });
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

  useEffect(() => {
    if (config?.configured) loadModels({ silent: true });
  }, [config?.configured, loadModels]);

  const update = key => event => setForm(current => ({ ...current, [key]: event.target.value }));

  async function handleSave(event) {
    event.preventDefault();
    setAlert(null);
    const validationError = validateForm(form, config?.hasApiKey);
    if (validationError) {
      setAlert({ severity: "error", message: validationError });
      return;
    }
    setBusy("save");
    try {
      const result = await saveProviderConfig({
        provider: form.provider.trim(),
        baseUrl: form.baseUrl.trim(),
        apiKey: form.apiKey.trim(),
        model: form.model.trim()
      });
      setConfig(result.config);
      setForm(current => ({ ...current, apiKey: "" }));
      setAlert({ severity: "success", message: `${result.message} Saved key: ${result.config.apiKeyMasked}` });
    } catch (error) {
      setAlert({ severity: "error", message: getApiErrorMessage(error) });
    } finally {
      setBusy("");
    }
  }

  async function handleTest() {
    setAlert(null);
    if (!form.baseUrl.trim()) {
      setAlert({ severity: "error", message: "Enter an API base URL first." });
      return;
    }
    setBusy("test");
    try {
      const result = await testProviderConnection({
        provider: form.provider.trim(),
        baseUrl: form.baseUrl.trim(),
        apiKey: form.apiKey.trim() || undefined,
        model: form.model.trim() || undefined
      });
      if (Array.isArray(result.availableModels) && result.availableModels.length > 0) {
        setModels(result.availableModels);
      }
      setTestResult({ status: "connected" });
      setAlert({ severity: "success", message: result.message });
      fetchProviderConfig().then(setConfig).catch(() => {});
    } catch (error) {
      setTestResult({ status: testStatusFromError(error) });
      setAlert({ severity: "error", message: getApiErrorMessage(error) });
    } finally {
      setBusy("");
    }
  }

  function applyPreset(preset) {
    setForm(current => ({ ...current, ...preset.values }));
    setAlert({ severity: "info", message: `${preset.note} Paste your API key, then Save and Test.` });
  }

  async function handleDelete() {
    if (!window.confirm("Delete your saved provider configuration? Chat will stop working until you save a new one.")) {
      return;
    }
    setAlert(null);
    setBusy("delete");
    try {
      await deleteProviderConfig();
      setConfig(null);
      setModels([]);
      setForm(EMPTY_FORM);
      setAlert({ severity: "success", message: "Provider configuration deleted." });
    } catch (error) {
      setAlert({ severity: "error", message: getApiErrorMessage(error) });
    } finally {
      setBusy("");
    }
  }

  const status = providerStatus(config, testResult);

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
            <span className="auth-kicker">YOUR OWN AI PROVIDER</span>
            <Typography component="h1">API settings</Typography>
            <p>
              Connect any OpenAI-compatible provider. Paste your key once — it is encrypted on the server
              with AES-256-GCM, never stored in your browser, and never shown in full again.
            </p>
          </div>

          <div className={`settings-status settings-status--${status.tone}`} role="status">
            <span className="settings-status-dot" aria-hidden="true" />
            <strong>{status.label}</strong>
          </div>

          {alert && (
            <Alert severity={alert.severity} sx={{ mb: 3 }} onClose={() => setAlert(null)}>
              {alert.message}
            </Alert>
          )}

          {config?.configured && (
            <div className="settings-saved">
              <span className="settings-saved-badge">SAVED</span>
              <div>
                <strong>{config.provider}</strong>
                <span className="settings-saved-detail">{config.baseUrl}</span>
                {config.model && <span className="settings-saved-detail">Model: {config.model}</span>}
                <span className="settings-saved-detail">
                  <KeyRoundedIcon fontSize="inherit" /> Key: {config.apiKeyMasked || "saved"}
                </span>
              </div>
            </div>
          )}

          <form className="settings-card" onSubmit={handleSave}>
            <div className="settings-presets">
              <span className="settings-models-label">QUICK START — ONE CLICK TO FILL THE FORM</span>
              <div className="settings-models-list">
                {PROVIDER_PRESETS.map(preset => (
                  <button
                    key={preset.id}
                    type="button"
                    className={`settings-model-chip${form.baseUrl === preset.values.baseUrl ? " is-active" : ""}`}
                    onClick={() => applyPreset(preset)}
                    title={preset.note}
                  >
                    {preset.label} · {preset.values.model}
                  </button>
                ))}
              </div>
            </div>
            <div className="settings-form-grid">
              <TextField
                label="Provider name"
                value={form.provider}
                onChange={update("provider")}
                helperText='A label for you, e.g. "OpenAI-compatible" or "Groq"'
                inputProps={{ maxLength: 80 }}
                required
              />
              <TextField
                label="API base URL"
                value={form.baseUrl}
                onChange={update("baseUrl")}
                placeholder="https://api.example.com/v1"
                helperText="The provider's OpenAI-compatible base URL (ends with /v1 for most providers)"
                inputProps={{ maxLength: 500 }}
                required
              />
              <TextField
                label="API key"
                type="password"
                value={form.apiKey}
                onChange={update("apiKey")}
                placeholder={config?.hasApiKey ? "Leave blank to keep your saved key" : "sk-…"}
                helperText={
                  config?.hasApiKey
                    ? `A key is saved (${config.apiKeyMasked}). Type a new one only to replace it.`
                    : "Stored encrypted on the server. Never saved in your browser."
                }
                inputProps={{ maxLength: 4096, autoComplete: "off" }}
                required={!config?.hasApiKey}
              />
              <TextField
                label="Model ID"
                value={form.model}
                onChange={update("model")}
                placeholder="Select below or type an exact model ID"
                helperText="The exact model ID from your provider, e.g. gpt-4o-mini"
                inputProps={{ maxLength: 200 }}
              />
            </div>

            {models.length > 0 && (
              <div className="settings-models">
                <span className="settings-models-label">AVAILABLE MODELS — CLICK TO SELECT</span>
                <div className="settings-models-list">
                  {models.map(model => (
                    <button
                      key={model.id}
                      type="button"
                      className={`settings-model-chip${form.model === model.id ? " is-active" : ""}`}
                      aria-pressed={form.model === model.id}
                      onClick={() => setForm(current => ({ ...current, model: model.id }))}
                    >
                      {model.id}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="settings-actions">
              <Button
                type="submit"
                variant="contained"
                startIcon={busy === "save" ? <CircularProgress size={17} color="inherit" /> : <SaveRoundedIcon />}
                disabled={Boolean(busy)}
              >
                {busy === "save" ? "Saving…" : "Save configuration"}
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
              <Button
                type="button"
                variant="outlined"
                startIcon={busy === "models" ? <CircularProgress size={17} color="inherit" /> : <AutoAwesomeRoundedIcon />}
                onClick={() => loadModels()}
                disabled={Boolean(busy) || !config?.configured}
              >
                {busy === "models" ? "Loading…" : "Load models"}
              </Button>
              {config?.configured && (
                <Button
                  type="button"
                  color="error"
                  variant="text"
                  startIcon={<DeleteOutlineRoundedIcon />}
                  onClick={handleDelete}
                  disabled={Boolean(busy)}
                >
                  Delete configuration
                </Button>
              )}
            </div>
          </form>

          <div className="settings-help">
            <h2>How testing works</h2>
            <ul>
              <li><b>Test connection</b> calls your provider's model list and, when a model ID is set, sends one tiny request to confirm the model works. The status badge above shows Connected, Insufficient Balance, or the exact failure.</li>
              <li><b>Chat</b> always uses the provider, base URL, and model you save here. If a model fails, VupsRouter reports the provider's error instead of switching models silently.</li>
              <li>Use <b>Load models</b> to see what the provider currently offers — model IDs change over time, so pick one from the live list instead of trusting old documentation.</li>
              <li>DeepSeek's base URL is <code>https://api.deepseek.com</code> (no <code>/v1</code> needed; <code>/v1</code> also works).</li>
            </ul>
            <Link to="/chat" className="settings-chat-link">Go to chat →</Link>
          </div>
        </div>
      </main>
    </>
  );
}
