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
2. Open **API settings** (`/settings`) and enter your own provider: provider name, API base URL, API key, and model ID. `Test connection` and `Load models` verify the key and fetch the provider's real model list. The saved key is shown only masked.
3. Open **Chat** (`/chat`), pick a model if your provider exposes several, and send a message. Requests go through the backend proxy; replies stream in; conversations are saved per user and can be reopened or deleted from the sidebar.

`/settings` and `/chat` are protected routes; anonymous visitors are redirected to sign in and returned to the requested page afterwards.

## API contract

The client calls the VupsRouter backend (`server/`):

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/auth/signup`, `/api/auth/signin`, `/api/auth/logout` | Cookie sessions |
| `GET` | `/api/auth/me` | Persistent login check |
| `GET`/`PUT`/`DELETE` | `/api/settings/provider` | Provider configuration (key always masked in responses) |
| `POST` | `/api/settings/provider/test` | Connection test |
| `GET` | `/api/settings/models` | Provider model list |
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

## Checks

```sh
npm test
npm run build
```
