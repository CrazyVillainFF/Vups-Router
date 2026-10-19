# VupsRouter Client

React 19 + Vite frontend for VupsRouter: the existing home, signup, and signin pages, plus a real chat that talks to the VupsRouter backend proxy.

## Setup

```sh
npm ci
```

Create `.env.local` (dev) or set the Vercel environment variable (production):

```dotenv
VITE_API_BASE_URL=http://localhost:4000/api
```

In development this defaults to `http://localhost:4000/api` when unset. Production builds require it to be set; never put AI provider keys or server secrets in a `VITE_` variable.

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
2. Open **Provider settings** (`/settings`): pick a provider from the built-in directory (OpenRouter, AgentRouter, DeepSeek, Groq, Google Gemini, Mistral, Cohere, Together, Fireworks, Cerebras, NVIDIA NIM, xAI, SambaNova, Novita, Ollama, vLLM, LocalAI, LM Studio, LiteLLM, FlagshipRouter, custom OpenAI-compatible endpoints, and more listed with their official links) or add any custom endpoint. Save as many configurations as you like — including several keys for the same provider (`Add another key`). Each keeps its own server-generated `configId`, encrypted key, base URL, and model list, and saving one never overwrites another. `Test connection` and `Load models` verify the key and fetch the real model list; `Use for chat` switches the active configuration. Keys are stored server-side only (AES-256-GCM) and shown masked in the UI. Localhost/private URLs are rejected by the deployed backend with an explanation (use a tunnel or run the backend locally).
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
| `POST` | `/api/settings/providers/:configId/test` | Connection test |
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

**Required environment variable** (Project -> Settings -> Environment Variables, for Production *and* Preview):

```dotenv
VITE_API_BASE_URL=https://vups-router-be.onrender.com/api
```

Vite bakes `VITE_` variables into the bundle at build time, so you must **redeploy after setting or changing it**. Note the `/api` suffix — the backend mounts all routes under `/api` (`/api/auth/signup`, `/api/auth/signin`, ...).

The legacy deployed bundle hardcoded `http://localhost:4000/api` as a fallback (old `VITE_API_URL` variable name), which is why Sign Up/Sign In failed in production. The current code reads only `VITE_API_BASE_URL`; remove any old `VITE_API_URL` variable.

Backend CORS: the backend allows `https://vups-router-three.vercel.app` (plus anything in its `CLIENT_ORIGIN`/`CLIENT_ORIGINS`) and sends `SameSite=None; Secure; Partitioned` session cookies, so both sites are served over HTTPS and cross-site sessions work in current Chrome, Edge, Firefox, and Safari 16.4+.

## Launch readiness (legal, SEO, security)

- **Legal pages:** `/privacy-policy`, `/terms`, `/cookie-policy` are real routes rendered from `src/legal/LegalPages.jsx`. They are generated from `src/legal/config.js`, which reads `VITE_LEGAL_*` environment variables (documented in `.env.example`). The defaults are explicit placeholders (`not yet configured` / `.example` contact) — set `VITE_LEGAL_ENTITY`, `VITE_LEGAL_JURISDICTION`, `VITE_LEGAL_CONTACT_EMAIL`, and `VITE_LEGAL_RETENTION_DESCRIPTION` in Vercel, then redeploy. The pages show an on-page configuration notice until real values are set.
- **SEO:** `public/robots.txt` and `public/sitemap.xml` ship with the build; `index.html` carries canonical/Open Graph/Twitter metadata; `src/components/PageMeta.jsx` sets per-route titles and `noindex` on private routes (sign-in, sign-up, settings, 404).
- **Security headers:** `vercel.json` sets a Content-Security-Policy (self + Google Fonts + the Render API origin), HSTS, `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`, and `Permissions-Policy`. If you change `VITE_API_BASE_URL` to a different origin, add it to `connect-src` there.
- **Verification:** `npm test` covers the legal config, routes, footer links, robots/sitemap, metadata, and headers; direct navigation to all three legal routes was smoke-tested against `vite preview` (HTTP 200).

## Checks

```sh
npm test
npm run build
```
