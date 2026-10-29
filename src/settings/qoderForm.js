export const QODER_REGIONS = [
  {
    id: "global",
    label: "Global — api.qoder.com",
    businessUrl: "https://api.qoder.com/api/v1/cloud",
    openapiUrl: "https://openapi.qoder.sh"
  },
  {
    id: "cn",
    label: "China mainland — api.qoder.com.cn",
    businessUrl: "https://api.qoder.com.cn/api/v1/cloud",
    openapiUrl: "https://openapi.qoder.com.cn"
  }
];

export const QODER_AUTH_MODES = [
  { value: "pat", label: "Personal Access Token (sent directly)" },
  { value: "service_account", label: "Service account key (exchanged for a short-lived token)" }
];

const GLOBAL_HOSTS = new Set(["api.qoder.com", "www.api.qoder.com", "openapi.qoder.sh"]);
const CN_HOSTS = new Set(["api.qoder.com.cn", "www.api.qoder.com.cn", "openapi.qoder.com.cn"]);

export function qoderRegionFor(baseUrl) {
  const value = String(baseUrl || "").trim().toLowerCase();
  if (!value) return "global";
  const host = value.replace(/^https?:\/\//, "").split(/[/?#]/)[0];
  if (GLOBAL_HOSTS.has(host)) return "global";
  if (CN_HOSTS.has(host)) return "cn";
  return "custom";
}

function normalizedUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

export function formDiffersFromSaved(form, savedProvider) {
  if (!form || !savedProvider) return false;
  if (normalizedUrl(form.baseUrl) !== normalizedUrl(savedProvider.baseUrl)) return true;
  if ((form.providerType || "openai_compatible") !== (savedProvider.providerType || "openai_compatible")) return true;
  if (form.providerType !== "qoder_cloud_agents") return false;
  if ((form.authMode || "pat") !== (savedProvider.authMode || "pat")) return true;
  return normalizedUrl(form.openapiBaseUrl) !== normalizedUrl(savedProvider.openapiBaseUrl);
}
