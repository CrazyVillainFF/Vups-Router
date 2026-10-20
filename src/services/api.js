import axios from "axios";

const viteEnv = import.meta.env ?? {};

export function resolveApiBaseURL(env = viteEnv) {
  const configured = env.VITE_API_BASE_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  return env.DEV ? "http://localhost:4000/api" : "/api";
}

export const apiClient = axios.create({
  baseURL: resolveApiBaseURL() || undefined,
  timeout: 75000,
  withCredentials: true,
  headers: { Accept: "application/json", "Content-Type": "application/json" }
});

function ensureApiBaseURL() {
  if (!apiClient.defaults.baseURL) {
    throw new Error("Set VITE_API_BASE_URL to your deployed backend API URL.");
  }
}

// ─── Authentication ─────────────────────────────────────────────────────────

export async function signUp(payload) {
  ensureApiBaseURL();
  const { data } = await apiClient.post("/auth/signup", payload);
  return data;
}

export async function signIn(payload) {
  ensureApiBaseURL();
  const { data } = await apiClient.post("/auth/signin", payload);
  return data;
}

export async function signOut() {
  ensureApiBaseURL();
  const { data } = await apiClient.post("/auth/logout");
  return data;
}

export async function fetchCurrentUser() {
  ensureApiBaseURL();
  const { data } = await apiClient.get("/auth/me");
  return data.user;
}

export async function requestPasswordReset(email) {
  ensureApiBaseURL();
  const { data } = await apiClient.post("/forgot-password", { email });
  return data;
}

export async function verifyResetCode({ email, code }) {
  ensureApiBaseURL();
  const { data } = await apiClient.post("/verify-code", { email, code });
  return data;
}

export async function resetPassword({ email, code, newPassword }) {
  ensureApiBaseURL();
  const { data } = await apiClient.post("/reset-password", { email, code, newPassword });
  return data;
}

// ─── Provider configuration ─────────────────────────────────────────────────

export async function fetchProviderConfig() {
  ensureApiBaseURL();
  const { data } = await apiClient.get("/settings/provider");
  return data.config;
}

export async function saveProviderConfig(payload) {
  ensureApiBaseURL();
  const { data } = await apiClient.put("/settings/provider", payload);
  return data;
}

export async function deleteProviderConfig() {
  ensureApiBaseURL();
  const { data } = await apiClient.delete("/settings/provider");
  return data;
}

export async function testProviderConnection(payload) {
  ensureApiBaseURL();
  const { data } = await apiClient.post("/settings/provider/test", payload);
  return data;
}

export async function testProviderModel(payload) {
  ensureApiBaseURL();
  const { data } = await apiClient.post("/settings/provider/test-model", payload);
  return data;
}

export async function listProviders() {
  ensureApiBaseURL();
  const { data } = await apiClient.get("/settings/providers");
  return data;
}

export async function saveManagedProvider(providerId, payload) {
  ensureApiBaseURL();
  const id = encodeURIComponent(providerId);
  const { data } = await apiClient.put(`/settings/providers/${id}`, payload);
  return data;
}

export async function createManagedProvider(payload) {
  ensureApiBaseURL();
  const { data } = await apiClient.post("/settings/providers", payload);
  return data;
}

export async function activateProvider(providerId) {
  ensureApiBaseURL();
  const id = encodeURIComponent(providerId);
  const { data } = await apiClient.post(`/settings/providers/${id}/activate`);
  return data;
}

export async function removeProvider(providerId) {
  ensureApiBaseURL();
  const id = encodeURIComponent(providerId);
  const { data } = await apiClient.delete(`/settings/providers/${id}`);
  return data;
}

export async function testManagedProvider(providerId, payload) {
  ensureApiBaseURL();
  const id = encodeURIComponent(providerId);
  const { data } = await apiClient.post(`/settings/providers/${id}/test`, payload ?? {});
  return data;
}

export async function testManagedProviderModel(providerId, payload) {
  ensureApiBaseURL();
  const id = encodeURIComponent(providerId);
  const { data } = await apiClient.post(`/settings/providers/${id}/test-model`, payload ?? {});
  return data;
}

export async function saveProviderModels(providerId, payload) {
  ensureApiBaseURL();
  const id = encodeURIComponent(providerId);
  const { data } = await apiClient.put(`/settings/providers/${id}/models`, payload);
  return data;
}

export async function fetchProviderModels() {
  ensureApiBaseURL();
  const { data } = await apiClient.get("/settings/models");
  return data.models;
}

export async function fetchProviderModelsDetailed(configId) {
  ensureApiBaseURL();
  const { data } = await apiClient.get("/settings/models", {
    params: configId ? { configId } : undefined
  });
  return data;
}

export async function fetchSharedModelStatus() {
  ensureApiBaseURL();
  const { data } = await apiClient.get("/settings/shared-model");
  return data.shared;
}

export async function fetchOmniRouteStatus() {
  ensureApiBaseURL();
  const { data } = await apiClient.get("/settings/omniroute/status");
  return data.omniroute;
}

// ─── Conversations ──────────────────────────────────────────────────────────

export async function listConversations() {
  ensureApiBaseURL();
  const { data } = await apiClient.get("/conversations");
  return data.conversations;
}

export async function getConversation(id) {
  ensureApiBaseURL();
  const { data } = await apiClient.get(`/conversations/${id}`);
  return data.conversation;
}

export async function deleteConversation(id) {
  ensureApiBaseURL();
  const { data } = await apiClient.delete(`/conversations/${id}`);
  return data;
}

// ─── Errors ─────────────────────────────────────────────────────────────────

export function getApiErrorMessage(error) {
  if (axios.isAxiosError(error)) {
    if (typeof error.response?.data?.message === "string") return error.response.data.message;
    if (error.response) return `The backend request failed (HTTP ${error.response.status}).`;
    const target = error.config?.baseURL ? ` at ${error.config.baseURL}` : "";
    return `Could not reach the VupsRouter backend${target}. Check that it is running and the URL is correct. If it is on a free hosting tier (e.g. Render), it can take up to a minute to wake up — please try again.`;
  }
  return error instanceof Error ? error.message : "The request could not be completed.";
}
