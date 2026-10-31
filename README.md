# Vektor

Vektor is a single-user, local-first AI workspace. The core workspace includes
profiles, channels and direct conversations, streamed Markdown chat with stop and
regenerate, persisted run events, OpenRouter settings, file attachments, and
context inclusion controls with token estimates, permissioned terminal tools,
approvals, runtime timelines, an audit log, and emergency stop.

The product plan lives in [docs/PLAN.md](docs/PLAN.md). Current work is
[Phase 4 — Terminal permissions and runtime controls](docs/PLAN.md#phase-4--terminal-permissions-and-runtime-controls).

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

## Terminal permissions and runtime controls

Edit a profile in **Settings** and select its terminal mode. The default,
**No terminal**, never exposes a command tool and rejects unsolicited calls.
For either enabled mode, also enable the profile's **terminal tool** checkbox.
Changes apply to new runs; permissions are checked before each subsequent command,
including after approval. Cancel an active command to stop it immediately.

**Basic** allows `pwd`, `ls`, `cat`, `head`, `tail`, `wc`, `mkdir`, and `touch` with
restricted options and paths inside the workspace. It rejects symlinks, special
files, shells, interpreters, and path traversal. Arguments are passed directly,
without shell expansion. The tool accepts an executable name, an argument array,
optional working directory, and timeout; pipelines/redirection require full access
with an explicit shell. Basic is a guardrail, not a hardened sandbox: path checks
cannot prevent hostile concurrent filesystem changes or detect hard links to
outside files. The container boundary supplies isolation.

**Full access** uses the backend account's filesystem permissions. A warning must
be acknowledged before saving the profile, and each command requires approval.
The global runtime bar shows the exact executable, arguments, optional working
directory (defaults to the workspace), and timeout with **Approve command** /
**Deny command** controls. Each decision applies once. Full-access commands can
affect paths outside the workspace; approval does not elevate privileges.
The UI labels execution as `container` or `host`; Docker cannot access host paths
unless you mount them. A local backend executes directly as your host user.

Both modes strip inherited environment variables, set a private umask, cap output
at 64 KiB, and supervise command process groups. Default timeout is 15 seconds;
basic caps at 15 seconds, full permits up to 60 seconds. Timeout, output overflow,
cancellation, and loss of the API pipe kill the supervised group. Full-access
commands can deliberately create a new session/daemon; group cleanup is not a
security boundary for those commands. Windows terminal execution requires the
Docker/POSIX backend.

Compose enables Docker's init process to reap exited/orphaned children. If launching
the image directly, use `docker run --init` for the same behavior.

Use **Run timeline and tool calls** to inspect persisted command input, output,
status, and run events or retry a previous run. Retries review their context budget
and use current profile permissions. **Audit** lists permission changes, tool
decisions/outcomes, approvals, cancellation/recovery, and stop/resume.
Known credentials are redacted from persisted command/run output; this does not
protect arbitrary files or encoded variants. Tool results are returned to the model,
with at most eight rounds/eight calls per round and cumulative usage reporting.
Results must fit the run's context allowance; oversized results fail the run.
The profile's output allowance applies across provider rounds.

**Emergency stop** aborts active runs, cancels pending approvals, kills supervised
process groups, and blocks new runs until **Resume execution**. The latch survives
restart; resume does not rerun cancelled work. Interrupted runs are marked failed,
pending approvals/tools are cancelled, and commands are never replayed automatically.
The scheduler added in Phase 5 must honor this same execution gate.

`VEKTOR_RUN_TIMEOUT_MS` defaults to `120000` (two minutes, including approval waits),
with a range of 1,000–600,000 ms. `VEKTOR_RUNTIME_ENV` controls the environment label:
`host` by default, `container` in the Docker image. It is a label, not a sandbox switch.

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
workspace/        basic terminal boundary and default command working directory
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
| `GET /api/runs/:id/context`              | bearer | estimate retry context using current permissions                     |
| `GET /api/runs`                          | bearer | recent run history, optionally filtered by channel                   |
| `GET /api/runs/:id/details`              | bearer | saved tool calls, approvals and non-delta timeline                   |
| `GET /api/runtime`                       | bearer | stop latch, execution environment, active runs and pending approvals |
| `POST /api/approvals/:id`                | bearer | resolve a pending approval with `{ "approved": true/false }`         |
| `POST /api/runtime/emergency-stop`       | bearer | stop active work and persist the stop latch                          |
| `POST /api/runtime/resume`               | bearer | explicitly clear the stop latch                                      |
| `GET /api/audit`                         | bearer | paginated audit entries (`?before=<id>`)                             |
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
- Basic terminal mode is a restricted-command guardrail, not a hardened sandbox.
