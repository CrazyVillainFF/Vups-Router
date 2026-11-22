/**
 * Hardware facts used by the compatibility labels.
 *
 * On Windows the numbers come from the machine itself (a native command reads
 * physical memory and disk space). The browser build can only offer coarse
 * estimates, so everything it reports is marked as an estimate and its RAM is
 * never treated as GPU memory. Nothing here guesses VRAM from RAM.
 */

import { formatModelSize } from "./localRuntime.js";

const GIGABYTE = 1024 * 1024 * 1024;
const HARDWARE_CACHE_KEY = "vupsrouter.localai.hardware.v1";
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;

export const HARDWARE_SOURCES = Object.freeze({
  native: "native",
  browser: "browser",
  none: "none"
});

export const HARDWARE_TIERS = Object.freeze({
  low: Object.freeze({ id: "low", label: "Low-end" }),
  mid: Object.freeze({ id: "mid", label: "Mid-end" }),
  high: Object.freeze({ id: "high", label: "High-end" })
});

export const UNKNOWN_HARDWARE = Object.freeze({
  source: HARDWARE_SOURCES.none,
  cpu: "",
  logicalCores: 0,
  totalRamBytes: 0,
  availableRamBytes: 0,
  storageTotalBytes: 0,
  storageFreeBytes: 0,
  gpus: Object.freeze([]),
  estimated: true
});

export function tierForRamBytes(totalRamBytes) {
  const bytes = Number(totalRamBytes);
  if (!Number.isFinite(bytes) || bytes <= 0) return null;
  if (bytes < 12 * GIGABYTE) return HARDWARE_TIERS.low;
  if (bytes < 24 * GIGABYTE) return HARDWARE_TIERS.mid;
  return HARDWARE_TIERS.high;
}

function browserStorage() {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readHardwareCache(storage = browserStorage(), now = Date.now()) {
  try {
    const parsed = JSON.parse(storage?.getItem(HARDWARE_CACHE_KEY) || "null");
    if (!parsed || typeof parsed !== "object" || !parsed.hardware) return null;
    if (now - Number(parsed.at || 0) > CACHE_TTL_MS) return null;
    return parsed.hardware;
  } catch {
    return null;
  }
}

export function writeHardwareCache(hardware, storage = browserStorage(), at = Date.now()) {
  try {
    storage?.setItem(HARDWARE_CACHE_KEY, JSON.stringify({ at, hardware }));
  } catch {
    /* A device that cannot cache simply probes again next time. */
  }
}

function normalizeNative(payload) {
  if (!payload || typeof payload !== "object") return null;
  return {
    source: HARDWARE_SOURCES.native,
    cpu: String(payload.cpu || "").trim(),
    logicalCores: Number(payload.logicalCores) || 0,
    totalRamBytes: Number(payload.totalRamBytes) || 0,
    availableRamBytes: Number(payload.availableRamBytes) || 0,
    storageTotalBytes: Number(payload.storageTotalBytes) || 0,
    storageFreeBytes: Number(payload.storageFreeBytes) || 0,
    gpus: (Array.isArray(payload.gpus) ? payload.gpus : [])
      .map(gpu => ({
        name: String(gpu?.name || "").trim(),
        vramBytes: Number(gpu?.vramBytes) > 0 ? Number(gpu.vramBytes) : 0
      }))
      .filter(gpu => gpu.name),
    estimated: false
  };
}

async function detectBrowser() {
  const nav = typeof navigator === "undefined" ? null : navigator;
  const reportedRam = Number(nav?.deviceMemory) * GIGABYTE || 0;
  let storageTotalBytes = 0;
  let storageFreeBytes = 0;
  try {
    const estimate = await nav?.storage?.estimate?.();
    const quota = Number(estimate?.quota) || 0;
    const usage = Number(estimate?.usage) || 0;
    storageTotalBytes = quota;
    storageFreeBytes = Math.max(0, quota - usage);
  } catch {
    /* Storage reporting is optional in the browser. */
  }
  return {
    source: HARDWARE_SOURCES.browser,
    cpu: "",
    logicalCores: Number(nav?.hardwareConcurrency) || 0,
    totalRamBytes: reportedRam,
    availableRamBytes: 0,
    storageTotalBytes,
    storageFreeBytes,
    gpus: [],
    estimated: true,
    reason: "Browser builds report approximate memory; VRAM is not visible."
  };
}

/**
 * Detect the machine's hardware.
 *
 * `nativeInfo` is the Windows bridge; when it is absent or fails, the browser
 * estimate is used and labelled as one. A cached reading is reused until it
 * expires unless `force` is set.
 */
export async function detectHardware({ nativeInfo, storage = browserStorage(), force = false } = {}) {
  if (!force) {
    const cached = readHardwareCache(storage);
    if (cached) return cached;
  }
  let hardware = null;
  if (typeof nativeInfo === "function") {
    try {
      hardware = normalizeNative(await nativeInfo());
    } catch {
      hardware = null;
    }
  }
  if (!hardware) hardware = await detectBrowser();
  writeHardwareCache(hardware, storage);
  return hardware;
}

/**
 * The memory a model needs on this machine, including runtime and context
 * overhead. Weights size alone is never treated as the whole requirement.
 */
export function modelFootprintBytes(model) {
  const weightsBytes =
    Number(model?.installedBytes) ||
    Number(model?.downloadBytes) ||
    (Number(model?.params) > 0 ? Math.round(Number(model.params) * 0.65 * GIGABYTE) : 0);
  if (!weightsBytes) return 0;
  return Math.round(weightsBytes * 1.15 + 1.25 * GIGABYTE);
}

function bestVram(hardware) {
  return (hardware?.gpus || []).reduce((best, gpu) => Math.max(best, Number(gpu?.vramBytes) || 0), 0);
}

/**
 * How a model fits the detected machine.
 *
 * A GPU result is only reported when the GPU itself reports its dedicated
 * memory. System RAM is used for the CPU result and is never called VRAM.
 */
export function classifyModelFit(model, hardware) {
  const footprint = modelFootprintBytes(model);
  const tier = tierForRamBytes(hardware?.totalRamBytes);
  if (!footprint) {
    return { level: "unknown", label: "Size unknown", detail: "The model's size could not be read.", estimated: true };
  }
  if (!hardware || hardware.source === HARDWARE_SOURCES.none || (!hardware.totalRamBytes && !bestVram(hardware))) {
    return {
      level: "unknown",
      label: "Compatibility unknown",
      detail: "Hardware could not be read on this device.",
      estimated: true
    };
  }
  const sizeLabel = formatModelSize(footprint);
  const vram = bestVram(hardware);
  if (vram > 0 && footprint <= vram * 0.9) {
    return {
      level: "gpu",
      label: "High-end",
      detail: `Fits in the detected ${formatModelSize(vram)} of GPU memory.`,
      estimated: false
    };
  }
  if (hardware.totalRamBytes > 0 && footprint <= hardware.totalRamBytes * 0.72) {
    const tierLabel = tier?.label || "Mid-end";
    const spare = hardware.totalRamBytes - footprint;
    return {
      level: tier?.id || "mid",
      label: tierLabel,
      detail: `Runs from system RAM: needs about ${sizeLabel}, leaving roughly ${formatModelSize(spare)}.${hardware.estimated ? " Estimated." : ""}`,
      estimated: Boolean(hardware.estimated)
    };
  }
  return {
    level: "insufficient",
    label: "Too large",
    detail: hardware.totalRamBytes > 0
      ? `Needs about ${sizeLabel}; this PC reports ${formatModelSize(hardware.totalRamBytes)} of RAM.`
      : "Needs more memory than this device reports.",
    estimated: Boolean(hardware.estimated)
  };
}

export function hardwareSummary(hardware) {
  const source = hardware?.source;
  const gpuText = (hardware?.gpus || [])
    .map(gpu => (gpu.vramBytes ? `${gpu.name} (${formatModelSize(gpu.vramBytes)} VRAM)` : gpu.name))
    .filter(Boolean)
    .join(", ");
  return {
    tier: tierForRamBytes(hardware?.totalRamBytes),
    ram: hardware?.totalRamBytes
      ? `${formatModelSize(hardware.totalRamBytes)}${source === HARDWARE_SOURCES.browser ? " (estimated)" : ""}`
      : "Not detected",
    cpu: hardware?.cpu
      ? `${hardware.cpu}${hardware.logicalCores ? ` · ${hardware.logicalCores} threads` : ""}`
      : hardware?.logicalCores
        ? `${hardware.logicalCores} logical cores`
        : "Not detected",
    gpu: gpuText || "Not detected — compatibility is based on system RAM",
    storage: hardware?.storageFreeBytes
      ? `${formatModelSize(hardware.storageFreeBytes)} free${source === HARDWARE_SOURCES.browser ? " (browser quota)" : ""}`
      : "Not detected"
  };
}
