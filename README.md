# VupsRouter Client

React 19 + Vite frontend for VupsRouter: the existing home, signup, and signin pages, plus a real chat that talks to the VupsRouter backend proxy.

## Setup

```sh
npm ci
```

Create `.env.local` for development:

```dotenv
VITE_API_BASE_URL=http://localhost:4000/api
```

In development this defaults to `http://localhost:4000/api` when unset. Production always uses the same-origin `/api` proxy, even if a stale absolute backend URL is configured; never put AI provider keys or server secrets in a `VITE_` variable.

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
3. Open **Chat** (`/chat`): the model picker always shows both sections — **YOUR KEYS** (every saved configuration, each with its provider, masked key, and a `Saved model` tag) and **FREE MODELS** (the shared catalogue, which stays visible even if a provider's discovery fails). Pick a row (or use `+ Add API key` to jump to settings), send a message, and the active model is shown in the header and the composer chip. The choice is remembered across reloads. Requests go through the backend proxy (with the selected `configId` when using a saved key); replies stream in; conversations are saved per user and can be reopened or deleted from the sidebar. A saved row can be deleted from the picker (with confirmation); deleting the active configuration falls back to a free model.

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
{ "source": "/api/:path*", "destination": "https://vups-router-be.onrender.com/api/:path*" }
```

The production client always calls `/api` on its own origin; absolute backend URLs are ignored in production. You may unset `VITE_API_BASE_URL` in Vercel or set it to `/api` for clarity, then redeploy. Vite bakes `VITE_` variables into the bundle at build time.

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
