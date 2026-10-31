# Vektor Product Plan

Status: v0.5 · 2026-10-31
Approval: Scope and Phase 0 accepted on 2026-10-31. Implementation may begin with Phase 1. OCR remains deferred, and v1 uses a single local access token.

## Product summary

Vektor is a single-user, local-first AI workspace. It combines:

- **Profiles** — reusable agent configurations: system prompt, default model, generation settings, tool access, terminal mode.
- **Slack-like conversations** — channels and direct conversations with persistent, scannable history.
- **Streamed chat** — token-by-token responses rendered as Markdown, with stop and regenerate.
- **Files and context** — pasted or uploaded documents and images, with explicit control over what enters the context window.
- **A permissioned terminal** — three access modes, approvals, an audit trail, and an emergency stop.
- **Scheduled runs** — recurring jobs that execute a profile and post results back into a channel.
- **Two shells** — Docker for the server, an optional Tauri app for the desktop.

Non-goals for v1 are listed under [Explicitly deferred](#explicitly-deferred).

## Approval gate

Scope and Phase 0 were approved on 2026-10-31. Phase 1 may start; each later phase starts only after the previous phase's exit criteria are demonstrated.

Working agreement:

1. Build one phase at a time against its exit criteria.
2. Demo the phase and get sign-off before starting the next.
3. Plan changes are edits to this file, reviewed before they affect code.

## Phase 0 — Decisions (accepted)

All decisions below were accepted on 2026-10-31 and recorded in the decision log at the end of this file.

### D1. Stack — accepted

Accepted: TypeScript monorepo with pnpm workspaces.

- `apps/web` — React + Vite + Tailwind.
- `apps/api` — Node.js LTS + Fastify.
- `packages/shared` — Zod contracts and shared types.
- `packages/db` — Drizzle schema, migrations, queries.
- SQLite in WAL mode as the single datastore.

Why: one language across UI, API, and contracts; SQLite fits a single-user local product and makes backup a file copy.

### D2. Deployment model — accepted

Accepted: Docker Compose is the primary install. One API container serves the built web app on `127.0.0.1:8787` by default, with a single volume mounted at `/data`. The container runs as an unprivileged user. Tauri (Phase 6) is a thin desktop shell over the same web UI, not a second backend.

### D3. Identity and access — accepted

Accepted: single user, no accounts. The API requires a locally generated access token stored in the data directory; the browser session gets it through a one-time setup flow. Bind to loopback unless the user explicitly changes it. Multi-user is deferred.

### D4. Agent runtime — accepted (hybrid)

V1 uses a Vektor-owned loop. The API calls OpenRouter chat completions with streaming and tool calling, executes tools itself, and persists every event. Permissions, approvals, audit, cancellation, and scheduling all sit inside a loop we control.

After v1, a runner interface adds a CLI adapter for heavy coding tasks. All runners share the same run-event contract, approval model, and audit trail; see [After v1 — Hybrid CLI runner](#after-v1--hybrid-cli-runner).

### D5. Streaming and run events — accepted

Accepted: server-sent events (SSE) for one-way streams; REST for commands. Every run writes an ordered event log (`run.started`, `message.delta`, `tool.requested`, `tool.output`, `approval.requested`, `usage`, `run.completed` / `failed` / `cancelled`). The client subscribes with a sequence cursor, so a reload or reconnect replays missed events instead of losing output.

### D6. Conversation shape — accepted

V1 ships channels (named, with topic and optional archive) plus direct conversations, both with a flat message timeline. Threads, reactions, mentions, and unread state are deferred. A conversation belongs to one profile; switching the profile affects new runs and is shown in the timeline.

### D7. Profile model — accepted

Accepted: a profile stores name, avatar/color, system prompt, default model, generation parameters (temperature, max output tokens), terminal mode, enabled tools, and context defaults. Provider credentials are global settings, not per profile. A conversation can override the model per run without changing the profile.

### D8. Secrets — accepted

Accepted: the OpenRouter key is write-only from the client. The API encrypts it with AES-256-GCM using a key file generated on first boot (`/data/secrets.key`, mode `0600`). A `VEKTOR_OPENROUTER_KEY` environment variable overrides stored settings and is never persisted. Keys are redacted from logs and tool output.

### D9. Scheduler — accepted

Accepted: an in-process scheduler inside the API, backed by the same SQLite database. Jobs store cron expression, IANA time zone, profile, target channel, prompt, enabled flag, and next run time. A short database lease prevents duplicate firing if two instances ever run. Missed runs are skipped by default, with a per-job catch-up option. Overlapping runs for the same job are skipped.

### D10. Supported attachments — accepted

Accepted for v1:

- Text-like: `.txt`, `.md`, `.csv`, `.json`, and source code — read directly.
- Documents: PDF and DOCX — extract plain text; scanned PDFs without a text layer are rejected with a clear message (OCR deferred).
- Images: PNG, JPEG, WebP, GIF — stored and passed to vision-capable models.
- Per-file size cap (default 25 MB) and per-conversation storage cap, both configurable.

### D11. Terminal modes — accepted

Accepted semantics, enforced by the API rather than by prompt instructions:

- **No-terminal** — no command execution tool is exposed to the model.
- **Basic** — commands run as the unprivileged container user, `cwd` jailed to `/data/workspace`, environment stripped of secrets, per-command timeout and output cap, no Docker socket. This is a guardrail, not a hardened sandbox; the container boundary is the real isolation. The UI says so.
- **Full access** — unrestricted paths inside the container, with a warning, an approval prompt for destructive or privileged commands, and full audit logging.

All modes get run timelines, cancellation, and audit entries. The global emergency stop kills active runs, their process groups, and the scheduler's pending work. On desktop, full access also warns that commands run on the host, not in a container.

### D12. Desktop strategy — accepted

Accepted: Tauri wraps the built web UI and connects to a backend URL chosen on first launch (default `http://127.0.0.1:8787`). No bundled sidecar in v1. Notifications and tray actions talk to the API.

### D13. Version 1 provider scope — accepted

Accepted: OpenRouter only, using its model list and usage reporting. The provider layer is an internal interface so another provider can be added later without changing the UI.

### D14. Releases and update checks — accepted

Accepted: GitHub Actions builds and publishes tagged releases to GitHub Releases and GitHub Container Registry. The API checks GitHub Releases for a newer version, caches the result, and notifies in the UI. The check is optional and sends no local data; v1 does not self-update.

## Architecture

```text
┌──────────────┐   REST + SSE   ┌──────────────────────────────┐
│  React web   │ ◄────────────► │  Fastify API                 │
│  (or Tauri)  │                │  ├─ settings / secrets       │
└──────────────┘                │  ├─ profiles / channels      │
                                │  ├─ agent runner ── OpenRouter│
                                │  │   (CLI adapter post-v1)    │
                                │  ├─ tool executor ── terminal │
                                │  ├─ scheduler                │
                                │  └─ SSE event hub            │
                                └──────────┬───────────────────┘
                                           │
                                ┌──────────▼───────────────────┐
                                │  /data                       │
                                │  ├─ vektor.db (SQLite, WAL)  │
                                │  ├─ files/<attachment-id>    │
                                │  ├─ workspace/               │
                                │  ├─ logs/                    │
                                │  └─ secrets.key (0600)       │
                                └──────────────────────────────┘
```

### Run lifecycle

1. Client posts a message; the API stores it and creates a queued run.
2. The runner assembles context: profile prompt, recent conversation history, selected attachments, tool definitions.
3. The active runner streams from OpenRouter and appends every delta and tool event to the run log. V1 has one runner; the CLI adapter arrives after v1.
4. Tool calls pause the run if they need approval; the UI resolves the approval and the run resumes.
5. On completion the assistant message, usage, and final status are persisted; the event stream closes.
6. Cancel sets the run to `cancelled`, aborts the provider request, and kills any child process group.

### Data model (draft)

| Table            | Purpose                     | Key fields                                                                             |
| ---------------- | --------------------------- | -------------------------------------------------------------------------------------- |
| `settings`       | Global config               | `key`, `value_json`, `updated_at`                                                      |
| `profiles`       | Agent configurations        | `name`, `system_prompt`, `model`, `params_json`, `terminal_mode`, `tools_json`         |
| `channels`       | Slack-like containers       | `name`, `topic`, `kind`, `archived_at`                                                 |
| `conversations`  | A message timeline          | `channel_id?`, `profile_id`, `title`                                                   |
| `messages`       | User and assistant turns    | `conversation_id`, `role`, `content`, `run_id?`                                        |
| `runs`           | One agent execution         | `conversation_id`, `runner`, `status`, `started_at`, `ended_at`, `usage_json`, `error` |
| `run_events`     | Ordered append-only log     | `run_id`, `seq`, `type`, `payload_json`                                                |
| `tool_calls`     | Queryable tool history      | `run_id`, `name`, `input_json`, `output`, `status`                                     |
| `attachments`    | Stored files                | `message_id?`, `filename`, `mime`, `size`, `path`, `extracted_text`                    |
| `scheduled_jobs` | Recurring jobs              | `schedule`, `timezone`, `profile_id`, `channel_id`, `prompt`, `next_run_at`            |
| `job_runs`       | Scheduled execution history | `job_id`, `scheduled_for`, `status`, `run_id?`, `error`                                |
| `approvals`      | Pending decisions           | `run_id`, `tool_call_id`, `command`, `status`                                          |
| `audit_log`      | Security-relevant actions   | `actor`, `action`, `target`, `detail_json`, `created_at`                               |

## Phase 1 — Foundation

Goal: a deployable, observable skeleton with a working database, contracts, auth, and a streaming spike.

Target layout:

```text
apps/api          Fastify service
apps/web          React + Vite app
packages/db       Drizzle schema, migrations, queries
packages/shared   Zod contracts and inferred types
```

Status (2026-10-31): implemented and verified locally with Node 22.23.4, pnpm 10.34.9, and Docker Compose. The only open item is the live OpenRouter check, which needs `VEKTOR_OPENROUTER_KEY` and is skipped without it.

### 1.1 Workspace and tooling

- [x] Root `package.json`, `pnpm-workspace.yaml`, `.nvmrc` (current Node LTS), `.editorconfig`, `.gitignore` (`node_modules`, `dist`, `.env`, `data/`).
- [x] Strict `tsconfig.base.json` plus per-package configs; workspace packages resolve by name through their built exports.
- [x] ESLint flat config and Prettier; scripts for `lint`, `format:check`, `typecheck`, `test`, and `build`.
- [x] Vitest across workspaces for contracts, database, API, and web logic.
- [ ] React Testing Library with the first component test; deferred to Phase 2 when the first interactive component lands.
- [x] GitHub Actions: install with a frozen lockfile, then lint, typecheck, test, and build.

Done when a clean clone passes `pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test && pnpm build`.

### 1.2 Shared contracts

- [x] `packages/shared`: `HealthResponse`, `ApiError`, and a discriminated `RunEvent` union covering `run.started`, `message.delta`, `tool.requested`, `tool.output`, `approval.requested`, `usage`, `run.completed`, `run.failed`, and `run.cancelled`.
- [x] SSE frame helpers (`id`, `event`, `data`) and cursor types.
- [x] Unit tests for every event variant and for rejecting unknown event types without crashing a stream.

Done when web and API import the same schemas and the union is exhaustively tested.

### 1.3 Database and data directory

- [x] `packages/db`: better-sqlite3 plus Drizzle; initial schema limited to `settings` and the migration journal.
- [x] Boot migration runner over generated SQL; transactional and idempotent.
- [x] PRAGMAs: WAL, `foreign_keys=ON`, `busy_timeout=5000`.
- [x] Data-directory bootstrap for `VEKTOR_DATA_DIR` (default `/data`): `files/`, `workspace/`, and `logs/`, with directory mode `0700`.
- [x] Generate `secrets.key` (32 random bytes, `0600`) on first boot for Phase 2 secret storage; generate and persist `app.instance_id`.
- [x] Settings repository with typed JSON get/set, used for the instance id.
- [x] Tests: migrate an empty database, re-run as a no-op, verify WAL, verify the instance id survives reopen.

Done when a restart reuses the same instance id and migrations are safe to re-run.

### 1.4 API skeleton

- [x] Fastify with env-validated config (`PORT`, `VEKTOR_DATA_DIR`, optional `VEKTOR_ACCESS_TOKEN`, `VEKTOR_ENABLE_DEV_STREAM`).
- [x] Pino JSON logs with request ids and redaction for authorization headers and cookies; request bodies (which may carry provider keys) are never logged.
- [x] `GET /healthz` returns status, version, instance id, DB check, and uptime; `503` when the DB check fails.
- [x] Consistent error envelope, not-found handler, and validation-error mapping.
- [x] Access token: generate `/data/access-token` (`0600`) on first boot; require `Authorization: Bearer` on `/api/*`; keep `/healthz` public. The browser setup flow lands in Phase 2.
- [x] Dev-only SSE endpoint `GET /api/dev/stream` (enabled by `VEKTOR_ENABLE_DEV_STREAM=1`): 20 ordered stub deltas, heartbeats, and resume from `Last-Event-ID` or `?after=`.
- [x] Graceful shutdown: preClose ends open SSE responses, the database closes, and a 10-second watchdog prevents a hung exit.
- [x] Tests with Fastify `inject`: health, 401/200 auth, error shape, SSE ordering, and resume.

Done when `/healthz` is 200, unauthenticated `/api/*` is 401, and logs are JSON with request ids.

### 1.5 Web shell

- [x] Vite + React + Tailwind; shell with a header and disabled placeholders for Chat, Profiles, and Settings.
- [x] Health card polling `/healthz` with version, DB status, instance id, and a clear disconnected state.
- [x] SSE demo panel: connect to the dev stream, render deltas in order, show sequence numbers, and offer reconnect.
- [x] Dev token handling via `VITE_ACCESS_TOKEN` or a browser-local token field; Phase 2 replaces it with the setup flow.
- [x] Loading, empty, and error states; no chat features yet.

Done when the health card and SSE demo work in dev and from the built container.

### 1.6 Provider spike

- [x] `ChatProvider` interface: `streamChat(request)` yields normalized text, tool-call, usage, and finish events, and aborts through `request.signal`.
- [x] Stub provider with deterministic deltas and one fake tool call.
- [x] OpenRouter provider: streaming chat completions, SSE parsing, tool-call argument assembly across chunks, and abort on signal.
- [x] Fixtures: text-only stream, split tool call, usage frame, provider error, and mid-stream disconnect.
- [x] Contract tests replay every fixture through the normalizer; a live OpenRouter test is opt-in and skipped in CI.
- [x] Not wired into chat, runs, or persistence yet.

Done when fixture replays produce the shared event types and a live key produces a short streamed reply.

### 1.7 Docker and Compose

- [x] Multi-stage Dockerfile: build web and API, deploy the API with production dependencies only (`pnpm deploy`), non-root user, writable `/data`, 85 MB image.
- [x] Compose: `127.0.0.1:8787:8787`, named volume `vektor-data:/data`, health check on `/healthz`, restart policy.
- [x] API serves the built web app with SPA fallback, excluding `/healthz` and `/api/*`.
- [x] `.dockerignore` and a reproducible image build.
- [x] README quickstart: `docker compose up --build`, data location, and where the access token lives.

Done when `docker compose up --build` reaches healthy and serves the web shell.

### 1.8 Phase 1 verification

- [x] Clean clone: install, lint, typecheck, test, and build pass.
- [x] Container: health page loads; `/healthz` returns 200; `/api/*` requires the token.
- [x] Persistence: recreate the container and confirm the instance id is unchanged.
- [x] Streaming: dev stream renders in order; disconnect and reconnect resumes from the last sequence.
- [x] Provider: the stub streams text, a tool call, usage, and finish; the live OpenRouter test is skipped without `VEKTOR_OPENROUTER_KEY`.
- [ ] Provider live check: run `pnpm --filter @vektor/api test` with `VEKTOR_OPENROUTER_KEY` set to confirm a real short reply.
- [x] Logs: JSON, request ids present, secrets redacted.

Exit criteria: all verification items pass, and health, persistence, auth, and the streaming demo are demonstrated before Phase 2 begins.

## Phase 2 — Core workspace (initial product scope)

Goal: the first useful chat loop.

- Add profile selection.
- Add Slack-like conversations.
- Add streaming responses.
- Add Markdown rendering.
- Add settings for OpenRouter and profiles.

Details:

- Settings screen: write-only OpenRouter key, model list, default model, connection test.
- Profile CRUD and a header switcher; prompt, model, parameters, terminal mode field (enforced in Phase 4).
- Channel sidebar, create/rename/archive, direct conversations, message history with pagination.
- Composer with send, stop (basic abort), retry/regenerate; optimistic user message; streamed assistant message.
- GFM Markdown with code highlighting and copy; safe HTML sanitization.
- Persist and replay run events so a reload mid-stream recovers the output.

Exit criteria: configure a key, create a profile, create a channel, receive a streamed Markdown answer, stop it, reload, and find the conversation intact.

## Phase 3 — Files and context

- Add file uploads and local storage.
- Add image paste and drag-and-drop.
- Add document text extraction.
- Add attachment previews.
- Add context inclusion controls.
- Add context/token usage display.

Details: attachment rows and on-disk files, extraction pipeline, per-attachment include/exclude toggles, context budget meter with truncation policy, and a pre-send warning when the selected context exceeds the model window.

Exit criteria: attach a PDF and an image, see previews, include only one of them, and see an accurate token estimate before and after sending.

## Phase 4 — Terminal permissions and runtime controls

- Implement no-terminal mode.
- Implement basic terminal sandbox.
- Implement full-access mode with warnings and approvals.
- Add run timeline, tool-call display, cancellation, retry, and audit log.
- Add global emergency stop.

Details: mode matrix enforced server-side, workspace jail and scrubbed environment in basic mode, approval prompts and destructive-command denylist in full mode, process-group kill, audit viewer, and an emergency stop that halts all active runs and the scheduler.

Exit criteria: a basic-mode command cannot escape the workspace and is audited; a full-mode destructive command blocks on approval; emergency stop ends a long-running command within a few seconds.

## Phase 5 — Scheduling

- Add cron job CRUD.
- Add friendly schedule input.
- Add time zone support.
- Add run history and failure states.
- Add delivery into Vektor channels.
- Add restart-safe scheduler behavior.

Details: cron parsing with a natural-language helper ("weekdays at 9am"), IANA time zones, `next_run_at` computed in the job's zone, a lease-based tick, skip-overlap policy, pause/resume, and job results delivered as a message in the target channel.

Exit criteria: create a job, restart the container, and see it fire on schedule with history and a delivered message; a disabled job does not fire.

## Phase 6 — Desktop packaging

- Wrap the frontend with Tauri.
- Add local backend connection setup.
- Add native notifications.
- Add system tray behavior.
- Add data-directory and backend health screens.
- Document Docker-based local installation.

Exit criteria: the desktop app connects to a Docker backend, shows health, delivers a notification on run completion, and exposes scheduler pause and emergency stop from the tray.

## Phase 7 — Hardening

- Add automated tests for permissions and terminal isolation.
- Add backup and restore.
- Add structured logs.
- Add usage and cost reporting.
- Add upgrade/migration documentation.
- Test recovery after container restart and interrupted agent runs.

Details: a consistent backup command (SQLite snapshot plus files), restore into a fresh volume, JSON logs with rotation and redaction, per-profile and per-job cost report from OpenRouter usage, and crash-recovery tests that kill the process mid-run.

Exit criteria: restore a backup into a clean volume and resume work; an interrupted run is marked failed and retryable; the cost report reconciles with provider usage.

## Phase 8 — Release builds and update checks

Goal: GitHub Actions produces the release, and a running Vektor can tell the user when a newer release exists without leaking local data or interrupting work.

- [ ] Version has one source of truth: the root package metadata, injected into the API and web build. `/healthz`, the About panel, the Docker image label, and the release tag all report the same value.
- [ ] CI keeps running lint, typecheck, test, and build on every push and pull request; tag builds run the same checks before publishing.
- [ ] Release workflow on `v*` tags (with manual dispatch): run the full verification, build the API and web artifacts, and publish a multi-arch image to GitHub Container Registry with `x.y.z`, `x.y`, and `latest` tags.
- [ ] Image carries OCI labels for version, revision, source, and build date, plus a build-provenance attestation. The GitHub Release links to the image, release notes, and upgrade instructions.
- [ ] `GET /api/update-check` (bearer auth) queries the GitHub Releases API for the repository, compares versions with strict semver, caches the result for 24 hours, and returns current version, latest version, availability, release URL, and publish date.
- [ ] Failure handling: 5-second timeout, at most one retry, and quiet degradation for offline, rate-limited (HTTP 403/429), missing, or malformed responses. A failed check never blocks startup, chat, or runs.
- [ ] Privacy: the check sends only a `User-Agent` and reads public release metadata. No instance id, access token, provider key, usage data, or data-directory contents leave the machine, and the only outbound host is `api.github.com`.
- [ ] Update checking is optional: `VEKTOR_UPDATE_CHECK` and an About-panel switch. Default is one check per 24 hours; "Check now" forces a fresh request.
- [ ] UI: current version in the About panel and footer, an "update available" badge with the release link, and upgrade steps (`docker compose pull && docker compose up -d`; the `vektor-data` volume is preserved).
- [ ] No automatic download or install in v1. Docker and desktop both notify and link to the release; silent self-update is deferred.
- [ ] Tests: semver comparison table (equal, newer, older, prerelease, malformed), fixture GitHub responses (latest, prerelease-only, rate-limited, offline), cache expiry, and opt-out behavior.

Details: the repository is public, so release metadata needs no GitHub token. If it ever becomes private, the check requires an optional read-only token stored in the data directory and remains off by default. Version comparison uses the `semver` package rather than string comparison. Cached results live in `settings` so a restart does not immediately re-query GitHub, and the timestamp is visible as "last checked". The check is server-side to keep the token out of the browser and to avoid CORS and per-browser rate limits.

Exit criteria: pushing a `v*` tag publishes a tagged image and GitHub Release with no manual steps; an older running instance reports the newer version within the cache window and links to the upgrade instructions; with no network the instance keeps working and shows "unable to check" instead of an error.

## After v1 — Hybrid CLI runner

Planned, not part of the first usable release. This is the second half of D4.

- Introduce a runner interface with `native` (the OpenRouter loop) and `cli` adapters.
- CLI runs reuse `run_events`, approvals, audit, and cancellation; stdout/stderr become streamed events, and the process group is killed on cancel.
- A CLI runner requires basic or full terminal mode; no-terminal profiles reject it.
- Per-profile runner selection, a compatibility check for the installed CLI, and a clear "commands run on this machine" warning.
- Normalize CLI tool and file events into the existing run timeline rather than inventing a parallel UI.

Exit criteria: a conversation can use either runner with identical timeline, cancel, approval, and audit behavior.

## After v1 — External service integrations

Planned, not part of the first usable release. Vektor should support adding optional integrations with third-party services such as Spotify, Gmail, and Apple Calendar.

- Introduce a provider-neutral integration interface for authentication, capabilities, rate limits, and error handling.
- Add secure OAuth credential storage and per-integration permission scopes, with the ability to disconnect or revoke access.
- Expose enabled services as permissioned tools that profiles and scheduled jobs can use, with every request recorded in the audit log.
- Start with Spotify, Gmail, and Apple Calendar as the initial integration targets, subject to API and platform availability.
- Keep integrations optional and isolated so the core local-first workspace works without any connected external accounts.

Exit criteria: a user can connect and disconnect an integration, review its granted permissions, use an approved capability from a profile or scheduled job, and see the request in the audit history.

## Explicitly deferred

- Browser automation.
- Multi-user accounts and collaboration.
- Visual workflow builder.
- Distributed microservices.
- Large-scale worker autoscaling.
- Native video understanding.
- External service integrations, including Spotify, Gmail, and Apple Calendar.
- Marketplace/plugin ecosystem.
- Complex multi-agent planning graphs.

Also deferred: conversation threads and reactions, OCR for scanned PDFs, providers other than OpenRouter, and a bundled desktop backend.

## Definition of the first usable release

The first usable release is complete when a user can:

1. Start Vektor with Docker.
2. Configure an OpenRouter key.
3. Create and switch between profiles.
4. Choose no-terminal, basic-terminal, or full-access mode.
5. Chat with a profile and receive streamed responses.
6. Paste or upload supported documents and images.
7. See active runs, tool calls, and context usage.
8. Cancel a running agent.
9. Create, pause, and inspect a recurring scheduled job.
10. Restart the container without losing data.
11. See the installed version and whether a newer release exists.

Phase mapping: item 1 → Phase 1; items 2, 3, 5 → Phase 2; item 6 → Phase 3; item 7 → Phases 3–4; items 4, 8 → Phase 4; item 9 → Phase 5; item 10 → Phases 1 and 7; item 11 → Phase 8.

## Risks

- **Sandbox expectations.** Basic mode is a guardrail; only the container boundary is real isolation. The UI and docs must say this, and Phase 7 must test the claim.
- **Provider variance.** OpenRouter models differ in streaming, tool-call formatting, and vision support. Fixtures and capability checks are required, plus graceful "model does not support X" errors.
- **SQLite contention.** Event streaming is write-heavy; keep a single writer, batch deltas, and use WAL.
- **Scheduler duplicates.** Restarts and multiple instances can double-fire jobs; the lease and `next_run_at` update must be atomic.
- **Secret leakage.** Tool output and error messages can echo environment variables; redact before persisting or logging.
- **Context drift.** Long conversations and large attachments can silently truncate; the usage meter and inclusion controls must reflect what is actually sent.
- **Desktop divergence.** Full-access commands on the host are more dangerous than inside Docker; the desktop build needs its own warning and approval defaults.
- **CLI adapter drift.** External CLIs change flags and event formats; pin versions, detect capabilities, and fail closed to the native runner.
- **Update checks.** GitHub's API is rate-limited and may be unreachable; checks must be cached, optional, and must never block startup or reveal local data.

## Decision log

| Date       | Decision                                                                                           | Status   |
| ---------- | -------------------------------------------------------------------------------------------------- | -------- |
| 2026-10-31 | Plan v0.2: added Phase 0 proposals, Phases 1–2, architecture, data model, risks                    | Draft    |
| 2026-10-31 | D1: TypeScript monorepo — React/Vite, Fastify, SQLite/Drizzle, shared Zod contracts                | Accepted |
| 2026-10-31 | D4: hybrid runtime — Vektor-owned loop in v1, CLI adapter after v1                                 | Accepted |
| 2026-10-31 | D6: channels plus DMs with flat timelines; threads deferred                                        | Accepted |
| 2026-10-31 | D11: basic mode is a container-boundary guardrail, documented as such                              | Accepted |
| 2026-10-31 | D14: GitHub Actions publishes releases; Vektor checks GitHub Releases for updates, no auto-install | Accepted |
| 2026-10-31 | D2, D3, D5, D7–D10, D12, D13: remaining Phase 0 defaults                                           | Accepted |
| 2026-10-31 | OCR for scanned PDFs deferred; PDFs without a text layer are rejected with a clear message         | Accepted |
| 2026-10-31 | Auth: single local access token, no accounts                                                       | Accepted |
| 2026-10-31 | Plan v0.4: all Phase 0 decisions accepted; Phase 1 expanded into a task checklist                  | Accepted |
