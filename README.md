# Vektor

Vektor is a single-user, local-first AI workspace. Phase 1 is the foundation: a
Fastify API, SQLite persistence, local token auth, a shared event contract, an
SSE stream, and a React shell that proves the loop.

The product plan lives in [docs/PLAN.md](docs/PLAN.md). Phase 1 is defined in
[Phase 1 — Foundation](docs/PLAN.md#phase-1--foundation).

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

Paste it into the **Event stream demo** panel. The API requires it on every
`/api/*` request; `/healthz` is public.

## Run locally

```bash
pnpm install
pnpm dev
```

Open <http://127.0.0.1:5173>. Vite proxies `/healthz` and `/api` to the API on
port 8787. The token is written to `.data/access-token`; optionally set
`VITE_ACCESS_TOKEN` in `apps/web/.env.local` to prefill the demo.

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
apps/api          Fastify service (health, auth, SSE, provider spike)
apps/web          React + Vite + Tailwind shell
packages/db       SQLite + Drizzle schema, migrations, settings repository
packages/shared   Zod contracts and SSE helpers
```

Data directory (default `/data` in production, `.data` in development):

```text
vektor.db         SQLite database (WAL)
access-token      32-byte token, mode 0600
secrets.key       reserved for Phase 2 secret storage, mode 0600
files/            attachments (Phase 3)
workspace/        terminal working directory (Phase 4)
logs/             reserved for file logs
```

## Endpoints

| Endpoint                | Auth   | Purpose                                                              |
| ----------------------- | ------ | -------------------------------------------------------------------- |
| `GET /healthz`          | public | status, version, instance id, DB check, uptime                       |
| `GET /api/dev/stream`   | bearer | 20 stub deltas plus completion; supports `Last-Event-ID` / `?after=` |
| `GET /api/dev/provider` | bearer | normalized provider events from the stub or OpenRouter               |

The dev endpoints are enabled outside production by default. Compose enables
them explicitly for the Phase 1 demo; set `VEKTOR_ENABLE_DEV_STREAM=0` to disable.

## Security notes

- The API binds to loopback by default. The container listens on `0.0.0.0` but
  Compose publishes it only on `127.0.0.1`.
- Access tokens and the encryption key are generated locally with mode `0600`.
- Phase 1 has no user accounts. Multi-user is explicitly deferred.
- The basic terminal mode arrives in Phase 4 and is a guardrail, not a hardened
  sandbox.
