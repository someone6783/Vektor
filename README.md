# Vektor

Vektor is a single-user, local-first AI workspace. The core workspace includes
profiles, channels and direct conversations, streamed Markdown chat with stop and
regenerate, persisted run events, OpenRouter settings, file attachments, and
context inclusion controls with token estimates.

The product plan lives in [docs/PLAN.md](docs/PLAN.md). Current work is
[Phase 3 — Files and context](docs/PLAN.md#phase-3--files-and-context).

## Requirements

- Node.js 22.13 or newer (`.nvmrc` pins 22; the PDF parser requires 22.13+)
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

## Files and context

Use **Attach files**, paste an image into the message box, or drop files onto
the composer. Files stay in the channel across reloads and backend restarts.
Each file has an **Include in context** checkbox, a preview, and a remove action.
The checkbox applies to future runs; an earlier message or answer may still
quote an excluded file. To send only files, leave the message box empty and send.

Supported inputs are UTF-8 text and common source-code files, text-layer PDFs,
DOCX, and PNG/JPEG/WebP/GIF images. Document previews show the first 4,000 extracted
characters, with the original available to download. Images are sent as inline
image content, so choose a vision-capable model. SVG and binary files are rejected;
scanned PDFs need OCR, which remains deferred.

Defaults: 25 MB per file, 250 MB and 50 files per channel, 40 megapixels per image,
200,000 extracted characters per document, and 500 PDF pages. Document extraction
runs in a worker with a 128 MB JavaScript heap limit and a 15-second deadline.
Set `VEKTOR_MAX_FILE_BYTES` (up to 100 MB) and `VEKTOR_CHANNEL_FILE_BYTES` to change
storage limits. Docker Compose reads these values from `.env`.

The composer estimates context using the same assembly policy as the runner:
profile prompt, up to 100 recent completed messages, current message, and selected
files. Text uses `cl100k_base` tokenization plus message overhead. Images reserve
4,096 tokens each for planning; actual counts depend on the provider and resolution.
The cached OpenRouter model list supplies the context window; when unknown, Vektor
uses 8,192 tokens and labels the fallback. Refresh models in Settings to update it.
The profile's max output tokens are reserved and sent to the provider.

When context exceeds the budget, Vektor proposes omitting the oldest history and
requires confirmation. It preserves saved history and does not silently cut the
current prompt or documents. If those inputs alone are too large, exclude files,
shorten the prompt, lower max output tokens, or choose a larger model. Each run saves
its estimate; the last run's actual provider usage appears alongside it when available.
Historical attachments appear on the user turns that included them. Regeneration
uses the original turn, skips files since excluded or removed, and excludes later turns.

File originals are stored under random IDs in `/data/files` (mode `0600`). The database
stores metadata, extracted text, inclusion choices, message links, and run estimates.
Preview/download requests require the access token; URLs never contain the token.
Removing a file deletes its original, extracted text, and message links, but does not
erase earlier chat text or completed run estimates. Back up the entire data directory.

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
files/            attachment originals, named by UUID
workspace/        terminal working directory (Phase 4)
logs/             reserved for file logs
```

## Endpoints

| Endpoint                                 | Auth   | Purpose                                                              |
| ---------------------------------------- | ------ | -------------------------------------------------------------------- |
| `GET /healthz`                           | public | status, version, instance id, DB check, uptime                       |
| `GET/PUT /api/settings`                  | bearer | provider state, default model, write-only key                        |
| `POST /api/settings/provider/test`       | bearer | fetch and cache the OpenRouter model list                            |
| `GET/POST /api/profiles`                 | bearer | list and create profiles                                             |
| `PATCH/DELETE /api/profiles/:id`         | bearer | update or archive a profile                                          |
| `GET/POST /api/channels`                 | bearer | list and create channels or DMs                                      |
| `PATCH/DELETE /api/channels/:id`         | bearer | rename, retarget, or archive a channel                               |
| `GET/POST /api/channels/:id/messages`    | bearer | paginated history and sending a message (starts a run)               |
| `GET/POST /api/channels/:id/attachments` | bearer | list files and limits; upload one multipart file                     |
| `PATCH/DELETE /api/attachments/:id`      | bearer | include/exclude or permanently remove a file                         |
| `GET /api/attachments/:id/content`       | bearer | authenticated original download or image preview                     |
| `POST /api/channels/:id/context`         | bearer | estimate context before sending                                      |
| `GET /api/runs/:id/events`               | bearer | replay and follow a run's SSE events (`Last-Event-ID` / `?after=`)   |
| `POST /api/runs/:id/cancel`              | bearer | abort an active run                                                  |
| `POST /api/runs/:id/retry`               | bearer | rerun the same user turn                                             |
| `GET /api/dev/stream`                    | bearer | 20 stub deltas plus completion; supports `Last-Event-ID` / `?after=` |
| `GET /api/dev/provider`                  | bearer | normalized provider events from the stub or OpenRouter               |

The dev endpoints are enabled outside production by default. Compose enables
them explicitly for demo purposes; set `VEKTOR_ENABLE_DEV_STREAM=0` to disable.

Messages and context requests accept `attachmentIds` (omit for all included files;
use `[]` for none), `profileId`, and `model`. Sending also accepts `allowTruncation`.
History responses include linked attachments and `lastRun` with the stored context
estimate and provider usage. Existing databases migrate automatically on startup.

## Security notes

- The API binds to loopback by default. The container listens on `0.0.0.0` but
  Compose publishes it only on `127.0.0.1`.
- Access tokens and the encryption key are generated locally with mode `0600`.
- The provider key is encrypted at rest and never returned by the API.
- There are no user accounts. Multi-user is explicitly deferred.
- The basic terminal mode arrives in Phase 4 and is a guardrail, not a hardened
  sandbox.
