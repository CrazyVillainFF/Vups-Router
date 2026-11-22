/**
 * Client-side settings cache and request deduplication.
 *
 * Multiple screens (chat, settings, combo) each fetch the same settings
 * endpoints on mount, and React StrictMode remounts components in
 * development, so the same settings requests could fire many times in a
 * few seconds and exhaust the backend settings rate limiter.
 *
 * This module holds a small in-memory cache of settings responses and
 * deduplicates in-flight requests: the first caller for a given key starts
 * the network request, and every concurrent caller for the same key waits
 * on the same promise. Cache entries are short-lived (5 minutes) so the
 * app still sees fresh data, but repeated mounts, remounts, and navigation
 * do not re-request the server.
 *
 * Safety features:
 * - User isolation: cache keys include the authenticated user ID, so one
 *   user's cached settings are never reused for another user.
 * - Logout: calling `invalidateSettings()` clears the cache and cancels
 *   in-flight requests. Pending requests are cancelled via AbortController.
 * - Stale protection: each cache entry stores a monotonic version counter.
 *   Invalidation increments the version, so an older request completing
 *   after invalidation is discarded rather than overwriting newer data.
 * - Mutation safety: after a successful settings mutation, the affected
 *   cache keys are invalidated and re-fetched.
 *
 * Requests that fail with 429 (rate limited) are retried with bounded
 * exponential backoff plus jitter, honouring the server's Retry-After
 * header when present. Non-retryable client errors (401/403/404) and
 * network failures after the retry budget are surfaced to the caller.
 *
 * All settings keys share one cache keyed by request key, so different
 * settings resources never collide, but multiple callers of the same
 * resource always share one request.
 */

import {
  fetchProviderConfig,
  fetchProviderModels,
  fetchProviderModelsDetailed,
  fetchFreeModels,
  fetchSharedModelStatus,
  fetchOmniRouteStatus,
  listProviders
} from "./api.js";
import { isCloudOnline, offlineError } from "../connectivity/connectivity.js";

/** Cache entries keyed by request key. */
const cache = new Map();

/** In-flight requests keyed by request key, for deduplication. */
const inFlight = new Map();

/** Abort controllers for in-flight requests, for cancellation. */
const abortControllers = new Map();

/** The user ID for which the cache is currently populated. */
let cachedUserId = null;

/** Global cache version - increments on invalidation. */
let cacheVersion = 0;

/** Cached entries are considered fresh for five minutes. */
const CACHE_TTL_MS = 5 * 60 * 1000;

/** Maximum number of retry attempts after the first attempt. */
const MAX_RETRIES = 3;

/** Base delay (ms) for exponential backoff with jitter. */
const BACKOFF_BASE_MS = 500;

/** Ceiling (ms) for any single backoff delay. */
const BACKOFF_CAP_MS = 10000;

/** Sleeps for the given number of milliseconds. */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Exponential backoff with jitter, in milliseconds. */
function backoffDelay(attempt) {
  const jitter = Math.random() * BACKOFF_BASE_MS;
  return Math.min(BACKOFF_BASE_MS * Math.pow(2, attempt) + jitter, BACKOFF_CAP_MS);
}

/**
 * Delay in milliseconds indicated by a 429 response, or an exponential
 * backoff fallback.
 */
function delayFor(error, attempt) {
  const retryAfter = error?.response?.headers?.["retry-after"];
  if (retryAfter) {
    // Numeric seconds format (e.g., "30")
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) {
      return seconds * 1000;
    }
    // HTTP-date format (e.g., "Wed, 21 Oct 2023 07:28:00 GMT")
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) {
      const ms = date - Date.now();
      if (ms > 0) {
        return ms;
      }
    }
  }
  const resetAfter = error?.response?.headers?.["ratelimit-reset"];
  if (resetAfter) {
    const seconds = Number(resetAfter) - Date.now() / 1000;
    if (Number.isFinite(seconds) && seconds > 0) {
      return seconds * 1000;
    }
  }
  return backoffDelay(attempt);
}

/**
 * Builds the cache key for a resource, including the user ID for isolation.
 * @param {string} resourceKey - The base resource key (e.g. "settings/provider").
 * @param {string|null} userId - The authenticated user ID.
 * @returns {string} The full cache key.
 */
function buildKey(resourceKey, userId) {
  return `${userId || "anonymous"}:${resourceKey}`;
}

/**
 * Fetch a settings resource with caching and request deduplication.
 *
 * @param {string} resourceKey - Stable cache key for this resource.
 * @param {Function} fetcher - Function returning a promise that resolves to the response data.
 * @param {Object} [options]
 * @param {boolean} [options.force] - If true, bypasses the cache and refetches.
 * @param {string} [options.userId] - The authenticated user ID for cache isolation.
 * @returns {Promise} The cached or freshly fetched data.
 */
async function cachedGet(resourceKey, fetcher, { force = false, userId = null } = {}) {
  const key = buildKey(resourceKey, userId);
  const version = cacheVersion;
  const now = Date.now();

  // Return the cached value if it is fresh and not forcing a refresh.
  if (!force) {
    const cached = cache.get(key);
    if (cached && now - cached.timestamp < CACHE_TTL_MS && cached.version === version) {
      return cached.value;
    }
  }

  // Return the in-flight promise if the same request is already in flight.
  if (inFlight.has(key)) {
    return inFlight.get(key);
  }

  if (!isCloudOnline()) {
    throw offlineError();
  }

  const controller = new AbortController();
  abortControllers.set(key, controller);

  const promise = (async () => {
    let lastError;
    try {
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        if (controller.signal.aborted) {
          throw new Error("Request cancelled.");
        }
        try {
          const response = await fetcher();
          // Check if the cache was invalidated while we were fetching.
          if (version !== cacheVersion) {
            // Cache was invalidated - discard this result.
            throw new Error("Cache invalidated during fetch.");
          }
          const data = response && typeof response === "object" && "data" in response ? response.data : response;
          cache.set(key, { value: data, timestamp: Date.now(), version });
          return data;
        } catch (error) {
          lastError = error;
          const status = error?.response?.status;
          // Non-retryable: authentication, permission, not found, bad request.
          if (status === 401 || status === 403 || status === 404) {
            throw error;
          }
          // Rate limited: honour Retry-After / RateLimit-Reset, else back off.
          if (status === 429) {
            if (attempt === MAX_RETRIES || controller.signal.aborted) throw error;
            await sleep(delayFor(error, attempt));
            continue;
          }
          // Network error (no response): retry with backoff, unless the route
          // is already known to be down.
          if (!error.response) {
            if (!isCloudOnline() || attempt === MAX_RETRIES || controller.signal.aborted) throw error;
            await sleep(backoffDelay(attempt));
            continue;
          }
          // Other 4xx/5xx: do not retry.
          throw error;
        }
      }
      throw lastError;
    } catch (error) {
      // If the cache was invalidated, do not set the stale result.
      if (error.message === "Cache invalidated during fetch.") {
        // Re-throw as a cancellation-like error.
        throw new Error("Settings were updated. Please refresh.");
      }
      throw error;
    } finally {
      if (inFlight.get(key) === promise) {
        inFlight.delete(key);
      }
      abortControllers.delete(key);
    }
  })();

  inFlight.set(key, promise);
  return promise;
}

/**
 * Set the current authenticated user for cache isolation.
 * Call this when the user changes (login, logout, account switch).
 * @param {string|null} userId - The authenticated user ID, or null for anonymous.
 */
export function setSettingsUser(userId) {
  if (userId !== cachedUserId) {
    // User changed - clear the cache and cancel in-flight requests.
    invalidateSettings();
    cachedUserId = userId;
  }
}

/**
 * Get the current cached user ID.
 * @returns {string|null} The cached user ID.
 */
export function getSettingsUser() {
  return cachedUserId;
}

/** Drop any cached value for the given key and cancel its in-flight request. */
export function invalidateSettingsKey(key, userId = null) {
  const fullKey = buildKey(key, userId || cachedUserId);
  cache.delete(fullKey);
  if (inFlight.has(fullKey)) {
    const controller = abortControllers.get(fullKey);
    if (controller) controller.abort();
    inFlight.delete(fullKey);
    abortControllers.delete(fullKey);
  }
}

/** Drop every cached settings value and cancel every in-flight request. */
export function invalidateSettings() {
  cacheVersion += 1;
  // Abort all in-flight requests.
  for (const controller of abortControllers.values()) {
    controller.abort();
  }
  cache.clear();
  inFlight.clear();
  abortControllers.clear();
}

/**
 * Wrappers around the API functions so every caller shares one cache entry
 * per settings resource and never starts two network requests for the same
 * resource at the same time.
 */
export async function cachedFetchProviderConfig() {
  return cachedGet("settings/provider", fetchProviderConfig, { userId: cachedUserId });
}

export async function cachedFetchProviderModels() {
  return cachedGet("settings/models", fetchProviderModels, { userId: cachedUserId });
}

export async function cachedFetchFreeModels({ force = false } = {}) {
  return cachedGet("settings/free-models", () => fetchFreeModels({ refresh: force }), { force, userId: cachedUserId });
}

export async function cachedFetchSharedModelStatus() {
  return cachedGet("settings/shared-model", fetchSharedModelStatus, { userId: cachedUserId });
}

export async function cachedFetchOmniRouteStatus() {
  return cachedGet("settings/omniroute/status", fetchOmniRouteStatus, { userId: cachedUserId });
}

export async function cachedListProviders() {
  return cachedGet("settings/providers", listProviders, { userId: cachedUserId });
}

export async function cachedFetchProviderModelsDetailed(configId) {
  return cachedGet(`settings/models:${configId}`, () => fetchProviderModelsDetailed(configId), { userId: cachedUserId });
}
