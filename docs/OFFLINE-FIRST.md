# Offline-first architecture and implementation plan

Status: implementation in progress. This file records the audited startup and
execution path, the offline blockers found in it, and the order the work is
being done. It is not a claim that any platform already passes.

## 1. Audit summary (evidence paths)

### Windows native shell

- `src-tauri/src/main.rs` starts the app with no network wait: it bootstraps
  `Documents\VupsRouter`, starts the loopback desktop server, then builds the
  window against that loopback URL.
- `src-tauri/src/desktop_server.rs` binds `127.0.0.1` ports from 47821, serves
  the bundled `dist` assets, and proxies `/api/*` to the backend. Its CSP allows
  GitHub releases and the two Ollama loopback origins. Assets and fonts are
  bundled by Vite; no CDN is required.
- Native storage used by Local AI work: `local_chats.rs` (durable,
  owner-scoped JSON), workspace commands, `vups_root` bootstrap. None require
  internet.
- The Windows updater check is the only native network feature, and it runs
  from the frontend after 20 seconds.

### React startup

- `src/context/AuthContext.jsx` calls `fetchCurrentUser()` on mount. A network
  failure with no cached user sets `status = "unavailable"`.
- `src/components/RequireAuth.jsx` currently blocks the whole protected app in
  `unavailable` with a Retry button. This is the primary Windows offline
  startup blocker: the app has a working local runtime and local store but the
  route to them is gated on the cloud.
- `src/desktop/TaskContext.jsx` mounts two cloud reads and then polls usage and
  conversations every 60 seconds, plus on `visibilitychange`.
- `src/tasks/TaskTrackerContext.jsx` starts a 2.5-second cloud poll whenever an
  authenticated owner exists.
- `src/services/settingsCache.js` retries network failures three times, so an
  offline settings read is a burst of requests rather than one bounded attempt.
- `src/ChatPage.jsx` loads cloud catalogs/Combo state on mount, independently of
  the local runtime probe (30 seconds) and local chat store.
- `src/components/WindowsUpdateNotice.jsx` checks GitHub after 20 seconds.
- `src/localai/LocalAiPage.jsx` reads registry download sizes with network
  fetches, independent of the installed-model runtime probe.
- `public/sw.js` only caches pages after an online visit and falls back to
  `offline.html`; it does not pre-cache the app shell.
- `capacitor.config.json` loads `https://vups-router-three.vercel.app` in the
  Android WebView. The bundled `dist` is not used by the shipped configuration.
  The Android Java tree has download and app-info plugins only: there is no
  llama.cpp/GGUF/ONNX/TFLite runtime, so on-device inference is not currently a
  supported Android capability.

### Existing local execution stack (reuse, do not duplicate)

- Runtime discovery/streaming/cancel: `src/localai/localRuntime.js`.
- Intent-aware routing: `src/localai/localRouter.js`.
- Sequential local combo runner and partial preservation:
  `src/localai/localComboRun.js`.
- Run registry/drafts: `src/localai/localRunStore.js`.
- Save-first Local Chats: `src/localai/localChatStore.js` (Tauri) and
  `src/localai/localChats.js` (browser storage/legacy).
- Automatic Windows project save: `src/localai/localProjectSave.js`, with
  save-before-done in the local send path in `ChatPage.jsx`.
- Existing recovery: native/draft reload marks an interrupted run rather than
  claiming it still runs. Inference cannot be resumed after process death.

## 2. Implementation plan

1. **Connectivity manager (new, single source of truth).**
   `src/connectivity/connectivity.js`: startup state from `navigator.onLine`, a
   bounded `/api/health` probe, single-flight probing, a 30-second minimum probe
   interval, `online`/`offline` browser events, request-failure reporting, and a
   React subscription hook. It must never block startup and must never probe
   while offline.
2. **Cloud request gate.** An axios interceptor in `services/api.js` rejects
   cloud calls with a machine-readable `OFFLINE` error while offline. The
   settings cache short-circuits without retries. This is the enforcement layer
   that makes suppression independent of each screen remembering to check.
3. **Offline auth/local profile.** Persist only a non-secret identity receipt
   (id, display name, email, source, timestamp) after a verified `/auth/me`.
   Offline boot uses that receipt with status `offline`; with no receipt it
   creates a clearly labelled device-local profile and uses status `local`.
   No password, session token, cookie or API key is persisted. Cached identity
   is never treated as fresh server authorization; on reconnect `/auth/me`
   decides. Explicit logout clears the account receipt. `RequireAuth` accepts
   the local-access statuses and the shell labels them as offline/local.
4. **Gating cloud work.** Task list/usage, task tracker polling, settings
   catalogs, Combo state, update checks and registry-size reads only run when
   online, and re-run once on a reconnect transition. Cloud chat sends are
   refused with a visible explanation; local/Combined Local AI sends are not
   gated. No local work is queued for the cloud.
5. **Offline status UI.** A compact connection badge in the sidebar shows
   online/offline and the local-only consequence, using existing tokens. The
   Local AI page already reports runtime/model availability.
6. **Android.** Improve the existing service worker to pre-cache the shell and
   serve it for offline navigations instead of the static placeholder, so a
   previously loaded install can reopen. Keep the deployed URL configuration
   because switching origins would break first-party cookies/CORS on the live
   backend. Report the absence of an Android inference runtime and first-launch
   offline limitation explicitly; do not simulate inference.
7. **Verification.**
   - Unit: connectivity transitions/probe suppression, offline profile
     semantics, cloud gate, service-worker fallback, existing local run/save
     suites.
   - Build: production client build and Rust/Tauri test suite.
   - Compiled Windows: launch the actual Tauri app with external DNS blocked in
     WebView2 and a closed loopback API origin, real Ollama available, then run
     local chat, Combined Local AI, project save, navigation/restart recovery and
     reconnect checks. Capture CDP request logs to prove only loopback traffic.
   - Android: build and attempt an emulator run; report exactly which parts ran.

## 3. Boundaries

- No changes to the deployed backend, `.env` files, deployment config or
  production data.
- No commit, push, deploy, tag or release.
- No second task engine, database, router or model registry.
- No cloud fallback for local work and no automatic local-to-cloud conversion.
- Android is not called offline-inference-ready: the native runtime does not
  exist in this tree.
