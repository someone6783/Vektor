# Vektor

Vektor is a single-user, local-first AI workspace. Phase 2 is the core workspace:
profiles, channels and direct conversations, streamed Markdown chat with stop and
regenerate, persisted run events, and OpenRouter settings.

The product plan lives in [docs/PLAN.md](docs/PLAN.md). Phase 2 is defined in
[Phase 2 — Core workspace](docs/PLAN.md#phase-2--core-workspace-initial-product-scope).

## Requirements

- Node.js 22.12 or newer (`.nvmrc` pins 22)
- pnpm 10 (`corepack enable` or `npm install -g pnpm@10`)
- Docker with Compose for the container path

## Run with Docker

```bash
docker compose up --build
```

Open <http://127.0.0.1:8787>. The container binds to host loopback only and keeps
its data in the `vektor-data` volume.

The access token is generated on first boot:

```bash
docker compose exec vektor cat /data/access-token
```

Paste it into the unlock screen. The API requires it on every `/api/*` request;
`/healthz` is public.

Without a provider key, chat uses the deterministic stub. To use OpenRouter, open
**Settings**, paste an OpenRouter key, save it, and run **Test connection** to
load the model list. The stored key is encrypted with `/data/secrets.key` and is
never returned by the API. `VEKTOR_OPENROUTER_KEY` takes precedence over a stored
key when set on the container.

## Run locally

```bash
pnpm install
pnpm dev
```

Open <http://127.0.0.1:5173>. Vite proxies `/healthz` and `/api` to the API on
port 8787. The token is written to `.data/access-token`; optionally set
`VITE_ACCESS_TOKEN` in `apps/web/.env.local` to skip the unlock screen.

The dev provider endpoint uses the stub unless `VEKTOR_OPENROUTER_KEY` is set:

```bash
curl -N \
  -H "Authorization: Bearer $(cat .data/access-token)" \
  "http://127.0.0.1:8787/api/dev/provider?prompt=Say%20hello"
```

## Scripts

| Command             | What it does                                                   |
| ------------------- | -------------------------------------------------------------- |
| `pnpm dev`          | Build workspace packages, then run API and web with watch mode |
| `pnpm build`        | Build shared packages, API, and web                            |
| `pnpm typecheck`    | Build packages, then type-check every workspace                |
| `pnpm test`         | Build packages, then run Vitest suites                         |
| `pnpm lint`         | ESLint over the repo                                           |
| `pnpm format`       | Prettier write                                                 |
| `pnpm format:check` | Prettier check                                                 |

## Layout

```text
apps/api          Fastify service (health, auth, chat, runs, SSE)
apps/web          React + Vite + Tailwind workspace
packages/db       SQLite + Drizzle schema, migrations, repositories
packages/shared   Zod contracts and SSE helpers
```

Data directory (default `/data` in production, `.data` in development):

```text
vektor.db         SQLite database (WAL)
access-token      32-byte token, mode 0600
secrets.key       32-byte AES key for stored provider secrets, mode 0600
files/            attachments (Phase 3)
workspace/        terminal working directory (Phase 4)
logs/             reserved for file logs
```

## Endpoints

| Endpoint                              | Auth   | Purpose                                                              |
| ------------------------------------- | ------ | -------------------------------------------------------------------- |
| `GET /healthz`                        | public | status, version, instance id, DB check, uptime                       |
| `GET/PUT /api/settings`               | bearer | provider state, default model, write-only key                        |
| `POST /api/settings/provider/test`    | bearer | fetch and cache the OpenRouter model list                            |
| `GET/POST /api/profiles`              | bearer | list and create profiles                                             |
| `PATCH/DELETE /api/profiles/:id`      | bearer | update or archive a profile                                          |
| `GET/POST /api/channels`              | bearer | list and create channels or DMs                                      |
| `PATCH/DELETE /api/channels/:id`      | bearer | rename, retarget, or archive a channel                               |
| `GET/POST /api/channels/:id/messages` | bearer | paginated history and sending a message (starts a run)               |
| `GET /api/runs/:id/events`            | bearer | replay and follow a run's SSE events (`Last-Event-ID` / `?after=`)   |
| `POST /api/runs/:id/cancel`           | bearer | abort an active run                                                  |
| `POST /api/runs/:id/retry`            | bearer | rerun the same user turn                                             |
| `GET /api/dev/stream`                 | bearer | 20 stub deltas plus completion; supports `Last-Event-ID` / `?after=` |
| `GET /api/dev/provider`               | bearer | normalized provider events from the stub or OpenRouter               |

The dev endpoints are enabled outside production by default. Compose enables
them explicitly for demo purposes; set `VEKTOR_ENABLE_DEV_STREAM=0` to disable.

## Security notes

- The API binds to loopback by default. The container listens on `0.0.0.0` but
  Compose publishes it only on `127.0.0.1`.
- Access tokens and the encryption key are generated locally with mode `0600`.
- The provider key is encrypted at rest and never returned by the API.
- There are no user accounts. Multi-user is explicitly deferred.
- The basic terminal mode arrives in Phase 4 and is a guardrail, not a hardened
  sandbox.
