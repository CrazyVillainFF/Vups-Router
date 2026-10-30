# VupsRouter Client

React 19 + Vite frontend for VupsRouter: the existing home, signup, and signin pages, plus a real chat that talks to the VupsRouter backend proxy.

## Download VupsRouter

| | Download | Notes |
| --- | --- | --- |
| **Download for Windows** | <https://github.com/CrazyVillainFF/Vups-Router/releases/latest/download/VupsRouter-windows-x64-setup.exe> | 64-bit installer (NSIS). Unsigned: SmartScreen shows *Windows protected your PC* → **More info → Run anyway**. |
| **Download for Android** | <https://github.com/CrazyVillainFF/Vups-Router/releases/latest/download/VupsRouter-android-test-debug.apk> | **Test build** — debug-signed APK for sideloading. Not a Play Store release; no signed APK yet (see [Android](#android)). |
| **Use the Web App** | <https://vups-router-three.vercel.app/> | Works today on any browser; install it with *Install app* / *Add to Home Screen*. |
| **All Releases** | <https://github.com/CrazyVillainFF/Vups-Router/releases/> | Every published build, the MSI, checksums (`SHA256SUMS.txt`) and release notes. |

Also available in the release: `VupsRouter-windows-x64.msi` (same app, for managed installs). **There is no iOS app** — nothing is downloaded for iPhone or iPad; use the web app there.

**Current build: v1.0.6** — built and published by CI on **2026-10-30 06:52 UTC** (12:22 IST, 30 Oct 2026). Verify any download against [`SHA256SUMS.txt`](https://github.com/CrazyVillainFF/Vups-Router/releases/download/v1.0.6/SHA256SUMS.txt):

| File | SHA-256 |
| --- | --- |
| `VupsRouter-android-test-debug.apk` (6,617,147 B) | `e625e799ce859f26b31e229aeee6ad71dd921255ddd121cdadd97ea52fb3fb0a` |
| `VupsRouter-windows-x64-setup.exe` (5,955,603 B) | `5f2df0a715e9403c463a9c06a1b689442d8ade43f7b0d8977c3fed0196865b03` |
| `VupsRouter-windows-x64.msi` (7,827,456 B) | `4533584e1a21b00f00f9cc37e6a763c41dd48bab994c64e018e8b0c8e651e0aa` |

The two *latest/download* links above always resolve to the newest release, because CI publishes assets with version-free names. `src/download/releases.js` (the in-app `/download` page) reads the same GitHub Release at runtime, so this table and the website cannot disagree. If an asset is missing from the release, the page shows *Not published yet* instead of a dead button.

### Web app (works today)

Open <https://vups-router-three.vercel.app/>, sign in, and install it from the browser:

1. Chrome or Edge: the install icon in the address bar, or menu → **Install app**.
2. Safari on macOS/iOS: Share → **Add to Home Screen**.
3. Android Chrome: menu → **Add to Home Screen**.

The PWA uses the same backend and account as the website; there is no separate installer. The service worker never caches `/api/`, so conversations and credentials stay out of the app cache.

### Windows

The Windows app is a Tauri 2 shell. It starts a loopback-only server (`127.0.0.1`, random port) that serves the UI bundled at build time and proxies `/api/*` to `https://vups-router-be.onrender.com`, then opens `http://127.0.0.1:<port>/chat?native=windows` in its own window. Sign-in uses that same-origin `/api` path, so the session cookie stays first-party. Because the interface is baked into the installer, a web-only change reaches Windows users only after a rebuild — and it needs internet for the API. Publishing is a tag push, no manual build:

```sh
npm ci && npm test && npm run build && npm run tauri:build
```

That produces, under `src-tauri/target/release/bundle/`:

- `nsis/VupsRouter_<version>_x64-setup.exe` — the usual one-click installer
- `msi/VupsRouter_<version>_x64_en-US.msi` — the same app as an MSI for managed installs

CI renames both to version-free asset names when publishing, so the links above stay valid across releases.

Pushing a `v*` tag runs `.github/workflows/native-builds.yml`: it runs the tests, builds the web bundle, builds both installer formats, and publishes a GitHub Release with the installers plus `SHA256SUMS.txt`. The release notes are generated from the assets that actually attached, so nothing is claimed about a build that failed. Never advertise a local `target/` folder, a source archive, or a dev-server URL as an installer.

Installing a published build:

1. Download **Download for Windows** above (the same file is listed on the release page as `VupsRouter-windows-x64-setup.exe`).
2. Run it; the app appears in **Start → VupsRouter** and signs in on first launch.
3. The installers are **not code-signed yet**, so Windows SmartScreen shows "Windows protected your PC" — choose **More info → Run anyway** only if you trust the download source. Signing (`AZURE_TRUSTED_CERT_*` or a EV/OV certificate) is a separate step and is not claimed here.
4. Uninstall from **Settings → Apps → VupsRouter**.

### Android

`android/` is a real Capacitor 7 project (`com.vupsrouter.app`) that loads the same production site with `?native=android`. CI builds a **debug** APK and publishes it as `VupsRouter-android-test-debug.apk`, and the build is checked with `apksigner verify` before upload. A debug APK is signed with the Android debug key, is not Play-Store eligible, and is labelled a test build everywhere it appears — it is not advertised as the production download. Use it if you want the app in its own window on a real device; use *Add to Home Screen* if you would rather not sideload. If VupsRouter is already installed, uninstall it before installing a build signed with a different key; Android reports that update as "app not installed".

A release APK needs a keystore that this repository does not have. The workflow reads these secrets and only runs the signed build when all four are present — leave them unset and the signed job is skipped rather than producing a broken package:

| Secret | Purpose |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | Base64 of the `.keystore`/`.jks` file |
| `ANDROID_KEYSTORE_PASSWORD` | Keystore password |
| `ANDROID_KEY_ALIAS` | Key alias inside the keystore |
| `ANDROID_KEY_PASSWORD` | Key password |

Never commit a keystore, password, or Play credential. Until a signed APK or a Play listing exists, the downloadable package is the labelled test build above, and **Add to Home Screen** (see the web section) stays the option that needs no sideloading.

### Localhost is development only

`http://localhost:5173` and the local API on `:4000` are dev servers; they are not a product URL and their data disappears with the process. Anything that requires an account, provider key, or session must be tested against the deployed site.

## Setup

```sh
npm ci
```

`npm run dev` and `npm run preview` use the same-origin `/api` path and proxy it through Vite to the Render backend. To use a local backend instead, set the proxy target:

```dotenv
# Optional: defaults to https://vups-router-be.onrender.com
# VITE_API_PROXY_TARGET=http://localhost:4000
```

Or point the browser directly at a backend (it must allow the dev origin):

```dotenv
# VITE_API_BASE_URL=http://localhost:4000/api
```

Production always uses the same-origin `/api` proxy, even if a stale absolute backend URL is configured; never put AI provider keys or server secrets in a `VITE_` variable. `npm run build` runs `scripts/check-api-config.mjs`, which fails if `VITE_API_BASE_URL` points at localhost and warns when an absolute URL will be ignored.

## Run

```sh
npm run dev       # http://localhost:5173
npm test          # service-level tests (no browser needed)
npm run build     # production bundle in dist/
npm run preview   # serve the production build locally
```

The backend must be running and its `CLIENT_ORIGIN` must allow `http://localhost:5173`.

## User flow

1. **Sign up** at `/signup` or **sign in** at `/signin` — sessions use HTTP-only cookies managed by the backend; the client stores no tokens and login persists across reloads.
2. Open **Provider settings** (`/settings`): pick a provider from the built-in directory (OpenRouter, OmniRoute, AgentRouter, OpenCode Zen, DeepSeek, Groq, Google Gemini, Anthropic, Mistral, Cohere, Together, Fireworks, Cerebras, NVIDIA NIM, xAI, SambaNova, Novita, Vercel AI Gateway, Hugging Face, Cloudflare Workers AI, Amazon Bedrock, Azure AI Foundry, IBM watsonx, AI21, Ollama, vLLM, LocalAI, LM Studio, LiteLLM, FlagshipRouter, custom OpenAI-compatible or Anthropic-compatible endpoints, and more listed with their official links) or add any custom endpoint. The OmniRoute directory entry is a personal provider: enter your own instance URL and key (both are saved per user and encrypted), so it never falls back to the server's shared `OMNIROUTE_*` gateway credentials. OpenCode Zen's `-free` models are restricted to the official OpenCode client: VupsRouter marks them unavailable and will not relay them; use a paid Zen model with Console credits or another provider. Google Gemini uses an AI Studio key and the official OpenAI-compatible endpoint; its free tier has per-project RPM/TPM/RPD limits, may use free-tier content to improve Google products, is intended for professional use with 18+ users, and is not offered in the EEA, Switzerland, or the UK (those regions require paid Google Cloud billing). Choose the API protocol (OpenAI Chat Completions, OpenAI Responses, Anthropic Messages, Azure OpenAI, or IBM watsonx) and save as many configurations as you like — including several keys for the same provider (`Add another key`). Each keeps its own server-generated `configId`, encrypted key, base URL, and model list, and saving one never overwrites another. `Check connection` only reads the model list and never sends inference; `Test model` is a separate, confirmed action that may consume a small number of tokens. `Use for chat` switches the active configuration. Keys are stored server-side only (AES-256-GCM) and shown masked in the UI. Localhost/private URLs are rejected by the deployed backend with an explanation (use a tunnel or run the backend locally).
3. Open **Chat** (`/chat`): the model picker always shows both sections — **YOUR KEYS** (every saved configuration, each with its provider, masked key, and a `Saved model` tag) and **FREE MODELS** (the shared catalogue, which stays visible even if a provider's discovery fails). Pick a row (or use `+ Add API key` to jump to settings), send a message, and the active model is shown in the header and the composer chip. The choice is remembered across reloads. Requests go through the backend proxy (with the selected `configId` when using a saved key); replies stream in; conversations are saved per user and can be reopened or deleted from the sidebar. A saved row can be deleted from the picker (with confirmation); deleting the active configuration falls back to a free model. Use the **Image** action in the composer to generate a picture with the backend's Cloudflare Workers AI model `@cf/black-forest-labs/flux-1-schnell`; generation is separate from chat/vision, shows loading and safe errors, and offers download without adding the image to conversation history.

`/settings` and `/chat` are protected routes; anonymous visitors are redirected to sign in and returned to the requested page afterwards.

## API contract

The client calls the VupsRouter backend (`server/`):

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/auth/signup`, `/api/auth/signin`, `/api/auth/logout` | Cookie sessions |
| `GET` | `/api/auth/me` | Persistent login check |
| `GET` | `/api/settings/providers` | All saved configurations + `activeConfigId` (keys masked) |
| `POST` | `/api/settings/providers` | Create another configuration (server-generated `configId`) |
| `PUT`/`DELETE` | `/api/settings/providers/:configId` | Save/edit or delete one configuration (isolated per `configId`) |
| `POST` | `/api/settings/providers/:configId/activate` | Switch the configuration chat uses |
| `POST` | `/api/settings/providers/:configId/test` | Zero-inference connection check (model listing only) |
| `POST` | `/api/settings/providers/:configId/test-model` | Explicit model test (sends one small inference request after confirmation) |
| `PUT` | `/api/settings/providers/:configId/models` | Save model list + default model |
| `GET` | `/api/settings/models?configId=` | Focused model discovery for one configuration; without the parameter: free catalogue + saved rows for every configuration |
| `GET`/`PUT`/`DELETE` | `/api/settings/provider` | Legacy single-provider endpoints (still supported) |
| `POST` | `/api/chat` | Streaming chat proxy (SSE) |
| `POST` | `/api/images/generate` | Prompt-based image generation via Cloudflare Workers AI (authenticated, quota-limited) |
| `GET`/`DELETE` | `/api/conversations`, `/api/conversations/:id` | Conversation history |

## Vercel deployment

This repo (`CrazyVillainFF/Vups-Router`) is connected to the Vercel project behind `https://vups-router-three.vercel.app`. Pushing to `main` triggers a production deploy.

Vercel project settings:

- Framework Preset: `Vite`
- Install Command: `npm ci`
- Build Command: `npm run build`
- Output Directory: `dist`

**API requests go through a same-origin proxy** declared in `vercel.json`:

```json
{ "source": "/api/(.*)", "destination": "https://vups-router-be.onrender.com/api/$1" }
{ "source": "/api/:path*", "destination": "https://vups-router-be.onrender.com/api/:path*" }
```

The production client always calls `/api` on its own origin; absolute backend URLs are ignored in production. `npm run build` runs `scripts/check-api-config.mjs` first: it fails if `VITE_API_BASE_URL` points at localhost and warns that an absolute URL will be ignored. You may unset `VITE_API_BASE_URL` in Vercel or set it to `/api` for clarity, then redeploy. Vite bakes `VITE_` variables into the bundle at build time, but production request routing never uses them unless the value is relative.

Why the proxy: the browser talks to `https://vups-router-three.vercel.app/api/...`, so the backend's HTTP-only `vr_session` cookie is **first-party** and survives page reloads in Chrome, Safari, Firefox, and privacy-focused browsers. Pointing `VITE_API_BASE_URL` at the Render URL directly makes the cookie third-party; browsers increasingly block those, which signs users out on every refresh.

The production cookie is `HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800` (host-only, no `Domain`), matching the seven-day JWT lifetime. `SameSite=Lax` is sent for same-origin proxy requests and is not available to cross-site requests. This was a deliberate correction from the older `SameSite=None; Secure; Partitioned` cookie, which is unnecessary for the first-party proxy and vulnerable to third-party cookie blocking. Logout clears the current cookie and the older partitioned variant.

Backend CORS remains allowlisted for direct API clients: the backend allows `https://vups-router-three.vercel.app` (plus anything in its `CLIENT_ORIGIN`/`CLIENT_ORIGINS`). Direct API clients should use bearer tokens rather than relying on cross-site cookies.

## Launch readiness (legal, SEO, security)

- **Legal pages:** `/privacy-policy`, `/terms`, `/cookie-policy` are real routes rendered from `src/legal/LegalPages.jsx`. They are generated from `src/legal/config.js`, which reads `VITE_LEGAL_*` environment variables (documented in `.env.example`). The defaults are explicit placeholders (`not yet configured` / `.example` contact) — set `VITE_LEGAL_ENTITY`, `VITE_LEGAL_JURISDICTION`, `VITE_LEGAL_CONTACT_EMAIL`, and `VITE_LEGAL_RETENTION_DESCRIPTION` in Vercel, then redeploy. The pages show an on-page configuration notice until real values are set.
- **SEO:** `public/robots.txt` and `public/sitemap.xml` ship with the build; `index.html` carries canonical/Open Graph/Twitter metadata; `src/components/PageMeta.jsx` sets per-route titles and `noindex` on private routes (sign-in, sign-up, settings, 404).
- **Security headers:** `vercel.json` sets a Content-Security-Policy (self + Google Fonts + the proxied Render API), HSTS, `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`, and `Permissions-Policy`. The `/api/:path*` rewrite also disables CDN caching so authenticated responses are never cached.
- **Verification:** `npm test` covers the legal config, routes, footer links, robots/sitemap, metadata, and headers; direct navigation to all three legal routes was smoke-tested against `vite preview` (HTTP 200).

## Checks

```sh
npm test
npm run build
```
